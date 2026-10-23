import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { CloudPairResponse } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
import type { CloudRequestError } from "./api-client"
import type { CloudIdentity } from "./identity"
import type { PairSessionManager, PairSessionSnapshot } from "./pair-session"
import { runPairCommand, type PairCommandArgs, type PairCommandDeps } from "./pair-command"
import { apiError, makeFakeCloudApiClient, networkError } from "./testing"

const PAIR_RESPONSE: CloudPairResponse = {
  machineToken: "mt",
  proxySecret: "ps",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "new-connector-token",
  tunnelHost: "tun-new.kanna.sh",
}

const IDENTITY: CloudIdentity = {
  controlUrl: "https://kanna.sh/api/cloud",
  machineToken: "old-token",
  proxySecret: "old-proxy",
  subdomain: "jakemor-old",
  appOrigin: "https://jakemor-old.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}

function createHarness(overrides: {
  identity?: CloudIdentity | null
  pairResult?: CloudPairResponse | CloudRequestError
  removeResult?: CloudRequestError | null
  confirm?: boolean
} = {}) {
  const calls = {
    pair: [] as Array<{ code: string; name?: string }>,
    remove: 0,
    written: [] as CloudIdentity[],
    deleted: 0,
    log: [] as string[],
    warn: [] as string[],
  }

  const client = makeFakeCloudApiClient({
    controlUrl: "https://kanna.sh/api/cloud",
    pair: (code, name) => Effect.suspend(() => {
      calls.pair.push({ code, name })
      const result = overrides.pairResult ?? PAIR_RESPONSE
      return result instanceof Error ? Effect.fail(result) : Effect.succeed(result)
    }),
    removeMachine: () => Effect.suspend(() => {
      calls.remove += 1
      return overrides.removeResult ? Effect.fail(overrides.removeResult) : Effect.void
    }),
  })

  const deps: PairCommandDeps = {
    log: (message) => calls.log.push(message),
    warn: (message) => calls.warn.push(message),
    readIdentity: () => Effect.succeed(overrides.identity ?? null),
    writeIdentity: (identity) => Effect.sync(() => {
      calls.written.push(identity)
    }),
    deleteIdentity: () => Effect.sync(() => {
      calls.deleted += 1
      return true
    }),
    createApiClient: () => client,
    getMachineName: () => Effect.succeed("Jake's MBP"),
    confirm: () => Effect.succeed(overrides.confirm ?? true),
  }

  return { calls, deps }
}

const pair = (args: PairCommandArgs, deps: PairCommandDeps) => runTest(runPairCommand(args, deps))

/** A stand-in session manager whose snapshots the test scripts. */
function scriptedSession(snapshots: { start: PairSessionSnapshot; status: () => PairSessionSnapshot }): PairSessionManager {
  return {
    start: Effect.succeed(snapshots.start),
    status: Effect.sync(snapshots.status),
    stop: Effect.void,
  }
}

describe("kanna pair", () => {
  test("exchanges the code, writes identity, prints next step", async () => {
    const { calls, deps } = createHarness()

    const code = await pair({ action: "pair", pairingCode: "ABC123" }, deps)

    expect(code).toBe(0)
    expect(calls.pair).toEqual([{ code: "ABC123", name: "Jake's MBP" }])
    expect(calls.written).toEqual([
      {
        controlUrl: "https://kanna.sh/api/cloud",
        machineToken: "mt",
        proxySecret: "ps",
        subdomain: "jakemor-mbp",
        appOrigin: "https://jakemor-mbp.kanna.sh",
        tunnelToken: "new-connector-token",
        tunnelHost: "tun-new.kanna.sh",
        enabled: true,
      },
    ])
    expect(calls.log.some((line) => line.includes("https://jakemor-mbp.kanna.sh"))).toBe(true)
  })

  test("pairing over a stale/outdated cloud.json stays silent about it", async () => {
    const { calls, deps } = createHarness()
    // Simulate identity.ts finding an outdated v1 file: it invokes the warn
    // callback and yields null. During `pair` that callback must be a no-op.
    deps.readIdentity = (warnCb) => Effect.sync(() => {
      warnCb?.("cloud.json is missing tunnelToken, tunnelHost — run `kanna pair` again")
      return null
    })

    const code = await pair({ action: "pair", pairingCode: "ABC123" }, deps)

    expect(code).toBe(0)
    expect(calls.warn).toEqual([])
    expect(calls.written.length).toBe(1)
  })

  test("management actions still surface a broken cloud.json with the log prefix", async () => {
    const { calls, deps } = createHarness()
    deps.readIdentity = (warnCb) => Effect.sync(() => {
      warnCb?.("cloud.json is missing tunnelToken, tunnelHost — run `kanna pair` again")
      return null
    })

    await pair({ action: "status", pairingCode: null }, deps)

    expect(calls.warn.length).toBe(1)
    expect(calls.warn[0].startsWith("[kanna] ")).toBe(true)
  })

  test("warns when re-pairing an already paired machine", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY })
    await pair({ action: "pair", pairingCode: "ABC123" }, deps)
    expect(calls.warn.some((line) => line.includes("already paired"))).toBe(true)
    expect(calls.written.length).toBe(1)
  })

  test("expired code → exit 1 with pointer to kanna.sh", async () => {
    const { calls, deps } = createHarness({ pairResult: apiError(410, "Pairing code expired", "/pair") })
    const code = await pair({ action: "pair", pairingCode: "STALE" }, deps)
    expect(code).toBe(1)
    expect(calls.warn.some((line) => line.includes("expired"))).toBe(true)
    expect(calls.written).toEqual([])
  })

  test("unknown code → exit 1 as invalid", async () => {
    const { calls, deps } = createHarness({ pairResult: apiError(404, "Pairing code not found", "/pair") })
    const code = await pair({ action: "pair", pairingCode: "NOPE" }, deps)
    expect(code).toBe(1)
    expect(calls.warn.some((line) => line.includes("invalid"))).toBe(true)
  })

  test("bare `kanna pair` prints a claim link + QR and waits for the browser half", async () => {
    const { calls, deps } = createHarness()
    const waiting: PairSessionSnapshot = {
      status: "waiting",
      claimUrl: "https://kanna.sh/machine?pair=ABC123",
      expiresAt: 1,
    }
    let statusReads = 0
    deps.renderQr = (url) => `[qr:${url}]`
    deps.createPairSession = (sessionDeps) => Effect.gen(function* () {
      // The manager writes credentials through onPaired, as the real one does.
      yield* sessionDeps.onPaired({ ...IDENTITY, appOrigin: "https://jakemor-mbp.kanna.sh" }).pipe(Effect.orDie)
      return scriptedSession({
        start: waiting,
        // The browser half completes while the command is waiting.
        status: () => {
          statusReads += 1
          return statusReads > 1 ? { status: "paired", appOrigin: "https://jakemor-mbp.kanna.sh" } : waiting
        },
      })
    })

    const code = await pair({ action: "pair", pairingCode: null }, deps)

    expect(code).toBe(0)
    expect(calls.log.some((line) => line.includes("[qr:https://kanna.sh/machine?pair=ABC123]"))).toBe(true)
    expect(calls.log.some((line) => line === "https://kanna.sh/machine?pair=ABC123")).toBe(true)
    expect(calls.log.some((line) => line.includes("paired!"))).toBe(true)
    expect(calls.written).toHaveLength(1)
  })

  test("bare `kanna pair` reports an expired link with exit 1", async () => {
    const { calls, deps } = createHarness()
    deps.renderQr = () => "[qr]"
    deps.createPairSession = () => Effect.succeed(scriptedSession({
      start: { status: "expired" },
      status: () => ({ status: "expired" }),
    }))

    const code = await pair({ action: "pair", pairingCode: null }, deps)

    expect(code).toBe(1)
    expect(calls.warn.some((line) => line.includes("could not start pairing"))).toBe(true)
  })

  test("status reports paired/enabled state", async () => {
    const paired = createHarness({ identity: IDENTITY })
    expect(await pair({ action: "status", pairingCode: null }, paired.deps)).toBe(0)
    expect(paired.calls.log.some((line) => line.includes("https://jakemor-old.kanna.sh"))).toBe(true)

    const unpaired = createHarness()
    expect(await pair({ action: "status", pairingCode: null }, unpaired.deps)).toBe(0)
    expect(unpaired.calls.log.some((line) => line.includes("not paired"))).toBe(true)
  })

  test("disable/enable flip the sticky flag", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY })
    expect(await pair({ action: "disable", pairingCode: null }, deps)).toBe(0)
    expect(calls.written[0].enabled).toBe(false)

    expect(await pair({ action: "enable", pairingCode: null }, deps)).toBe(0)
    expect(calls.written[1].enabled).toBe(true)
  })

  test("disable when not paired → exit 1", async () => {
    const { deps } = createHarness()
    expect(await pair({ action: "disable", pairingCode: null }, deps)).toBe(1)
  })

  test("remove unlinks remotely and deletes credentials", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY })
    expect(await pair({ action: "remove", pairingCode: null }, deps)).toBe(0)
    expect(calls.remove).toBe(1)
    expect(calls.deleted).toBe(1)
  })

  test("remove deletes local credentials even when the control plane call fails", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY, removeResult: networkError("offline", "/machine") })
    expect(await pair({ action: "remove", pairingCode: null }, deps)).toBe(0)
    expect(calls.deleted).toBe(1)
    expect(calls.warn.some((line) => line.includes("deleting local credentials anyway"))).toBe(true)
  })

  test("remove respects a declined confirmation", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY, confirm: false })
    expect(await pair({ action: "remove", pairingCode: null }, deps)).toBe(0)
    expect(calls.remove).toBe(0)
    expect(calls.deleted).toBe(0)
  })
})

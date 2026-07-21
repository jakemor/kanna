import { describe, expect, test } from "bun:test"
import type { CloudPairResponse } from "../../shared/cloud-api"
import { CloudApiError, type CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { runPairCommand, type PairCommandDeps } from "./pair-command"

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
  pairResult?: CloudPairResponse | Error
  removeResult?: Error | null
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

  const client: CloudApiClient = {
    controlUrl: "https://kanna.sh/api/cloud",
    async pair(code, name) {
      calls.pair.push({ code, name })
      const result = overrides.pairResult ?? PAIR_RESPONSE
      if (result instanceof Error) throw result
      return result
    },
    async heartbeat() {},
    async markOffline() {},
    async removeMachine() {
      calls.remove += 1
      if (overrides.removeResult) throw overrides.removeResult
    },
  }

  const deps: PairCommandDeps = {
    log: (message) => calls.log.push(message),
    warn: (message) => calls.warn.push(message),
    readIdentity: async () => overrides.identity ?? null,
    writeIdentity: async (identity) => {
      calls.written.push(identity)
    },
    deleteIdentity: async () => {
      calls.deleted += 1
      return true
    },
    createApiClient: () => client,
    getMachineName: () => "Jake's MBP",
    confirm: async () => overrides.confirm ?? true,
  }

  return { calls, deps }
}

describe("kanna pair", () => {
  test("exchanges the code, writes identity, prints next step", async () => {
    const { calls, deps } = createHarness()

    const code = await runPairCommand({ action: "pair", pairingCode: "ABC123" }, deps)

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
    expect(calls.log.some((line) => line.includes("run `kanna`"))).toBe(true)
  })

  test("warns when re-pairing an already paired machine", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY })
    await runPairCommand({ action: "pair", pairingCode: "ABC123" }, deps)
    expect(calls.warn.some((line) => line.includes("already paired"))).toBe(true)
    expect(calls.written.length).toBe(1)
  })

  test("expired code → exit 1 with pointer to kanna.sh", async () => {
    const { calls, deps } = createHarness({ pairResult: new CloudApiError("Pairing code expired", 410) })
    const code = await runPairCommand({ action: "pair", pairingCode: "STALE" }, deps)
    expect(code).toBe(1)
    expect(calls.warn.some((line) => line.includes("expired"))).toBe(true)
    expect(calls.written).toEqual([])
  })

  test("unknown code → exit 1 as invalid", async () => {
    const { calls, deps } = createHarness({ pairResult: new CloudApiError("Pairing code not found", 404) })
    const code = await runPairCommand({ action: "pair", pairingCode: "NOPE" }, deps)
    expect(code).toBe(1)
    expect(calls.warn.some((line) => line.includes("invalid"))).toBe(true)
  })

  test("status reports paired/enabled state", async () => {
    const paired = createHarness({ identity: IDENTITY })
    expect(await runPairCommand({ action: "status", pairingCode: null }, paired.deps)).toBe(0)
    expect(paired.calls.log.some((line) => line.includes("https://jakemor-old.kanna.sh"))).toBe(true)

    const unpaired = createHarness()
    expect(await runPairCommand({ action: "status", pairingCode: null }, unpaired.deps)).toBe(0)
    expect(unpaired.calls.log.some((line) => line.includes("not paired"))).toBe(true)
  })

  test("disable/enable flip the sticky flag", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY })
    expect(await runPairCommand({ action: "disable", pairingCode: null }, deps)).toBe(0)
    expect(calls.written[0].enabled).toBe(false)

    expect(await runPairCommand({ action: "enable", pairingCode: null }, deps)).toBe(0)
    expect(calls.written[1].enabled).toBe(true)
  })

  test("disable when not paired → exit 1", async () => {
    const { deps } = createHarness()
    expect(await runPairCommand({ action: "disable", pairingCode: null }, deps)).toBe(1)
  })

  test("remove unlinks remotely and deletes credentials", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY })
    expect(await runPairCommand({ action: "remove", pairingCode: null }, deps)).toBe(0)
    expect(calls.remove).toBe(1)
    expect(calls.deleted).toBe(1)
  })

  test("remove deletes local credentials even when the control plane call fails", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY, removeResult: new Error("offline") })
    expect(await runPairCommand({ action: "remove", pairingCode: null }, deps)).toBe(0)
    expect(calls.deleted).toBe(1)
    expect(calls.warn.some((line) => line.includes("deleting local credentials anyway"))).toBe(true)
  })

  test("remove respects a declined confirmation", async () => {
    const { calls, deps } = createHarness({ identity: IDENTITY, confirm: false })
    expect(await runPairCommand({ action: "remove", pairingCode: null }, deps)).toBe(0)
    expect(calls.remove).toBe(0)
    expect(calls.deleted).toBe(0)
  })
})

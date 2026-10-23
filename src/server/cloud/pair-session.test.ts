import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, type Duration } from "effect"
import { TestClock } from "effect/testing"
import type { CloudDeviceCodePollResponse } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
import type { CloudRequestError } from "./api-client"
import { readCloudIdentity, writeCloudIdentity, type CloudIdentity } from "./identity"
import type { PlatformServices } from "../platform"
import { createPairSessionManager, type PairSessionManager } from "./pair-session"
import { apiError, captureLogs, makeFakeCloudApiClient, networkError } from "./testing"

const NOW = 1_700_000_000_000
const CONTROL_URL = "https://kanna.sh/api/cloud"

const PAIRING = {
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
}

interface FakeApiOptions {
  /** Consumed one per poll; the last entry repeats. */
  polls?: Array<CloudDeviceCodePollResponse | CloudRequestError>
  requestError?: CloudRequestError
  expiresAt?: number
  pollIntervalMs?: number
}

function createFakeApi(options: FakeApiOptions = {}) {
  const calls = { requests: 0, polls: 0 }
  const polls = options.polls ?? [{ status: "pending" as const }]

  const client = makeFakeCloudApiClient({
    controlUrl: CONTROL_URL,
    requestDeviceCode: () => Effect.suspend(() => {
      calls.requests += 1
      if (options.requestError) return Effect.fail(options.requestError)
      return Effect.succeed({
        code: "ABC123",
        deviceToken: "device-token",
        claimUrl: "https://kanna.sh/machine?pair=ABC123",
        expiresAt: options.expiresAt ?? NOW + 900_000,
        pollIntervalMs: options.pollIntervalMs ?? 1,
      })
    }),
    pollDeviceCode: () => Effect.suspend(() => {
      const next = polls[Math.min(calls.polls, polls.length - 1)]!
      calls.polls += 1
      return next instanceof Error ? Effect.fail(next) : Effect.succeed(next)
    }),
  })

  return { client, calls }
}

/** One TestClock step, then a real macrotask so the poll loop can run. */
const step = (duration: Duration.Input = "1 millis") =>
  TestClock.adjust(duration).pipe(Effect.andThen(Effect.promise(() => Bun.sleep(1))))

const waitForSettled = (manager: PairSessionManager, duration: Duration.Input = "1 millis") =>
  Effect.gen(function* () {
    for (let index = 0; index < 200; index += 1) {
      const snapshot = yield* manager.status
      if (snapshot.status !== "waiting") return snapshot
      yield* step(duration)
    }
    throw new Error("pair session never settled")
  })

function createManager(
  api: ReturnType<typeof createFakeApi>,
  overrides: { onPaired?: (identity: CloudIdentity) => Effect.Effect<void, Error> } = {},
) {
  const paired: CloudIdentity[] = []
  const manager = createPairSessionManager({
    machineName: "Jake's MBP",
    createApiClient: () => api.client,
    onPaired: overrides.onPaired ?? ((identity) => Effect.sync(() => {
      paired.push(identity)
    })),
  })
  return { manager, paired }
}

/** Runs the body on a TestClock set to NOW, with the session's log lines captured. */
function run<A, E>(body: Effect.Effect<A, E, PlatformServices>) {
  const logs = captureLogs()
  return runTest(TestClock.setTime(NOW).pipe(
    Effect.andThen(body),
    Effect.provide(logs.layer),
    Effect.provide(TestClock.layer()),
  ))
}

describe("createPairSessionManager", () => {
  test("start issues a claim URL and reports waiting", async () => {
    const api = createFakeApi()

    const snapshot = await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      const started = yield* manager.start
      yield* manager.stop
      return started
    }))

    expect(snapshot.status).toBe("waiting")
    expect(snapshot.claimUrl).toBe("https://kanna.sh/machine?pair=ABC123")
    expect(snapshot.expiresAt).toBe(NOW + 900_000)
    expect(api.calls.requests).toBe(1)
  })

  test("start reuses a live session instead of burning a second code", async () => {
    const api = createFakeApi()

    await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      const first = yield* manager.start
      const second = yield* manager.start
      yield* manager.stop
      expect(second).toEqual(first)
    }))
    expect(api.calls.requests).toBe(1)
  })

  test("a claim hands credentials to onPaired and flips to paired", async () => {
    const api = createFakeApi({
      polls: [{ status: "pending" }, { status: "claimed", pairing: PAIRING }],
    })
    const { manager, paired } = createManager(api)

    const settled = await run(Effect.gen(function* () {
      const session = yield* manager
      yield* session.start
      return yield* waitForSettled(session)
    }))

    expect(settled.status).toBe("paired")
    expect(settled.appOrigin).toBe(PAIRING.appOrigin)
    expect(paired).toEqual([
      {
        controlUrl: CONTROL_URL,
        machineToken: PAIRING.machineToken,
        proxySecret: PAIRING.proxySecret,
        subdomain: PAIRING.subdomain,
        appOrigin: PAIRING.appOrigin,
        tunnelToken: PAIRING.tunnelToken,
        tunnelHost: PAIRING.tunnelHost,
        enabled: true,
      },
    ])
  })

  test("onPaired runs with what the creator's context provided", async () => {
    const api = createFakeApi({ polls: [{ status: "claimed", pairing: PAIRING }] })
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-pair-session-"))
    const filePath = path.join(dir, "cloud.json")

    try {
      const written = await run(Effect.gen(function* () {
        // Needs the FileSystem: the poll loop gets it from here, not from its caller.
        const manager = yield* createPairSessionManager({
          machineName: "Jake's MBP",
          createApiClient: () => api.client,
          onPaired: (identity) => writeCloudIdentity(identity, filePath),
        })
        yield* manager.start
        yield* waitForSettled(manager)
        return yield* readCloudIdentity(filePath)
      }))
      expect(written?.appOrigin).toBe(PAIRING.appOrigin)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("start after pairing keeps the paired snapshot", async () => {
    const api = createFakeApi({ polls: [{ status: "claimed", pairing: PAIRING }] })

    const again = await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      yield* manager.start
      yield* waitForSettled(manager)
      return yield* manager.start
    }))

    expect(again.status).toBe("paired")
    expect(api.calls.requests).toBe(1)
  })

  test("a redeemed or unknown session expires instead of polling forever", async () => {
    const api = createFakeApi({ polls: [apiError(410, "gone", "/device-code/poll")] })

    const settled = await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      yield* manager.start
      return yield* waitForSettled(manager)
    }))

    expect(settled.status).toBe("expired")
  })

  test("transient poll failures are retried, not fatal", async () => {
    const api = createFakeApi({
      polls: [networkError("network"), networkError("network"), { status: "claimed", pairing: PAIRING }],
    })
    const { manager, paired } = createManager(api)

    const settled = await run(Effect.gen(function* () {
      const session = yield* manager
      yield* session.start
      return yield* waitForSettled(session)
    }))

    expect(settled.status).toBe("paired")
    expect(paired).toHaveLength(1)
  })

  test("a repeatedly failing control plane surfaces an error", async () => {
    const api = createFakeApi({ polls: [networkError("network unreachable")] })

    const settled = await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      yield* manager.start
      return yield* waitForSettled(manager)
    }))

    expect(settled.status).toBe("error")
    expect(settled.error).toContain("network unreachable")
    expect(api.calls.polls).toBe(10)
  })

  test("the local clock passing expiry ends the session", async () => {
    const api = createFakeApi({ expiresAt: NOW + 1_000, pollIntervalMs: 600 })

    const settled = await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      yield* manager.start
      return yield* waitForSettled(manager, "600 millis")
    }))

    expect(settled.status).toBe("expired")
    expect(api.calls.polls).toBe(1)
  })

  test("failing to activate the pairing surfaces as an error, not silent success", async () => {
    const api = createFakeApi({ polls: [{ status: "claimed", pairing: PAIRING }] })
    const logs = captureLogs()

    const settled = await runTest(Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const manager = yield* createManager(api, {
        onPaired: () => Effect.fail(new Error("cloud.json is read-only")),
      }).manager
      yield* manager.start
      return yield* waitForSettled(manager)
    }).pipe(Effect.provide(logs.layer), Effect.provide(TestClock.layer())))

    expect(settled.status).toBe("error")
    expect(settled.error).toContain("read-only")
    expect(logs.warnings()).toEqual(["cloud: pairing succeeded but activation failed: cloud.json is read-only"])
  })

  test("start reports a control-plane failure without wedging the manager", async () => {
    const api = createFakeApi({ requestError: networkError("503", "/device-code") })

    const snapshot = await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      return yield* manager.start
    }))

    expect(snapshot.status).toBe("error")
    expect(snapshot.error).toContain("503")
  })

  test("stop halts polling", async () => {
    const api = createFakeApi()

    await run(Effect.gen(function* () {
      const manager = yield* createManager(api).manager
      yield* manager.start
      yield* step()
      yield* manager.stop
      const after = api.calls.polls
      yield* step()
      yield* step()
      expect(api.calls.polls).toBe(after)
      expect((yield* manager.status).status).toBe("waiting")
    }))
  })
})

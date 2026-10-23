import { describe, expect, test } from "bun:test"
import { FileSystem, type Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
import type { StartedShareTunnel } from "../share"
import type { CloudRequestError } from "./api-client"
import type { CloudIdentity } from "./identity"
import { apiError, captureLogs, makeFakeCloudApiClient, networkError, settle, waitFor } from "./testing"
import { restartDelayMs, runCloudTunnelSupervisor, type TunnelSupervisorDeps } from "./tunnel-supervisor"

const IDENTITY: CloudIdentity = {
  controlUrl: DEFAULT_CLOUD_CONTROL_URL,
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}

const PING = "30 seconds"

/** Fake named-tunnel connector: resolves "connected" (publicUrl null). */
function createFakeConnectors() {
  const stopped: number[] = []
  const tokens: string[] = []
  let started = 0
  let failNext = 0
  const startTunnelImpl = async (_localUrl: string, tunnelToken: string): Promise<StartedShareTunnel> => {
    const index = started
    started += 1
    tokens.push(tunnelToken)
    if (failNext > 0) {
      failNext -= 1
      throw new Error("connector failed to start")
    }
    return {
      publicUrl: null,
      stop: () => {
        stopped.push(index)
      },
    }
  }
  return {
    startTunnelImpl,
    stopped,
    tokens,
    startedCount: () => started,
    failNextStarts(count: number) {
      failNext = count
    },
  }
}

function createFakeApi() {
  const heartbeats: CloudHeartbeatRequest[] = []
  let failNextWith: CloudRequestError | null = null
  const client = makeFakeCloudApiClient({
    controlUrl: "http://cp/api/cloud",
    heartbeat: (_token, update) => Effect.suspend(() => {
      if (failNextWith) {
        const error = failNextWith
        failNextWith = null
        return Effect.fail(error)
      }
      heartbeats.push(update)
      return Effect.void
    }),
  })
  return {
    client,
    heartbeats,
    failNext(error: CloudRequestError) {
      failNextWith = error
    },
  }
}

/** A /health that answers ok unless told to fail the next N pings. */
function createPings() {
  let count = 0
  let failuresRemaining = 0
  let failureMessage = "tunnel gone"
  const fetchImpl = (async () => {
    count += 1
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      throw new Error(failureMessage)
    }
    return new Response("ok")
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    count: () => count,
    failNext(times: number, message = "tunnel gone") {
      failuresRemaining = times
      failureMessage = message
    },
  }
}

/** The "restarting in Ns" delays the supervisor announced, in seconds. */
const restartDelays = (warnings: string[]) =>
  warnings.flatMap((message) => {
    const match = message.match(/restarting in (\d+)s$/)
    return match ? [Number(match[1])] : []
  })

/** Runs the body on a TestClock (starting at 0) with the supervisor's logs captured. */
function runSupervised<A>(body: (logs: ReturnType<typeof captureLogs>) => Effect.Effect<A, never, FileSystem.FileSystem>) {
  const logs = captureLogs()
  return runTest(body(logs).pipe(Effect.provide(logs.layer), Effect.provide(TestClock.layer())))
}

function supervise(
  api: ReturnType<typeof createFakeApi>,
  deps: TunnelSupervisorDeps,
  onTunnelUp?: (kind: "started" | "recovered") => void,
) {
  return runCloudTunnelSupervisor({
    localUrl: "http://localhost:3210",
    identity: IDENTITY,
    apiClient: api.client,
    onTunnelUp,
    deps,
  }).pipe(Effect.forkChild)
}

/** One self-ping interval passes and its ping lands. */
const nextPing = (pings: ReturnType<typeof createPings>) =>
  Effect.gen(function* () {
    const before = pings.count()
    yield* TestClock.adjust(PING)
    yield* waitFor(() => pings.count() === before + 1)
    yield* settle
  })

describe("restartDelayMs", () => {
  test("retries every 1s inside the 60s fast window", () => {
    expect(restartDelayMs(0, 0)).toBe(1_000)
    expect(restartDelayMs(30_000, 0)).toBe(1_000)
    expect(restartDelayMs(59_999, 0)).toBe(1_000)
  })

  test("past the window, backs off 2s→4s→10s then holds at 30s", () => {
    expect([1, 2, 3, 4, 9].map((count) => restartDelayMs(60_000, count))).toEqual([
      2_000, 4_000, 10_000, 30_000, 30_000,
    ])
  })
})

describe("tunnel supervisor (named tunnel)", () => {
  test("connects with the tunnel token and heartbeats immediately", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()
    const upEvents: string[] = []

    await runSupervised((logs) => Effect.gen(function* () {
      const fiber = yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl }, (kind) => upEvents.push(kind))

      yield* waitFor(() => api.heartbeats.length === 1)
      expect(api.heartbeats[0]).toEqual({ localUrl: "http://localhost:3210" })
      expect(connectors.tokens).toEqual(["connector-token"])
      expect(upEvents).toEqual(["started"])
      expect(logs.infos()).toContain("cloud: connected (https://jakemor-mbp.kanna.sh)")

      yield* Fiber.interrupt(fiber)
      expect(connectors.stopped).toEqual([0])
    }))
  })

  test("heartbeats every Nth successful ping", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()

    await runSupervised(() => Effect.gen(function* () {
      yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl, heartbeatEveryNPings: 2 })

      yield* waitFor(() => api.heartbeats.length === 1)
      yield* nextPing(pings) // ping 1
      expect(api.heartbeats.length).toBe(1)
      yield* nextPing(pings) // ping 2 → heartbeat
      yield* waitFor(() => api.heartbeats.length === 2)
      yield* nextPing(pings) // ping 3
      expect(api.heartbeats.length).toBe(2)
      yield* nextPing(pings) // ping 4 → heartbeat
      yield* waitFor(() => api.heartbeats.length === 3)
    }))
  })

  test("tolerates isolated ping failures without restarting", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()

    await runSupervised((logs) => Effect.gen(function* () {
      yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl })

      yield* waitFor(() => api.heartbeats.length === 1)
      pings.failNext(2, "530 transient blip") // below the tolerance of 3
      yield* nextPing(pings) // ping 1 fails
      yield* nextPing(pings) // ping 2 fails
      yield* nextPing(pings) // ping 3 succeeds — counter resets
      pings.failNext(2, "530 transient blip")
      yield* nextPing(pings) // fails, but the streak restarted at 1
      yield* nextPing(pings)

      expect(connectors.startedCount()).toBe(1) // never restarted
      expect(logs.warnings()).toEqual([
        "cloud: self-ping failed (1/3)",
        "cloud: self-ping failed (2/3)",
        "cloud: self-ping failed (1/3)",
        "cloud: self-ping failed (2/3)",
      ])
    }))
  })

  test("sustained ping failure restarts the connector with backoff (same hostname)", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()
    const upEvents: string[] = []

    await runSupervised((logs) => Effect.gen(function* () {
      yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl }, (kind) => upEvents.push(kind))

      yield* waitFor(() => api.heartbeats.length === 1)
      pings.failNext(3) // meets the tolerance → declared dead
      yield* nextPing(pings) // ping 1 fails
      yield* nextPing(pings) // ping 2 fails
      yield* nextPing(pings) // ping 3 fails → restart cycle
      expect(connectors.stopped).toEqual([0]) // first connector was stopped
      expect(logs.warnings().at(-1)).toBe("cloud: connection down (tunnel gone) — restarting in 1s")

      yield* TestClock.adjust("999 millis")
      yield* settle
      expect(connectors.startedCount()).toBe(1)
      yield* TestClock.adjust("1 millis") // backoff (1s) elapses
      yield* waitFor(() => api.heartbeats.length === 2) // reconnect heartbeat

      expect(connectors.startedCount()).toBe(2)
      expect(connectors.tokens).toEqual(["connector-token", "connector-token"])
      expect(upEvents).toEqual(["started", "recovered"])
    }))
  })

  test("repeated connector startup failures retry at 1s, then escalate past the fast window", async () => {
    const api = createFakeApi()
    let attempts = 0
    const startTunnelImpl = async (): Promise<StartedShareTunnel> => {
      attempts += 1
      throw new Error(`no connector ${attempts}`)
    }

    await runSupervised((logs) => Effect.gen(function* () {
      yield* supervise(api, { startTunnelImpl })

      // Inside the 60s fast window (t = 0s…59s): every retry is 1s.
      yield* waitFor(() => restartDelays(logs.warnings()).length === 1)
      for (let failures = 2; failures <= 60; failures += 1) {
        yield* TestClock.adjust("1 second")
        yield* waitFor(() => restartDelays(logs.warnings()).length === failures)
      }
      expect(restartDelays(logs.warnings())).toEqual(Array.from({ length: 60 }, () => 1))

      // Past the window: escalates 2s → 4s → 10s → 30s and holds.
      const steps: Array<Duration.Input> = ["1 second", "2 seconds", "4 seconds", "10 seconds", "30 seconds"]
      for (const step of steps) {
        const before = restartDelays(logs.warnings()).length
        yield* TestClock.adjust(step)
        yield* waitFor(() => restartDelays(logs.warnings()).length === before + 1)
      }
      expect(restartDelays(logs.warnings()).slice(60)).toEqual([2, 4, 10, 30, 30])
      expect(logs.warnings()[0]).toBe("cloud: connection down (no connector 1) — restarting in 1s")
    }))
  })

  test("a successful reconnect resets the failure streak to the fast window", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()

    await runSupervised((logs) => Effect.gen(function* () {
      yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl })
      yield* waitFor(() => api.heartbeats.length === 1)

      // Drive a failure streak long enough to escalate past the fast window:
      // the connector stays down for the first 60 restarts.
      connectors.failNextStarts(60)
      pings.failNext(3)
      yield* nextPing(pings) // ping 1 fails
      yield* nextPing(pings) // ping 2 fails
      yield* nextPing(pings) // ping 3 fails → streak starts → backoff (1s)
      yield* waitFor(() => restartDelays(logs.warnings()).length === 1)
      for (let failures = 2; failures <= 61; failures += 1) {
        yield* TestClock.adjust("1 second")
        yield* waitFor(() => restartDelays(logs.warnings()).length === failures)
      }
      expect(restartDelays(logs.warnings()).slice(59)).toEqual([1, 2]) // 60s in: escalated
      yield* TestClock.adjust("2 seconds") // escalated backoff → reconnects fine
      yield* waitFor(() => api.heartbeats.length === 2)

      // …then a later failure starts a fresh streak back at 1s, not 4s.
      pings.failNext(3)
      yield* nextPing(pings)
      yield* nextPing(pings)
      yield* nextPing(pings) // → restart cycle
      yield* waitFor(() => restartDelays(logs.warnings()).length === 62)
      expect(restartDelays(logs.warnings()).at(-1)).toBe(1)
    }))
  })

  test("401 from the control plane stops supervision (machine revoked)", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()
    api.failNext(apiError(401, "Unauthorized"))

    await runSupervised((logs) => Effect.gen(function* () {
      const fiber = yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl })

      // Supervision ends on its own.
      yield* Fiber.join(fiber)
      expect(logs.warnings()).toHaveLength(1)
      expect(logs.warnings()[0]).toContain("revoked")
      yield* TestClock.adjust("1 hour")
      yield* settle
      // No restarts were scheduled after the revocation.
      expect(connectors.startedCount()).toBe(1)
      expect(connectors.stopped).toEqual([0])
      expect(pings.count()).toBe(0)
    }))
  })

  test("a 401 on a periodic heartbeat also ends supervision", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()

    await runSupervised((logs) => Effect.gen(function* () {
      const fiber = yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl, heartbeatEveryNPings: 1 })
      yield* waitFor(() => api.heartbeats.length === 1)
      api.failNext(apiError(401, "Unauthorized"))
      yield* TestClock.adjust(PING)
      yield* Fiber.join(fiber)
      expect(logs.warnings().at(-1)).toContain("revoked")
      expect(connectors.stopped).toEqual([0])
      expect(connectors.startedCount()).toBe(1)
    }))
  })

  test("heartbeat network hiccups are tolerated (retry next round)", async () => {
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const pings = createPings()

    await runSupervised((logs) => Effect.gen(function* () {
      yield* supervise(api, { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: pings.fetchImpl, heartbeatEveryNPings: 1 })

      yield* waitFor(() => api.heartbeats.length === 1)
      api.failNext(networkError("control plane blip"))
      yield* nextPing(pings) // ping ok → heartbeat fails (tolerated)
      yield* waitFor(() => logs.warnings().includes("cloud: heartbeat failed (control plane blip)"))
      yield* nextPing(pings) // ping ok → heartbeat retries fine
      yield* waitFor(() => api.heartbeats.length === 2)

      expect(connectors.startedCount()).toBe(1) // no restart for a CP blip
    }))
  })

  test("stopping while the connector is still coming up stops it once it arrives", async () => {
    const api = createFakeApi()
    const stopped: string[] = []
    let arrive: () => void = () => {}
    const startTunnelImpl = () => new Promise<StartedShareTunnel>((resolve) => {
      arrive = () => resolve({ publicUrl: null, stop: () => stopped.push("late connector") })
    })

    await runSupervised(() => Effect.gen(function* () {
      const fiber = yield* supervise(api, { startTunnelImpl })
      yield* settle
      yield* Fiber.interrupt(fiber)
      expect(stopped).toEqual([])
      arrive()
      yield* waitFor(() => stopped.length === 1)
      expect(api.heartbeats).toEqual([])
    }))
  })
})

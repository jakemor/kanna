import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import { runTest } from "../effect/testing"
import type { CloudRequestError } from "./api-client"
import { runCloudHeartbeatLoop } from "./heartbeat-loop"
import type { CloudIdentity } from "./identity"
import { apiError, captureLogs, makeFakeCloudApiClient, networkError, settle, waitFor } from "./testing"

const IDENTITY: CloudIdentity = {
  controlUrl: DEFAULT_CLOUD_CONTROL_URL,
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-box",
  appOrigin: "https://jakemor-box.kanna.sh",
  tunnelToken: "",
  tunnelHost: "3210-sbx123.e2b.app",
  enabled: true,
  mode: "direct",
}

function createFakeApi() {
  const heartbeats: CloudHeartbeatRequest[] = []
  let attempts = 0
  let failNextWith: CloudRequestError | null = null
  const client = makeFakeCloudApiClient({
    heartbeat: (_token, update) => Effect.suspend(() => {
      attempts += 1
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
    attempts: () => attempts,
    failNextWith(error: CloudRequestError) {
      failNextWith = error
    },
  }
}

/** Runs the loop on a TestClock (1:1 ms) with its logs captured. */
function runLoop<A>(body: (logs: ReturnType<typeof captureLogs>) => Effect.Effect<A>) {
  const logs = captureLogs()
  return runTest(body(logs).pipe(Effect.provide(logs.layer), Effect.provide(TestClock.layer())))
}

describe("runCloudHeartbeatLoop", () => {
  test("heartbeats immediately, fires onUp('started'), then waits the interval", async () => {
    const api = createFakeApi()
    const ups: string[] = []

    await runLoop((logs) => Effect.gen(function* () {
      yield* runCloudHeartbeatLoop({
        localUrl: "http://localhost:3210",
        identity: IDENTITY,
        apiClient: api.client,
        onUp: (kind) => ups.push(kind),
        deps: { intervalMs: 111, retryIntervalMs: 22 },
      }).pipe(Effect.forkChild)

      yield* waitFor(() => api.heartbeats.length === 1)
      expect(api.heartbeats[0]).toEqual({ localUrl: "http://localhost:3210" })
      expect(ups).toEqual(["started"])
      expect(logs.infos().some((m) => m.includes("cloud: connected"))).toBe(true)

      yield* TestClock.adjust("110 millis")
      yield* settle
      expect(api.attempts()).toBe(1)
      yield* TestClock.adjust("1 millis")
      yield* waitFor(() => api.heartbeats.length === 2)
      expect(ups).toEqual(["started"])
    }))
  })

  test("failure → warn + retry cadence → onUp('recovered') on success", async () => {
    const api = createFakeApi()
    const ups: string[] = []

    api.failNextWith(networkError("network down"))
    await runLoop((logs) => Effect.gen(function* () {
      yield* runCloudHeartbeatLoop({
        localUrl: "http://localhost:3210",
        identity: IDENTITY,
        apiClient: api.client,
        onUp: (kind) => ups.push(kind),
        deps: { intervalMs: 111, retryIntervalMs: 22 },
      }).pipe(Effect.forkChild)

      // First beat fails → retry interval, warn once.
      yield* waitFor(() => logs.warnings().length === 1)
      expect(logs.warnings()[0]).toBe("cloud: heartbeat failed: network down — retrying")
      expect(ups).toEqual([])

      // Recovery: the retry 22ms later succeeds. First success still counts as "started".
      yield* TestClock.adjust("22 millis")
      yield* waitFor(() => api.heartbeats.length === 1)
      expect(ups).toEqual(["started"])

      // Back on the normal interval; a blip there retries at 22ms and recovers.
      api.failNextWith(networkError("blip"))
      yield* TestClock.adjust("111 millis")
      yield* waitFor(() => api.attempts() === 3)
      expect(api.heartbeats.length).toBe(1)
      yield* TestClock.adjust("21 millis")
      yield* settle
      expect(api.attempts()).toBe(3)
      yield* TestClock.adjust("1 millis")
      yield* waitFor(() => api.heartbeats.length === 2)
      expect(ups).toEqual(["started", "recovered"])
      expect(logs.infos()).toContain("cloud: reconnected (https://jakemor-box.kanna.sh)")
    }))
  })

  test("warns once per failure streak, not on every retry", async () => {
    const api = createFakeApi()

    await runLoop((logs) => Effect.gen(function* () {
      api.failNextWith(networkError("down"))
      yield* runCloudHeartbeatLoop({
        localUrl: "http://localhost:3210",
        identity: IDENTITY,
        apiClient: api.client,
        deps: { intervalMs: 111, retryIntervalMs: 22 },
      }).pipe(Effect.forkChild)
      yield* waitFor(() => api.attempts() === 1)
      api.failNextWith(networkError("still down"))
      yield* TestClock.adjust("22 millis")
      yield* waitFor(() => api.attempts() === 2)
      expect(logs.warnings()).toEqual(["cloud: heartbeat failed: down — retrying"])
    }))
  })

  test("401 → revocation warning and the loop stops for good", async () => {
    const api = createFakeApi()

    api.failNextWith(apiError(401, "machine not found"))
    await runLoop((logs) => Effect.gen(function* () {
      const fiber = yield* runCloudHeartbeatLoop({
        localUrl: "http://localhost:3210",
        identity: IDENTITY,
        apiClient: api.client,
        deps: { intervalMs: 111, retryIntervalMs: 22 },
      }).pipe(Effect.forkChild)

      // The loop exits on its own.
      yield* Fiber.join(fiber)
      expect(logs.warnings()).toHaveLength(1)
      expect(logs.warnings()[0]).toContain("revoked")
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(api.attempts()).toBe(1)
      expect(api.heartbeats.length).toBe(0)
    }))
  })

  test("interrupting the loop cancels the pending wait and ends it", async () => {
    const api = createFakeApi()

    await runLoop(() => Effect.gen(function* () {
      const fiber = yield* runCloudHeartbeatLoop({
        localUrl: "http://localhost:3210",
        identity: IDENTITY,
        apiClient: api.client,
        deps: { intervalMs: 111, retryIntervalMs: 22 },
      }).pipe(Effect.forkChild)

      yield* waitFor(() => api.heartbeats.length === 1)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(api.heartbeats.length).toBe(1)
    }))
  })
})

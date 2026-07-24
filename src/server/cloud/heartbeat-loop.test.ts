import { describe, expect, test } from "bun:test"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import { CloudApiError, type CloudApiClient } from "./api-client"
import { startCloudHeartbeatLoop } from "./heartbeat-loop"
import type { CloudIdentity } from "./identity"

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

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out")
    }
    await Bun.sleep(2)
  }
}

/** sleepImpl the test resolves manually, recording requested durations. */
function createManualSleep() {
  const waiting: Array<{ ms: number; resolve: () => void }> = []
  const requestedMs: number[] = []

  const sleepImpl = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      requestedMs.push(ms)
      const entry = { ms, resolve }
      waiting.push(entry)
      signal.addEventListener(
        "abort",
        () => {
          const index = waiting.indexOf(entry)
          if (index !== -1) waiting.splice(index, 1)
          resolve()
        },
        { once: true },
      )
    })

  return {
    sleepImpl,
    requestedMs,
    pendingCount: () => waiting.length,
    async releaseNext() {
      await waitFor(() => waiting.length > 0)
      waiting.shift()?.resolve()
      await Bun.sleep(2)
    },
  }
}

function createFakeApi() {
  const heartbeats: CloudHeartbeatRequest[] = []
  let failNextWith: Error | null = null
  const client: CloudApiClient = {
    controlUrl: DEFAULT_CLOUD_CONTROL_URL,
    pair: async () => {
      throw new Error("not used")
    },
    heartbeat: async (_token, update) => {
      if (failNextWith) {
        const error = failNextWith
        failNextWith = null
        throw error
      }
      heartbeats.push(update)
    },
    markOffline: async () => {},
    removeMachine: async () => {},
  }
  return {
    client,
    heartbeats,
    failNextWith(error: Error) {
      failNextWith = error
    },
  }
}

describe("startCloudHeartbeatLoop", () => {
  test("heartbeats immediately, fires onUp('started'), then sleeps the interval", async () => {
    const sleep = createManualSleep()
    const api = createFakeApi()
    const ups: string[] = []
    const logs: string[] = []

    const loop = startCloudHeartbeatLoop({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      log: (m) => logs.push(m),
      onUp: (kind) => ups.push(kind),
      deps: { sleepImpl: sleep.sleepImpl, intervalMs: 111, retryIntervalMs: 22 },
    })

    await waitFor(() => api.heartbeats.length === 1)
    expect(api.heartbeats[0]).toEqual({ localUrl: "http://localhost:3210" })
    expect(ups).toEqual(["started"])
    expect(logs.some((m) => m.includes("cloud: connected"))).toBe(true)
    await waitFor(() => sleep.requestedMs.length === 1)
    expect(sleep.requestedMs[0]).toBe(111)

    loop.stop()
  })

  test("failure → warn + retry cadence → onUp('recovered') on success", async () => {
    const sleep = createManualSleep()
    const api = createFakeApi()
    const ups: string[] = []
    const warns: string[] = []

    api.failNextWith(new Error("network down"))
    const loop = startCloudHeartbeatLoop({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      warn: (m) => warns.push(m),
      onUp: (kind) => ups.push(kind),
      deps: { sleepImpl: sleep.sleepImpl, intervalMs: 111, retryIntervalMs: 22 },
    })

    // First beat fails → retry interval, warn once.
    await waitFor(() => sleep.requestedMs.length === 1)
    expect(sleep.requestedMs[0]).toBe(22)
    expect(warns.some((m) => m.includes("heartbeat failed"))).toBe(true)
    expect(ups).toEqual([])

    // Recovery: next beat succeeds. First success still counts as "started".
    await sleep.releaseNext()
    await waitFor(() => api.heartbeats.length === 1)
    expect(ups).toEqual(["started"])
    await waitFor(() => sleep.requestedMs.length === 2)
    expect(sleep.requestedMs[1]).toBe(111)

    // A later blip: fail once, then succeed → "recovered".
    api.failNextWith(new Error("blip"))
    await sleep.releaseNext()
    await waitFor(() => sleep.requestedMs.length === 3)
    expect(sleep.requestedMs[2]).toBe(22)
    await sleep.releaseNext()
    await waitFor(() => api.heartbeats.length === 2)
    expect(ups).toEqual(["started", "recovered"])

    loop.stop()
  })

  test("401 → revocation warning and the loop stops for good", async () => {
    const sleep = createManualSleep()
    const api = createFakeApi()
    const warns: string[] = []

    api.failNextWith(new CloudApiError("machine not found", 401))
    startCloudHeartbeatLoop({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      warn: (m) => warns.push(m),
      deps: { sleepImpl: sleep.sleepImpl, intervalMs: 111, retryIntervalMs: 22 },
    })

    await waitFor(() => warns.length === 1)
    expect(warns[0]).toContain("revoked")
    // Loop exited: no sleep was ever requested, no further heartbeats.
    await Bun.sleep(10)
    expect(sleep.requestedMs.length).toBe(0)
    expect(api.heartbeats.length).toBe(0)
  })

  test("stop() aborts the pending sleep and ends the loop", async () => {
    const sleep = createManualSleep()
    const api = createFakeApi()

    const loop = startCloudHeartbeatLoop({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      deps: { sleepImpl: sleep.sleepImpl, intervalMs: 111, retryIntervalMs: 22 },
    })

    await waitFor(() => sleep.requestedMs.length === 1)
    loop.stop()
    await Bun.sleep(10)
    expect(sleep.pendingCount()).toBe(0)
    expect(api.heartbeats.length).toBe(1)
  })
})

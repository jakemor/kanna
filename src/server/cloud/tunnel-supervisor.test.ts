import { describe, expect, test } from "bun:test"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import type { StartedShareTunnel } from "../share"
import { CloudApiError, type CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { restartDelayMs, startCloudTunnelSupervisor } from "./tunnel-supervisor"

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
    async releaseNext() {
      await waitFor(() => waiting.length > 0)
      waiting.shift()?.resolve()
      await Bun.sleep(2)
    },
  }
}

/** Fake named-tunnel connector: resolves "connected" (publicUrl null). */
function createFakeConnectors() {
  const stopped: number[] = []
  const tokens: string[] = []
  let started = 0
  let failNext = false
  const startTunnelImpl = async (_localUrl: string, tunnelToken: string): Promise<StartedShareTunnel> => {
    const index = started
    started += 1
    tokens.push(tunnelToken)
    if (failNext) {
      failNext = false
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
    failNextStart() {
      failNext = true
    },
  }
}

function createFakeApi() {
  const heartbeats: CloudHeartbeatRequest[] = []
  let failNextWith: Error | null = null
  const client: CloudApiClient = {
    controlUrl: "http://cp/api/cloud",
    async pair() {
      throw new Error("not used")
    },
    async heartbeat(_token, update) {
      if (failNextWith) {
        const error = failNextWith
        failNextWith = null
        throw error
      }
      heartbeats.push(update)
    },
    async markOffline() {},
    async removeMachine() {},
  }
  return {
    client,
    heartbeats,
    failNext(error: Error) {
      failNextWith = error
    },
  }
}

function okPing(): typeof fetch {
  return (async () => new Response("ok")) as unknown as typeof fetch
}

describe("restartDelayMs", () => {
  test("backs off 1s→2s→4s→10s then holds at 30s", () => {
    expect([1, 2, 3, 4, 5, 9].map(restartDelayMs)).toEqual([
      1_000, 2_000, 4_000, 10_000, 30_000, 30_000,
    ])
  })
})

describe("tunnel supervisor (named tunnel)", () => {
  test("connects with the tunnel token and heartbeats immediately", async () => {
    const sleep = createManualSleep()
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const upEvents: string[] = []

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      onTunnelUp: (kind) => upEvents.push(kind),
      deps: { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: okPing(), sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => api.heartbeats.length === 1)
    expect(api.heartbeats[0]).toEqual({ localUrl: "http://localhost:3210" })
    expect(connectors.tokens).toEqual(["connector-token"])
    expect(upEvents).toEqual(["started"])

    supervisor.stop()
    expect(connectors.stopped).toEqual([0])
  })

  test("heartbeats every Nth successful ping", async () => {
    const sleep = createManualSleep()
    const connectors = createFakeConnectors()
    const api = createFakeApi()

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      deps: {
        startTunnelImpl: connectors.startTunnelImpl,
        fetchImpl: okPing(),
        sleepImpl: sleep.sleepImpl,
        heartbeatEveryNPings: 2,
      },
    })

    await waitFor(() => api.heartbeats.length === 1)
    await sleep.releaseNext() // ping 1
    await sleep.releaseNext() // ping 2 → heartbeat
    await waitFor(() => api.heartbeats.length === 2)
    await sleep.releaseNext() // ping 3
    await sleep.releaseNext() // ping 4 → heartbeat
    await waitFor(() => api.heartbeats.length === 3)

    supervisor.stop()
  })

  test("tolerates isolated ping failures without restarting", async () => {
    const sleep = createManualSleep()
    const connectors = createFakeConnectors()
    const api = createFakeApi()

    let failuresRemaining = 0
    const fetchImpl = (async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1
        throw new Error("530 transient blip")
      }
      return new Response("ok")
    }) as unknown as typeof fetch

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      deps: { startTunnelImpl: connectors.startTunnelImpl, fetchImpl, sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => api.heartbeats.length === 1)
    failuresRemaining = 2 // below the tolerance of 3
    await sleep.releaseNext() // ping 1 fails
    await sleep.releaseNext() // ping 2 fails
    await sleep.releaseNext() // ping 3 succeeds — counter resets
    await Bun.sleep(10)

    expect(connectors.startedCount()).toBe(1) // never restarted

    supervisor.stop()
  })

  test("sustained ping failure restarts the connector with backoff (same hostname)", async () => {
    const sleep = createManualSleep()
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const upEvents: string[] = []

    let failuresRemaining = 0
    const fetchImpl = (async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1
        throw new Error("tunnel gone")
      }
      return new Response("ok")
    }) as unknown as typeof fetch

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      onTunnelUp: (kind) => upEvents.push(kind),
      deps: { startTunnelImpl: connectors.startTunnelImpl, fetchImpl, sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => api.heartbeats.length === 1)
    failuresRemaining = 3 // meets the tolerance → declared dead
    await sleep.releaseNext() // ping 1 fails
    await sleep.releaseNext() // ping 2 fails
    await sleep.releaseNext() // ping 3 fails → restart cycle
    await sleep.releaseNext() // backoff sleep (1s)
    await waitFor(() => api.heartbeats.length === 2) // reconnect heartbeat

    expect(connectors.startedCount()).toBe(2)
    expect(connectors.stopped).toEqual([0]) // first connector was stopped
    expect(upEvents).toEqual(["started", "recovered"])
    expect(sleep.requestedMs).toContain(1_000)

    supervisor.stop()
  })

  test("repeated connector startup failures escalate the backoff", async () => {
    const sleep = createManualSleep()
    const api = createFakeApi()
    let attempts = 0
    const startTunnelImpl = async (): Promise<StartedShareTunnel> => {
      attempts += 1
      throw new Error(`no connector ${attempts}`)
    }

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      deps: { startTunnelImpl, fetchImpl: okPing(), sleepImpl: sleep.sleepImpl },
    })

    for (let index = 0; index < 5; index += 1) {
      await sleep.releaseNext()
    }
    await waitFor(() => sleep.requestedMs.length >= 5)
    expect(sleep.requestedMs.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 10_000, 30_000])

    supervisor.stop()
  })

  test("401 from the control plane stops supervision (machine revoked)", async () => {
    const sleep = createManualSleep()
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    api.failNext(new CloudApiError("Unauthorized", 401))
    const warnings: string[] = []

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      warn: (message) => warnings.push(message),
      deps: { startTunnelImpl: connectors.startTunnelImpl, fetchImpl: okPing(), sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => warnings.some((message) => message.includes("revoked")))
    await Bun.sleep(10)
    // No restarts were scheduled after the revocation.
    expect(sleep.requestedMs).toEqual([])
    expect(connectors.startedCount()).toBe(1)
    expect(connectors.stopped).toEqual([0])

    supervisor.stop()
  })

  test("heartbeat network hiccups are tolerated (retry next round)", async () => {
    const sleep = createManualSleep()
    const connectors = createFakeConnectors()
    const api = createFakeApi()
    const warnings: string[] = []

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      warn: (message) => warnings.push(message),
      deps: {
        startTunnelImpl: connectors.startTunnelImpl,
        fetchImpl: okPing(),
        sleepImpl: sleep.sleepImpl,
        heartbeatEveryNPings: 1,
      },
    })

    await waitFor(() => api.heartbeats.length === 1)
    api.failNext(new Error("control plane blip"))
    await sleep.releaseNext() // ping ok → heartbeat fails (tolerated)
    await waitFor(() => warnings.some((message) => message.includes("heartbeat failed")))
    await sleep.releaseNext() // ping ok → heartbeat retries fine
    await waitFor(() => api.heartbeats.length === 2)

    expect(connectors.startedCount()).toBe(1) // no restart for a CP blip

    supervisor.stop()
  })
})

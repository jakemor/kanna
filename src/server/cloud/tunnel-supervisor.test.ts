import { describe, expect, test } from "bun:test"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudTunnelUpdateRequest } from "../../shared/cloud-api"
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

function createFakeTunnels(urls: Array<string | null>) {
  const stopped: number[] = []
  let started = 0
  const startTunnelImpl = async (_localUrl: string): Promise<StartedShareTunnel> => {
    const index = started
    started += 1
    return {
      publicUrl: urls[Math.min(index, urls.length - 1)],
      stop: () => {
        stopped.push(index)
      },
    }
  }
  return { startTunnelImpl, stopped, startedCount: () => started }
}

function createFakeApi() {
  const updates: CloudTunnelUpdateRequest[] = []
  let failNextWith: Error | null = null
  const client: CloudApiClient = {
    controlUrl: "http://cp/api/cloud",
    async pair() {
      throw new Error("not used")
    },
    async updateTunnel(_token, update) {
      if (failNextWith) {
        const error = failNextWith
        failNextWith = null
        throw error
      }
      updates.push(update)
    },
    async markOffline() {},
    async removeMachine() {},
  }
  return {
    client,
    updates,
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

describe("tunnel supervisor", () => {
  test("defers registration until the public URL is actually reachable", async () => {
    const sleep = createManualSleep()
    const tunnels = createFakeTunnels(["https://one.trycloudflare.com"])
    const api = createFakeApi()

    let propagated = false
    const fetchImpl = (async () => {
      if (!propagated) {
        throw new Error("530: hostname not yet propagated")
      }
      return new Response("ok")
    }) as unknown as typeof fetch

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      deps: { startTunnelImpl: tunnels.startTunnelImpl, fetchImpl, sleepImpl: sleep.sleepImpl },
    })

    // Two failed preflight attempts — nothing registered yet.
    await sleep.releaseNext()
    await sleep.releaseNext()
    expect(api.updates.length).toBe(0)
    expect(supervisor.getCurrentUrl()).toBeNull()

    // Hostname propagates → next preflight succeeds → registration happens.
    propagated = true
    await sleep.releaseNext()
    await waitFor(() => api.updates.length === 1)
    expect(supervisor.getCurrentUrl()).toBe("https://one.trycloudflare.com")

    supervisor.stop()
  })

  test("registers the tunnel URL and reports it", async () => {
    const sleep = createManualSleep()
    const tunnels = createFakeTunnels(["https://one.trycloudflare.com"])
    const api = createFakeApi()
    const upEvents: string[] = []
    const urlChanges: Array<string | null> = []

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      onTunnelUp: (kind) => upEvents.push(kind),
      onTunnelUrlChange: (url) => urlChanges.push(url),
      deps: { startTunnelImpl: tunnels.startTunnelImpl, fetchImpl: okPing(), sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => api.updates.length === 1)
    expect(api.updates[0]).toEqual({ url: "https://one.trycloudflare.com", kind: "cloudflared-quick" })
    expect(supervisor.getCurrentUrl()).toBe("https://one.trycloudflare.com")
    expect(upEvents).toEqual(["started"])
    expect(urlChanges).toEqual(["https://one.trycloudflare.com"])

    supervisor.stop()
    expect(supervisor.getCurrentUrl()).toBeNull()
    expect(tunnels.stopped).toEqual([0])
  })

  test("heartbeats every Nth successful ping", async () => {
    const sleep = createManualSleep()
    const tunnels = createFakeTunnels(["https://one.trycloudflare.com"])
    const api = createFakeApi()

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      deps: {
        startTunnelImpl: tunnels.startTunnelImpl,
        fetchImpl: okPing(),
        sleepImpl: sleep.sleepImpl,
        heartbeatEveryNPings: 2,
      },
    })

    await waitFor(() => api.updates.length === 1)
    await sleep.releaseNext() // ping 1
    await sleep.releaseNext() // ping 2 → heartbeat
    await waitFor(() => api.updates.length === 2)
    await sleep.releaseNext() // ping 3
    await sleep.releaseNext() // ping 4 → heartbeat
    await waitFor(() => api.updates.length === 3)

    supervisor.stop()
  })

  test("tolerates isolated ping failures without restarting (tunnel propagation)", async () => {
    const sleep = createManualSleep()
    const tunnels = createFakeTunnels(["https://one.trycloudflare.com"])
    const api = createFakeApi()

    let failuresRemaining = 0 // preflight succeeds immediately
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
      deps: { startTunnelImpl: tunnels.startTunnelImpl, fetchImpl, sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => api.updates.length === 1)
    failuresRemaining = 2 // below the tolerance of 3
    await sleep.releaseNext() // ping 1 fails
    await sleep.releaseNext() // ping 2 fails
    await sleep.releaseNext() // ping 3 succeeds — counter resets
    await Bun.sleep(10)

    expect(tunnels.startedCount()).toBe(1) // never restarted
    expect(supervisor.getCurrentUrl()).toBe("https://one.trycloudflare.com")

    supervisor.stop()
  })

  test("sustained ping failure restarts the tunnel with backoff and re-registers the rotated URL", async () => {
    const sleep = createManualSleep()
    const tunnels = createFakeTunnels(["https://one.trycloudflare.com", "https://two.trycloudflare.com"])
    const api = createFakeApi()
    const upEvents: string[] = []
    const urlChanges: Array<string | null> = []

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
      onTunnelUrlChange: (url) => urlChanges.push(url),
      deps: { startTunnelImpl: tunnels.startTunnelImpl, fetchImpl, sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => api.updates.length === 1)
    failuresRemaining = 3 // meets the tolerance → declared dead
    await sleep.releaseNext() // ping 1 fails
    await sleep.releaseNext() // ping 2 fails
    await sleep.releaseNext() // ping 3 fails → restart cycle
    await sleep.releaseNext() // backoff sleep (1s)
    await waitFor(() => api.updates.length === 2)

    expect(api.updates[1].url).toBe("https://two.trycloudflare.com")
    expect(supervisor.getCurrentUrl()).toBe("https://two.trycloudflare.com")
    expect(upEvents).toEqual(["started", "recovered"])
    expect(urlChanges).toEqual([
      "https://one.trycloudflare.com",
      null,
      "https://two.trycloudflare.com",
    ])
    expect(tunnels.stopped).toEqual([0]) // first tunnel was stopped on failure
    // Backoff used the first restart delay.
    expect(sleep.requestedMs).toContain(1_000)

    supervisor.stop()
  })

  test("repeated startup failures escalate the backoff", async () => {
    const sleep = createManualSleep()
    const api = createFakeApi()
    let attempts = 0
    const startTunnelImpl = async (): Promise<StartedShareTunnel> => {
      attempts += 1
      throw new Error(`no tunnel ${attempts}`)
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
    const tunnels = createFakeTunnels(["https://one.trycloudflare.com"])
    const api = createFakeApi()
    api.failNext(new CloudApiError("Unauthorized", 401))
    const warnings: string[] = []

    const supervisor = startCloudTunnelSupervisor({
      localUrl: "http://localhost:3210",
      identity: IDENTITY,
      apiClient: api.client,
      warn: (message) => warnings.push(message),
      deps: { startTunnelImpl: tunnels.startTunnelImpl, fetchImpl: okPing(), sleepImpl: sleep.sleepImpl },
    })

    await waitFor(() => warnings.some((message) => message.includes("revoked")))
    await Bun.sleep(10)
    // No restarts were scheduled after the revocation.
    expect(sleep.requestedMs).toEqual([])
    expect(tunnels.startedCount()).toBe(1)
    expect(supervisor.getCurrentUrl()).toBeNull()

    supervisor.stop()
  })
})

/**
 * Stall recovery for the cloud tunnel supervisor (Oct 25 2026 incident: the
 * machine sat "offline" for 1h51m after `connection down … restarting in 1s`
 * because a step of the restart never settled). Each test hands the
 * supervisor a step that hangs and asserts it still reaches `cloud: connected`
 * again within a bounded time, with at most one connector alive at once.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_CLOUD_CONTROL_URL, type CloudHeartbeatRequest } from "../../shared/cloud-api"
import type { StartedShareTunnel } from "../share"
import type { CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { startCloudTunnelSupervisor, type TunnelSupervisorDeps } from "./tunnel-supervisor"

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

/** Small real deadlines so a stalled step is cut off within the test. */
const FAST_DEADLINES: TunnelSupervisorDeps = {
  heartbeatTimeoutMs: 40,
  tunnelReadyTimeoutMs: 40,
  watchdogMs: 60_000,
}

async function waitFor(condition: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out")
    }
    await Bun.sleep(2)
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Virtual-time sleep: the test advances it with `pumpUntil`, which releases
 * one pending sleep at a time until a condition holds.
 */
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
    async pumpUntil(condition: () => boolean, timeoutMs = 1_500) {
      const deadline = Date.now() + timeoutMs
      while (!condition()) {
        if (Date.now() > deadline) throw new Error("pumpUntil timed out")
        waiting.shift()?.resolve()
        await Bun.sleep(3)
      }
    },
  }
}

type StartBehavior = "ok" | "fail" | "hang" | "hang-ignoring-signal"

/**
 * Fake connectors that track which processes are alive. "hang" never becomes
 * ready but stops its process when the start signal aborts (as share.ts does);
 * "hang-ignoring-signal" can be resolved late by the test.
 */
function createConnectors() {
  const live = new Set<number>()
  const stopped: number[] = []
  const exits = new Map<number, () => void>()
  const lateResolvers = new Map<number, () => void>()
  const startSignals: Array<AbortSignal | undefined> = []
  const plan: StartBehavior[] = []
  let started = 0
  let maxLive = 0

  const markLive = (index: number) => {
    live.add(index)
    maxLive = Math.max(maxLive, live.size)
  }

  const startTunnelImpl = (_localUrl: string, _token: string, signal?: AbortSignal): Promise<StartedShareTunnel> => {
    const index = started
    started += 1
    startSignals.push(signal)
    const behavior = plan.shift() ?? "ok"
    if (behavior === "fail") return Promise.reject(new Error("connector failed to start"))

    markLive(index)
    const exit = deferred()
    exits.set(index, () => {
      live.delete(index)
      exit.resolve()
    })
    const tunnel: StartedShareTunnel = {
      publicUrl: null,
      stop: () => {
        stopped.push(index)
        live.delete(index)
        exit.resolve()
      },
      exited: exit.promise,
    }

    if (behavior === "ok") return Promise.resolve(tunnel)
    return new Promise<StartedShareTunnel>((resolve, reject) => {
      lateResolvers.set(index, () => resolve(tunnel))
      if (behavior === "hang" && signal) {
        signal.addEventListener("abort", () => {
          live.delete(index)
          reject(signal.reason)
        }, { once: true })
      }
    })
  }

  return {
    startTunnelImpl,
    live,
    stopped,
    startSignals,
    plan,
    startedCount: () => started,
    maxLive: () => maxLive,
    /** The connector process dies on its own. */
    exit(index: number) {
      exits.get(index)?.()
    },
    /** A start that had been abandoned finally reports ready. */
    resolveLate(index: number) {
      lateResolvers.get(index)?.()
    },
  }
}

type HeartbeatBehavior = "ok" | "fail" | "hang"

/** "hang" never settles and ignores any abort signal, like a wedged socket. */
function createApi() {
  const heartbeats: CloudHeartbeatRequest[] = []
  const signals: Array<AbortSignal | undefined> = []
  const plan: HeartbeatBehavior[] = []
  let calls = 0
  let fallback: HeartbeatBehavior = "ok"
  const client: CloudApiClient = {
    controlUrl: "http://cp/api/cloud",
    async pair() {
      throw new Error("not used")
    },
    async requestDeviceCode() {
      throw new Error("not used")
    },
    async pollDeviceCode() {
      throw new Error("not used")
    },
    heartbeat(_token, update, options?: { signal?: AbortSignal }) {
      calls += 1
      signals.push(options?.signal)
      const behavior = plan.shift() ?? fallback
      if (behavior === "hang") return new Promise<void>(() => {})
      if (behavior === "fail") return Promise.reject(new Error("control plane returned 500"))
      heartbeats.push(update)
      return Promise.resolve()
    },
    async markOffline() {},
    async removeMachine() {},
  }
  return {
    client,
    heartbeats,
    signals,
    plan,
    calls: () => calls,
    setFallback(behavior: HeartbeatBehavior) {
      fallback = behavior
    },
  }
}

function createPing() {
  let failuresRemaining = 0
  const fetchImpl = (async () => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      throw new Error("The operation timed out.")
    }
    return new Response("ok")
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    failNext(count: number) {
      failuresRemaining = count
    },
  }
}

interface Plans {
  connectors?: StartBehavior[]
  heartbeats?: HeartbeatBehavior[]
}

function startSupervisor(extraDeps: TunnelSupervisorDeps = {}, plans: Plans = {}) {
  const sleep = createManualSleep()
  const connectors = createConnectors()
  const api = createApi()
  const ping = createPing()
  // The first connector start happens synchronously inside startCloudTunnelSupervisor.
  connectors.plan.push(...(plans.connectors ?? []))
  api.plan.push(...(plans.heartbeats ?? []))
  const logs: string[] = []
  const ups: string[] = []
  const supervisor = startCloudTunnelSupervisor({
    localUrl: "http://localhost:3210",
    identity: IDENTITY,
    apiClient: api.client,
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    onTunnelUp: (kind) => ups.push(kind),
    deps: {
      startTunnelImpl: connectors.startTunnelImpl,
      fetchImpl: ping.fetchImpl,
      sleepImpl: sleep.sleepImpl,
      ...FAST_DEADLINES,
      ...extraDeps,
    },
  })
  const connectedCount = () => logs.filter((line) => line.includes("cloud: connected")).length
  return { supervisor, sleep, connectors, api, ping, logs, ups, connectedCount }
}

describe("tunnel supervisor stall recovery", () => {
  test("a startup heartbeat that never settles is cut off and the supervisor reconnects", async () => {
    const run = startSupervisor({}, { heartbeats: ["hang"] })

    await run.sleep.pumpUntil(() => run.connectedCount() === 1)

    expect(run.connectors.startedCount()).toBe(2)
    expect(run.connectors.stopped).toContain(0)
    expect(run.connectors.maxLive()).toBe(1)
    expect(run.logs.some((line) => /heartbeat failed after .*: control plane never answered/.test(line))).toBe(true)
    expect(run.ups).toEqual(["started"])
    run.supervisor.stop()
    expect(run.connectors.live.size).toBe(0)
  })

  test("a steady-state heartbeat that never settles times out and monitoring continues", async () => {
    const run = startSupervisor({ heartbeatEveryNPings: 1 })
    await waitFor(() => run.connectedCount() === 1)

    run.api.plan.push("hang")
    await run.sleep.pumpUntil(() => run.api.calls() === 2)
    // The hung heartbeat must not stop the loop: the next round heartbeats again.
    await run.sleep.pumpUntil(() => run.api.heartbeats.length === 2)

    expect(run.logs.some((line) => /heartbeat failed after .*: control plane never answered/.test(line))).toBe(true)
    expect(run.connectors.startedCount()).toBe(1) // a control-plane stall alone does not restart the tunnel
    run.supervisor.stop()
  })

  test("readiness that never arrives is cut off, its process stopped, and startup retried", async () => {
    const run = startSupervisor({}, { connectors: ["hang"] })

    await run.sleep.pumpUntil(() => run.connectedCount() === 1)

    expect(run.connectors.startedCount()).toBe(2)
    expect(run.connectors.startSignals[0]?.aborted).toBe(true)
    expect(run.connectors.maxLive()).toBe(1)
    expect(run.logs.some((line) => /not ready after/.test(line))).toBe(true)
    run.supervisor.stop()
    expect(run.connectors.live.size).toBe(0)
  })

  test("a connector that reports ready after it was abandoned is stopped, not leaked", async () => {
    const run = startSupervisor({}, { connectors: ["hang-ignoring-signal"] })

    await run.sleep.pumpUntil(() => run.connectedCount() === 1)
    run.connectors.resolveLate(0)
    await waitFor(() => run.connectors.stopped.includes(0))

    expect(run.connectors.live).toEqual(new Set([1]))
    run.supervisor.stop()
    expect(run.connectors.live.size).toBe(0)
  })

  test("the connector exiting while the startup heartbeat is pending triggers a restart", async () => {
    const run = startSupervisor({ heartbeatTimeoutMs: 60_000 }, { heartbeats: ["hang"] })

    await waitFor(() => run.api.calls() === 1)
    run.connectors.exit(0)
    await run.sleep.pumpUntil(() => run.connectedCount() === 1)

    expect(run.connectors.startedCount()).toBe(2)
    expect(run.logs.some((line) => line.includes("connector exited"))).toBe(true)
    expect(run.connectors.maxLive()).toBe(1)
    run.supervisor.stop()
  })

  test("the connector exiting during steady state restarts it without waiting for ping failures", async () => {
    const run = startSupervisor()
    await waitFor(() => run.connectedCount() === 1)
    await waitFor(() => run.sleep.pendingCount() === 1) // idle in the ping interval

    run.connectors.exit(0)
    await run.sleep.pumpUntil(() => run.connectedCount() === 2)

    expect(run.connectors.startedCount()).toBe(2)
    expect(run.ups).toEqual(["started", "recovered"])
    run.supervisor.stop()
  })

  test("incident replay: 3 failed self-pings → restart → hung heartbeat still reconnects", async () => {
    const run = startSupervisor()
    await waitFor(() => run.connectedCount() === 1)

    run.ping.failNext(3)
    run.api.plan.push("hang") // the restart's startup heartbeat wedges
    await run.sleep.pumpUntil(() => run.connectedCount() === 2)

    expect(run.logs.filter((line) => line.includes("self-ping failed")).length).toBe(2)
    expect(run.logs.some((line) => line.includes("connection down"))).toBe(true)
    expect(run.connectors.startedCount()).toBe(3)
    expect(run.connectors.maxLive()).toBe(1)
    expect(run.ups).toEqual(["started", "recovered"])
    run.supervisor.stop()
    expect(run.connectors.live.size).toBe(0)
  })
})

describe("tunnel supervisor watchdog", () => {
  test("no heartbeat completing within the watchdog window forces a full restart", async () => {
    const run = startSupervisor({ heartbeatEveryNPings: 1, watchdogMs: 80 })
    await waitFor(() => run.connectedCount() === 1)

    // Pings stay healthy but every later heartbeat fails, so nothing restarts
    // the attempt except the watchdog.
    run.api.setFallback("fail")
    await waitFor(() => run.logs.some((line) => line.includes("watchdog")), 2_000)
    run.api.setFallback("ok")
    await run.sleep.pumpUntil(() => run.connectedCount() === 2)

    expect(run.connectors.stopped).toContain(0)
    expect(run.connectors.maxLive()).toBe(1)
    run.supervisor.stop()
  })

  test("the watchdog cuts off a step that ignores every other deadline", async () => {
    // Heartbeat deadline far longer than the watchdog: only the watchdog can act.
    const run = startSupervisor({ heartbeatTimeoutMs: 60_000, watchdogMs: 80 }, { heartbeats: ["hang"] })

    await run.sleep.pumpUntil(() => run.connectedCount() === 1, 2_000)

    expect(run.logs.some((line) => line.includes("watchdog"))).toBe(true)
    expect(run.connectors.startedCount()).toBe(2)
    run.supervisor.stop()
  })
})

describe("tunnel supervisor shutdown", () => {
  test("stop() during a pending startup heartbeat aborts it and never reports connected", async () => {
    const run = startSupervisor({ heartbeatTimeoutMs: 60_000 }, { heartbeats: ["hang"] })
    await waitFor(() => run.api.calls() === 1)

    run.supervisor.stop()
    await Bun.sleep(20)

    expect(run.api.signals[0]?.aborted).toBe(true)
    expect(run.connectors.live.size).toBe(0)
    expect(run.connectedCount()).toBe(0)
    expect(run.ups).toEqual([])
    expect(run.connectors.startedCount()).toBe(1)
  })

  test("stop() during a pending connector start aborts it and starts nothing else", async () => {
    const run = startSupervisor({ tunnelReadyTimeoutMs: 60_000 }, { connectors: ["hang-ignoring-signal"] })
    await waitFor(() => run.connectors.startedCount() === 1)

    run.supervisor.stop()
    expect(run.connectors.startSignals[0]?.aborted).toBe(true)
    run.connectors.resolveLate(0) // readiness lands after shutdown
    await waitFor(() => run.connectors.stopped.includes(0))
    await Bun.sleep(20)

    expect(run.connectors.live.size).toBe(0)
    expect(run.api.calls()).toBe(0)
    expect(run.connectors.startedCount()).toBe(1)
  })

  test("stop() while monitoring stops the connector and leaves no timers behind", async () => {
    const run = startSupervisor({ watchdogMs: 30 })
    await waitFor(() => run.connectedCount() === 1)

    run.supervisor.stop()
    await Bun.sleep(80) // past the watchdog window

    expect(run.connectors.live.size).toBe(0)
    expect(run.logs.some((line) => line.includes("watchdog"))).toBe(false)
    expect(run.connectors.startedCount()).toBe(1)
  })
})

describe("tunnel supervisor restarts", () => {
  test("restarts of every kind keep exactly one connector alive and one loop running", async () => {
    const run = startSupervisor({ heartbeatEveryNPings: 1, watchdogMs: 150 })
    await waitFor(() => run.connectedCount() === 1)

    run.connectors.exit(0) // process death
    await run.sleep.pumpUntil(() => run.connectedCount() === 2)
    run.ping.failNext(3) // tunnel unreachable
    await run.sleep.pumpUntil(() => run.connectedCount() === 3)
    run.api.setFallback("fail") // control plane stale → watchdog
    await waitFor(() => run.logs.some((line) => line.includes("watchdog")), 2_000)
    run.api.setFallback("ok")
    await run.sleep.pumpUntil(() => run.connectedCount() === 4)

    expect(run.connectors.startedCount()).toBe(4)
    expect(run.connectors.maxLive()).toBe(1)
    expect(run.connectors.live).toEqual(new Set([3]))
    // One loop: only the current attempt is ever waiting on a sleep.
    expect(run.sleep.pendingCount()).toBeLessThanOrEqual(1)
    run.supervisor.stop()
    expect(run.connectors.live.size).toBe(0)
  })
})

describe("tunnel supervisor heartbeat scheduling", () => {
  test("a due heartbeat waits for a successful self-ping", async () => {
    const run = startSupervisor({ heartbeatEveryNPings: 2 })
    await waitFor(() => run.connectedCount() === 1)

    await run.sleep.pumpUntil(() => run.sleep.requestedMs.length === 2) // round 1 ok
    run.ping.failNext(1)
    await run.sleep.pumpUntil(() => run.sleep.requestedMs.length === 3) // round 2 fails: due, not sent
    expect(run.api.calls()).toBe(1)
    await run.sleep.pumpUntil(() => run.api.calls() === 2) // round 3 ok → sent

    expect(run.sleep.requestedMs.length).toBe(4)
    run.supervisor.stop()
  })

  test("a failed due heartbeat is retried on the next round, not a full cadence later", async () => {
    const run = startSupervisor({ heartbeatEveryNPings: 4 })
    await waitFor(() => run.connectedCount() === 1)

    run.api.plan.push("fail")
    await run.sleep.pumpUntil(() => run.api.calls() === 2) // round 4: fails
    const roundsAtFailure = run.sleep.requestedMs.length
    await run.sleep.pumpUntil(() => run.api.heartbeats.length === 2)

    expect(run.sleep.requestedMs.length).toBe(roundsAtFailure + 1)
    run.supervisor.stop()
  })

  test("log lines carry a timestamp and the age of the last good heartbeat", async () => {
    const run = startSupervisor({ heartbeatEveryNPings: 1 })
    await waitFor(() => run.connectedCount() === 1)
    run.api.plan.push("fail")
    await run.sleep.pumpUntil(() => run.api.calls() === 2)

    expect(run.logs.every((line) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d cloud: /.test(line))).toBe(true)
    expect(run.logs.some((line) => /heartbeat failed after .*\(last ok .* ago\)/.test(line))).toBe(true)
    expect(run.logs.some((line) => line.includes("machine-token") || line.includes("connector-token"))).toBe(false)
    run.supervisor.stop()
  })
})

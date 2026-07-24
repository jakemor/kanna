/**
 * Keeps the machine reachable over its named Cloudflare tunnel: runs the
 * connector (token-scoped to this machine's tunnel), heartbeats the control
 * plane so the dashboard/proxy know it's alive, self-pings through the
 * permanent public hostname, and restarts the connector with backoff on
 * sustained failure. The hostname never changes, so there is no URL
 * registration, rotation handling, or propagation wait.
 *
 * Fully DI'd (tunnel, fetch, sleep) so tests drive it deterministically.
 */

import { startShareTunnel, type StartedShareTunnel } from "../share"
import type { CloudApiClient } from "./api-client"
import { CloudApiError } from "./api-client"
import type { CloudIdentity } from "./identity"

const PING_INTERVAL_MS = 30_000
const PING_TIMEOUT_MS = 10_000
/** Heartbeat the control plane every Nth successful ping (~2 min). */
const HEARTBEAT_EVERY_N_PINGS = 4
/**
 * Consecutive self-ping failures before the connector is declared dead and
 * restarted — tolerates transient edge blips without churning the connector.
 */
const PING_FAILURE_TOLERANCE = 3
/**
 * For the first minute of a failure streak, retry every second — the common
 * failure (laptop wake, network flap, edge blip) clears in seconds and should
 * recover as fast as possible. Only a sustained outage earns the backoff.
 */
const FAST_RETRY_WINDOW_MS = 60_000
const FAST_RETRY_DELAY_MS = 1_000
const RESTART_BACKOFF_MS = [2_000, 4_000, 10_000]
const RESTART_BACKOFF_MAX_MS = 30_000

export interface CloudTunnelSupervisor {
  stop(): void
}

export interface TunnelSupervisorDeps {
  startTunnelImpl?: (localUrl: string, tunnelToken: string) => Promise<StartedShareTunnel>
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>
  nowImpl?: () => number
  pingIntervalMs?: number
  heartbeatEveryNPings?: number
}

export interface TunnelSupervisorArgs {
  localUrl: string
  identity: CloudIdentity
  apiClient: CloudApiClient
  log?: (message: string) => void
  warn?: (message: string) => void
  /** Fired once when the connector first comes up, then on each recovery. */
  onTunnelUp?: (kind: "started" | "recovered") => void
  deps?: TunnelSupervisorDeps
}

export function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function restartDelayMs(msIntoFailureStreak: number, failuresPastFastWindow: number) {
  // Inside the fast window: always 1s. Past it (failuresPastFastWindow is
  // 1-based): 1 → 2s, 2 → 4s, 3 → 10s, 4+ → 30s.
  if (msIntoFailureStreak < FAST_RETRY_WINDOW_MS) return FAST_RETRY_DELAY_MS
  return RESTART_BACKOFF_MS[failuresPastFastWindow - 1] ?? RESTART_BACKOFF_MAX_MS
}

export function startCloudTunnelSupervisor(args: TunnelSupervisorArgs): CloudTunnelSupervisor {
  const log = args.log ?? (() => {})
  const warn = args.warn ?? log
  const fetchImpl = args.deps?.fetchImpl ?? fetch
  const sleepImpl = args.deps?.sleepImpl ?? defaultSleep
  const nowImpl = args.deps?.nowImpl ?? Date.now
  const startTunnelImpl = args.deps?.startTunnelImpl
    ?? ((localUrl: string, tunnelToken: string) =>
      startShareTunnel(localUrl, { kind: "token", token: tunnelToken }, { log }))
  const pingIntervalMs = args.deps?.pingIntervalMs ?? PING_INTERVAL_MS
  const heartbeatEveryNPings = args.deps?.heartbeatEveryNPings ?? HEARTBEAT_EVERY_N_PINGS

  const publicUrl = `https://${args.identity.tunnelHost}`
  let stopped = false
  let activeTunnel: StartedShareTunnel | null = null
  let hasEverConnected = false
  /** Wall-clock start of the current failure streak (null while healthy). */
  let failureStreakStartedAt: number | null = null
  let failuresPastFastWindow = 0
  const abortController = new AbortController()

  async function pingPublicHealth() {
    const response = await fetchImpl(`${publicUrl}/health`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`public /health returned ${response.status}`)
    }
  }

  async function sendHeartbeat() {
    await args.apiClient.heartbeat(args.identity.machineToken, { localUrl: args.localUrl })
  }

  async function runOnce() {
    // Named tunnel: resolves once the connector reports "connected".
    const tunnel = await startTunnelImpl(args.localUrl, args.identity.tunnelToken)
    activeTunnel = tunnel
    try {
      // Announce liveness immediately — the hostname is permanent, so the
      // machine is reachable the moment the connector is up.
      await sendHeartbeat()
      args.onTunnelUp?.(hasEverConnected ? "recovered" : "started")
      hasEverConnected = true
      failureStreakStartedAt = null
      failuresPastFastWindow = 0
      log(`cloud: connected (${args.identity.appOrigin})`)

      let pingCount = 0
      let consecutivePingFailures = 0
      while (!stopped) {
        await sleepImpl(pingIntervalMs, abortController.signal)
        if (stopped) return

        try {
          await pingPublicHealth()
          consecutivePingFailures = 0
        } catch (error) {
          consecutivePingFailures += 1
          if (consecutivePingFailures >= PING_FAILURE_TOLERANCE) {
            throw error
          }
          warn(`cloud: self-ping failed (${consecutivePingFailures}/${PING_FAILURE_TOLERANCE})`)
          continue
        }
        pingCount += 1

        if (pingCount % heartbeatEveryNPings === 0) {
          try {
            await sendHeartbeat()
          } catch (error) {
            if (error instanceof CloudApiError && error.status === 401) {
              throw error
            }
            // Control plane hiccup while the tunnel itself is healthy — the
            // next heartbeat retries; worst case the proxy shows "offline"
            // until then.
            warn(`cloud: heartbeat failed (${error instanceof Error ? error.message : String(error)})`)
          }
        }
      }
    } finally {
      activeTunnel = null
      tunnel.stop()
    }
  }

  async function supervise() {
    while (!stopped) {
      try {
        await runOnce()
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 401) {
          warn("cloud: this machine was revoked on kanna.sh — run `kanna pair` again (or `kanna pair --disable` to silence this)")
          return
        }
        if (stopped) return
        const now = nowImpl()
        failureStreakStartedAt ??= now
        const msIntoStreak = now - failureStreakStartedAt
        if (msIntoStreak >= FAST_RETRY_WINDOW_MS) failuresPastFastWindow += 1
        const delay = restartDelayMs(msIntoStreak, failuresPastFastWindow)
        warn(`cloud: connection down (${error instanceof Error ? error.message : String(error)}) — restarting in ${Math.round(delay / 1000)}s`)
        await sleepImpl(delay, abortController.signal)
      }
    }
  }

  void supervise()

  return {
    stop() {
      if (stopped) return
      stopped = true
      abortController.abort()
      activeTunnel?.stop()
      activeTunnel = null
    },
  }
}

/**
 * Keeps the machine reachable: runs a cloudflared quick tunnel, registers its
 * (rotating) URL with the control plane, self-pings through the public URL,
 * and heartbeats so `last_seen_at` stays fresh. On any failure it restarts
 * the tunnel with backoff and re-registers the new URL.
 *
 * Fully DI'd (tunnel, fetch, sleep) so tests drive it deterministically.
 */

import { startShareTunnel, type StartedShareTunnel } from "../share"
import type { CloudApiClient } from "./api-client"
import { CloudApiError } from "./api-client"
import type { CloudIdentity } from "./identity"

export const TUNNEL_KIND_QUICK = "cloudflared-quick"

const PING_INTERVAL_MS = 30_000
const PING_TIMEOUT_MS = 10_000
/** Re-register every Nth successful ping (~2 min) as a heartbeat. */
const HEARTBEAT_EVERY_N_PINGS = 4
/**
 * Consecutive self-ping failures before the tunnel is declared dead and
 * restarted. Fresh trycloudflare hostnames can 530 at the edge for a while
 * before they propagate — restarting on the first failure would mint a new
 * hostname and start the propagation wait over again.
 */
const PING_FAILURE_TOLERANCE = 3
/**
 * Before registering a fresh tunnel URL with the control plane, poll its
 * public /health until it actually serves. Advertising the hostname before
 * it propagates makes the proxy (and its colo's DNS negative cache) resolve
 * a name that doesn't exist yet — visitors then sit on the offline page far
 * longer than the propagation itself.
 */
const PREFLIGHT_INTERVAL_MS = 2_000
const PREFLIGHT_MAX_ATTEMPTS = 45 // ~90s, then restart with a new hostname
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 10_000]
const RESTART_BACKOFF_MAX_MS = 30_000

export interface CloudTunnelSupervisor {
  getCurrentUrl(): string | null
  stop(): void
}

export interface TunnelSupervisorDeps {
  startTunnelImpl?: (localUrl: string) => Promise<StartedShareTunnel>
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>
  pingIntervalMs?: number
  heartbeatEveryNPings?: number
}

export interface TunnelSupervisorArgs {
  localUrl: string
  identity: CloudIdentity
  apiClient: CloudApiClient
  log?: (message: string) => void
  warn?: (message: string) => void
  /** Fired with the public URL after each successful registration, and null when the tunnel drops. */
  onTunnelUrlChange?: (url: string | null) => void
  /** Fired once on the first successful registration, then on each recovery. */
  onTunnelUp?: (kind: "started" | "recovered") => void
  deps?: TunnelSupervisorDeps
}

function defaultSleep(ms: number, signal: AbortSignal) {
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

export function restartDelayMs(failureCount: number) {
  // failureCount is 1-based: 1 → 1s, 2 → 2s, 3 → 4s, 4 → 10s, 5+ → 30s.
  return RESTART_BACKOFF_MS[failureCount - 1] ?? RESTART_BACKOFF_MAX_MS
}

export function startCloudTunnelSupervisor(args: TunnelSupervisorArgs): CloudTunnelSupervisor {
  const log = args.log ?? (() => {})
  const warn = args.warn ?? log
  const fetchImpl = args.deps?.fetchImpl ?? fetch
  const sleepImpl = args.deps?.sleepImpl ?? defaultSleep
  const startTunnelImpl = args.deps?.startTunnelImpl
    ?? ((localUrl: string) => startShareTunnel(localUrl, "quick", { log }))
  const pingIntervalMs = args.deps?.pingIntervalMs ?? PING_INTERVAL_MS
  const heartbeatEveryNPings = args.deps?.heartbeatEveryNPings ?? HEARTBEAT_EVERY_N_PINGS

  let stopped = false
  let currentUrl: string | null = null
  let activeTunnel: StartedShareTunnel | null = null
  let hasEverRegistered = false
  const abortController = new AbortController()

  function setCurrentUrl(url: string | null) {
    if (currentUrl === url) return
    currentUrl = url
    args.onTunnelUrlChange?.(url)
  }

  async function pingPublicHealth(publicUrl: string) {
    const response = await fetchImpl(`${publicUrl}/health`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`public /health returned ${response.status}`)
    }
  }

  async function runOnce() {
    const tunnel = await startTunnelImpl(args.localUrl)
    activeTunnel = tunnel
    try {
      if (!tunnel.publicUrl) {
        throw new Error("quick tunnel started without a public URL")
      }
      const publicUrl = tunnel.publicUrl.replace(/\/$/, "")

      // Preflight: only advertise the URL once it demonstrably serves.
      log(`cloud: waiting for ${publicUrl} to become reachable`)
      let reachable = false
      for (let attempt = 0; attempt < PREFLIGHT_MAX_ATTEMPTS && !stopped; attempt += 1) {
        try {
          await pingPublicHealth(publicUrl)
          reachable = true
          break
        } catch {
          await sleepImpl(PREFLIGHT_INTERVAL_MS, abortController.signal)
        }
      }
      if (stopped) return
      if (!reachable) {
        throw new Error("tunnel never became publicly reachable")
      }

      await args.apiClient.updateTunnel(args.identity.machineToken, {
        url: publicUrl,
        kind: TUNNEL_KIND_QUICK,
      })
      setCurrentUrl(publicUrl)
      args.onTunnelUp?.(hasEverRegistered ? "recovered" : "started")
      hasEverRegistered = true
      log(`cloud: tunnel registered (${publicUrl})`)

      let pingCount = 0
      let consecutivePingFailures = 0
      while (!stopped) {
        await sleepImpl(pingIntervalMs, abortController.signal)
        if (stopped) return

        try {
          await pingPublicHealth(publicUrl)
          consecutivePingFailures = 0
        } catch (error) {
          consecutivePingFailures += 1
          if (consecutivePingFailures >= PING_FAILURE_TOLERANCE) {
            throw error
          }
          warn(`cloud: self-ping failed (${consecutivePingFailures}/${PING_FAILURE_TOLERANCE}) — tunnel may still be propagating`)
          continue
        }
        pingCount += 1

        if (pingCount % heartbeatEveryNPings === 0) {
          try {
            await args.apiClient.updateTunnel(args.identity.machineToken, {
              url: publicUrl,
              kind: TUNNEL_KIND_QUICK,
            })
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
    let consecutiveFailures = 0
    while (!stopped) {
      try {
        await runOnce()
        consecutiveFailures = 0
      } catch (error) {
        setCurrentUrl(null)
        if (error instanceof CloudApiError && error.status === 401) {
          warn("cloud: this machine was revoked on kanna.sh — run `kanna pair` again (or `kanna pair --disable` to silence this)")
          return
        }
        if (stopped) return
        consecutiveFailures += 1
        const delay = restartDelayMs(consecutiveFailures)
        warn(`cloud: tunnel down (${error instanceof Error ? error.message : String(error)}) — restarting in ${Math.round(delay / 1000)}s`)
        await sleepImpl(delay, abortController.signal)
      }
    }
    setCurrentUrl(null)
  }

  void supervise()

  return {
    getCurrentUrl: () => currentUrl,
    stop() {
      if (stopped) return
      stopped = true
      abortController.abort()
      activeTunnel?.stop()
      activeTunnel = null
      setCurrentUrl(null)
    },
  }
}

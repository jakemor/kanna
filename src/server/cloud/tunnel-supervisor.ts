/**
 * Keeps the machine reachable over its named Cloudflare tunnel: runs the
 * connector (token-scoped to this machine's tunnel), heartbeats the control
 * plane so the dashboard/proxy know it's alive, self-pings through the
 * permanent public hostname, and restarts the connector with backoff on
 * sustained failure. The hostname never changes, so there is no URL
 * registration, rotation handling, or propagation wait.
 *
 * Every await inside an attempt is bounded and cancellable. On Oct 25 2026 a
 * restart's startup heartbeat never settled, and because nothing raced it the
 * supervisor sat silent for ~2h while the cloud showed the machine offline.
 * Now each step has a deadline, the connector's exit and stop() abort the
 * attempt from anywhere, and a watchdog tears it down if no heartbeat has
 * landed for HEARTBEAT_WATCHDOG_MS, whatever it is stuck on.
 *
 * Fully DI'd (tunnel, fetch, sleep) so tests drive it deterministically.
 */

import {
  isBelowCloudflaredMinimum,
  minimumCloudflaredVersion,
  onCloudflaredInstalled,
  type CloudflaredInstalledEvent,
} from "../cloudflared-updater"
import { startShareTunnel, type StartedShareTunnel } from "../share"
import type { CloudApiClient } from "./api-client"
import { CloudApiError, CONTROL_PLANE_REQUEST_TIMEOUT_MS } from "./api-client"
import type { CloudIdentity } from "./identity"

const PING_INTERVAL_MS = 30_000
const PING_TIMEOUT_MS = 10_000
/** Heartbeat the control plane every Nth ping round (~2 min). */
const HEARTBEAT_EVERY_N_PINGS = 4
/**
 * Consecutive self-ping failures before the connector is declared dead and
 * restarted — tolerates transient edge blips without churning the connector.
 */
const PING_FAILURE_TOLERANCE = 3
/**
 * cloudflared registers its first edge connection within a few seconds on a
 * working network. A connector that hasn't in a minute is retried from
 * scratch rather than waited on.
 */
const TUNNEL_READY_TIMEOUT_MS = 60_000
/**
 * The API client aborts a heartbeat at CONTROL_PLANE_REQUEST_TIMEOUT_MS. This
 * backstop, a second later, settles it even if fetch never honours the abort.
 */
const HEARTBEAT_DEADLINE_MS = CONTROL_PLANE_REQUEST_TIMEOUT_MS + 1_000
/**
 * The cloud marks a machine offline once its heartbeat is 5 minutes old
 * (kanna-site src/worker/cloud/env.ts). If none has completed for 3, the
 * attempt is torn down and restarted, leaving two minutes for the restart to
 * land a fresh one before anyone sees "offline".
 */
const HEARTBEAT_WATCHDOG_MS = 3 * 60_000
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
  startTunnelImpl?: (localUrl: string, tunnelToken: string, signal: AbortSignal) => Promise<StartedShareTunnel>
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>
  nowImpl?: () => number
  pingIntervalMs?: number
  heartbeatEveryNPings?: number
  heartbeatTimeoutMs?: number
  tunnelReadyTimeoutMs?: number
  watchdogMs?: number
  /** Where verified cloudflared installs are announced (cloudflared-updater.ts). */
  subscribeCloudflaredInstalls?: (listener: (event: CloudflaredInstalledEvent) => void) => () => void
  platform?: NodeJS.Platform
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

/** Local wall-clock time for cloud log lines, e.g. `2026-10-25 21:10:40`. */
export function cloudLogStamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDuration(ms: number) {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1_000)}s`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs `work` with a signal that aborts at `ms` or when `parent` aborts, and
 * settles at that moment even if `work` ignores its signal: a wedged socket
 * can't hold the supervisor past the deadline. `timeoutMessage` names the
 * step, since every bare timeout otherwise reads "The operation timed out."
 */
async function withDeadline<T>(
  timeoutMessage: string,
  ms: number,
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parent.reason)
  parent.addEventListener("abort", onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), ms)
  try {
    return await new Promise<T>((resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
      let result: Promise<T>
      try {
        result = work(controller.signal)
      } catch (error) {
        reject(error)
        return
      }
      result.then(resolve, reject)
    })
  } finally {
    clearTimeout(timer)
    parent.removeEventListener("abort", onParentAbort)
  }
}

export function startCloudTunnelSupervisor(args: TunnelSupervisorArgs): CloudTunnelSupervisor {
  const rawLog = args.log ?? (() => {})
  const rawWarn = args.warn ?? rawLog
  const log = (message: string) => rawLog(`${cloudLogStamp()} ${message}`)
  const warn = (message: string) => rawWarn(`${cloudLogStamp()} ${message}`)
  const fetchImpl = args.deps?.fetchImpl ?? fetch
  const sleepImpl = args.deps?.sleepImpl ?? defaultSleep
  const nowImpl = args.deps?.nowImpl ?? Date.now
  const startTunnelImpl = args.deps?.startTunnelImpl
    ?? ((localUrl: string, tunnelToken: string, signal: AbortSignal) =>
      startShareTunnel(localUrl, { kind: "token", token: tunnelToken }, { log }, { signal }))
  const pingIntervalMs = args.deps?.pingIntervalMs ?? PING_INTERVAL_MS
  const heartbeatEveryNPings = args.deps?.heartbeatEveryNPings ?? HEARTBEAT_EVERY_N_PINGS
  const heartbeatTimeoutMs = args.deps?.heartbeatTimeoutMs ?? HEARTBEAT_DEADLINE_MS
  const tunnelReadyTimeoutMs = args.deps?.tunnelReadyTimeoutMs ?? TUNNEL_READY_TIMEOUT_MS
  const watchdogMs = args.deps?.watchdogMs ?? HEARTBEAT_WATCHDOG_MS

  const publicUrl = `https://${args.identity.tunnelHost}`
  let stopped = false
  /** Stops the current attempt's connector; null between attempts. */
  let stopActiveConnector: (() => void) | null = null
  let hasEverConnected = false
  let attemptCount = 0
  let lastHeartbeatOkAt: number | null = null
  /** What the current attempt is waiting on, for the watchdog's message. */
  let phase = "idle"
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  /** Wall-clock start of the current failure streak (null while healthy). */
  let failureStreakStartedAt: number | null = null
  let failuresPastFastWindow = 0
  const stopController = new AbortController()
  /** The live connector's cloudflared version and a way to end its attempt. */
  let activeConnector: { version: string | null; restart: (reason: Error) => void } | null = null
  const platform = args.deps?.platform ?? process.platform

  // The background updater swaps the binary on disk and the connector keeps
  // running the old one until its next natural start; an upgrade alone is
  // never worth dropping the machine's tunnel. The one exception is a
  // connector below the security minimum (it trusts the compromised eMudhra
  // intermediates). That one is restarted, but only after the updater has
  // verified and swapped in a patched binary, so the restart can't land on a
  // broken download. It costs a few seconds: the attempt ends, and the fast
  // retry window brings the connector back in about a second, with the
  // bounded start and watchdog above guarding against a restart that stalls.
  const unsubscribeInstalls = (args.deps?.subscribeCloudflaredInstalls ?? onCloudflaredInstalled)((event) => {
    const active = activeConnector
    if (!active || stopped) return
    if (!isBelowCloudflaredMinimum(active.version, platform)) return
    if (isBelowCloudflaredMinimum(event.version, platform)) return
    warn(`cloud: connector runs cloudflared ${active.version}, below the security minimum ${minimumCloudflaredVersion(platform)}; restarting it on the verified ${event.version}`)
    active.restart(new Error(`restarting onto patched cloudflared ${event.version}`))
  })

  function lastOkAge() {
    return lastHeartbeatOkAt === null ? "never" : `${formatDuration(nowImpl() - lastHeartbeatOkAt)} ago`
  }

  function clearWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = null
  }

  /** (Re)starts the countdown; called when an attempt begins and on each heartbeat. */
  function armWatchdog(attempt: AbortController) {
    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      attempt.abort(new Error(
        `watchdog: no heartbeat completed in ${formatDuration(watchdogMs)} (last ok ${lastOkAge()}; stuck ${phase})`,
      ))
    }, watchdogMs)
    watchdogTimer.unref?.()
  }

  async function pingPublicHealth(signal: AbortSignal) {
    await withDeadline(`self-ping timed out after ${formatDuration(PING_TIMEOUT_MS)}`, PING_TIMEOUT_MS, signal, async (pingSignal) => {
      const response = await fetchImpl(`${publicUrl}/health`, { signal: pingSignal })
      if (!response.ok) {
        throw new Error(`public /health returned ${response.status}`)
      }
    })
  }

  async function sendHeartbeat(attempt: AbortController) {
    const startedAt = nowImpl()
    try {
      await withDeadline("control plane never answered", heartbeatTimeoutMs, attempt.signal, (signal) =>
        args.apiClient.heartbeat(args.identity.machineToken, { localUrl: args.localUrl }, { signal }))
    } catch (error) {
      attempt.signal.throwIfAborted()
      warn(`cloud: heartbeat failed after ${formatDuration(nowImpl() - startedAt)}: ${errorMessage(error)} (last ok ${lastOkAge()})`)
      throw error
    }
    log(`cloud: heartbeat ok in ${formatDuration(nowImpl() - startedAt)} (previous ok ${lastOkAge()})`)
    lastHeartbeatOkAt = nowImpl()
    armWatchdog(attempt)
  }

  async function startConnector(attempt: AbortController) {
    let pending = null as Promise<StartedShareTunnel> | null
    const notReady = `connector not ready after ${formatDuration(tunnelReadyTimeoutMs)}`
    try {
      return await withDeadline(notReady, tunnelReadyTimeoutMs, attempt.signal, (signal) => {
        pending = startTunnelImpl(args.localUrl, args.identity.tunnelToken, signal)
        return pending
      })
    } catch (error) {
      // A start given up on (deadline, exit, stop) that reports ready anyway,
      // now or later, must not leave a second connector running.
      void pending?.then((late) => late.stop(), () => {})
      attempt.signal.throwIfAborted()
      throw error
    }
  }

  async function runOnce() {
    attemptCount += 1
    const attempt = new AbortController()
    const onStop = () => attempt.abort(new Error("supervisor stopped"))
    stopController.signal.addEventListener("abort", onStop, { once: true })
    armWatchdog(attempt)
    let tunnel: StartedShareTunnel | null = null
    let connectorStopped = false
    const stopConnector = () => {
      if (!tunnel || connectorStopped) return
      connectorStopped = true
      tunnel.stop()
    }

    try {
      phase = "starting connector"
      log(`cloud: starting connector (attempt ${attemptCount})`)
      const startedAt = nowImpl()
      // Named tunnel: resolves once the connector reports "connected".
      tunnel = await startConnector(attempt)
      stopActiveConnector = stopConnector
      if (stopped) return
      activeConnector = { version: tunnel.binaryVersion ?? null, restart: (reason) => attempt.abort(reason) }
      void tunnel.exited?.then(() => {
        if (!connectorStopped) attempt.abort(new Error("connector exited"))
      })
      log(`cloud: connector ready in ${formatDuration(nowImpl() - startedAt)}`)

      // Announce liveness immediately — the hostname is permanent, so the
      // machine is reachable the moment the connector is up.
      phase = "sending startup heartbeat"
      await sendHeartbeat(attempt)
      args.onTunnelUp?.(hasEverConnected ? "recovered" : "started")
      hasEverConnected = true
      failureStreakStartedAt = null
      failuresPastFastWindow = 0
      log(`cloud: connected (${args.identity.appOrigin})`)

      let roundsSinceHeartbeat = 0
      let consecutivePingFailures = 0
      while (!stopped) {
        phase = "waiting to self-ping"
        await sleepImpl(pingIntervalMs, attempt.signal)
        attempt.signal.throwIfAborted()
        roundsSinceHeartbeat += 1

        phase = "self-pinging"
        try {
          await pingPublicHealth(attempt.signal)
        } catch (error) {
          attempt.signal.throwIfAborted()
          consecutivePingFailures += 1
          if (consecutivePingFailures >= PING_FAILURE_TOLERANCE) {
            throw error
          }
          warn(`cloud: tunnel self-ping failed (${consecutivePingFailures}/${PING_FAILURE_TOLERANCE}): ${errorMessage(error)}`)
          continue
        }
        if (consecutivePingFailures > 0) {
          log(`cloud: tunnel self-ping ok again after ${consecutivePingFailures} failure(s)`)
          consecutivePingFailures = 0
        }

        // A heartbeat tells the proxy to forward traffic here, so it is only
        // sent right after a self-ping proved the public hostname reaches this
        // server. While pings fail the heartbeat waits and the cloud's record
        // ages, which is the truth: the 3-strike restart above fixes the
        // transport, and staying "online" over a dead tunnel would only swap
        // the offline page for proxy errors. A due heartbeat that fails is
        // retried on the next good ping instead of waiting a full cadence, so
        // one control-plane blip doesn't run the record toward the watchdog.
        if (roundsSinceHeartbeat >= heartbeatEveryNPings) {
          phase = "sending heartbeat"
          try {
            await sendHeartbeat(attempt)
            roundsSinceHeartbeat = 0
          } catch (error) {
            if (error instanceof CloudApiError && error.status === 401) {
              throw error
            }
            // Control plane hiccup while the tunnel itself is healthy — the
            // next round retries; the watchdog restarts if it never recovers.
          }
        }
      }
    } finally {
      phase = "idle"
      activeConnector = null
      clearWatchdog()
      stopController.signal.removeEventListener("abort", onStop)
      if (stopActiveConnector === stopConnector) stopActiveConnector = null
      stopConnector()
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
        warn(`cloud: connection down (${errorMessage(error)}) — restarting in ${Math.round(delay / 1000)}s (last heartbeat ok ${lastOkAge()})`)
        await sleepImpl(delay, stopController.signal)
      }
    }
  }

  void supervise()

  return {
    stop() {
      if (stopped) return
      stopped = true
      clearWatchdog()
      unsubscribeInstalls()
      // Aborts the attempt (and with it any pending start, heartbeat or ping).
      stopController.abort()
      stopActiveConnector?.()
      stopActiveConnector = null
    },
  }
}

/**
 * Direct-mode liveness (E2B dev-boxes, `kanna --cloud`): no cloudflared
 * connector to supervise — the proxy forwards straight to the sandbox's
 * public URL — so "being online" is just heartbeating the control plane.
 *
 * Deliberately NO self-ping of the public hostname: inbound traffic to the
 * sandbox URL resets E2B's activity timer, so a supervisor-style self-ping
 * would keep the box awake forever and defeat auto-pause.
 *
 * Fully DI'd (sleep, intervals) so tests drive it deterministically.
 */

import type { CloudApiClient } from "./api-client"
import { CloudApiError } from "./api-client"
import type { CloudIdentity } from "./identity"
import { defaultSleep } from "./tunnel-supervisor"

/** Matches the supervisor's effective cadence (ping × every-4th ≈ 2 min). */
const HEARTBEAT_INTERVAL_MS = 120_000
/** Failed heartbeats retry quickly — a missed window flips the dashboard offline. */
const RETRY_INTERVAL_MS = 15_000

export interface CloudHeartbeatLoop {
  stop(): void
}

export interface HeartbeatLoopDeps {
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>
  intervalMs?: number
  retryIntervalMs?: number
}

export interface HeartbeatLoopArgs {
  localUrl: string
  identity: CloudIdentity
  apiClient: CloudApiClient
  log?: (message: string) => void
  warn?: (message: string) => void
  /** Fired on the first successful heartbeat, then on each recovery. */
  onUp?: (kind: "started" | "recovered") => void
  deps?: HeartbeatLoopDeps
}

export function startCloudHeartbeatLoop(args: HeartbeatLoopArgs): CloudHeartbeatLoop {
  const log = args.log ?? (() => {})
  const warn = args.warn ?? log
  const sleepImpl = args.deps?.sleepImpl ?? defaultSleep
  const intervalMs = args.deps?.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const retryIntervalMs = args.deps?.retryIntervalMs ?? RETRY_INTERVAL_MS

  let stopped = false
  const abortController = new AbortController()

  async function run() {
    let hasEverConnected = false
    let failing = false

    while (!stopped) {
      try {
        await args.apiClient.heartbeat(args.identity.machineToken, { localUrl: args.localUrl })
        if (!hasEverConnected) {
          hasEverConnected = true
          log(`cloud: connected (${args.identity.appOrigin})`)
          args.onUp?.("started")
        } else if (failing) {
          log(`cloud: reconnected (${args.identity.appOrigin})`)
          args.onUp?.("recovered")
        }
        failing = false
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 401) {
          warn("cloud: this machine was revoked on kanna.sh — run `kanna pair` again (or `kanna pair --disable` to silence this)")
          return
        }
        if (!failing) {
          const detail = error instanceof Error && error.message ? `: ${error.message}` : ""
          warn(`cloud: heartbeat failed${detail} — retrying`)
        }
        failing = true
      }

      if (stopped) return
      await sleepImpl(failing ? retryIntervalMs : intervalMs, abortController.signal)
    }
  }

  void run()

  return {
    stop() {
      stopped = true
      abortController.abort()
    },
  }
}

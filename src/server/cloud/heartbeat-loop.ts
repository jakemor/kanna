/**
 * Direct-mode liveness (E2B dev-boxes, `kanna --cloud`): no cloudflared
 * connector to supervise — the proxy forwards straight to the sandbox's
 * public URL — so "being online" is just heartbeating the control plane.
 *
 * Deliberately NO self-ping of the public hostname: inbound traffic to the
 * sandbox URL resets E2B's activity timer, so a supervisor-style self-ping
 * would keep the box awake forever and defeat auto-pause.
 *
 * Time comes from Effect's Clock, so tests drive it with TestClock.
 */

import { Duration, Effect, Ref, Schedule } from "effect"
import { isRevoked, type CloudApiClient, type CloudRequestError } from "./api-client"
import type { CloudIdentity } from "./identity"

/** Matches the supervisor's effective cadence (ping × every-4th ≈ 2 min). */
const HEARTBEAT_INTERVAL_MS = 120_000
/** Failed heartbeats retry quickly — a missed window flips the dashboard offline. */
const RETRY_INTERVAL_MS = 15_000

export const REVOKED_WARNING =
  "cloud: this machine was revoked on kanna.sh — run `kanna pair` again (or `kanna pair --disable` to silence this)"

export interface HeartbeatLoopDeps {
  intervalMs?: number
  retryIntervalMs?: number
}

export interface HeartbeatLoopArgs {
  localUrl: string
  identity: CloudIdentity
  apiClient: CloudApiClient
  /** Fired on the first successful heartbeat, then on each recovery. */
  onUp?: (kind: "started" | "recovered") => void
  deps?: HeartbeatLoopDeps
}

type Beat = "ok" | "failed"

/**
 * Heartbeats now, then every 2 minutes, or every 15 seconds while failing.
 * Runs until interrupted, or until the control plane says the machine was
 * revoked (401), which ends it for good.
 */
export const runCloudHeartbeatLoop = Effect.fn("CloudHeartbeatLoop.run")(function* (args: HeartbeatLoopArgs) {
  yield* Effect.annotateCurrentSpan("subdomain", args.identity.subdomain)
  const interval = Duration.millis(args.deps?.intervalMs ?? HEARTBEAT_INTERVAL_MS)
  const retryInterval = Duration.millis(args.deps?.retryIntervalMs ?? RETRY_INTERVAL_MS)
  const state = yield* Ref.make({ hasEverConnected: false, failing: false })

  const succeeded = Ref.getAndSet(state, { hasEverConnected: true, failing: false }).pipe(
    Effect.flatMap((previous) => {
      if (!previous.hasEverConnected) {
        return Effect.logInfo(`cloud: connected (${args.identity.appOrigin})`).pipe(
          Effect.andThen(Effect.sync(() => args.onUp?.("started"))),
        )
      }
      if (previous.failing) {
        return Effect.logInfo(`cloud: reconnected (${args.identity.appOrigin})`).pipe(
          Effect.andThen(Effect.sync(() => args.onUp?.("recovered"))),
        )
      }
      return Effect.void
    }),
    Effect.as<Beat>("ok"),
  )

  // Warn once per failure streak, not on every retry.
  const failed = (error: CloudRequestError) =>
    Ref.getAndUpdate(state, (current) => ({ ...current, failing: true })).pipe(
      Effect.tap((previous) => {
        if (previous.failing) return Effect.void
        const detail = error.message ? `: ${error.message}` : ""
        return Effect.logWarning(`cloud: heartbeat failed${detail} — retrying`)
      }),
      Effect.as<Beat>("failed"),
    )

  const beat = args.apiClient.heartbeat(args.identity.machineToken, { localUrl: args.localUrl }).pipe(
    Effect.andThen(succeeded),
    Effect.catchTags({
      // A revocation is the one failure that escapes: it ends the loop.
      "@kanna/server/cloud/api-client/CloudApiError": (error) => isRevoked(error) ? Effect.fail(error) : failed(error),
      "@kanna/server/cloud/api-client/CloudNetworkError": failed,
    }),
  )

  const cadence = Schedule.forever.pipe(
    Schedule.setInputType<Beat>(),
    Schedule.modifyDelay(({ input }) => Effect.succeed(input === "failed" ? retryInterval : interval)),
  )

  yield* beat.pipe(
    Effect.repeat(cadence),
    Effect.catchTag("@kanna/server/cloud/api-client/CloudApiError", () => Effect.logWarning(REVOKED_WARNING)),
  )
})

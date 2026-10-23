/**
 * Keeps the machine reachable over its named Cloudflare tunnel: runs the
 * connector (token-scoped to this machine's tunnel), heartbeats the control
 * plane so the dashboard/proxy know it's alive, self-pings through the
 * permanent public hostname, and restarts the connector with backoff on
 * sustained failure. The hostname never changes, so there is no URL
 * registration, rotation handling, or propagation wait.
 *
 * Time comes from Effect's Clock, so tests drive it with TestClock; the
 * connector and fetch are DI'd.
 */

import { Clock, Duration, Effect, Option, Ref, Schedule, Schema } from "effect"
import { startShareTunnel, type StartedShareTunnel } from "../share"
import { describeError, isRevoked, type CloudApiClient } from "./api-client"
import { REVOKED_WARNING } from "./heartbeat-loop"
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

/** The connector didn't come up (cloudflared missing, exited, bad token). */
export class CloudTunnelStartError extends Schema.TaggedError<CloudTunnelStartError>()(
  "@kanna/server/cloud/tunnel-supervisor/CloudTunnelStartError",
  {
    message: Schema.String,
    tunnelHost: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The machine's own public /health didn't answer through the tunnel. */
export class CloudSelfPingError extends Schema.TaggedError<CloudSelfPingError>()(
  "@kanna/server/cloud/tunnel-supervisor/CloudSelfPingError",
  {
    message: Schema.String,
    url: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface TunnelSupervisorDeps {
  startTunnelImpl?: (localUrl: string, tunnelToken: string) => Promise<StartedShareTunnel>
  fetchImpl?: typeof fetch
  pingIntervalMs?: number
  heartbeatEveryNPings?: number
}

export interface TunnelSupervisorArgs {
  localUrl: string
  identity: CloudIdentity
  apiClient: CloudApiClient
  /** Fired once when the connector first comes up, then on each recovery. */
  onTunnelUp?: (kind: "started" | "recovered") => void
  deps?: TunnelSupervisorDeps
}

export function restartDelayMs(msIntoFailureStreak: number, failuresPastFastWindow: number) {
  // Inside the fast window: always 1s. Past it (failuresPastFastWindow is
  // 1-based): 1 → 2s, 2 → 4s, 3 → 10s, 4+ → 30s.
  if (msIntoFailureStreak < FAST_RETRY_WINDOW_MS) return FAST_RETRY_DELAY_MS
  return RESTART_BACKOFF_MS[failuresPastFastWindow - 1] ?? RESTART_BACKOFF_MAX_MS
}

interface SupervisorState {
  hasEverConnected: boolean
  /** Clock time the current failure streak started (none while healthy). */
  failureStreakStartedAt: Option.Option<number>
  failuresPastFastWindow: number
}

/**
 * Runs the connector and keeps it up: restarts it on sustained failure,
 * with backoff, until interrupted (which stops the connector) or until the
 * control plane says the machine was revoked (401), which ends it for good.
 */
export const runCloudTunnelSupervisor = Effect.fn("CloudTunnelSupervisor.run")(function* (args: TunnelSupervisorArgs) {
  yield* Effect.annotateCurrentSpan("subdomain", args.identity.subdomain)
  const { identity, apiClient } = args
  const fetchImpl = args.deps?.fetchImpl ?? fetch
  const pingInterval = Duration.millis(args.deps?.pingIntervalMs ?? PING_INTERVAL_MS)
  const heartbeatEveryNPings = args.deps?.heartbeatEveryNPings ?? HEARTBEAT_EVERY_N_PINGS
  const publicHealthUrl = `https://${identity.tunnelHost}/health`

  // cloudflared's own progress (install, download) is reported through a
  // plain callback; it lands in the same log as everything here.
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const startTunnelImpl = args.deps?.startTunnelImpl

  const state = yield* Ref.make<SupervisorState>({
    hasEverConnected: false,
    failureStreakStartedAt: Option.none(),
    failuresPastFastWindow: 0,
  })

  // Named tunnel: resolves once the connector reports "connected". The
  // connector is stopped when the attempt's scope closes. Stopping while it
  // is still coming up doesn't wait for it; it is stopped as it arrives.
  const startTunnel = Effect.uninterruptibleMask((restore) =>
    restore(startTunnelImpl
      // Compatibility edge for callers that inject a Promise connector. A
      // late result still needs stopping after the supervising fiber exits.
      ? Effect.tryPromise({
          try: (signal) => startTunnelImpl(args.localUrl, identity.tunnelToken).then((tunnel) => {
            if (signal.aborted) tunnel.stop()
            return tunnel
          }),
          catch: (cause) => new CloudTunnelStartError({ message: describeError(cause), tunnelHost: identity.tunnelHost, cause }),
        })
      : startShareTunnel(args.localUrl, { kind: "token", token: identity.tunnelToken }, {
        log: (message) => {
          runFork(Effect.logInfo(message))
        },
      }).pipe(
        Effect.catchTags({
          "@kanna/server/share/CloudflaredInstallError": (cause) =>
            Effect.fail(new CloudTunnelStartError({ message: describeError(cause), tunnelHost: identity.tunnelHost, cause })),
          "@kanna/server/share/ShareTunnelError": (cause) =>
            Effect.fail(new CloudTunnelStartError({ message: describeError(cause), tunnelHost: identity.tunnelHost, cause })),
          "@kanna/server/share/ShareTunnelExitedError": (cause) =>
            Effect.fail(new CloudTunnelStartError({ message: describeError(cause), tunnelHost: identity.tunnelHost, cause })),
        }),
        // A throw inside the connector is retried like any failed start, as it
        // was when the start ran behind a Promise; otherwise supervision ends.
        Effect.catchDefect((cause) =>
          Effect.fail(new CloudTunnelStartError({ message: describeError(cause), tunnelHost: identity.tunnelHost, cause }))),
      )).pipe(
      Effect.tap((tunnel) => Effect.addFinalizer(() => Effect.sync(() => tunnel.stop()))),
    ))

  const sendHeartbeat = apiClient.heartbeat(identity.machineToken, { localUrl: args.localUrl })

  const pingPublicHealth = Effect.tryPromise({
    try: (signal) => fetchImpl(publicHealthUrl, { signal }),
    catch: (cause) => new CloudSelfPingError({ message: describeError(cause), url: publicHealthUrl, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(PING_TIMEOUT_MS),
      orElse: () => Effect.fail(new CloudSelfPingError({ message: "The operation timed out.", url: publicHealthUrl })),
    }),
    Effect.flatMap((response) => response.ok
      ? Effect.void
      : Effect.fail(new CloudSelfPingError({ message: `public /health returned ${response.status}`, url: publicHealthUrl }))),
  )

  // One self-ping, and every Nth successful one a heartbeat. Isolated ping
  // failures are tolerated; the PING_FAILURE_TOLERANCE-th in a row fails the
  // attempt, as does a revocation.
  const pingRound = (pings: Ref.Ref<{ count: number; consecutiveFailures: number }>) =>
    pingPublicHealth.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Ref.updateAndGet(pings, (current) => ({ ...current, consecutiveFailures: current.consecutiveFailures + 1 })).pipe(
            Effect.flatMap(({ consecutiveFailures }) => consecutiveFailures >= PING_FAILURE_TOLERANCE
              ? Effect.fail(error)
              : Effect.logWarning(`cloud: self-ping failed (${consecutiveFailures}/${PING_FAILURE_TOLERANCE})`)),
          ),
        onSuccess: () =>
          Ref.updateAndGet(pings, (current) => ({ count: current.count + 1, consecutiveFailures: 0 })).pipe(
            Effect.flatMap(({ count }) => count % heartbeatEveryNPings === 0
              ? sendHeartbeat.pipe(
                // Control plane hiccup while the tunnel itself is healthy — the
                // next heartbeat retries; worst case the proxy shows "offline"
                // until then.
                Effect.catchTags({
                  "@kanna/server/cloud/api-client/CloudApiError": (error) => isRevoked(error)
                    ? Effect.fail(error)
                    : Effect.logWarning(`cloud: heartbeat failed (${error.message})`),
                  "@kanna/server/cloud/api-client/CloudNetworkError": (error) =>
                    Effect.logWarning(`cloud: heartbeat failed (${error.message})`),
                }),
              )
              : Effect.void),
          ),
      }),
    )

  const connectOnce = Effect.gen(function* () {
    yield* startTunnel
    // Announce liveness immediately — the hostname is permanent, so the
    // machine is reachable the moment the connector is up.
    yield* sendHeartbeat
    const previous = yield* Ref.getAndUpdate(state, (current) => ({
      ...current,
      hasEverConnected: true,
      failureStreakStartedAt: Option.none(),
      failuresPastFastWindow: 0,
    }))
    yield* Effect.sync(() => args.onTunnelUp?.(previous.hasEverConnected ? "recovered" : "started"))
    yield* Effect.logInfo(`cloud: connected (${identity.appOrigin})`)

    const pings = yield* Ref.make({ count: 0, consecutiveFailures: 0 })
    yield* pingRound(pings).pipe(Effect.schedule(Schedule.spaced(pingInterval)))
  }).pipe(Effect.scoped)

  // 1s retries for the first minute of a failure streak, then 2s → 4s →
  // 10s → 30s. A successful connect (above) starts the next streak afresh.
  const nextRestartDelay = Effect.fn("CloudTunnelSupervisor.nextRestartDelay")(function* (error: Error) {
    const now = yield* Clock.currentTimeMillis
    const next = yield* Ref.updateAndGet(state, (current) => {
      const streakStartedAt = Option.getOrElse(current.failureStreakStartedAt, () => now)
      return {
        ...current,
        failureStreakStartedAt: Option.some(streakStartedAt),
        failuresPastFastWindow: now - streakStartedAt >= FAST_RETRY_WINDOW_MS
          ? current.failuresPastFastWindow + 1
          : current.failuresPastFastWindow,
      }
    })
    const msIntoStreak = now - Option.getOrElse(next.failureStreakStartedAt, () => now)
    const delay = restartDelayMs(msIntoStreak, next.failuresPastFastWindow)
    yield* Effect.logWarning(`cloud: connection down (${error.message}) — restarting in ${Math.round(delay / 1000)}s`)
    return Duration.millis(delay)
  })

  const restartPolicy = Schedule.forever.pipe(
    Schedule.setInputType<Error>(),
    Schedule.modifyDelay(({ input }) => nextRestartDelay(input)),
  )

  yield* connectOnce.pipe(
    // Revoked: the attempt's connector is already stopped; supervision ends.
    Effect.catchTag("@kanna/server/cloud/api-client/CloudApiError", (error) =>
      isRevoked(error) ? Effect.logWarning(REVOKED_WARNING) : Effect.fail(error)),
    Effect.retry(restartPolicy),
    // The restart policy never gives up, so no failure gets past it.
    Effect.orDie,
  )
})

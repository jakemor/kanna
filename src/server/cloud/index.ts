/**
 * Cloud runtime shell: created in the CLI *before* the server starts (so the
 * request guard and ws-endpoint route are live from the first request), then
 * `start`ed with the server's local URL to bring the tunnel up.
 *
 * Not a layer: whether there is one at all, and when it starts, is decided
 * at launch (or at pair time, mid-run), so its owner calls `start`/`stop`.
 * The loop runs in a scope `start` opens and `stop` closes.
 */

import { FileSystem, Effect, Exit, Option, Scope } from "effect"
import { createCloudApiClient, type CloudApiClient } from "./api-client"
import { createConnectTokenManager, type ConnectTokenManager } from "./connect-token"
import { runCloudHeartbeatLoop, type HeartbeatLoopDeps } from "./heartbeat-loop"
import type { CloudIdentity } from "./identity"
import { runCloudTunnelSupervisor, type TunnelSupervisorDeps } from "./tunnel-supervisor"

/** How long shutdown waits for the control plane to hear "offline". */
const MARK_OFFLINE_TIMEOUT = "2 seconds"

export interface CloudRuntimeStartArgs {
  localUrl: string
  /** Fired once when the machine first comes online, then on each recovery. */
  onTunnelUp?: (kind: "started" | "recovered") => void
}

export interface CloudRuntime {
  readonly identity: CloudIdentity
  readonly connectTokens: ConnectTokenManager
  /** Brings the machine online. A second call while running does nothing. */
  /** Needs `FileSystem.FileSystem` to find a local `cloudflared` for the connector. */
  readonly start: (args: CloudRuntimeStartArgs) => Effect.Effect<void, never, FileSystem.FileSystem>
  /**
   * Stops the tunnel and best-effort tells the control plane we're offline
   * (so the dashboard/proxy flip immediately instead of waiting out the
   * heartbeat window). Finishes within ~2s even if the control plane is
   * unreachable.
   */
  readonly stop: Effect.Effect<void>
}

export interface CloudRuntimeDeps {
  apiClient?: CloudApiClient
  supervisorDeps?: TunnelSupervisorDeps
  heartbeatDeps?: HeartbeatLoopDeps
}

export function createCloudRuntime(
  identity: CloudIdentity,
  deps: CloudRuntimeDeps = {},
): CloudRuntime {
  const apiClient = deps.apiClient ?? createCloudApiClient({ controlUrl: identity.controlUrl })
  const connectTokens = createConnectTokenManager()
  let running: Option.Option<Scope.Closeable> = Option.none()

  const start = Effect.fn("CloudRuntime.start")(function* (args: CloudRuntimeStartArgs) {
    if (Option.isSome(running)) return
    yield* Effect.annotateCurrentSpan("subdomain", identity.subdomain)
    const scope = yield* Scope.make()
    running = Option.some(scope)
    const loop = identity.mode === "direct"
      // Dev-box (E2B): the proxy reaches us via our public sandbox URL — no
      // connector to run, just keep the control plane's liveness fresh.
      ? runCloudHeartbeatLoop({
        localUrl: args.localUrl,
        identity,
        apiClient,
        onUp: args.onTunnelUp,
        deps: deps.heartbeatDeps,
      })
      : runCloudTunnelSupervisor({
        localUrl: args.localUrl,
        identity,
        apiClient,
        onTunnelUp: args.onTunnelUp,
        deps: deps.supervisorDeps,
      })
    yield* Effect.forkIn(loop, scope)
  })

  const stop = Effect.gen(function* () {
    if (Option.isNone(running)) return
    const scope = running.value
    running = Option.none()
    // Interrupts the loop; its connector is stopped as the scope closes.
    yield* Scope.close(scope, Exit.void)
    // Graceful offline signal, capped so shutdown never hangs on it.
    yield* apiClient.markOffline(identity.machineToken).pipe(
      Effect.timeout(MARK_OFFLINE_TIMEOUT),
      Effect.ignore,
    )
  }).pipe(Effect.withSpan("CloudRuntime.stop"))

  return { identity, connectTokens, start, stop }
}

/**
 * Cloud runtime shell: created in the CLI *before* the server starts (so the
 * request guard and ws-endpoint route are live from the first request), then
 * `start()`ed with the server's local URL to bring the tunnel up.
 */

import { createCloudApiClient, type CloudApiClient } from "./api-client"
import { createConnectTokenManager, type ConnectTokenManager } from "./connect-token"
import type { CloudIdentity } from "./identity"
import {
  startCloudTunnelSupervisor,
  type CloudTunnelSupervisor,
  type TunnelSupervisorDeps,
} from "./tunnel-supervisor"

export interface CloudRuntime {
  identity: CloudIdentity
  connectTokens: ConnectTokenManager
  start(args: {
    localUrl: string
    log?: (message: string) => void
    warn?: (message: string) => void
    onTunnelUp?: (kind: "started" | "recovered") => void
  }): void
  /**
   * Stops the tunnel and best-effort tells the control plane we're offline
   * (so the dashboard/proxy flip immediately instead of waiting out the
   * heartbeat window). Resolves within ~2s even if the control plane is
   * unreachable.
   */
  stop(): Promise<void>
}

export interface CloudRuntimeDeps {
  apiClient?: CloudApiClient
  supervisorDeps?: TunnelSupervisorDeps
}

export function createCloudRuntime(
  identity: CloudIdentity,
  deps: CloudRuntimeDeps = {},
): CloudRuntime {
  const apiClient = deps.apiClient ?? createCloudApiClient({ controlUrl: identity.controlUrl })
  const connectTokens = createConnectTokenManager()
  let supervisor: CloudTunnelSupervisor | null = null

  return {
    identity,
    connectTokens,

    start(args) {
      if (supervisor) return
      supervisor = startCloudTunnelSupervisor({
        localUrl: args.localUrl,
        identity,
        apiClient,
        log: args.log,
        warn: args.warn,
        onTunnelUp: args.onTunnelUp,
        deps: deps.supervisorDeps,
      })
    },

    async stop() {
      const wasRunning = supervisor !== null
      supervisor?.stop()
      supervisor = null

      if (wasRunning) {
        // Graceful offline signal, capped so shutdown never hangs on it.
        await Promise.race([
          apiClient.markOffline(identity.machineToken).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ])
      }
    },
  }
}

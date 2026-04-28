import type { CloudflareTunnelRecord } from "../../shared/types"
import type { CloudflareTunnelEvent } from "./events"

export interface ChatTunnelsProjection {
  tunnels: Record<string, CloudflareTunnelRecord>
  liveTunnelId: string | null
}

const EMPTY: ChatTunnelsProjection = { tunnels: {}, liveTunnelId: null }

export function deriveChatTunnels(
  events: readonly CloudflareTunnelEvent[],
  chatId?: string,
): ChatTunnelsProjection {
  const tunnels: Record<string, CloudflareTunnelRecord> = {}
  let liveTunnelId: string | null = null

  for (const event of events) {
    if (chatId !== undefined && event.chatId !== chatId) continue
    applyOne(tunnels, event)
    const record = tunnels[event.tunnelId]
    if (record && (record.state === "proposed" || record.state === "active")) {
      liveTunnelId = record.tunnelId
    } else if (liveTunnelId === event.tunnelId) {
      liveTunnelId = null
    }
  }

  if (Object.keys(tunnels).length === 0 && liveTunnelId === null) return EMPTY
  return { tunnels, liveTunnelId }
}

function applyOne(tunnels: Record<string, CloudflareTunnelRecord>, event: CloudflareTunnelEvent): void {
  switch (event.kind) {
    case "tunnel_proposed":
      tunnels[event.tunnelId] = {
        tunnelId: event.tunnelId,
        chatId: event.chatId,
        port: event.port,
        state: "proposed",
        url: null,
        error: null,
        proposedAt: event.timestamp,
        activatedAt: null,
        stoppedAt: null,
      }
      return
    case "tunnel_accepted":
      // transitional; state stays "proposed" until tunnel_active arrives
      return
    case "tunnel_active": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      tunnels[event.tunnelId] = {
        ...existing,
        state: "active",
        url: event.url,
        activatedAt: event.timestamp,
      }
      return
    }
    case "tunnel_stopped": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      tunnels[event.tunnelId] = { ...existing, state: "stopped", stoppedAt: event.timestamp }
      return
    }
    case "tunnel_failed": {
      const existing = tunnels[event.tunnelId]
      if (!existing) return
      tunnels[event.tunnelId] = { ...existing, state: "failed", error: event.error }
      return
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return
    }
  }
}

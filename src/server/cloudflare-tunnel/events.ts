export const CLOUDFLARE_TUNNEL_EVENT_VERSION = 1 as const

interface BaseTunnelEvent {
  v: typeof CLOUDFLARE_TUNNEL_EVENT_VERSION
  timestamp: number
  chatId: string
  tunnelId: string
}

export type CloudflareTunnelEvent =
  | (BaseTunnelEvent & {
      kind: "tunnel_proposed"
      port: number
      sourcePid: number | null
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_accepted"
      source: "user" | "auto_setting"
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_active"
      url: string
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_stopped"
      reason: "user" | "source_exited" | "session_closed" | "server_shutdown"
    })
  | (BaseTunnelEvent & {
      kind: "tunnel_failed"
      error: string
    })

import { randomUUID } from "node:crypto"
import type { CloudflareTunnelSettings } from "../../shared/types"
import { evaluateBashOutput } from "./detector"
import type { CloudflareTunnelEvent } from "./events"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION } from "./events"

export interface HandleBashArgs {
  command: string
  stdout: string
  chatId: string
  sourcePid: number | null
  settings: CloudflareTunnelSettings
  onEvent: (event: CloudflareTunnelEvent) => void
  autoStart: (args: { chatId: string; tunnelId: string; port: number; sourcePid: number | null }) => Promise<void>
  now?: () => number
}

export function handleBashToolResult(args: HandleBashArgs): Promise<void> {
  return runHandleBashToolResult(args)
}

async function runHandleBashToolResult(args: HandleBashArgs): Promise<void> {
  if (!args.settings.enabled) return
  const result = evaluateBashOutput({
    command: args.command,
    stdout: args.stdout,
  })
  if (!result.isServer) return

  const now = (args.now ?? Date.now)()
  for (const port of result.ports) {
    const tunnelId = randomUUID()
    args.onEvent({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_proposed",
      timestamp: now,
      chatId: args.chatId,
      tunnelId,
      port,
      sourcePid: args.sourcePid,
    })

    if (args.settings.mode === "auto-expose") {
      args.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_accepted",
        timestamp: now,
        chatId: args.chatId,
        tunnelId,
        source: "auto_setting",
      })
      await args.autoStart({ chatId: args.chatId, tunnelId, port, sourcePid: args.sourcePid })
    }
  }
}

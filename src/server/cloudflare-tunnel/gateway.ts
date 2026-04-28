import type { AppSettingsManager } from "../app-settings"
import type { EventStore } from "../event-store"
import { handleBashToolResult } from "./agent-integration"
import type { CloudflareTunnelEvent } from "./events"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION } from "./events"
import { TunnelLifecycle } from "./lifecycle"
import { deriveChatTunnels } from "./read-model"
import { TunnelManager } from "./tunnel-manager"

export interface TunnelGatewayArgs {
  manager: TunnelManager
  lifecycle: TunnelLifecycle
  settings: AppSettingsManager
  store: EventStore
  broadcast: (chatId: string) => void
  now?: () => number
}

export class TunnelGateway {
  private readonly manager: TunnelManager
  private readonly lifecycle: TunnelLifecycle
  private readonly settings: AppSettingsManager
  private readonly store: EventStore
  private readonly broadcast: (chatId: string) => void
  private readonly now: () => number
  // tunnelId → sourcePid for retry
  private readonly proposedSourcePid = new Map<string, number | null>()

  constructor(args: TunnelGatewayArgs) {
    this.manager = args.manager
    this.lifecycle = args.lifecycle
    this.settings = args.settings
    this.store = args.store
    this.broadcast = args.broadcast
    this.now = args.now ?? (() => Date.now())
  }

  async reapOrphanedTunnels(): Promise<void> {
    const chatIds = this.store.listTunnelChats()
    for (const chatId of chatIds) {
      const projection = deriveChatTunnels(this.store.getTunnelEvents(chatId), chatId)
      for (const record of Object.values(projection.tunnels)) {
        if (record.state !== "proposed" && record.state !== "active") continue
        await this.persist({
          v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
          kind: "tunnel_stopped",
          timestamp: this.now(),
          chatId,
          tunnelId: record.tunnelId,
          reason: "server_shutdown",
        })
      }
    }
  }

  async handleBashResult(args: { command: string; stdout: string; chatId: string; sourcePid: number | null }): Promise<void> {
    const snapshot = this.settings.getSnapshot()
    const livePorts = this.collectLivePorts(args.chatId)
    const skippedTunnels = new Set<string>()
    await handleBashToolResult({
      command: args.command,
      stdout: args.stdout,
      chatId: args.chatId,
      sourcePid: args.sourcePid,
      settings: snapshot.cloudflareTunnel,
      onEvent: (e: CloudflareTunnelEvent) => {
        if (e.kind === "tunnel_proposed") {
          if (livePorts.has(e.port)) {
            skippedTunnels.add(e.tunnelId)
            return
          }
          this.proposedSourcePid.set(e.tunnelId, e.sourcePid)
        }
        if (skippedTunnels.has(e.tunnelId)) return
        void this.persist(e)
      },
      autoStart: async (a) => {
        if (skippedTunnels.has(a.tunnelId)) return
        await this.manager.start({ chatId: a.chatId, port: a.port, sourcePid: a.sourcePid, tunnelId: a.tunnelId })
        this.lifecycle.watch(a.tunnelId, a.sourcePid)
      },
      now: this.now,
    })
  }

  private collectLivePorts(chatId: string): Set<number> {
    const events = this.store.getTunnelEvents(chatId)
    const projection = deriveChatTunnels(events, chatId)
    const ports = new Set<number>()
    for (const record of Object.values(projection.tunnels)) {
      if (record.state === "proposed" || record.state === "active") {
        ports.add(record.port)
      }
    }
    return ports
  }

  async accept(chatId: string, tunnelId: string): Promise<void> {
    const sourcePid = this.proposedSourcePid.get(tunnelId) ?? null
    const proposedEvents = this.store.getTunnelEvents(chatId).filter((e: CloudflareTunnelEvent) => e.tunnelId === tunnelId)
    const proposed = proposedEvents.find((e: CloudflareTunnelEvent) => e.kind === "tunnel_proposed")
    if (!proposed || proposed.kind !== "tunnel_proposed") return
    await this.persist({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_accepted",
      timestamp: this.now(),
      chatId,
      tunnelId,
      source: "user",
    })
    await this.manager.start({ chatId, port: proposed.port, sourcePid, tunnelId })
    this.lifecycle.watch(tunnelId, sourcePid)
  }

  async stop(chatId: string, tunnelId: string): Promise<void> {
    this.lifecycle.unwatch(tunnelId)
    await this.manager.stop(tunnelId, "user")
    void chatId  // chatId may be useful for logging/auditing
  }

  async retry(chatId: string, tunnelId: string): Promise<void> {
    // For v1, retry just re-runs accept on the existing proposed record.
    await this.accept(chatId, tunnelId)
  }

  closeChat(chatId: string): void {
    const events = this.store.getTunnelEvents(chatId)
    const live = deriveChatTunnels(events, chatId).liveTunnelId
    if (!live) return
    this.lifecycle.unwatch(live)
    void this.manager.stop(live, "session_closed")
  }

  shutdown(): void {
    this.lifecycle.shutdown()
    this.manager.shutdown()
  }

  private async persist(event: CloudflareTunnelEvent): Promise<void> {
    await this.store.appendTunnelEvent(event)
    this.broadcast(event.chatId)
  }
}

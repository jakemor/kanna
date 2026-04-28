import { randomUUID } from "node:crypto"
import { spawn as nodeSpawn } from "node:child_process"
import type { CloudflareTunnelEvent } from "./events"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION } from "./events"

export interface ChildHandle {
  pid: number
  kill: () => void
  onStdout: (listener: (chunk: string) => void) => void
  onStderr: (listener: (chunk: string) => void) => void
  onExit: (listener: (code: number) => void) => void
  isKilled: () => boolean
}

export type SpawnFn = (cmd: string, args: string[]) => ChildHandle

export interface TunnelManagerArgs {
  spawn?: SpawnFn
  cloudflaredPath: string
  onEvent: (event: CloudflareTunnelEvent) => void
  now?: () => number
}

interface TunnelRecord {
  tunnelId: string
  chatId: string
  port: number
  sourcePid: number | null
  child: ChildHandle
  state: "starting" | "active" | "stopped" | "failed"
}

const TRYCF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export class TunnelManager {
  private readonly spawn: SpawnFn
  private readonly cloudflaredPath: string
  private readonly onEvent: (event: CloudflareTunnelEvent) => void
  private readonly now: () => number
  private readonly byPort = new Map<number, string>()
  private readonly byTunnel = new Map<string, TunnelRecord>()

  constructor(args: TunnelManagerArgs) {
    this.spawn = args.spawn ?? defaultSpawn
    this.cloudflaredPath = args.cloudflaredPath
    this.onEvent = args.onEvent
    this.now = args.now ?? (() => Date.now())
  }

  async start(input: { chatId: string; port: number; sourcePid: number | null; tunnelId?: string }): Promise<string> {
    const existing = this.byPort.get(input.port)
    if (existing) return existing

    const tunnelId = input.tunnelId ?? randomUUID()
    let child: ChildHandle
    try {
      child = this.spawn(this.cloudflaredPath, ["tunnel", "--url", `http://localhost:${input.port}`])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_failed",
        timestamp: this.now(),
        chatId: input.chatId,
        tunnelId,
        error: `cloudflared failed to start: ${message}`,
      })
      return tunnelId
    }

    const record: TunnelRecord = {
      tunnelId,
      chatId: input.chatId,
      port: input.port,
      sourcePid: input.sourcePid,
      child,
      state: "starting",
    }
    this.byPort.set(input.port, tunnelId)
    this.byTunnel.set(tunnelId, record)

    child.onStdout((chunk: string) => this.handleStdout(record, chunk))
    child.onStderr((chunk: string) => this.handleStdout(record, chunk))
    child.onExit((code: number) => this.handleExit(record, code))

    return tunnelId
  }

  async stop(tunnelId: string, reason: "user" | "source_exited" | "session_closed" | "server_shutdown"): Promise<void> {
    const record = this.byTunnel.get(tunnelId)
    if (!record) return
    if (record.state === "stopped" || record.state === "failed") return
    record.state = "stopped"
    record.child.kill()
    this.byPort.delete(record.port)
    this.onEvent({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_stopped",
      timestamp: this.now(),
      chatId: record.chatId,
      tunnelId,
      reason,
    })
  }

  shutdown() {
    for (const id of [...this.byTunnel.keys()]) {
      void this.stop(id, "server_shutdown")
    }
  }

  private handleStdout(record: TunnelRecord, chunk: string): void {
    if (record.state !== "starting") return
    const match = TRYCF_URL_RE.exec(chunk)
    if (!match) return
    record.state = "active"
    this.onEvent({
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_active",
      timestamp: this.now(),
      chatId: record.chatId,
      tunnelId: record.tunnelId,
      url: match[0],
    })
  }

  private handleExit(record: TunnelRecord, code: number): void {
    this.byPort.delete(record.port)
    if (record.state === "starting") {
      record.state = "failed"
      this.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_failed",
        timestamp: this.now(),
        chatId: record.chatId,
        tunnelId: record.tunnelId,
        error: `cloudflared exited (code ${code}) before tunnel URL appeared`,
      })
      return
    }
    if (record.state === "active") {
      record.state = "stopped"
      this.onEvent({
        v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
        kind: "tunnel_stopped",
        timestamp: this.now(),
        chatId: record.chatId,
        tunnelId: record.tunnelId,
        reason: "source_exited",
      })
    }
  }
}

function defaultSpawn(cmd: string, args: string[]): ChildHandle {
  const proc = nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
  return {
    pid: proc.pid ?? -1,
    kill: () => { proc.kill("SIGTERM") },
    onStdout: (l: (chunk: string) => void) => { proc.stdout?.on("data", (b: Buffer) => l(b.toString("utf8"))) },
    onStderr: (l: (chunk: string) => void) => { proc.stderr?.on("data", (b: Buffer) => l(b.toString("utf8"))) },
    onExit: (l: (code: number) => void) => { proc.on("exit", (code: number | null) => l(code ?? 0)) },
    isKilled: () => proc.killed,
  }
}

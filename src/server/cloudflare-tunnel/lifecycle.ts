export interface TunnelLifecycleArgs {
  pollIntervalMs?: number
  isPidAlive?: (pid: number) => boolean
  onSourceExit: (tunnelId: string) => void
}

export class TunnelLifecycle {
  private readonly pollIntervalMs: number
  private readonly isPidAlive: (pid: number) => boolean
  private readonly onSourceExit: (tunnelId: string) => void
  private readonly watched = new Map<string, number | null>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(args: TunnelLifecycleArgs) {
    this.pollIntervalMs = args.pollIntervalMs ?? 1500
    this.isPidAlive = args.isPidAlive ?? defaultIsPidAlive
    this.onSourceExit = args.onSourceExit
  }

  watch(tunnelId: string, sourcePid: number | null) {
    this.watched.set(tunnelId, sourcePid)
    this.ensureTimer()
  }

  unwatch(tunnelId: string) {
    this.watched.delete(tunnelId)
    if (this.watched.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watched.clear()
  }

  private ensureTimer() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs)
  }

  private tick() {
    for (const [tunnelId, pid] of [...this.watched.entries()]) {
      if (pid === null) continue
      if (!this.isPidAlive(pid)) {
        this.unwatch(tunnelId)
        this.onSourceExit(tunnelId)
      }
    }
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

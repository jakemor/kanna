import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { startShareTunnel, type StartedShareTunnel } from "./share"

/**
 * One cloudflared quick tunnel per exposed local port.
 *
 * A port's link is `http://localhost:<port>`, which in cloud mode resolves
 * to the viewer's own machine. A quick tunnel gives the
 * port a public https URL that works from anywhere. A forgotten public share
 * is the main risk of this feature, so nothing here is meant to outlive the
 * server: the tunnels are its child processes and are stopped first when it
 * shuts down.
 *
 * A child does not die with a parent that is killed, though, or one that
 * crashes or hangs on its way out: cloudflared carries on, the port stays
 * public, and the next server knows nothing of it. So the pids are kept in a
 * file, and whatever is still running from the last server is stopped when
 * the next one starts (`reapOrphans`).
 *
 * Anyone with the URL can reach the port. trycloudflare hostnames are random
 * words, not an auth scheme.
 */

export interface ExposedPort {
  port: number
  publicUrl: string
}

export interface PortTunnelManagerDeps {
  startTunnel?: (localUrl: string) => Promise<StartedShareTunnel>
  log?: (message: string) => void
  /** Where the running tunnels' pids are kept. Without it nothing is recorded. */
  stateFile?: string
  /** Whether `pid` is a cloudflared tunnel right now. A pid can be reused. */
  isTunnelProcess?: (pid: number) => Promise<boolean>
  killProcess?: (pid: number) => void
}

interface RecordedTunnel {
  port: number
  pid: number
}

function isCloudflaredTunnel(pid: number) {
  if (process.platform === "win32") return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 }, (error, stdout) => {
      resolve(!error && /cloudflared/.test(stdout) && /\btunnel\b/.test(stdout))
    })
  })
}

function assertValidPort(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port is invalid.")
  }
}

export class PortTunnelManager {
  private readonly tunnels = new Map<number, { publicUrl: string; stop: () => void; pid?: number }>()
  private readonly stateFile: string | null
  private readonly isTunnelProcess: (pid: number) => Promise<boolean>
  private readonly killProcess: (pid: number) => void
  /** Writes to the state file, one after another. */
  private recording: Promise<void> = Promise.resolve()
  private readonly pending = new Map<number, Promise<ExposedPort>>()
  private readonly startTunnel: (localUrl: string) => Promise<StartedShareTunnel>
  private readonly log: (message: string) => void

  constructor(deps: PortTunnelManagerDeps = {}) {
    this.startTunnel = deps.startTunnel ?? ((localUrl) => startShareTunnel(localUrl, "quick", { log: deps.log }))
    this.log = deps.log ?? (() => {})
    this.stateFile = deps.stateFile ?? null
    this.isTunnelProcess = deps.isTunnelProcess ?? isCloudflaredTunnel
    this.killProcess = deps.killProcess ?? ((pid) => {
      process.kill(pid, "SIGTERM")
    })
  }

  /**
   * Stops the tunnels a previous server left running. Called once at boot,
   * before any new tunnel is recorded.
   */
  async reapOrphans() {
    if (!this.stateFile) return
    let recorded: RecordedTunnel[] = []
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown
      if (Array.isArray(parsed)) {
        recorded = parsed.filter((entry): entry is RecordedTunnel =>
          Boolean(entry) && Number.isInteger((entry as RecordedTunnel).pid) && (entry as RecordedTunnel).pid > 1)
      }
    } catch {
      // No file, or one cut short: nothing is known to be running.
    }
    for (const entry of recorded) {
      try {
        if (!(await this.isTunnelProcess(entry.pid))) continue
        this.killProcess(entry.pid)
        this.log(`stopped a tunnel for port ${entry.port} left running by a previous server (pid ${entry.pid})`)
      } catch {
        // Gone between the check and the signal, or not ours to stop.
      }
    }
    this.record()
  }

  private record() {
    if (!this.stateFile) return
    const stateFile = this.stateFile
    this.recording = this.recording.then(async () => {
      const running: RecordedTunnel[] = [...this.tunnels.entries()]
        .flatMap(([port, tunnel]) => tunnel.pid ? [{ port, pid: tunnel.pid }] : [])
      await writeFile(stateFile, JSON.stringify(running)).catch(() => {})
    })
  }

  getPublicUrl(port: number) {
    return this.tunnels.get(port)?.publicUrl
  }

  list(): ExposedPort[] {
    return [...this.tunnels.entries()].map(([port, tunnel]) => ({ port, publicUrl: tunnel.publicUrl }))
  }

  /**
   * Start a tunnel for the port, or return the one already running. A second
   * call while the first is still connecting shares that attempt instead of
   * spawning a second cloudflared.
   */
  async expose(port: number): Promise<ExposedPort> {
    assertValidPort(port)
    const running = this.tunnels.get(port)
    if (running) return { port, publicUrl: running.publicUrl }
    const inFlight = this.pending.get(port)
    if (inFlight) return inFlight

    const attempt = this.startTunnel(`http://localhost:${port}`)
      .then((tunnel) => {
        if (!tunnel.publicUrl) {
          tunnel.stop()
          throw new Error(`Cloudflare tunnel for port ${port} started without a public URL.`)
        }
        const record = { publicUrl: tunnel.publicUrl, stop: tunnel.stop, pid: tunnel.pid }
        this.tunnels.set(port, record)
        this.record()
        this.log(`exposed port ${port} at ${tunnel.publicUrl}`)
        // cloudflared can die on its own (rate limit, network). Drop the
        // record so the panel stops showing a URL that no longer answers.
        void tunnel.exited?.then(() => {
          if (this.tunnels.get(port) === record) {
            this.tunnels.delete(port)
            this.record()
            this.log(`tunnel for port ${port} exited`)
          }
        })
        return { port, publicUrl: tunnel.publicUrl }
      })
      .finally(() => {
        this.pending.delete(port)
      })

    this.pending.set(port, attempt)
    return attempt
  }

  unexpose(port: number) {
    assertValidPort(port)
    const tunnel = this.tunnels.get(port)
    if (!tunnel) return { ok: true, port }
    this.tunnels.delete(port)
    tunnel.stop()
    this.record()
    this.log(`stopped exposing port ${port}`)
    return { ok: true, port }
  }

  stopAll() {
    for (const port of [...this.tunnels.keys()]) {
      this.unexpose(port)
    }
  }
}

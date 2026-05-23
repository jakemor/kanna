export interface PtyProcess {
  /** OS pid of the spawned child (== pgid because Bun.Terminal setsid). */
  pid: number
  sendInput(data: string): Promise<void>
  resize(cols: number, rows: number): void
  exited: Promise<number>
  /** Default terminate: SIGTERM (gives the child a chance to flush). */
  close(): void
  /**
   * Force kill (SIGKILL) — use after SIGTERM has had a grace window and
   * the process still hasn't exited. Bypasses any child cleanup.
   */
  kill(signal?: NodeJS.Signals | number): void
}

export interface SpawnPtyProcessArgs {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  onOutput?: (chunk: string) => void
}

export async function spawnPtyProcess(opts: SpawnPtyProcessArgs): Promise<PtyProcess> {
  if (typeof Bun.Terminal !== "function") {
    throw new Error("Bun.Terminal not available — requires Bun 1.3.5+")
  }

  const cols = opts.cols ?? 120
  const rows = opts.rows ?? 40

  const terminal = new Bun.Terminal({
    cols,
    rows,
    name: "xterm-256color",
    data: (_t, data) => {
      if (opts.onOutput) {
        const chunk = Buffer.from(data).toString("utf8")
        opts.onOutput(chunk)
      }
    },
  })

  const proc = Bun.spawn([opts.command, ...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal,
  })

  return {
    pid: proc.pid,
    async sendInput(data) { terminal.write(data) },
    resize(newCols, newRows) { terminal.resize(newCols, newRows) },
    exited: proc.exited,
    close() {
      try { terminal.close() } catch { /* swallow */ }
      try { proc.kill("SIGTERM") } catch { /* swallow */ }
    },
    kill(signal) {
      try { terminal.close() } catch { /* swallow */ }
      try { proc.kill(signal ?? "SIGKILL") } catch { /* swallow */ }
    },
  }
}

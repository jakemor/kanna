import path from "node:path"
import process from "node:process"
import defaultShell, { detectDefaultShell } from "default-shell"
import type { TerminalEvent, TerminalSnapshot } from "../shared/protocol"

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_SCROLLBACK = 1_000
const MIN_SCROLLBACK = 500
const MAX_SCROLLBACK = 5_000
const MAX_HISTORY_BYTES = 2_000_000

interface CreateTerminalArgs {
  projectPath: string
  terminalId: string
  cols: number
  rows: number
  scrollback: number
}

interface TerminalSession {
  terminalId: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  scrollback: number
  status: "running" | "exited"
  exitCode: number | null
  process: Bun.Subprocess | null
  terminal: Bun.Terminal
  history: string[]
  historyLineCount: number
  historyBytes: number
}

function clampScrollback(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_SCROLLBACK
  return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(value)))
}

function normalizeTerminalDimension(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

function resolveShell() {
  try {
    return detectDefaultShell()
  } catch {
    if (defaultShell) return defaultShell
    if (process.platform === "win32") {
      return process.env.ComSpec || "cmd.exe"
    }
    return process.env.SHELL || "/bin/sh"
  }
}

function resolveShellArgs(shellPath: string) {
  if (process.platform === "win32") {
    return []
  }

  const shellName = path.basename(shellPath)
  if (["bash", "zsh", "fish", "sh", "ksh"].includes(shellName)) {
    return ["-l"]
  }

  return []
}

function createTerminalEnv() {
  return {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }
}

function countNewlines(value: string) {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      count += 1
    }
  }
  return count
}

function trimHistory(session: TerminalSession) {
  while (
    session.history.length > 1 &&
    (session.historyLineCount > session.scrollback || session.historyBytes > MAX_HISTORY_BYTES)
  ) {
    const removed = session.history.shift()
    if (!removed) break
    session.historyLineCount -= countNewlines(removed)
    session.historyBytes -= Buffer.byteLength(removed, "utf8")
  }

  session.historyLineCount = Math.max(0, session.historyLineCount)
  session.historyBytes = Math.max(0, session.historyBytes)
}

function appendHistory(session: TerminalSession, chunk: string) {
  if (!chunk) return
  session.history.push(chunk)
  session.historyLineCount += countNewlines(chunk)
  session.historyBytes += Buffer.byteLength(chunk, "utf8")
  trimHistory(session)
}

function killTerminalProcessTree(subprocess: Bun.Subprocess | null) {
  if (!subprocess) return

  const pid = subprocess.pid
  if (typeof pid !== "number") return

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL")
      return
    } catch {
      // Fall back to killing only the shell process if group termination fails.
    }
  }

  try {
    subprocess.kill("SIGKILL")
  } catch {
    // Ignore subprocess shutdown errors during disposal.
  }
}

function signalTerminalProcessGroup(subprocess: Bun.Subprocess | null, signal: NodeJS.Signals) {
  if (!subprocess) return false

  const pid = subprocess.pid
  if (typeof pid !== "number") return false

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // Fall back to signaling only the shell if group signaling fails.
    }
  }

  try {
    subprocess.kill(signal)
    return true
  } catch {
    return false
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly listeners = new Set<(event: TerminalEvent) => void>()

  onEvent(listener: (event: TerminalEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  createTerminal(args: CreateTerminalArgs) {
    if (process.platform === "win32") {
      throw new Error("Embedded terminal is currently supported on macOS/Linux only.")
    }
    if (typeof Bun.Terminal !== "function") {
      throw new Error("Embedded terminal requires Bun 1.3.5+ with Bun.Terminal support.")
    }

    const existing = this.sessions.get(args.terminalId)
    if (existing) {
      existing.scrollback = clampScrollback(args.scrollback)
      existing.cols = normalizeTerminalDimension(args.cols, existing.cols)
      existing.rows = normalizeTerminalDimension(args.rows, existing.rows)
      existing.terminal.resize(existing.cols, existing.rows)
      trimHistory(existing)
      return this.snapshotOf(existing)
    }

    const shell = resolveShell()
    const cols = normalizeTerminalDimension(args.cols, DEFAULT_COLS)
    const rows = normalizeTerminalDimension(args.rows, DEFAULT_ROWS)
    const scrollback = clampScrollback(args.scrollback)
    const title = path.basename(shell) || "shell"

    const session: TerminalSession = {
      terminalId: args.terminalId,
      title,
      cwd: args.projectPath,
      shell,
      cols,
      rows,
      scrollback,
      status: "running",
      exitCode: null,
      process: null,
      history: [],
      historyLineCount: 0,
      historyBytes: 0,
      terminal: new Bun.Terminal({
        cols,
        rows,
        name: "xterm-256color",
        data: (_terminal, data) => {
          const chunk = Buffer.from(data).toString("utf8")
          appendHistory(session, chunk)
          this.emit({
            type: "terminal.output",
            terminalId: args.terminalId,
            data: chunk,
          })
        },
      }),
    }

    try {
      session.process = Bun.spawn([shell, ...resolveShellArgs(shell)], {
        cwd: args.projectPath,
        env: createTerminalEnv(),
        terminal: session.terminal,
      })
    } catch (error) {
      session.terminal.close()
      throw error
    }

    void session.process.exited.then((exitCode) => {
      const active = this.sessions.get(args.terminalId)
      if (!active) return
      active.status = "exited"
      active.exitCode = exitCode
      this.emit({
        type: "terminal.exit",
        terminalId: args.terminalId,
        exitCode,
      })
    }).catch((error) => {
      const active = this.sessions.get(args.terminalId)
      if (!active) return
      active.status = "exited"
      active.exitCode = 1
      this.emit({
        type: "terminal.output",
        terminalId: args.terminalId,
        data: `\r\n[terminal error] ${error instanceof Error ? error.message : String(error)}\r\n`,
      })
      this.emit({
        type: "terminal.exit",
        terminalId: args.terminalId,
        exitCode: 1,
      })
    })

    this.sessions.set(args.terminalId, session)
    return this.snapshotOf(session)
  }

  getSnapshot(terminalId: string): TerminalSnapshot | null {
    const session = this.sessions.get(terminalId)
    return session ? this.snapshotOf(session) : null
  }

  write(terminalId: string, data: string) {
    const session = this.sessions.get(terminalId)
    if (!session || session.status === "exited") return

    let cursor = 0

    while (cursor < data.length) {
      const ctrlCIndex = data.indexOf("\x03", cursor)

      if (ctrlCIndex === -1) {
        session.terminal.write(data.slice(cursor))
        return
      }

      if (ctrlCIndex > cursor) {
        session.terminal.write(data.slice(cursor, ctrlCIndex))
      }

      signalTerminalProcessGroup(session.process, "SIGINT")
      cursor = ctrlCIndex + 1
    }
  }

  resize(terminalId: string, cols: number, rows: number) {
    const session = this.sessions.get(terminalId)
    if (!session) return
    session.cols = normalizeTerminalDimension(cols, session.cols)
    session.rows = normalizeTerminalDimension(rows, session.rows)
    session.terminal.resize(session.cols, session.rows)
  }

  close(terminalId: string) {
    const session = this.sessions.get(terminalId)
    if (!session) return

    this.sessions.delete(terminalId)
    killTerminalProcessTree(session.process)
    session.terminal.close()
  }

  closeByCwd(cwd: string) {
    for (const [terminalId, session] of this.sessions.entries()) {
      if (session.cwd !== cwd) continue
      this.close(terminalId)
    }
  }

  closeAll() {
    for (const terminalId of this.sessions.keys()) {
      this.close(terminalId)
    }
  }

  private snapshotOf(session: TerminalSession): TerminalSnapshot {
    return {
      terminalId: session.terminalId,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      scrollback: session.scrollback,
      history: [...session.history],
      status: session.status,
      exitCode: session.exitCode,
    }
  }

  private emit(event: TerminalEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

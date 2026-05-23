import path from "node:path"
import process from "node:process"
import defaultShell, { detectDefaultShell } from "default-shell"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import type { TerminalEvent, TerminalSnapshot } from "../shared/protocol"
import type { TerminalPidRegistry } from "./terminal-pid-registry.adapter"
import { createBunTerminal, hasBunTerminal, spawnTerminalProcess } from "./terminal-manager-io.adapter"

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_SCROLLBACK = 1_000
const MIN_SCROLLBACK = 500
const MAX_SCROLLBACK = 5_000
const FOCUS_IN_SEQUENCE = "\x1b[I"
const FOCUS_OUT_SEQUENCE = "\x1b[O"
const MODE_SEQUENCE_TAIL_LENGTH = 16

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
  headless: Terminal
  serializeAddon: SerializeAddon
  focusReportingEnabled: boolean
  modeSequenceTail: string
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

function updateFocusReportingState(session: Pick<TerminalSession, "focusReportingEnabled" | "modeSequenceTail">, chunk: string) {
  const combined = session.modeSequenceTail + chunk
  const regex = /\x1b\[\?1004([hl])/g

  for (const match of combined.matchAll(regex)) {
    session.focusReportingEnabled = match[1] === "h"
  }

  session.modeSequenceTail = combined.slice(-MODE_SEQUENCE_TAIL_LENGTH)
}

function filterFocusReportInput(data: string, allowFocusReporting: boolean) {
  if (allowFocusReporting) {
    return data
  }

  return data.replaceAll(FOCUS_IN_SEQUENCE, "").replaceAll(FOCUS_OUT_SEQUENCE, "")
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

function reapShellPgroup(pid: number | undefined) {
  if (process.platform === "win32") return
  if (typeof pid !== "number" || pid <= 0) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // ESRCH (empty pgrp) and EPERM (race with kernel reap) are expected.
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
  private readonly pidRegistry: TerminalPidRegistry | null

  constructor(args: { pidRegistry?: TerminalPidRegistry | null } = {}) {
    this.pidRegistry = args.pidRegistry ?? null
  }

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
    if (!hasBunTerminal()) {
      throw new Error("Embedded terminal requires Bun 1.3.5+ with Bun.Terminal support.")
    }

    const existing = this.sessions.get(args.terminalId)
    if (existing) {
      existing.scrollback = clampScrollback(args.scrollback)
      existing.cols = normalizeTerminalDimension(args.cols, existing.cols)
      existing.rows = normalizeTerminalDimension(args.rows, existing.rows)
      existing.headless.options.scrollback = existing.scrollback
      existing.headless.resize(existing.cols, existing.rows)
      existing.terminal.resize(existing.cols, existing.rows)
      signalTerminalProcessGroup(existing.process, "SIGWINCH")
      return this.snapshotOf(existing)
    }

    const shell = resolveShell()
    const cols = normalizeTerminalDimension(args.cols, DEFAULT_COLS)
    const rows = normalizeTerminalDimension(args.rows, DEFAULT_ROWS)
    const scrollback = clampScrollback(args.scrollback)
    const title = path.basename(shell) || "shell"
    const headless = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    const serializeAddon = new SerializeAddon()
    headless.loadAddon(serializeAddon)

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
      terminal: createBunTerminal({
        cols,
        rows,
        name: "xterm-256color",
        data: (_terminal: unknown, data: Uint8Array) => {
          const chunk = Buffer.from(data).toString("utf8")
          updateFocusReportingState(session, chunk)
          headless.write(chunk)
          this.emit({
            type: "terminal.output",
            terminalId: args.terminalId,
            data: chunk,
          })
        },
      }),
      headless,
      serializeAddon,
      focusReportingEnabled: false,
      modeSequenceTail: "",
    }

    try {
      session.process = spawnTerminalProcess([shell, ...resolveShellArgs(shell)], {
        cwd: args.projectPath,
        env: createTerminalEnv(),
        terminal: session.terminal,
      })
    } catch (error) {
      session.terminal.close()
      session.serializeAddon.dispose()
      session.headless.dispose()
      throw error
    }
    const shellPid = session.process.pid
    if (typeof shellPid === "number") {
      void this.pidRegistry?.register({
        terminalId: args.terminalId,
        pid: shellPid,
        cwd: args.projectPath,
      })
    }
    const handleShellExit = () => {
      reapShellPgroup(shellPid)
      void this.pidRegistry?.unregister(args.terminalId)
    }
    void session.process.exited.then((exitCode) => {
      handleShellExit()
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
      handleShellExit()
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

    const filteredData = filterFocusReportInput(data, session.focusReportingEnabled)
    if (!filteredData) return

    let cursor = 0

    while (cursor < filteredData.length) {
      const ctrlCIndex = filteredData.indexOf("\x03", cursor)

      if (ctrlCIndex === -1) {
        session.terminal.write(filteredData.slice(cursor))
        return
      }

      if (ctrlCIndex > cursor) {
        session.terminal.write(filteredData.slice(cursor, ctrlCIndex))
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
    session.headless.resize(session.cols, session.rows)
    session.terminal.resize(session.cols, session.rows)
    signalTerminalProcessGroup(session.process, "SIGWINCH")
  }

  close(terminalId: string) {
    const session = this.sessions.get(terminalId)
    if (!session) return

    this.sessions.delete(terminalId)
    killTerminalProcessTree(session.process)
    void this.pidRegistry?.unregister(terminalId)
    session.terminal.close()
    session.serializeAddon.dispose()
    session.headless.dispose()
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
      serializedState: session.serializeAddon.serialize({ scrollback: session.scrollback }),
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

import path from "node:path"
import process from "node:process"
import { StringDecoder } from "node:string_decoder"
import defaultShell, { detectDefaultShell } from "default-shell"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import type { TerminalEvent, TerminalSnapshot, TerminalTailResult } from "../shared/protocol"

const DEFAULT_COLS = 80
/**
 * Characters of recent output kept per terminal for `terminal.tail`. A hidden
 * pane that comes back within this much output gets only the gap; past it,
 * the client falls back to a full `serializedState` replay. Max scrollback is
 * 5,000 lines, so one screenful of history per line is more than enough.
 */
const OUTPUT_LOG_LIMIT = 1_000_000
/** Segment size for the log; 64 KB keeps a full log under 16 segments. */
const OUTPUT_LOG_SEGMENT_CHARS = 65_536
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
  /**
   * Stateful UTF-8 decoder for PTY output. PTY reads split at arbitrary byte
   * offsets, so a decoder that carries incomplete trailing sequences across
   * chunks is required — a per-chunk `Buffer.toString("utf8")` turns every
   * multi-byte character straddling a read boundary into U+FFFD.
   */
  decoder: StringDecoder
  output: TerminalOutputLog
  focusReportingEnabled: boolean
  modeSequenceTail: string
}

/**
 * Recent PTY output, addressed by a version that only grows. The version is a
 * running character count, so the client can check that a tail lines up with
 * what it already wrote (`start === written`) instead of trusting order.
 */
export class TerminalOutputLog {
  /**
   * Output packed into segments of up to `segmentSize` chars. One object per
   * PTY read would let a slow trickle (a byte every few ms) hold a million
   * tiny objects inside a "1 MB" budget; packing bounds the object count to
   * limit / segmentSize.
   */
  private chunks: Array<{ start: number; data: string }> = []
  private retained = 0
  /** Output count after the newest chunk. */
  version = 0
  /** Oldest version a tail can start from. */
  private oldest = 0

  constructor(private readonly limit = OUTPUT_LOG_LIMIT, private readonly segmentSize = OUTPUT_LOG_SEGMENT_CHARS) {}

  append(data: string) {
    if (!data) return this.version
    const last = this.chunks[this.chunks.length - 1]
    if (last && last.data.length + data.length <= this.segmentSize) {
      last.data += data
    } else {
      this.chunks.push({ start: this.version, data })
    }
    this.version += data.length
    this.retained += data.length
    while (this.retained > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.retained -= dropped.data.length
      this.oldest = dropped.start + dropped.data.length
    }
    return this.version
  }

  /** Exposed for tests: how many segments are held. */
  get segmentCount() {
    return this.chunks.length
  }

  /** Output after `sinceVersion`, or null when it is already gone or ahead of us. */
  tailSince(sinceVersion: number): string | null {
    if (!Number.isInteger(sinceVersion) || sinceVersion < this.oldest || sinceVersion > this.version) return null
    if (sinceVersion === this.version) return ""
    let out = ""
    for (const chunk of this.chunks) {
      const end = chunk.start + chunk.data.length
      if (end <= sinceVersion) continue
      out += chunk.start >= sinceVersion ? chunk.data : chunk.data.slice(sinceVersion - chunk.start)
    }
    return out
  }
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

// Matches the locale suffixes that imply a multi-byte-capable charmap. Same
// test VS Code uses for `terminal.integrated.detectLocale`.
const UTF8_LOCALE_PATTERN = /(\.utf-?8|\.euc.+)$/i

/**
 * The embedded terminal only transports UTF-8, but a shell launched under a
 * `C`/`POSIX` locale makes programs transliterate non-ASCII to literal `?`
 * before the bytes ever reach us. Guarantee a UTF-8 locale when the inherited
 * environment doesn't already specify one.
 *
 * POSIX precedence is LC_ALL > LC_CTYPE > LANG, so setting LANG alone (what
 * VS Code does) is not enough — an inherited `LC_ALL=C` would still win.
 */
export function applyUtf8Locale(env: Record<string, string | undefined>) {
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (effective && UTF8_LOCALE_PATTERN.test(effective)) return env

  // C.UTF-8 always exists on glibc/musl without locale generation; macOS ships
  // en_US.UTF-8 but has no C.UTF-8.
  const fallback = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
  // Replace only the variables actually forcing ASCII, so a user's deliberate
  // regional choice (`LANG=de_DE.UTF-8` under an inherited `LC_ALL=C`) survives.
  if (!env.LANG || !UTF8_LOCALE_PATTERN.test(env.LANG)) env.LANG = fallback
  if (env.LC_ALL && !UTF8_LOCALE_PATTERN.test(env.LC_ALL)) env.LC_ALL = fallback
  if (env.LC_CTYPE && !UTF8_LOCALE_PATTERN.test(env.LC_CTYPE)) env.LC_CTYPE = fallback
  return env
}

function createTerminalEnv() {
  return applyUtf8Locale({
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    // Lets a shell rc tell "running inside Kanna" from a normal terminal, the
    // way VS Code's TERM_PROGRAM=vscode does. The one lever a user has for a
    // setup this terminal can't host — an rc that execs into another shell,
    // say — is to condition on it.
    TERM_PROGRAM: "kanna",
    KANNA_TERMINAL: "1",
  })
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

  /**
   * Single entry point for PTY bytes. Kept as a method (rather than inlined in
   * the `Bun.Terminal` config) so tests can drive it with deliberately split
   * chunks — the real PTY gives no control over where reads land.
   *
   * The decode is stateful: bytes of a partially received character are held
   * back and prepended to the next chunk. Both consumers below take that same
   * string, so xterm only ever sees one decoder's output.
   */
  private handlePtyOutput(session: TerminalSession, data: Uint8Array) {
    const chunk = session.decoder.write(Buffer.from(data))
    if (!chunk) return
    updateFocusReportingState(session, chunk)
    this.appendOutput(session, chunk)
  }

  /**
   * Every byte the client may see goes through here, so the shadow terminal,
   * the tail log and the event stream never disagree about the version.
   */
  private appendOutput(session: TerminalSession, chunk: string) {
    session.headless.write(chunk)
    const version = session.output.append(chunk)
    this.emit({
      type: "terminal.output",
      terminalId: session.terminalId,
      data: chunk,
      version,
    })
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
    // Without this xterm runs Unicode 6 width tables, where every astral emoji
    // measures 1 cell instead of 2. Programs size their output with a modern
    // wcwidth, so the mismatch shifts everything after a wide character.
    // Must stay in step with the client terminal or snapshot replay desyncs.
    headless.loadAddon(new Unicode11Addon())
    headless.unicode.activeVersion = "11"
    const decoder = new StringDecoder("utf8")

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
      terminal: new Bun.Terminal({
        cols,
        rows,
        name: "xterm-256color",
        data: (_terminal, data) => {
          this.handlePtyOutput(session, data)
        },
      }),
      headless,
      serializeAddon,
      decoder,
      output: new TerminalOutputLog(),
      focusReportingEnabled: false,
      modeSequenceTail: "",
    }

    try {
      session.process = Bun.spawn([shell, ...resolveShellArgs(shell)], {
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
    session.terminal.close()
    session.serializeAddon.dispose()
    session.headless.dispose()
  }

  closeAll() {
    for (const terminalId of this.sessions.keys()) {
      this.close(terminalId)
    }
  }

  getRootPidsByCwd(cwd: string) {
    const pids: number[] = []
    for (const session of this.sessions.values()) {
      if (session.cwd !== cwd || session.status !== "running") continue
      const pid = session.process?.pid
      if (typeof pid === "number") {
        pids.push(pid)
      }
    }
    return pids
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
      outputVersion: session.output.version,
    }
  }

  /**
   * Output since `sinceVersion` for a pane that stopped listening while it was
   * hidden. Falls back to a full snapshot when the gap has left the log, or
   * when the client has no version to resume from.
   */
  getTail(terminalId: string, sinceVersion: number | null): TerminalTailResult | null {
    const session = this.sessions.get(terminalId)
    if (!session) return null
    const tail = sinceVersion === null ? null : session.output.tailSince(sinceVersion)
    if (tail === null) {
      return { terminalId, tail: null, snapshot: this.snapshotOf(session) }
    }
    return { terminalId, tail: { data: tail, version: session.output.version }, snapshot: null }
  }

  private emit(event: TerminalEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

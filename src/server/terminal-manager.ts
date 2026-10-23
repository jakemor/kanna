import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { Context, Effect, Exit, Layer, PubSub, Schema, Scope, Stream } from "effect"
import type { TerminalEvent, TerminalSnapshot, TerminalTailResult } from "../shared/protocol"
import { Machine } from "./platform/machine"
import { PtySpawner, type PtyProcess } from "./platform/pty"

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

export interface CreateTerminalArgs {
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
  /** The shell on its PTY. */
  pty: PtyProcess
  /** Owns the PTY: closing it kills the shell if still running and closes the terminal. */
  scope: Scope.Closeable
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

  get retainedCharacters() { return this.retained }

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


/** The login shell, from the user's account, else the platform's default. */
const resolveShell = Effect.fn("Terminals.resolveShell")(function* (machine: Machine["Service"]) {
  const shell = yield* machine.userShell
  if (shell) return shell
  if (machine.platform === "win32") {
    return machine.env.get("ComSpec") || "cmd.exe"
  }
  return machine.env.get("SHELL") || "/bin/sh"
})

function resolveShellArgs(shellPath: string, platform: NodeJS.Platform) {
  if (platform === "win32") {
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
export function applyUtf8Locale(env: Record<string, string | undefined>, platform: NodeJS.Platform) {
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (effective && UTF8_LOCALE_PATTERN.test(effective)) return env

  // C.UTF-8 always exists on glibc/musl without locale generation; macOS ships
  // en_US.UTF-8 but has no C.UTF-8.
  const fallback = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
  // Replace only the variables actually forcing ASCII, so a user's deliberate
  // regional choice (`LANG=de_DE.UTF-8` under an inherited `LC_ALL=C`) survives.
  if (!env.LANG || !UTF8_LOCALE_PATTERN.test(env.LANG)) env.LANG = fallback
  if (env.LC_ALL && !UTF8_LOCALE_PATTERN.test(env.LC_ALL)) env.LC_ALL = fallback
  if (env.LC_CTYPE && !UTF8_LOCALE_PATTERN.test(env.LC_CTYPE)) env.LC_CTYPE = fallback
  return env
}

function createTerminalEnv(machine: Machine["Service"]) {
  return applyUtf8Locale({
    ...machine.env.snapshot(),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    // Lets a shell rc tell "running inside Kanna" from a normal terminal, the
    // way VS Code's TERM_PROGRAM=vscode does. The one lever a user has for a
    // setup this terminal can't host — an rc that execs into another shell,
    // say — is to condition on it.
    TERM_PROGRAM: "kanna",
    KANNA_TERMINAL: "1",
  }, machine.platform)
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

/** Embedded terminals can't run here (Windows, or a platform without PTYs). */
export class TerminalUnsupportedError extends Schema.TaggedError<TerminalUnsupportedError>()(
  "@kanna/server/terminal-manager/TerminalUnsupportedError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

/** The shell could not be started. The message is the spawn error's own. */
export class TerminalSpawnError extends Schema.TaggedError<TerminalSpawnError>()(
  "@kanna/server/terminal-manager/TerminalSpawnError",
  {
    terminalId: Schema.String,
    shell: Schema.String,
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/**
 * Keystrokes for a session. Ctrl+C is sent to the process group as SIGINT
 * rather than written, so a foreground job dies even when it has the PTY in
 * raw mode. Exported for tests.
 */
export const writeToSession = Effect.fn("Terminals.writeToSession")(function* (
  session: Pick<TerminalSession, "status" | "focusReportingEnabled"> & {
    pty: Pick<PtyProcess, "write" | "signalGroup">
  },
  data: string,
) {
  if (session.status === "exited") return

  const filteredData = filterFocusReportInput(data, session.focusReportingEnabled)
  if (!filteredData) return

  let cursor = 0

  while (cursor < filteredData.length) {
    const ctrlCIndex = filteredData.indexOf("\x03", cursor)

    // A failed write is a defect, as the PTY's throw was.
    if (ctrlCIndex === -1) {
      yield* session.pty.write(filteredData.slice(cursor)).pipe(Effect.orDie)
      return
    }

    if (ctrlCIndex > cursor) {
      yield* session.pty.write(filteredData.slice(cursor, ctrlCIndex)).pipe(Effect.orDie)
    }

    yield* session.pty.signalGroup("SIGINT")
    cursor = ctrlCIndex + 1
  }
})

/** Resizes the PTY and the shadow terminal together, then tells the shell. Exported for tests. */
export const resizeSession = Effect.fn("Terminals.resizeSession")(function* (
  session: Pick<TerminalSession, "cols" | "rows"> & {
    headless: Pick<Terminal, "resize">
    pty: Pick<PtyProcess, "resize" | "signalGroup">
  },
  cols: number,
  rows: number,
) {
  session.cols = normalizeTerminalDimension(cols, session.cols)
  session.rows = normalizeTerminalDimension(rows, session.rows)
  session.headless.resize(session.cols, session.rows)
  yield* session.pty.resize(session.cols, session.rows)
  yield* session.pty.signalGroup("SIGWINCH")
})

/**
 * Single entry point for PTY bytes. Kept apart from the PTY's `onData` so
 * tests can drive it with deliberately split chunks — the real PTY gives no
 * control over where reads land. Plain code: the PTY calls it synchronously,
 * outside any fiber.
 *
 * The decode is stateful: bytes of a partially received character are held
 * back and prepended to the next chunk. The shadow terminal, the tail log and
 * the event take that same string, so they never disagree about the version.
 */
export function handlePtyOutput(
  session: Pick<TerminalSession, "terminalId" | "decoder" | "output" | "focusReportingEnabled" | "modeSequenceTail"> & {
    headless: Pick<Terminal, "write">
  },
  data: Uint8Array,
  emit: (event: TerminalEvent) => void,
) {
  const chunk = session.decoder.write(Buffer.from(data))
  if (!chunk) return
  updateFocusReportingState(session, chunk)
  session.headless.write(chunk)
  const version = session.output.append(chunk)
  emit({
    type: "terminal.output",
    terminalId: session.terminalId,
    data: chunk,
    version,
  })
}

/**
 * The shadow terminal a session's state is serialized from. Exported for
 * tests.
 */
export function createHeadlessTerminal(cols: number, rows: number, scrollback: number) {
  const headless = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  const serializeAddon = new SerializeAddon()
  headless.loadAddon(serializeAddon)
  // Without this xterm runs Unicode 6 width tables, where every astral emoji
  // measures 1 cell instead of 2. Programs size their output with a modern
  // wcwidth, so the mismatch shifts everything after a wide character.
  // Must stay in step with the client terminal or snapshot replay desyncs.
  headless.loadAddon(new Unicode11Addon())
  headless.unicode.activeVersion = "11"
  return { headless, serializeAddon }
}

function snapshotOf(session: TerminalSession): TerminalSnapshot {
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

function disposeShadow(session: Pick<TerminalSession, "serializeAddon" | "headless">) {
  session.serializeAddon.dispose()
  session.headless.dispose()
}

/** Closes the PTY (and its terminal), then the shadow terminal. */
const disposeSession = (session: TerminalSession) =>
  Scope.close(session.scope, Exit.void).pipe(Effect.andThen(Effect.sync(() => disposeShadow(session))))

export interface TerminalResourceCounts {
  terminalSessions: number
  runningTerminals: number
  terminalOutputCharacters: number
}

/**
 * The embedded terminals: one PTY-backed shell per terminal id, mirrored
 * into a headless xterm so a pane that (re)subscribes gets the screen as it
 * is. Every shell is killed when the layer closes.
 *
 * `events` carries output and exits from the moment of subscribing; it never
 * replays. Read `snapshot` or `tail` for what came before.
 */
export class Terminals extends Context.Service<Terminals, {
  readonly events: Stream.Stream<TerminalEvent>
  /** Starts the terminal, or resizes the running one with that id. */
  readonly create: (args: CreateTerminalArgs) => Effect.Effect<TerminalSnapshot, TerminalUnsupportedError | TerminalSpawnError>
  readonly snapshot: (terminalId: string) => Effect.Effect<TerminalSnapshot | null>
  readonly write: (terminalId: string, data: string) => Effect.Effect<void>
  readonly resize: (terminalId: string, cols: number, rows: number) => Effect.Effect<void>
  readonly close: (terminalId: string) => Effect.Effect<void>
  /**
   * Output since `sinceVersion` for a pane that stopped listening while it
   * was hidden. Falls back to a full snapshot when the gap has left the log,
   * or when the client has no version to resume from.
   */
  readonly tail: (terminalId: string, sinceVersion: number | null) => Effect.Effect<TerminalTailResult | null>
  /** The shells still running in `cwd`, for telling a project's own servers apart. */
  readonly rootPidsByCwd: (cwd: string) => Effect.Effect<ReadonlyArray<number>>
  readonly resourceCounts: Effect.Effect<TerminalResourceCounts>
}>()("@kanna/server/Terminals") {
  static readonly layer = Layer.effect(this, Effect.suspend(() => makeTerminals()))
}

const makeTerminals = Effect.fn("Terminals.make")(function* () {
  const machine = yield* Machine
  const ptys = yield* PtySpawner
  // Sessions are touched from PTY callbacks, which run outside any fiber, so
  // they live in a plain map rather than a Ref.
  const sessions = new Map<string, TerminalSession>()
  const events = yield* PubSub.unbounded<TerminalEvent>()
  const emit = (event: TerminalEvent) => {
    PubSub.publishUnsafe(events, event)
  }
  const layerScope = yield* Effect.scope

  const close = Effect.fn("Terminals.close")(function* (terminalId: string) {
    const session = sessions.get(terminalId)
    if (!session) return
    sessions.delete(terminalId)
    yield* session.pty.signalGroup("SIGKILL")
    yield* disposeSession(session)
  })

  // Shutdown kills every shell; then subscribers see the stream end.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], (terminalId) => close(terminalId), { discard: true }).pipe(
      Effect.andThen(PubSub.shutdown(events)),
    ))

  /** Marks the session exited when its shell ends, unless it was closed first. */
  const watchExit = (terminalId: string, pty: PtyProcess) =>
    pty.exited.pipe(
      Effect.flatMap(({ code: exitCode }) => Effect.sync(() => {
        const active = sessions.get(terminalId)
        if (!active) return
        active.status = "exited"
        active.exitCode = exitCode
        emit({ type: "terminal.exit", terminalId, exitCode })
      })),
      Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (error) => Effect.sync(() => {
        const active = sessions.get(terminalId)
        if (!active) return
        active.status = "exited"
        active.exitCode = 1
        const cause = error.cause
        emit({
          type: "terminal.output",
          terminalId,
          data: `\r\n[terminal error] ${cause instanceof Error ? cause.message : String(cause)}\r\n`,
        })
        emit({ type: "terminal.exit", terminalId, exitCode: 1 })
      })),
    )

  const create = Effect.fn("Terminals.create")(function* (args: CreateTerminalArgs) {
    yield* Effect.annotateCurrentSpan("terminalId", args.terminalId)
    if (machine.platform === "win32") {
      return yield* new TerminalUnsupportedError({ reason: "Embedded terminal is currently supported on macOS/Linux only." })
    }
    if (!ptys.available) {
      return yield* new TerminalUnsupportedError({ reason: "Embedded terminal requires Bun 1.3.5+ with PTY support." })
    }

    const existing = sessions.get(args.terminalId)
    if (existing) {
      existing.scrollback = clampScrollback(args.scrollback)
      existing.cols = normalizeTerminalDimension(args.cols, existing.cols)
      existing.rows = normalizeTerminalDimension(args.rows, existing.rows)
      existing.headless.options.scrollback = existing.scrollback
      existing.headless.resize(existing.cols, existing.rows)
      yield* existing.pty.resize(existing.cols, existing.rows)
      yield* existing.pty.signalGroup("SIGWINCH")
      return snapshotOf(existing)
    }

    const shell = yield* resolveShell(machine)
    const cols = normalizeTerminalDimension(args.cols, DEFAULT_COLS)
    const rows = normalizeTerminalDimension(args.rows, DEFAULT_ROWS)
    const scrollback = clampScrollback(args.scrollback)
    const title = path.basename(shell) || "shell"
    const { headless, serializeAddon } = createHeadlessTerminal(cols, rows, scrollback)

    // Everything but the PTY, which needs this object for its output.
    const shadow = {
      terminalId: args.terminalId,
      title,
      cwd: args.projectPath,
      shell,
      cols,
      rows,
      scrollback,
      status: "running" as TerminalSession["status"],
      exitCode: null as number | null,
      headless,
      serializeAddon,
      decoder: new StringDecoder("utf8"),
      output: new TerminalOutputLog(),
      focusReportingEnabled: false,
      modeSequenceTail: "",
    }

    // The PTY outlives the request that created it. Its scope stands alone
    // rather than under the layer's, so only close() ends it, and shutdown
    // keeps the order close() has: SIGKILL the group, then close the PTY.
    // Closing the PTY first hangs up the shell, which then exits on its own
    // and the SIGKILL lands mid-exit (in the tests, the next shell then
    // stalls at startup).
    const scope = yield* Scope.make()
    const pty = yield* ptys.spawn([shell, ...resolveShellArgs(shell, machine.platform)], {
      cwd: args.projectPath,
      env: createTerminalEnv(machine),
      cols,
      rows,
      name: "xterm-256color",
      onData: (data) => {
        handlePtyOutput(shadow, data, emit)
      },
    }).pipe(
      Scope.provide(scope),
      Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (error) =>
        Effect.fail(new TerminalSpawnError({ terminalId: args.terminalId, shell, cwd: args.projectPath, cause: error.cause }))),
      Effect.tapError(() => Scope.close(scope, Exit.void).pipe(Effect.andThen(Effect.sync(() => disposeShadow(shadow))))),
    )
    const session: TerminalSession = Object.assign(shadow, { pty, scope })
    // The watch, like the PTY, belongs to the layer.
    yield* watchExit(args.terminalId, pty).pipe(Effect.forkIn(layerScope))

    sessions.set(args.terminalId, session)
    return snapshotOf(session)
  })

  const write = Effect.fn("Terminals.write")(function* (terminalId: string, data: string) {
    const session = sessions.get(terminalId)
    if (!session) return
    yield* writeToSession(session, data)
  })

  const resize = Effect.fn("Terminals.resize")(function* (terminalId: string, cols: number, rows: number) {
    const session = sessions.get(terminalId)
    if (!session) return
    yield* resizeSession(session, cols, rows)
  })

  return {
    events: Stream.fromPubSub(events),
    create,
    snapshot: (terminalId: string) => Effect.sync(() => {
      const session = sessions.get(terminalId)
      return session ? snapshotOf(session) : null
    }),
    write,
    resize,
    close,
    tail: (terminalId: string, sinceVersion: number | null) => Effect.sync((): TerminalTailResult | null => {
      const session = sessions.get(terminalId)
      if (!session) return null
      const tail = sinceVersion === null ? null : session.output.tailSince(sinceVersion)
      if (tail === null) {
        return { terminalId, tail: null, snapshot: snapshotOf(session) }
      }
      return { terminalId, tail: { data: tail, version: session.output.version }, snapshot: null }
    }),
    rootPidsByCwd: (cwd: string) => Effect.sync(() => {
      const pids: number[] = []
      for (const session of sessions.values()) {
        if (session.cwd !== cwd || session.status !== "running") continue
        const pid = session.pty.pid
        if (typeof pid === "number") {
          pids.push(pid)
        }
      }
      return pids
    }),
    resourceCounts: Effect.sync((): TerminalResourceCounts => {
      const all = [...sessions.values()]
      return {
        terminalSessions: all.length,
        runningTerminals: all.filter((session) => session.status === "running").length,
        terminalOutputCharacters: all.reduce((sum, session) => sum + session.output.retainedCharacters, 0),
      }
    }),
  }
})

import { Context, type Effect, type Scope } from "effect"
import type { CommandSpawnError, ProcessExit, ProcessSignal } from "./process-spawner"

export interface PtySpawnOptions {
  readonly cwd?: string
  /** The child's whole environment. Without it the child gets the machine's (`Machine.env`). */
  readonly env?: Record<string, string | undefined>
  readonly cols: number
  readonly rows: number
  /** The terminal type the PTY reports, e.g. "xterm-256color". */
  readonly name?: string
  /**
   * Every chunk the PTY produces, called synchronously as it is read, outside
   * any fiber. Chunks split wherever the reads land, mid-character included.
   */
  readonly onData: (data: Uint8Array) => void
}

/** A process on a pseudo-terminal: an embedded shell, or a login CLI that needs a TTY. */
export interface PtyProcess {
  readonly pid: number | undefined
  /** Writes to the terminal, as typed input. Fails once the terminal is closed. */
  readonly write: (data: string) => Effect.Effect<void, CommandSpawnError>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void>
  /**
   * Signals the process's whole process group, falling back to the process
   * alone when the group can't be signalled (or on Windows). Succeeds with
   * whether either took.
   */
  readonly signalGroup: (signal: ProcessSignal) => Effect.Effect<boolean>
  /** Signals the process (default SIGTERM) if it is still running. Never fails. */
  readonly kill: (signal?: ProcessSignal) => Effect.Effect<void>
  /** Waits for the process to exit. Fails when the wait itself fails. */
  readonly exited: Effect.Effect<ProcessExit, CommandSpawnError>
  readonly running: Effect.Effect<boolean>
  /** Closes the terminal device. Closing twice does nothing. */
  readonly close: Effect.Effect<void>
}

/**
 * Starts processes on a PTY on the machine. `available` is false where the
 * binding can't (Windows, a Bun without `Bun.Terminal`); callers check it to
 * explain why in their own words.
 */
export class PtySpawner extends Context.Service<PtySpawner, {
  readonly available: boolean
  /**
   * Starts `argv` on a new PTY. Closing the scope kills the process if it is
   * still running and closes the terminal.
   */
  readonly spawn: (
    argv: ReadonlyArray<string>,
    options: PtySpawnOptions,
  ) => Effect.Effect<PtyProcess, CommandSpawnError, Scope.Scope>
}>()("@kanna/server/platform/PtySpawner") {}

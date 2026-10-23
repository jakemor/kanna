import { Context, Effect, Schema, type Scope, type Stream } from "effect"

/**
 * A command that could not be started, or whose output could not be read.
 * The tag keeps its original module name: callers across the server catch it
 * by that string.
 */
export class CommandSpawnError extends Schema.TaggedError<CommandSpawnError>()(
  "@kanna/server/process-utils/CommandSpawnError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The message process-utils has always shown for a spawn failure: "Command
 * not found: x" for a missing executable. `ProcessSpawner.spawn` keeps the
 * platform's own message instead; callers that showed this one re-message
 * the error's `cause` with it.
 */
export function describeSpawnFailure(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return `Failed to start ${command}`
  }
  if ("code" in error && error.code === "ENOENT") {
    return `Command not found: ${command}`
  }
  return error.message || `Failed to start ${command}`
}

export type ProcessSignal = NodeJS.Signals

/** How a child's stdin starts: closed, open for `writeStdin`, or this text/bytes then closed. */
export type ProcessStdin = "ignore" | "inherit" | "pipe" | string | Uint8Array
export type ProcessOutput = "ignore" | "inherit" | "pipe"

export interface ProcessSpawnOptions {
  readonly cwd?: string
  /** The child's whole environment. Without it the child gets the machine's (`Machine.env`). */
  readonly env?: Record<string, string | undefined>
  /** Default "ignore". */
  readonly stdin?: ProcessStdin
  /** Default "ignore". */
  readonly stdout?: ProcessOutput
  /** Default "ignore". */
  readonly stderr?: ProcessOutput
}

export interface ProcessExit {
  /** What Bun's `exited` resolves to: the exit code, or 128 + n when signal n ended it. */
  readonly code: number
  /** The exit code; null when a signal ended the process. */
  readonly exitCode: number | null
  /** The signal that ended the process, if one did. */
  readonly signalCode: ProcessSignal | null
}

/**
 * A running child process on the machine. Belongs to the scope it was
 * spawned in: closing that scope kills it if it is still running.
 */
export interface SpawnedProcess {
  readonly command: string
  readonly pid: number | undefined
  /**
   * What the child writes to stdout, as it arrives. Empty unless stdout was
   * piped. Run it once: a second run sees nothing. Bytes written before
   * anyone runs it are buffered, not lost.
   */
  readonly stdout: Stream.Stream<Uint8Array, CommandSpawnError>
  /** stderr, the same way. */
  readonly stderr: Stream.Stream<Uint8Array, CommandSpawnError>
  /** Writes to a piped stdin. */
  readonly writeStdin: (chunk: string | Uint8Array) => Effect.Effect<void, CommandSpawnError>
  /** Closes a piped stdin. Closing twice, or a non-piped stdin, does nothing. */
  readonly endStdin: Effect.Effect<void>
  /** Waits for the process to exit. */
  readonly exited: Effect.Effect<ProcessExit>
  /** Whether it has neither exited nor been ended by a signal, right now. */
  readonly running: Effect.Effect<boolean>
  /** Signals it (default SIGTERM) if it is still running. Never fails. */
  readonly kill: (signal?: ProcessSignal) => Effect.Effect<void>
}

/**
 * Starts processes on the machine: git, gh, the agent CLIs, shells. Locally
 * that is this computer (`platform/bun`); a hosted binding forwards to the
 * container that holds the repos.
 */
export class ProcessSpawner extends Context.Service<ProcessSpawner, {
  /**
   * Starts `argv` (`argv[0]` is the command, resolved on the child's PATH).
   * Fails with the spawn error's own message, e.g. `Executable not found in
   * $PATH: "grok"`, which callers show users as it is.
   */
  readonly spawn: (
    argv: ReadonlyArray<string>,
    options?: ProcessSpawnOptions,
  ) => Effect.Effect<SpawnedProcess, CommandSpawnError, Scope.Scope>
  /**
   * Starts `command` detached from this process (an editor, a file manager,
   * a browser) and succeeds once it has started. It is never waited on or
   * killed.
   */
  readonly spawnDetached: (command: string, args: ReadonlyArray<string>) => Effect.Effect<void, CommandSpawnError>
}>()("@kanna/server/platform/ProcessSpawner") {}

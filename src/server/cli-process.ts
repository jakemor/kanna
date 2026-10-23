import { Effect, Fiber, Option, Result, Schema, Stream, type Scope } from "effect"
import { type CommandSpawnError, ProcessSpawner } from "./platform/process-spawner"

/**
 * A provider CLI run for one turn or one query (Cursor's `cursor-agent`,
 * Grok Build's `grok`): its output as text, its exit, and a way to signal it.
 * The process belongs to the scope it was spawned in and is killed when that
 * scope closes.
 */
export interface CliProcess {
  /** stdout as text, until the pipe closes. A pipe that errors as the process dies just ends. */
  readonly stdout: Stream.Stream<string>
  /** stderr as text, the same way. */
  readonly stderr: Stream.Stream<string>
  /** Waits for the process to exit: its exit code, or null when a signal ended it. */
  readonly exitCode: Effect.Effect<number | null>
  readonly kill: (signal?: NodeJS.Signals) => Effect.Effect<void>
}

export interface CliSpawnArgs {
  readonly cwd: string
  readonly argv: ReadonlyArray<string>
  /** Written to stdin, which is then closed. Without it stdin is closed from the start. */
  readonly stdin?: string
}

export type SpawnCli = (args: CliSpawnArgs) => Effect.Effect<CliProcess, CommandSpawnError, Scope.Scope>

/**
 * A spawner for `command` with the machine's environment, bound to the
 * machine's `ProcessSpawner`. The error's message is the spawn error's own
 * (e.g. `Executable not found in $PATH: "grok"`), which the adapters show the
 * user as the turn's error, as they did before.
 */
export const spawnCli = Effect.fn("CliProcess.make")(function* (command: string) {
  const spawner = yield* ProcessSpawner
  const spawn: SpawnCli = Effect.fn("CliProcess.spawn")(function* (args: CliSpawnArgs) {
    yield* Effect.annotateCurrentSpan("command", command)
    const proc = yield* spawner.spawn([command, ...args.argv], {
      cwd: args.cwd,
      stdin: args.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      stdout: pipeText(proc.stdout),
      stderr: pipeText(proc.stderr),
      exitCode: proc.exited.pipe(Effect.map((exit) => exit.exitCode)),
      kill: proc.kill,
    } satisfies CliProcess
  })
  return spawn
})

/** A pipe as text; a pipe that errors as the process dies just ends. */
const pipeText = (stream: Stream.Stream<Uint8Array, CommandSpawnError>) =>
  stream.pipe(
    Stream.decodeText,
    Stream.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Stream.empty),
  )

export interface CliOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/** Reads both pipes to the end and waits for the exit, as node's `close` event did. */
export const collectCliOutput = Effect.fn("CliProcess.collectOutput")(function* (proc: CliProcess) {
  const stderr = yield* Stream.mkString(proc.stderr).pipe(Effect.forkChild)
  const stdout = yield* Stream.mkString(proc.stdout)
  const exitCode = yield* proc.exitCode
  return { stdout, stderr: yield* Fiber.join(stderr), exitCode } satisfies CliOutput
})

/**
 * Runs a provider CLI's turn in the background of the caller's scope, the
 * way the adapters' node event handlers did: each stdout line goes to
 * `onLine` as it arrives, whether or not anyone reads the turn's events yet,
 * and `onExit` runs once the process has exited and both pipes have drained
 * (node's `close`). A process that fails to start goes straight to `onExit`
 * with no code and the spawn error's message as its stderr, as node's `error`
 * event did. Closing the scope stops all of it and kills the process.
 *
 * Succeeds with the process, or none when it failed to start.
 */
export const pumpCliTurn = Effect.fn("CliProcess.pumpTurn")(function* (options: {
  readonly spawn: Effect.Effect<CliProcess, CommandSpawnError, Scope.Scope>
  readonly onLine: (line: string) => Effect.Effect<void>
  readonly onExit: (exit: { readonly code: number | null; readonly stderr: string }) => Effect.Effect<void>
}) {
  const spawned = yield* Effect.result(options.spawn)
  if (Result.isFailure(spawned)) {
    yield* Effect.forkScoped(options.onExit({ code: null, stderr: `\n${spawned.failure.message}` }))
    return Option.none<CliProcess>()
  }
  const proc = spawned.success
  yield* Effect.gen(function* () {
    const stderr = yield* Stream.mkString(proc.stderr).pipe(Effect.forkChild)
    yield* proc.stdout.pipe(Stream.splitLines, Stream.runForEach(options.onLine))
    const code = yield* proc.exitCode
    yield* options.onExit({ code, stderr: yield* Fiber.join(stderr) })
  }).pipe(Effect.forkScoped)
  return Option.some(proc)
})

/**
 * A field of a CLI's JSON event, decoded conservatively: a value of another
 * type (a newer CLI changing a field) reads as absent instead of failing the
 * whole line. Structs ignore fields they don't declare, so new fields pass.
 */
export const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)))

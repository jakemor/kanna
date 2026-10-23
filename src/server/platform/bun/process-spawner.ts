import { spawn } from "node:child_process"
import process from "node:process"
import { Effect, Layer, Result, Stream } from "effect"
import {
  CommandSpawnError,
  describeSpawnFailure,
  ProcessSpawner,
  type ProcessExit,
  type ProcessOutput,
  type ProcessSignal,
  type ProcessSpawnOptions,
  type ProcessStdin,
  type SpawnedProcess,
} from "../process-spawner"

const detachedSpawnError = (command: string, cause: unknown) =>
  new CommandSpawnError({ command, message: describeSpawnFailure(command, cause), cause })

/** Bun.spawn's own message (`Executable not found in $PATH: "grok"`), which callers show as it is. */
const spawnError = (command: string, cause: unknown) =>
  new CommandSpawnError({
    command,
    message: cause instanceof Error ? cause.message : `Failed to start ${command}`,
    cause,
  })

const outputError = (command: string, cause: unknown) =>
  new CommandSpawnError({ command, message: `Failed to read the output of ${command}`, cause })

function bunStdin(stdin: ProcessStdin | undefined) {
  if (stdin === undefined || stdin === "ignore") return "ignore" as const
  if (stdin === "inherit" || stdin === "pipe") return stdin
  return typeof stdin === "string" ? Buffer.from(stdin) : stdin
}

const bunOutput = (output: ProcessOutput | undefined) => output ?? "ignore"

function outputStream(command: string, stream: ReadableStream<Uint8Array> | number | undefined | null) {
  if (!(stream instanceof ReadableStream)) return Stream.empty
  return Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => outputError(command, cause) })
}

const exitOf = (proc: Bun.Subprocess, code: number): ProcessExit => ({
  code,
  exitCode: proc.exitCode,
  signalCode: (proc.signalCode as ProcessSignal | null) ?? null,
})

const isRunning = (proc: Bun.Subprocess) => proc.exitCode === null && proc.signalCode === null

/** Wraps a Bun subprocess. Shared with the PTY binding. */
export function wrapBunSubprocess(command: string, proc: Bun.Subprocess): SpawnedProcess {
  const stdin = proc.stdin
  const writer = stdin && typeof stdin === "object" && "write" in stdin ? stdin : null
  return {
    command,
    pid: proc.pid,
    stdout: outputStream(command, proc.stdout),
    stderr: outputStream(command, proc.stderr),
    writeStdin: (chunk) =>
      writer
        ? Effect.try({
          try: () => {
            writer.write(chunk)
            writer.flush()
          },
          catch: (cause) => new CommandSpawnError({ command, message: `Failed to write to ${command}`, cause }),
        })
        : Effect.fail(new CommandSpawnError({ command, message: `${command}'s stdin is not piped`, cause: null })),
    endStdin: Effect.sync(() => {
      try {
        writer?.end()
      } catch {
        // already closed
      }
    }),
    exited: Effect.promise(() => proc.exited).pipe(Effect.map((code) => exitOf(proc, code))),
    running: Effect.sync(() => isRunning(proc)),
    kill: (signal) => Effect.sync(() => {
      if (!isRunning(proc)) return
      try {
        proc.kill(signal)
      } catch {
        // gone between the check and the signal
      }
    }),
  }
}

const spawnProcess = Effect.fn("BunProcessSpawner.spawn")(function* (
  argv: ReadonlyArray<string>,
  options: ProcessSpawnOptions = {},
) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const proc = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn([...argv], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdin: bunStdin(options.stdin),
        stdout: bunOutput(options.stdout),
        stderr: bunOutput(options.stderr),
      }),
      catch: (cause) => spawnError(command, cause),
    }),
    (proc) => Effect.sync(() => {
      if (isRunning(proc)) proc.kill()
    }),
  )
  return wrapBunSubprocess(command, proc)
})

const spawnDetached = Effect.fn("BunProcessSpawner.spawnDetached")(function* (command: string, args: ReadonlyArray<string>) {
  yield* Effect.annotateCurrentSpan("command", command)
  // Listeners go on in the same tick as the spawn: node reports a missing
  // command as an `error` event right after `spawn` returns.
  yield* Effect.callback<void, CommandSpawnError>((resume) => {
    const started = Result.try(() => spawn(command, [...args], { stdio: "ignore", detached: true }))
    if (Result.isFailure(started)) {
      resume(Effect.fail(detachedSpawnError(command, started.failure)))
      return
    }
    const child = started.success
    const handleError = (error: Error) => resume(Effect.fail(detachedSpawnError(command, error)))
    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resume(Effect.void)
    })
  })
})

/** Processes on this computer, through `Bun.spawn` (and node's spawn for detached ones). */
export const BunProcessSpawnerLayer = Layer.succeed(ProcessSpawner, {
  spawn: spawnProcess,
  spawnDetached,
})

import { Cause, Deferred, Effect, Queue, Stream } from "effect"
import { CommandSpawnError } from "./process-utils"
import type { CliProcess, CliSpawnArgs, SpawnCli } from "./cli-process"

/**
 * A provider CLI the test drives by hand: what it prints, when it exits.
 * Every spawn returns the same process. Killing it ends both pipes and exits
 * with no code, as a signalled process does.
 */
export interface FakeCli {
  readonly spawn: SpawnCli
  readonly spawns: ReadonlyArray<CliSpawnArgs>
  readonly kills: ReadonlyArray<NodeJS.Signals | undefined>
  /** Whether the process was killed by its scope closing (the turn's `close`). */
  readonly released: () => boolean
  readonly writeStdout: (text: string) => Effect.Effect<void>
  readonly writeStderr: (text: string) => Effect.Effect<void>
  /** Closes both pipes and exits with `code`. */
  readonly exit: (code: number | null) => Effect.Effect<void>
}

export const makeFakeCli = Effect.fn("FakeCli.make")(function* (options: {
  /** Fail the spawn the way a missing binary does. */
  readonly spawnError?: string
} = {}) {
  const stdout = yield* Queue.unbounded<string, Cause.Done>()
  const stderr = yield* Queue.unbounded<string, Cause.Done>()
  const exited = yield* Deferred.make<number | null>()
  const spawns: CliSpawnArgs[] = []
  const kills: Array<NodeJS.Signals | undefined> = []
  let released = false

  const exit = (code: number | null) => Effect.gen(function* () {
    yield* Queue.end(stdout)
    yield* Queue.end(stderr)
    yield* Deferred.succeed(exited, code)
  })

  const proc: CliProcess = {
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.fromQueue(stderr),
    exitCode: Deferred.await(exited),
    kill: (signal) => Effect.sync(() => { kills.push(signal) }).pipe(Effect.andThen(exit(null))),
  }

  const spawn: SpawnCli = (args) => Effect.gen(function* () {
    spawns.push(args)
    if (options.spawnError) {
      return yield* new CommandSpawnError({ command: "fake", message: options.spawnError, cause: null })
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => { released = true }))
    return proc
  })

  return {
    spawn,
    spawns,
    kills,
    released: () => released,
    writeStdout: (text) => Queue.offer(stdout, text).pipe(Effect.asVoid),
    writeStderr: (text) => Queue.offer(stderr, text).pipe(Effect.asVoid),
    exit,
  } satisfies FakeCli
})

/** A CLI that prints `stdout` and exits with `code` as soon as it is spawned. */
export const scriptedCli = Effect.fn("FakeCli.scripted")(function* (stdout: string, code: number | null = 0, stderr = "") {
  const fake = yield* makeFakeCli()
  if (stdout) yield* fake.writeStdout(stdout)
  if (stderr) yield* fake.writeStderr(stderr)
  yield* fake.exit(code)
  return fake
})

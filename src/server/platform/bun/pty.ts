import process from "node:process"
import { Effect, Layer } from "effect"
import { CommandSpawnError, type ProcessExit, type ProcessSignal } from "../process-spawner"
import { PtySpawner, type PtyProcess, type PtySpawnOptions } from "../pty"

const isRunning = (proc: Bun.Subprocess) => proc.exitCode === null && proc.signalCode === null

const spawnPty = Effect.fn("BunPtySpawner.spawn")(function* (argv: ReadonlyArray<string>, options: PtySpawnOptions) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const failure = (cause: unknown) =>
    new CommandSpawnError({ command, message: cause instanceof Error ? cause.message : `Failed to start ${command}`, cause })
  let closed = false
  const closeTerminal = (terminal: Bun.Terminal) => Effect.sync(() => {
    if (closed) return
    closed = true
    try {
      terminal.close()
    } catch {
      // already closed with the process
    }
  })
  const terminal = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Bun.Terminal({
        cols: options.cols,
        rows: options.rows,
        name: options.name ?? "xterm-256color",
        data: (_terminal, data) => options.onData(data),
      }),
      catch: failure,
    }),
    closeTerminal,
  )
  const proc = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn([...argv], { cwd: options.cwd, env: options.env ?? process.env, terminal }),
      catch: failure,
    }),
    (proc) => Effect.sync(() => {
      if (isRunning(proc)) proc.kill()
    }),
  )

  const signalProcess = (signal: ProcessSignal) => Effect.try(() => {
    proc.kill(signal)
  })

  return {
    pid: proc.pid,
    write: (data) => Effect.try({
      try: () => {
        terminal.write(data)
      },
      catch: (cause) => new CommandSpawnError({ command, message: `Failed to write to ${command}'s terminal`, cause }),
    }),
    resize: (cols, rows) => Effect.sync(() => terminal.resize(cols, rows)),
    signalGroup: (signal) => {
      const pid = proc.pid
      if (typeof pid !== "number") return Effect.succeed(false)
      const attempt = process.platform === "win32"
        ? signalProcess(signal)
        : Effect.try(() => {
          process.kill(-pid, signal)
        }).pipe(Effect.catchTag("UnknownError", () => signalProcess(signal)))
      return attempt.pipe(
        Effect.as(true),
        Effect.catchTag("UnknownError", () => Effect.succeed(false)),
      )
    },
    kill: (signal) => Effect.sync(() => {
      if (!isRunning(proc)) return
      try {
        proc.kill(signal)
      } catch {
        // gone between the check and the signal
      }
    }),
    exited: Effect.tryPromise({
      try: () => proc.exited,
      catch: (cause) => new CommandSpawnError({ command, message: cause instanceof Error ? cause.message : String(cause), cause }),
    }).pipe(Effect.map((code): ProcessExit => ({
      code,
      exitCode: proc.exitCode,
      signalCode: (proc.signalCode as ProcessSignal | null) ?? null,
    }))),
    running: Effect.sync(() => isRunning(proc)),
    close: closeTerminal(terminal),
  } satisfies PtyProcess
})

/** PTYs on this computer, through `Bun.Terminal` (Bun 1.3.5+, not on Windows). */
export const BunPtySpawnerLayer = Layer.sync(PtySpawner, () => ({
  available: process.platform !== "win32" && typeof Bun.Terminal === "function",
  spawn: spawnPty,
}))

import process from "node:process"
import { Cause, Effect, Exit, Layer, Predicate, Runtime } from "effect"
import { ServerPlatform } from "./runtime"

/**
 * Runs a `kanna` process's whole program (cli.ts, cli-supervisor.ts): the
 * program's success value is the exit code, and the process exits with it
 * the moment the program ends, whatever timers or handles are still open.
 * So the program's lifetime is the process's lifetime, and an Effect sleep
 * inside it (polling for the Mac app, pushing state to the supervisor) can't
 * keep a finished process alive. A failure is logged with Kanna's logger and
 * exits 1, as an uncaught error did before.
 *
 * `BunRuntime.runMain` would interrupt the program on the first SIGINT or
 * SIGTERM. Kanna's processes each handle signals their own way instead: the
 * supervisor forwards them to the server child and keeps waiting for it, and
 * the server stops on the first one and dies the default way on a second
 * Ctrl-C. So this runner leaves signals to the program.
 */
export function runKannaMain<E>(program: Effect.Effect<number, E, Layer.Success<typeof ServerPlatform>>) {
  runProcess(
    program.pipe(
      Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause)),
      Effect.provide(ServerPlatform),
    ),
    { disableErrorReporting: true, teardown: exitCode },
  )
}

const runProcess = Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) => teardown(exit, (code) => process.exit(code)))
})

const exitCode: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit) && Predicate.isNumber(exit.value)) return onExit(exit.value)
  Runtime.defaultTeardown(exit, onExit)
}

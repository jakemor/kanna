import { fileURLToPath } from "node:url"
import process from "node:process"
import { Effect, FileSystem, Schema } from "effect"
import {
  fetchLatestPackageVersion,
  installPackageVersion,
  openUrl,
  runCli,
  ServerStartError,
  type CliPlatform,
  type CliRuntimeDeps,
  type StartedCli,
} from "./cli-runtime"
import { CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, CLI_UI_UPDATE_RESTART_EXIT_CODE } from "./restart"
import { installNightlyBuild } from "./nightly"
import { startKannaServer } from "./server-bun"
import { awaitParentExit, openInMacApp } from "./mac-app"
import { runKannaMain } from "./effect/main"

// The server process: `kanna` as the supervisor's child (entry.ts), or
// directly under `bun run dev`. It runs once, as one Effect program, and the
// process exits with the code the program returns (effect/main.ts).

type ExitAction = "ui_restart" | "exit"

const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  version: Schema.optional(Schema.String),
})))

/** The version in package.json at the package root. */
const readPackageVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pkg = yield* decodePackageJson(yield* fs.readFileString(fileURLToPath(new URL("../../package.json", import.meta.url))))
  return pkg.version ?? "0.0.0"
})

/**
 * Last-resort backstop: log escaped rejections (e.g. from requests Bun
 * idle-timed-out mid-handler) instead of letting them crash the process.
 * Installed for the whole program, so it covers shutdown too.
 */
const logUnhandledRejections = Effect.gen(function* () {
  const runInBackground = Effect.runForkWith(yield* Effect.context<CliPlatform>())
  const onRejection = (reason: unknown) => {
    runInBackground(Effect.logError("unhandled rejection:", reason))
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("unhandledRejection", onRejection)),
    () => Effect.sync(() => process.off("unhandledRejection", onRejection)),
  )
})

/**
 * Waits for the reason to stop the running server: Ctrl-C or SIGTERM, an
 * update installed from the UI, or the Mac app that started it going away.
 */
const awaitExitAction = (started: StartedCli) => {
  // `once`, and left in place when something else wins: the first signal
  // after shutdown starts is absorbed, and a second Ctrl-C kills the server
  // the default way, without waiting for it to finish stopping.
  const signalled = Effect.callback<ExitAction>((resume) => {
    const shutdown = () => resume(Effect.succeed("exit"))
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
  const restartRequested = started.restartRequested.pipe(
    Effect.andThen(Effect.logInfo("update installed, shutting down current process for restart")),
    Effect.as<ExitAction>("ui_restart"),
  )
  // Not when the user chose to keep it running as the app quit.
  const orphaned = awaitParentExit().pipe(
    Effect.andThen(Effect.suspend(() => started.releasedFromParent?.() ? Effect.never : Effect.succeed<ExitAction>("exit"))),
  )
  return Effect.raceAll([signalled, restartRequested, orphaned])
}

const program = Effect.gen(function* () {
  yield* logUnhandledRejections
  const platform = yield* Effect.context<CliPlatform>()
  const deps: CliRuntimeDeps = {
    version: yield* readPackageVersion,
    bunVersion: Bun.version,
    // server.ts is still Promise code; it moves to Effect in a later wave.
    startServer: (options) => Effect.tryPromise({
      try: () => startKannaServer(options),
      catch: (cause) => new ServerStartError({ port: options.port, cause }),
    }).pipe(Effect.map((started) => ({ ...started, stop: Effect.promise(() => started.stop()) }))),
    fetchLatestVersion: fetchLatestPackageVersion,
    installVersion: (packageName, version) => installPackageVersion(packageName, version).pipe(Effect.provideContext(platform)),
    installNightly: installNightlyBuild().pipe(Effect.provideContext(platform)),
    openUrl: (url) => openUrl(url).pipe(Effect.provideContext(platform)),
    openInMacApp: (localUrl) => openInMacApp(localUrl).pipe(Effect.provideContext(platform)),
    // The CLI's terminal output, written as it is: not logging.
    log: console.log,
    warn: console.warn,
  }

  const outcome = yield* Effect.scoped(Effect.gen(function* () {
    const result = yield* runCli(process.argv.slice(2), deps)
    if (result.kind === "exited") return { kind: "exited", code: result.code } as const
    if (result.kind === "restarting") {
      const code = result.reason === "startup_update" ? CLI_STARTUP_UPDATE_RESTART_EXIT_CODE : CLI_UI_UPDATE_RESTART_EXIT_CODE
      return { kind: "exited", code } as const
    }
    // Closing this scope stops the server.
    return { kind: "stopped", action: yield* awaitExitAction(result) } as const
  }))
  if (outcome.kind === "exited") return outcome.code
  if (outcome.action === "ui_restart") {
    yield* Effect.logInfo("current process stopped, handing restart back to supervisor")
    return CLI_UI_UPDATE_RESTART_EXIT_CODE
  }
  return 0
})

runKannaMain(Effect.scoped(program).pipe(
  // A bad command line reads as one line, not a stack trace.
  Effect.catchTag("@kanna/server/cli-runtime/CliUsageError", (error) =>
    Effect.logError(error.message).pipe(Effect.as(1))),
))

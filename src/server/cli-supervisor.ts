import process from "node:process"
import path from "node:path"
import { homedir } from "node:os"
import { spawn, type ChildProcess } from "node:child_process"
import { Effect, Option, Schema } from "effect"
import { CLI_COMMAND, getDataRootDir } from "../shared/branding"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_CHILD_COMMAND_ENV_VAR,
  CLI_CHILD_MODE,
  CLI_CHILD_MODE_ENV_VAR,
  CLI_STARTUP_UPDATE_RESTART_EXIT_CODE,
  CLI_SUPPRESS_OPEN_ONCE_ENV_VAR,
  isUiUpdateRestart,
  parseChildArgsEnv,
  sanitizeRestartArgv,
  shouldRestartCliProcess,
  splitBunRuntimeFlags,
  withBunRuntimeFlags,
} from "./restart"
import { awaitParentExit } from "./mac-app"
import { runKannaMain } from "./effect/main"
import {
  acquireInstanceLock,
  INSTANCE_LOCK_ENV_VAR,
  STARTED_BY_ENV_VAR,
  startsServer,
  type InstanceLock,
} from "./instance-socket"

// The `kanna` a user runs: it starts the server as a child process and starts
// it again after an update, in the same terminal. It runs as one Effect
// program, and the process exits with the code the program returns
// (effect/main.ts).

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** The server child could not be started (the override's command, args or bun flags). */
export class ChildSpawnError extends Schema.TaggedError<ChildSpawnError>()(
  "@kanna/server/cli-supervisor/ChildSpawnError",
  {
    command: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/** What one spawn of the server child gets told through its environment. */
interface ChildLaunch {
  argv: string[]
  bunArgs: string[]
  suppressOpen: boolean
  skipUpdate: boolean
  lock: "held" | "taken" | "none"
}

function childProcessSpec(bunArgs: string[]) {
  const overridden = Boolean(process.env[CLI_CHILD_COMMAND_ENV_VAR])
  const command = process.env[CLI_CHILD_COMMAND_ENV_VAR] || CLI_COMMAND
  const args = parseChildArgsEnv(process.env[CLI_CHILD_ARGS_ENV_VAR])
  return withBunRuntimeFlags({ command, args }, bunArgs, {
    execPath: process.execPath,
    script: process.argv[1],
    overridden,
  })
}

/**
 * Runs the server child to its exit. While it runs, Ctrl-C and SIGTERM go to
 * the child rather than ending this process; between children nothing
 * catches them. `onSpawn` sees the child, for whoever has to stop it.
 */
const runChild = Effect.fn("CliSupervisor.runChild")(function* (launch: ChildLaunch, onSpawn: (child: ChildProcess) => void) {
  const spec = yield* Effect.try({
    try: () => childProcessSpec(launch.bunArgs),
    catch: (cause) => new ChildSpawnError({ command: process.env[CLI_CHILD_COMMAND_ENV_VAR] || CLI_COMMAND, cause }),
  })
  yield* Effect.annotateCurrentSpan("command", spec.command)
  const env: Record<string, string | undefined> = {
    ...process.env,
    [CLI_CHILD_MODE_ENV_VAR]: CLI_CHILD_MODE,
    ...(launch.suppressOpen ? { [CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]: "1" } : {}),
    ...(launch.skipUpdate ? { KANNA_DISABLE_SELF_UPDATE: "1" } : {}),
  }
  // Held: this supervisor has the lock and the child reports to it. Taken:
  // another Kanna has it, and the child points the user there. Unset (a
  // command, or `pair`): the child takes the lock itself if it needs one.
  if (launch.lock === "none") delete env[INSTANCE_LOCK_ENV_VAR]
  else env[INSTANCE_LOCK_ENV_VAR] = launch.lock

  return yield* Effect.callback<ChildExit, ChildSpawnError>((resume) => {
    const child = spawn(spec.command, [...spec.args, ...launch.argv], {
      stdio: "inherit",
      env,
    })
    onSpawn(child)

    const forwardSignal = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null) return
      child.kill(signal)
    }
    const onSigint = () => forwardSignal("SIGINT")
    const onSigterm = () => forwardSignal("SIGTERM")
    const stopForwarding = () => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
    }
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)

    child.once("error", (error) => {
      stopForwarding()
      resume(Effect.fail(new ChildSpawnError({ command: spec.command, cause: error })))
    })
    child.once("exit", (code, signal) => {
      stopForwarding()
      resume(Effect.succeed({ code, signal }))
    })
    return Effect.sync(() => {
      stopForwarding()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    })
  })
})

const program = Effect.gen(function* () {
  let currentChild: Option.Option<ChildProcess> = Option.none()
  let orphaned = false
  let stopRequested = false
  // The single-instance lock (instance-socket.ts), held here rather than in
  // the child so it stays held while the child restarts after an update.
  let lock: InstanceLock | null = null
  const stopChild = () => {
    if (Option.isSome(currentChild) && currentChild.value.exitCode === null) currentChild.value.kill("SIGTERM")
  }

  // Started by the Mac app, which then quit or crashed: stop the server cleanly
  // and don't restart it. Unless the user chose to keep it running when the
  // app quit (a `release`, instance-socket.ts).
  yield* awaitParentExit().pipe(
    Effect.andThen(Effect.sync(() => {
      if (lock?.releasedFromParent) return
      orphaned = true
      stopChild()
    })),
    Effect.forkScoped,
  )

  const startedBy = process.env[STARTED_BY_ENV_VAR] === "app" ? "app" : "terminal"
  const takeLockFor = Effect.fn("CliSupervisor.takeLock")(function* (argv: string[]) {
    if (lock || !startsServer(argv)) return
    lock = yield* acquireInstanceLock({
      owner: startedBy,
      // `kanna stop`, or the Mac app's Go Offline.
      onStop: () => {
        stopRequested = true
        stopChild()
      },
    })
  })

  const profileDir = path.join(getDataRootDir(homedir()), "profiles")
  const { bunArgs, argv } = splitBunRuntimeFlags(process.argv.slice(2), profileDir, process.cwd())
  if (bunArgs.some((arg) => arg.startsWith("--cpu-prof"))) {
    yield* Effect.logInfo(`profiling: CPU profile and heap snapshot go to ${profileDir} when the server stops`)
  }
  // The original argv only applies to the first spawn: a `pair <code>` launch
  // must not replay the (single-use) pairing on update restarts.
  let currentArgv = argv
  let suppressOpen = false
  let skipUpdate = false
  let lastStartupUpdateRestart = false

  while (true) {
    yield* takeLockFor(currentArgv)
    const result = yield* runChild({
      argv: currentArgv,
      bunArgs,
      suppressOpen,
      skipUpdate,
      lock: lock ? "held" : startsServer(currentArgv) ? "taken" : "none",
    }, (child) => {
      currentChild = Option.some(child)
    })
    suppressOpen = false
    skipUpdate = false
    if (orphaned || stopRequested) return 0
    currentArgv = sanitizeRestartArgv(currentArgv)
    if (shouldRestartCliProcess(result.code, result.signal)) {
      const isStartupUpdate = result.signal === null && result.code === CLI_STARTUP_UPDATE_RESTART_EXIT_CODE

      // Guard against infinite restart loops: if two consecutive startup-update
      // restarts happen it means the installed update did not change the binary
      // that actually runs (e.g. when launched via `bunx`, which maintains its
      // own package cache). Skip the self-update on the next spawn so the child
      // proceeds normally instead of trying to update again.
      if (isStartupUpdate && lastStartupUpdateRestart) {
        yield* Effect.logInfo("update installed but the running binary did not change, continuing with current version")
        skipUpdate = true
        lastStartupUpdateRestart = false
      } else {
        lastStartupUpdateRestart = isStartupUpdate
      }

      suppressOpen = isUiUpdateRestart(result.code, result.signal)
      yield* Effect.logInfo(`supervisor restarting ${CLI_COMMAND} in the same terminal session`)
      continue
    }

    return result.code ?? (result.signal ? 1 : 0)
  }
})

runKannaMain(Effect.scoped(program))

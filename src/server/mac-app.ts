/**
 * The Kanna Mac app (macos/) and the CLI keep each other running. The app is
 * a window around the globally installed `kanna`: opening it starts
 * `kanna --no-open` (or adopts one a terminal already started), and running
 * `kanna` in a terminal opens the app instead of a browser tab. This file is
 * the CLI's half of that arrangement.
 */

import { Effect } from "effect"
import { HostProcess } from "./platform/host-process"
import { Machine } from "./platform/machine"
import { runCommand } from "./process-utils"

export const MAC_APP_BUNDLE_ID = "sh.kanna.mac"
/** Registered by the app (macos/electron-builder.yml). `open?url=` names the server to show. */
export const MAC_APP_URL_SCHEME = "kanna-app"

/** The app sets this so a server it started does not outlive a crashed app. */
export const EXIT_WITH_PARENT_ENV_VAR = "KANNA_EXIT_WITH_PARENT"
const PARENT_POLL_INTERVAL = "2 seconds"

export function macAppOpenUrl(localUrl: string) {
  return `${MAC_APP_URL_SCHEME}://open?url=${encodeURIComponent(localUrl)}`
}

/**
 * Show `localUrl` in the Mac app when it is installed. Succeeds with false when it
 * is not (or off macOS), so the caller falls back to the browser. `open -b`
 * exits non-zero when no app has the bundle id, which is the whole check.
 */
export const openInMacApp = Effect.fn("MacApp.open")(function* (
  localUrl: string,
  platform?: NodeJS.Platform,
) {
  if ((platform ?? (yield* Machine).platform) !== "darwin") return false
  return yield* runCommand(["open", "-b", MAC_APP_BUNDLE_ID, macAppOpenUrl(localUrl)]).pipe(
    Effect.map((output) => output.exitCode === 0),
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(false)),
  )
})

/**
 * A server the app started should go when the app goes, crash included. A
 * crashed parent does not signal its children, so poll for the parent. The
 * supervisor and its child both watch: the supervisor for the app, the child
 * for a supervisor that was killed outright.
 *
 * Poll the parent's pid, not the parent pid's current value: Bun reads that
 * once at start, so it never turns into launchd's 1 when the parent dies.
 *
 * Completes once the parent is gone, checking every two seconds; never
 * completes when the app did not ask for this. Its sleeps hold the process
 * open, so run it alongside something that decides when the process ends:
 * the CLI's main program (cli.ts, cli-supervisor.ts), which exits the
 * process when it finishes.
 */
export const awaitParentExit = Effect.fn("MacApp.awaitParentExit")(function* (
  env?: Record<string, string | undefined>,
  parent?: number,
) {
  const machine = yield* Machine
  const exitWithParent = env ? env[EXIT_WITH_PARENT_ENV_VAR] : machine.env.get(EXIT_WITH_PARENT_ENV_VAR)
  const parentPid = parent ?? (yield* HostProcess).parentPid
  if (exitWithParent !== "1" || parentPid <= 1) return yield* Effect.never
  yield* Effect.annotateCurrentSpan("parent", parentPid)
  do {
    yield* Effect.sleep(PARENT_POLL_INTERVAL)
  } while (yield* isAlive(machine, parentPid))
})

const isAlive = (machine: Machine["Service"], pid: number) =>
  machine.signalProcess(pid, 0).pipe(
    Effect.as(true),
    // EPERM: it's there, just not ours to signal.
    Effect.catchTag("@kanna/server/platform/ProcessSignalError", (error) => Effect.succeed(error.code === "EPERM")),
  )

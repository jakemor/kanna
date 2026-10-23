import path from "node:path"
import { Result, Schema } from "effect"

export const CLI_CHILD_MODE_ENV_VAR = "KANNA_CLI_MODE"
export const CLI_CHILD_MODE = "child"
export const CLI_STARTUP_UPDATE_RESTART_EXIT_CODE = 75
export const CLI_UI_UPDATE_RESTART_EXIT_CODE = 76
export const CLI_CHILD_COMMAND_ENV_VAR = "KANNA_CLI_CHILD_COMMAND"
export const CLI_CHILD_ARGS_ENV_VAR = "KANNA_CLI_CHILD_ARGS"
export const CLI_SUPPRESS_OPEN_ONCE_ENV_VAR = "KANNA_SUPPRESS_OPEN_ONCE"

export function shouldRestartCliProcess(code: number | null, signal: NodeJS.Signals | null) {
  return signal === null && (code === CLI_STARTUP_UPDATE_RESTART_EXIT_CODE || code === CLI_UI_UPDATE_RESTART_EXIT_CODE)
}

export function isUiUpdateRestart(code: number | null, signal: NodeJS.Signals | null) {
  return signal === null && code === CLI_UI_UPDATE_RESTART_EXIT_CODE
}

/**
 * Argv the supervisor uses when it RESPAWNS a child after an update restart.
 * A `kanna pair <code>` launch falls through into a normal run once paired —
 * replaying the original argv would re-redeem the single-use pairing code
 * (and fail with "invalid code"). Respawns continue as a plain run; the
 * sticky cloud.json brings the machine back online.
 */
export function sanitizeRestartArgv(argv: string[]) {
  return argv[0] === "pair" ? [] : argv
}

const INSPECT_FLAG = /^--inspect(-wait|-brk)?(=.*)?$/

/**
 * Splits the flags meant for Bun out of the `kanna` argv. The supervisor
 * passes them to the bun that runs the server child, so the debugger and the
 * profiler see the server and not the supervisor that only restarts it.
 *
 * `--inspect[-wait|-brk][=<port|host:port>]` passes through as is. Bun prints
 * the URL to open (debug.bun.sh) for the debugger, CPU profiles and heap
 * snapshots. `--profile` writes a CPU profile (plus a markdown summary) and a
 * heap snapshot into `profileDir` when the server exits.
 */
export function splitBunRuntimeFlags(argv: string[], profileDir: string, cwd: string) {
  const bunArgs: string[] = []
  const rest: string[] = []
  for (const arg of argv) {
    if (INSPECT_FLAG.test(arg)) {
      bunArgs.push(arg)
    } else if (arg === "--profile") {
      bunArgs.push(
        "--cpu-prof",
        "--cpu-prof-md",
        `--cpu-prof-dir=${profileDir}`,
        "--heap-prof",
        // Bun 1.3.10 joins --heap-prof-dir onto the cwd even when it is
        // absolute, so hand it the path relative to the cwd.
        `--heap-prof-dir=${path.relative(cwd, profileDir) || "."}`,
      )
    } else {
      rest.push(arg)
    }
  }
  return { bunArgs, argv: rest }
}

/**
 * The child command with Bun flags in front of the script. The usual child is
 * the `kanna` shebang script, which can't take them, so it becomes
 * `bun <flags> <script>`. An override that already runs bun (`bun run dev`)
 * gets them right after `bun`.
 */
export function withBunRuntimeFlags(
  child: { command: string; args: string[] },
  bunArgs: string[],
  runtime: { execPath: string; script: string | undefined; overridden: boolean },
) {
  if (bunArgs.length === 0) return child
  if (runtime.overridden) {
    if (path.basename(child.command) !== "bun") {
      throw new Error(`--inspect and --profile need the server child to run under bun, not ${child.command}`)
    }
    return { command: child.command, args: [...bunArgs, ...child.args] }
  }
  if (!runtime.script) throw new Error("Can't find the kanna script to run under bun")
  return { command: runtime.execPath, args: [...bunArgs, runtime.script] }
}

const decodeChildArgs = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * The child's argv from the environment. Throws on a malformed value: the
 * supervisor reads it once at start, and a bad override should stop it there.
 */
export function parseChildArgsEnv(value: string | undefined): string[] {
  if (!value) return []
  const parsed = decodeChildArgs(value)
  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid ${CLI_CHILD_ARGS_ENV_VAR}: child args must be a JSON array of strings (${parsed.failure.message})`)
  }
  return [...parsed.success]
}

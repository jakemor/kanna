import path from "node:path"
import { Effect, Stream } from "effect"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import { CommandSpawnError, describeSpawnFailure, ProcessSpawner } from "./platform/process-spawner"

export { CommandSpawnError } from "./platform/process-spawner"

/**
 * Start `command` detached from this process (an editor, a file manager, a
 * browser) and succeed once it has started. It is never waited on or killed.
 */
export const spawnDetached = Effect.fn("ProcessUtils.spawnDetached")(function* (command: string, args: string[]) {
  yield* Effect.annotateCurrentSpan("command", command)
  const spawner = yield* ProcessSpawner
  yield* spawner.spawnDetached(command, args)
})

export interface CommandOutput {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `argv` to completion and collect what it printed on the streams asked
 * for. The process is killed if the caller is interrupted before it exits.
 */
export const runCommand = Effect.fn("ProcessUtils.runCommand")(function* (
  argv: ReadonlyArray<string>,
  options: {
    readonly cwd?: string
    readonly env?: Record<string, string | undefined>
    /** Written to the command's stdin, which is otherwise closed. */
    readonly stdin?: string
    readonly stdout?: boolean
    readonly stderr?: boolean
  } = {},
) {
  const command = argv[0] ?? ""
  yield* Effect.annotateCurrentSpan("command", command)
  const spawner = yield* ProcessSpawner
  const child = yield* spawner.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin ?? "ignore",
    stdout: options.stdout ? "pipe" : "ignore",
    stderr: options.stderr ? "pipe" : "ignore",
  }).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (error) =>
      Effect.fail(new CommandSpawnError({ command, message: describeSpawnFailure(command, error.cause), cause: error.cause }))),
  )
  const [exit, stdout, stderr] = yield* Effect.all([
    child.exited,
    Stream.mkString(Stream.decodeText(child.stdout)),
    Stream.mkString(Stream.decodeText(child.stderr)),
  ], { concurrency: "unbounded" })
  return { exitCode: exit.exitCode, stdout, stderr } satisfies CommandOutput
}, Effect.scoped)

/** Whether `argv` runs and exits 0. A command that can't start is a no. */
const succeeds = Effect.fn("ProcessUtils.succeeds")(function* (argv: ReadonlyArray<string>) {
  return yield* runCommand(argv).pipe(
    Effect.map((output) => output.exitCode === 0),
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(false)),
  )
})

/**
 * Whether `command` is on the login shell's PATH, asked of `sh` on every
 * platform (the updaters' check). Probes run in bulk use `commandExists`.
 */
export const hasCommand = Effect.fn("ProcessUtils.hasCommand")(function* (command: string) {
  return yield* succeeds(["sh", "-lc", `command -v ${command}`])
})

/**
 * Whether `command` is installed, for probes run in bulk.
 *
 * Windows has no `sh`, so asking it there would report every command missing
 * and quietly grey out the whole menu; `where` is the equivalent lookup.
 */
export const commandExists = Effect.fn("ProcessUtils.commandExists")(function* (command: string) {
  const machine = yield* Machine
  if (machine.platform === "win32") {
    return yield* succeeds(["where", command])
  }
  return yield* succeeds(["sh", "-lc", `command -v ${command}`])
})

/** Whether macOS knows an app by this name. */
export const macAppExists = Effect.fn("ProcessUtils.macAppExists")(function* (appName: string) {
  return yield* succeeds(["open", "-Ra", appName])
})

/**
 * Per-user bin dirs installers target without necessarily reaching the
 * sh login PATH: the native Claude Code installer uses ~/.local/bin but adds
 * its PATH line to the interactive shell rc (~/.zshrc on macOS), which
 * `sh -lc` never reads. Checked as a fallback when the login shell misses.
 */
const USER_BIN_DIRS = [".local/bin", ".bun/bin", ".npm-global/bin"]

const findInUserBinDirs = Effect.fn("ProcessUtils.findInUserBinDirs")(function* (command: string, homeDir: string) {
  const files = yield* FileSystemExtras
  for (const dir of USER_BIN_DIRS) {
    const candidate = path.join(homeDir, dir, command)
    if (yield* files.isExecutableFile(candidate)) return candidate
  }
  return null
})

/**
 * Resolve a command to an absolute path using a login shell, so binaries the
 * server process's own PATH misses (npm globals, ~/.local/bin) are still
 * found — the server may have been launched from launchd/systemd/cron.
 * Falls back to well-known per-user bin dirs the login shell may not cover.
 * `homeDir` defaults to the machine's.
 */
export const resolveCommandPath = Effect.fn("ProcessUtils.resolveCommandPath")(function* (command: string, homeDir?: string) {
  if (!/^[\w.-]+$/.test(command)) return null
  const machine = yield* Machine

  // Fast path: a PATH lookup is ~0.045 ms, and callers like diff-store's
  // `gh` runner hit this per invocation. It only sees the server's own PATH —
  // which is exactly the gap the login shell exists to cover — so it is a
  // fast path, not a replacement. Deliberately not memoized: callers that
  // need to re-resolve after an install (provider-auth's `fresh` option)
  // must not be served a stale path.
  const direct = yield* machine.which(command)
  if (direct) return direct

  const result = yield* runCommand(["sh", "-lc", `command -v -- ${command}`], { stdout: true }).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(null)),
  )
  if (result?.exitCode === 0) {
    const resolved = result.stdout.trim().split("\n").pop()?.trim() ?? ""
    if (resolved.startsWith("/")) return resolved
  }
  return yield* findInUserBinDirs(command, homeDir ?? machine.homeDirectory)
})

const SHELL_PATH_MARKER = "__KANNA_SHELL_PATH__"
export const SHELL_ENV_IMPORTED_ENV_VAR = "KANNA_SHELL_ENV_IMPORTED"
const SHELL_PATH_TIMEOUT_MS = 5_000

/**
 * `current` in its own order, then every `shell` entry it lacks. Appending
 * rather than replacing means a command the server already found keeps
 * resolving to the same binary (e.g. `bun run dev`'s node_modules/.bin).
 */
export function mergePathLists(current: string, shell: string) {
  const entries = [...current.split(path.delimiter), ...shell.split(path.delimiter)]
  return [...new Set(entries.filter(Boolean))].join(path.delimiter)
}

/** The PATH between the two markers, ignoring whatever the rc files print. */
export function parseShellPathOutput(output: string) {
  const [, between] = output.split(SHELL_PATH_MARKER)
  return between?.trim() || null
}

/**
 * Add the user's interactive login shell PATH to this process's PATH.
 *
 * Agents inherit `process.env` whole, and a server started by launchd, a
 * detached `kanna`, or the desktop app gets a PATH that skips ~/.zshrc, where
 * installers like to put ~/.local/bin. Skills then fail with "command not
 * found" for CLIs that work in the user's terminal. `resolveCommandPath`
 * covers the few binaries Kanna runs itself; this covers what agents run.
 *
 * `-i` is what reads ~/.zshrc. `printenv` rather than `$PATH` so fish, which
 * joins list variables with spaces, prints the same thing.
 */
export const inheritShellPath = Effect.fn("ProcessUtils.inheritShellPath")(function* () {
  const machine = yield* Machine
  if (machine.platform === "win32") return
  // The Mac app already started this process with the whole login-shell
  // environment (macos/src/shell-env.ts); a heavy ~/.zshrc costs
  // seconds, so don't pay for it twice.
  if (machine.env.get(SHELL_ENV_IMPORTED_ENV_VAR) === "1") return
  const shell = machine.env.get("SHELL") || (machine.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  const output = yield* readLoginShellPath(shell).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed("")),
  )
  const shellPath = parseShellPathOutput(output)
  if (!shellPath) return
  machine.env.set("PATH", mergePathLists(machine.env.get("PATH") ?? "", shellPath))
})

const readLoginShellPath = Effect.fn("ProcessUtils.readLoginShellPath")(function* (shell: string) {
  const script = `echo ${SHELL_PATH_MARKER}; printenv PATH; echo ${SHELL_PATH_MARKER}`
  const machine = yield* Machine
  const spawner = yield* ProcessSpawner
  const child = yield* spawner.spawn([shell, "-ilc", script], {
    stdout: "pipe",
    // oh-my-zsh otherwise asks whether to update, and nobody can answer.
    env: { ...machine.env.snapshot(), DISABLE_AUTO_UPDATE: "true" },
  }).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (error) =>
      Effect.fail(new CommandSpawnError({ command: shell, message: describeSpawnFailure(shell, error.cause), cause: error.cause }))),
  )
  // An interactive shell ignores SIGTERM: kill it outright on the way out.
  yield* Effect.addFinalizer(() => child.kill("SIGKILL"))
  // A slow or hung rc file must not stall boot: kill the shell and read
  // whatever it printed before it died.
  yield* Effect.sleep(SHELL_PATH_TIMEOUT_MS).pipe(
    Effect.andThen(child.kill("SIGKILL")),
    Effect.forkScoped,
  )
  return yield* Stream.mkString(Stream.decodeText(child.stdout))
}, Effect.scoped)

/** Whether macOS knows an app by this name. */
export const canOpenMacApp = Effect.fn("ProcessUtils.canOpenMacApp")(function* (appName: string) {
  return yield* succeeds(["open", "-Ra", appName])
})

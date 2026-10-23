import path from "node:path"
import { Effect, Fiber, FileSystem, Option, Result, Schema, Stream } from "effect"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { Machine } from "./platform/machine"
import { ProcessSpawner } from "./platform/process-spawner"
import { hasCommand } from "./process-utils"
import { CLI_CHILD_MODE, CLI_CHILD_MODE_ENV_VAR } from "./restart"

// Nightly channel: build the repo's main branch from source and install it as
// the global CLI, so clients can jump to unreleased changes without waiting
// for an npm release. The install reuses the normal update restart flow — the
// supervisor respawns the global bin, which `bun install -g .` just replaced.

const NIGHTLY_REPO = "jakemor/kanna"
const STEP_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL_CHARS = 2_000
const MAIN_COMMIT_TIMEOUT_MS = 10_000
const PIPE_DRAIN_GRACE_MS = 1_000

export interface NightlyInstallResult extends UpdateInstallAttemptResult {
  /** The stamped version of the installed build ("0.56.7-nightly.abc1234"), null on failure. */
  version: string | null
}

export interface RunCommandResult {
  ok: boolean
  output: string
}

export interface NightlyBuildDeps {
  fetchImpl?: typeof fetch
  /** Command runner seam for tests; the default spawns with a hard timeout. */
  runCommand?: (command: string, args: string[], cwd: string, env?: Record<string, string>) => Effect.Effect<RunCommandResult, never, ProcessSpawner | Machine>
  /** Working directory override for tests (default ~/.kanna/nightly). */
  workDir?: string
  /** Bun global dir override for tests (default $BUN_INSTALL or ~/.bun). */
  bunGlobalDir?: string
}

/** GitHub could not tell us which commit main is at. The message is shown to the user. */
export class MainCommitLookupError extends Schema.TaggedError<MainCommitLookupError>()(
  "@kanna/server/nightly/MainCommitLookupError",
  {
    repo: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Downloading the source archive failed. The message is shown to the user. */
export class NightlyDownloadError extends Schema.TaggedError<NightlyDownloadError>()(
  "@kanna/server/nightly/NightlyDownloadError",
  {
    url: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Version string stamped onto nightly builds: "<base>-nightly.<short-sha>". */
export function nightlyVersion(baseVersion: string, sha: string): string {
  return `${baseVersion}-nightly.${sha.slice(0, 7)}`
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The commit main is at, lower-cased. */
export const fetchMainCommitSha = Effect.fn("Nightly.fetchMainCommitSha")(function* (fetchImpl: typeof fetch = fetch) {
  const lookupError = (message: string, cause: unknown) => new MainCommitLookupError({ repo: NIGHTLY_REPO, message, cause })
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchImpl(`https://api.github.com/repos/${NIGHTLY_REPO}/commits/main`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(MAIN_COMMIT_TIMEOUT_MS)]),
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github.sha",
        "User-Agent": "kanna",
      },
    }),
    catch: (cause) => lookupError(errorMessage(cause), cause),
  })
  if (!response.ok) {
    return yield* lookupError(`GitHub returned ${response.status} for the main branch`, response.status)
  }
  const sha = (yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => lookupError(errorMessage(cause), cause),
  })).trim()
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return yield* lookupError("GitHub did not return a commit sha for main", sha)
  }
  return sha.toLowerCase()
})

/**
 * Runs one build step and collects its stdout and stderr interleaved, as the
 * user would see them in a terminal. Never fails: a step that can't start,
 * exits non-zero or runs past the timeout is `ok: false`, with why at the
 * end of `output`. The process is killed if the step is interrupted.
 */
export const runCommandWithTimeout = Effect.fn("Nightly.runCommand")(function* (
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) {
  yield* Effect.annotateCurrentSpan("command", command)
  const machine = yield* Machine
  const spawner = yield* ProcessSpawner
  let output = ""
  return yield* Effect.gen(function* () {
    const spawned = yield* Effect.result(spawner.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      ...(env ? { env: { ...machine.env.snapshot(), ...env } } : {}),
    }))
    if (Result.isFailure(spawned)) {
      output += `\n${spawned.failure.message}`
      return { ok: false, output } satisfies RunCommandResult
    }
    const child = spawned.success
    // Killed outright on the way out, not just signalled.
    yield* Effect.addFinalizer(() => child.kill("SIGKILL"))
    // The timeout is the child's own timer, not an Effect timeout: the global
    // install runs uninterruptibly (see `replaceGlobalInstall`), where an
    // Effect timeout could not stop it. Killing the child ends the wait.
    let timedOut = false
    const timer = yield* Effect.sleep(STEP_TIMEOUT_MS).pipe(
      Effect.andThen(Effect.sync(() => { timedOut = true })),
      Effect.andThen(child.kill("SIGKILL")),
      Effect.interruptible,
      Effect.forkChild,
    )
    // stdout and stderr interleaved as they arrive, as a terminal shows them.
    const append = (stream: typeof child.stdout) => stream.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) => Effect.sync(() => { output += chunk })),
      Effect.ignore,
      Effect.interruptible,
      Effect.forkChild,
    )
    const readers = [yield* append(child.stdout), yield* append(child.stderr)]
    const exit = yield* child.exited
    yield* Fiber.interrupt(timer)
    // The pipes close with the process; give them a moment to drain, but a
    // grandchild holding them open can't stall the step.
    yield* Effect.forEach(readers, Fiber.await, { discard: true }).pipe(
      Effect.timeoutOption(PIPE_DRAIN_GRACE_MS),
      Effect.interruptible,
    )
    yield* Effect.forEach(readers, Fiber.interrupt, { discard: true })
    if (timedOut) {
      output += `\n[timed out after ${STEP_TIMEOUT_MS / 60_000} minutes]`
      return { ok: false, output } satisfies RunCommandResult
    }
    return { ok: exit.exitCode === 0, output } satisfies RunCommandResult
  }).pipe(Effect.scoped)
})

function failure(userMessage: string): NightlyInstallResult {
  return {
    ok: false,
    errorCode: "install_failed",
    userTitle: "Nightly update failed",
    userMessage,
    version: null,
  }
}

function outputTail(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed
}

function bunGlobalDir(machine: Machine["Service"]): string {
  return machine.env.get("BUN_INSTALL") || path.join(machine.homeDirectory, ".bun")
}

const decodeJsonObject = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const decodeDependencies = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodePackageIdentity = Schema.decodeUnknownEffect(Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
}))

/** A JSON file as an object, keeping every key so it can be written back whole. */
const readJsonObject = Effect.fn("Nightly.readJsonObject")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* decodeJsonObject(yield* fs.readFileString(filePath))
})

const writeJson = Effect.fn("Nightly.writeJson")(function* (filePath: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(filePath, JSON.stringify(value, null, 2) + "\n")
})

/**
 * Strip corrupt entries from Bun's global package manifest. Kanna 0.57.0's
 * nightly install ran `bun install -g .`, which Bun mis-parses: it installs
 * nothing but records a junk dependency (key "" or "@", value "." / "@.").
 * While one is present, Bun refuses EVERY further global install with a
 * DependencyLoop error — including the stable auto-update — so both the
 * nightly and stable installers repair the manifest first.
 * Succeeds with true when the manifest was repaired.
 */
export const repairBunGlobalManifest = Effect.fn("Nightly.repairBunGlobalManifest")(function* (globalDir?: string) {
  const machine = yield* Machine
  return yield* repairManifest(path.join(globalDir ?? bunGlobalDir(machine), "install", "global", "package.json")).pipe(
    // Missing or unreadable manifest — nothing to repair.
    Effect.catchTags({
      PlatformError: () => Effect.succeed(false),
      SchemaError: () => Effect.succeed(false),
    }),
  )
})

const repairManifest = Effect.fnUntraced(function* (manifestPath: string) {
  const manifest = yield* readJsonObject(manifestPath)
  const dependencies = Option.getOrUndefined(decodeDependencies(manifest.dependencies))
  if (!dependencies) return false
  const kept = Object.fromEntries(Object.entries(dependencies).filter(([name, value]) => {
    const junkName = name === "" || name === "@"
    const junkValue = typeof value === "string" && /^(?:@|file:)?\.$/.test(value)
    return !junkName && !junkValue
  }))
  if (Object.keys(kept).length === Object.keys(dependencies).length) return false
  yield* writeJson(manifestPath, { ...manifest, dependencies: kept })
  return true
})

/**
 * Download main from GitHub, build it from source, and install it as the
 * global CLI. The build's version is stamped "<base>-nightly.<short-sha>" so
 * the UI shows what's running; the base version keeps ordering against npm,
 * so the next published release upgrades a nightly back to stable normally.
 *
 * Never fails: every way a nightly install can go wrong is a result the
 * update UI shows.
 */
export const installNightlyBuild = Effect.fn("Nightly.install")(function* (deps: NightlyBuildDeps = {}) {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const fetchImpl = deps.fetchImpl ?? fetch
  const runCommand = deps.runCommand ?? runCommandWithTimeout

  if (!(yield* hasCommand("tar"))) {
    return failure("Kanna needs the `tar` command to unpack the nightly source.")
  }
  if (!(yield* hasCommand("bun"))) {
    return failure("Kanna could not find Bun to build the nightly version.")
  }

  const commit = yield* Effect.result(fetchMainCommitSha(fetchImpl))
  if (Result.isFailure(commit)) {
    return failure(`Could not resolve the latest main commit: ${commit.failure.message}`)
  }
  const sha = commit.success
  yield* Effect.annotateCurrentSpan("sha", sha)
  yield* Effect.logInfo(`nightly: building ${NIGHTLY_REPO}@${sha.slice(0, 7)}`)

  const workDir = deps.workDir ?? path.join(machine.homeDirectory, ".kanna", "nightly")
  const srcDir = path.join(workDir, "src")
  const tarPath = path.join(workDir, "source.tar.gz")
  const archiveUrl = `https://codeload.github.com/${NIGHTLY_REPO}/tar.gz/${sha}`
  const download = yield* Effect.result(Effect.gen(function* () {
    if (yield* fs.exists(srcDir)) yield* fs.remove(srcDir, { recursive: true, force: true })
    yield* fs.makeDirectory(srcDir, { recursive: true })
    const tarball = yield* Effect.tryPromise({
      try: (signal) => fetchImpl(archiveUrl, { signal, headers: { "User-Agent": "kanna" } }),
      catch: (cause) => new NightlyDownloadError({ url: archiveUrl, message: errorMessage(cause), cause }),
    })
    if (!tarball.ok) return Option.some(tarball.status)
    const bytes = yield* Effect.tryPromise({
      try: () => tarball.arrayBuffer(),
      catch: (cause) => new NightlyDownloadError({ url: archiveUrl, message: errorMessage(cause), cause }),
    })
    yield* fs.writeFile(tarPath, new Uint8Array(bytes))
    return Option.none<number>()
  }))
  if (Result.isFailure(download)) {
    return failure(`Could not download the source archive: ${download.failure.message}`)
  }
  if (Option.isSome(download.success)) {
    return failure(`GitHub returned ${download.success.value} downloading the source archive.`)
  }

  const extract = yield* runCommand("tar", ["-xzf", tarPath, "-C", srcDir, "--strip-components=1"], workDir)
  yield* fs.remove(tarPath, { force: true }).pipe(Effect.ignore)
  if (!extract.ok) {
    return failure(`Could not unpack the source archive.\n${outputTail(extract.output)}`)
  }

  // Stamp the build's identity before installing so the running version and
  // the global package both carry the commit.
  const packageJsonPath = path.join(srcDir, "package.json")
  const stamped = yield* Effect.result(Effect.gen(function* () {
    const packageJson = yield* readJsonObject(packageJsonPath)
    const identity = yield* decodePackageIdentity(packageJson)
    const version = nightlyVersion(identity.version ?? "0.0.0", sha)
    yield* writeJson(packageJsonPath, { ...packageJson, version })
    return { packageName: identity.name ?? "kanna-code", version }
  }))
  if (Result.isFailure(stamped)) {
    return failure(`Could not stamp the nightly version: ${stamped.failure.message}`)
  }
  const { packageName, version } = stamped.success

  const steps: Array<{ label: string; command: string; args: string[] }> = [
    { label: "install dependencies", command: "bun", args: ["install"] },
    { label: "build", command: "bun", args: ["run", "build"] },
  ]
  for (const step of steps) {
    yield* Effect.logInfo(`nightly: ${step.label}…`)
    const result = yield* runCommand(step.command, step.args, srcDir)
    if (!result.ok) {
      return failure(`Nightly ${step.label} step failed.\n${outputTail(result.output)}`)
    }
  }

  // Startup probe BEFORE replacing the global install: `--version` in child
  // mode loads the entire server module graph, so a main that can't even
  // start never reaches users' PATH — the current install stays untouched.
  // It runs the bundle the install will ship (scripts/build-server.ts), not
  // the source bin/kanna prefers in a checkout.
  yield* Effect.logInfo("nightly: verifying the build…")
  const probe = yield* runCommand("bun", ["dist/server/entry.js", "--version"], srcDir, {
    [CLI_CHILD_MODE_ENV_VAR]: CLI_CHILD_MODE,
    KANNA_DISABLE_SELF_UPDATE: "1",
  })
  if (!probe.ok || !probe.output.includes(version)) {
    return failure(`The nightly build failed its startup check, so it was not installed.\n${outputTail(probe.output)}`)
  }

  // Install via a packed tarball with an absolute path — `bun install -g .`
  // mis-parses the bare dot (installs nothing, corrupts the global manifest).
  if (yield* repairBunGlobalManifest(deps.bunGlobalDir)) {
    yield* Effect.logInfo("nightly: repaired a corrupt bun global manifest")
  }
  yield* Effect.logInfo("nightly: installing the build…")
  const pack = yield* runCommand("bun", ["pm", "pack"], srcDir)
  if (!pack.ok) {
    return failure(`Nightly pack step failed.\n${outputTail(pack.output)}`)
  }
  const packedTarball = path.join(srcDir, `${packageName}-${version}.tgz`)
  if (!(yield* fs.exists(packedTarball).pipe(Effect.orElseSucceed(() => false)))) {
    return failure(`Nightly pack step did not produce ${path.basename(packedTarball)}.\n${outputTail(pack.output)}`)
  }
  // Bun refuses to switch an installed registry package to a tarball spec in
  // place (DependencyLoop), so drop the existing global entry first — the
  // package may not be installed globally, so a remove failure is fine. Any
  // failure past this point rolls back to the latest release so the machine
  // is never left without a global install. (The reverse direction — a
  // registry install over a tarball entry — works in place, so the stable
  // updater needs no such dance.)
  // From the remove until the new install is verified the machine has no
  // global `kanna`, so a stop in between must not cut it short: stopping
  // Kanna closes the update manager's scope, which would kill the install
  // and skip the rollback. Each step keeps its own timeout.
  const replaceGlobalInstall = Effect.gen(function* () {
    yield* runCommand("bun", ["remove", "-g", packageName], srcDir)
    const rollbackFailure = Effect.fn("Nightly.rollback")(function* (message: string) {
      const rollback = yield* runCommand("bun", ["install", "-g", `${packageName}@latest`], srcDir)
      return failure(`${message}${rollback.ok ? `\nThe latest ${packageName} release was reinstalled.` : `\nRestoring the release also failed — run \`bun install -g ${packageName}@latest\` to recover.`}`)
    })
    const install = yield* runCommand("bun", ["install", "-g", packedTarball], srcDir)
    if (!install.ok) {
      return Option.some(yield* rollbackFailure(`Nightly install step failed.\n${outputTail(install.output)}`))
    }

    // `bun install -g` can exit 0 without replacing the package (that's how
    // 0.57.0's dot-path install silently no-opped) — trust only the installed
    // manifest reporting the stamped version.
    const installedManifestPath = path.join(
      deps.bunGlobalDir ?? bunGlobalDir(machine),
      "install", "global", "node_modules", packageName, "package.json"
    )
    const installed = yield* Effect.result(readJsonObject(installedManifestPath).pipe(Effect.flatMap(decodePackageIdentity)))
    if (Result.isFailure(installed)) {
      return Option.some(yield* rollbackFailure(`Could not verify the installed build: ${installed.failure.message}`))
    }
    const installedVersion = installed.success.version
    if (installedVersion !== version) {
      return Option.some(yield* rollbackFailure(`The install finished but the global package still reports ${installedVersion ?? "no version"} instead of ${version}.`))
    }
    return Option.none<NightlyInstallResult>()
  })
  const replaced = yield* Effect.uninterruptible(replaceGlobalInstall)
  if (Option.isSome(replaced)) return replaced.value

  yield* Effect.logInfo(`nightly: installed ${version}`)
  return {
    ok: true,
    errorCode: null,
    userTitle: null,
    userMessage: null,
    version,
  } satisfies NightlyInstallResult
})

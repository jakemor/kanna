import { compareVersions } from "./cli-runtime"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { PACKAGE_NAME } from "../shared/branding"
import { spawnCapture } from "./process-utils.adapter"
import type { UpdateInstallErrorCode } from "../shared/types"

export interface UpdateChecker {
  check(): Promise<{ latestVersion: string; updateAvailable: boolean }>
}

export interface UpdateReloader {
  reload(version?: string): Promise<void>
}

export interface NpmCheckerDeps {
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Promise<string>
}

export class UpdateInstallError extends Error {
  constructor(
    message: string,
    public readonly errorCode: UpdateInstallErrorCode | null,
    public readonly userTitle: string | null,
  ) {
    super(message)
    this.name = "UpdateInstallError"
  }
}

export interface SupervisorExitReloaderDeps {
  targetVersion: () => string | null
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
}

export class SupervisorExitReloader implements UpdateReloader {
  constructor(private deps: SupervisorExitReloaderDeps) {}

  async reload(version?: string) {
    const targetRaw = version ?? this.deps.targetVersion()
    if (!targetRaw) {
      throw new UpdateInstallError(
        "Unable to determine target version.",
        "install_failed",
        "Update failed",
      )
    }
    const target = targetRaw.trim().replace(/^v/i, "")
    const result = this.deps.installVersion(PACKAGE_NAME, target)
    if (!result.ok) {
      throw new UpdateInstallError(
        result.userMessage ?? `Unable to install version ${target}.`,
        result.errorCode,
        result.userTitle,
      )
    }
  }
}

export class NpmChecker implements UpdateChecker {
  constructor(private deps: NpmCheckerDeps) {}

  async check() {
    const latestVersion = await this.deps.fetchLatestVersion(PACKAGE_NAME)
    const updateAvailable = compareVersions(this.deps.currentVersion, latestVersion) < 0
    return { latestVersion, updateAvailable }
  }
}

export interface GitCheckerDeps {
  repoDir: string
  branch: string
  runGit: (args: string[]) => Promise<string>
}

export class GitChecker implements UpdateChecker {
  constructor(private deps: GitCheckerDeps) {}

  async check() {
    await this.deps.runGit(["fetch", "origin", this.deps.branch])
    const headRaw = await this.deps.runGit(["rev-parse", "HEAD"])
    const upstreamRaw = await this.deps.runGit(["rev-parse", `origin/${this.deps.branch}`])
    const head = headRaw.trim()
    const upstream = upstreamRaw.trim()
    return {
      latestVersion: upstream.slice(0, 7),
      updateAvailable: head !== upstream,
    }
  }
}

export interface Pm2ReloaderDeps {
  repoDir: string
  runCommand: (command: string, args: string[]) => Promise<void>
  lockfileChanged: () => Promise<boolean>
}

export class Pm2Reloader implements UpdateReloader {
  constructor(private deps: Pm2ReloaderDeps) {}

  async reload(version?: string) {
    if (version) {
      throw new UpdateInstallError(
        "Installing a specific version is not supported in pm2 reloader mode.",
        "install_failed",
        "Version pin not supported",
      )
    }
    await this.step("git pull", ["git", "pull", "--ff-only"])
    if (await this.deps.lockfileChanged()) {
      await this.step("bun install", ["bun", "install"])
    }
    await this.step("bun run build", ["bun", "run", "build"])
  }

  private async step(label: string, argv: string[]) {
    const [command, ...args] = argv
    try {
      await this.deps.runCommand(command, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UpdateInstallError(
        `${label} failed: ${message}`,
        "install_failed",
        "Update failed",
      )
    }
  }
}

export interface CreateUpdateStrategyDeps {
  reloaderEnv: string | undefined
  currentVersion: string
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  latestVersionHint: () => string | null
  // Required for pm2 branch (KANNA_REPO_DIR).
  repoDir?: string
}

export interface UpdateStrategy {
  checker: UpdateChecker
  reloader: UpdateReloader
}

export function createUpdateStrategy(deps: CreateUpdateStrategyDeps): UpdateStrategy {
  const mode = deps.reloaderEnv ?? "supervisor"
  if (mode === "supervisor") {
    return {
      checker: new NpmChecker({
        currentVersion: deps.currentVersion,
        fetchLatestVersion: deps.fetchLatestVersion,
      }),
      reloader: new SupervisorExitReloader({
        targetVersion: deps.latestVersionHint,
        installVersion: deps.installVersion,
      }),
    }
  }
  if (mode === "pm2") {
    if (!deps.repoDir) {
      throw new Error("KANNA_RELOADER=pm2 requires KANNA_REPO_DIR to be set")
    }
    const repoDir = deps.repoDir
    return {
      checker: new GitChecker({
        repoDir,
        branch: "main",
        runGit: (args) => runCommandCapture("git", args, repoDir),
      }),
      reloader: new Pm2Reloader({
        repoDir,
        runCommand: (command, args) => runCommandThrow(command, args, repoDir),
        lockfileChanged: () => detectLockfileChange(repoDir),
      }),
    }
  }
  throw new Error(`Unknown KANNA_RELOADER value "${mode}". Supported values: supervisor, pm2`)
}

async function runCommandCapture(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await spawnCapture(command, args, cwd)
  if (exitCode !== 0) {
    const tail = stderr.trim().slice(-500)
    throw new Error(tail || `${command} exited with code ${exitCode}`)
  }
  return stdout
}

async function runCommandThrow(command: string, args: string[], cwd: string): Promise<void> {
  await runCommandCapture(command, args, cwd)
}

async function detectLockfileChange(repoDir: string): Promise<boolean> {
  try {
    const output = await runCommandCapture(
      "git",
      ["diff", "--name-only", "HEAD@{1}", "HEAD", "--", "bun.lock", "package.json"],
      repoDir,
    )
    return output.trim().length > 0
  } catch {
    // No prior HEAD@{1} (fresh clone) or other git error — install to be safe
    return true
  }
}


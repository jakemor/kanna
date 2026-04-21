import { compareVersions } from "./cli-runtime"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { PACKAGE_NAME } from "../shared/branding"
import type { UpdateInstallErrorCode } from "../shared/types"

export interface UpdateChecker {
  check(): Promise<{ latestVersion: string; updateAvailable: boolean }>
}

// Implemented by SupervisorExitReloader (Task 2) and Pm2Reloader (Task 8).
export interface UpdateReloader {
  reload(): Promise<void>
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

  async reload() {
    const version = this.deps.targetVersion()
    if (!version) {
      throw new UpdateInstallError(
        "Unable to determine target version.",
        "install_failed",
        "Update failed",
      )
    }
    const result = this.deps.installVersion(PACKAGE_NAME, version)
    if (!result.ok) {
      throw new UpdateInstallError(
        result.userMessage ?? "Unable to install the latest version.",
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
  processName: string
  runCommand: (command: string, args: string[]) => Promise<void>
  lockfileChanged: () => Promise<boolean>
  triggerPm2Reload: (processName: string) => Promise<void>
}

export class Pm2Reloader implements UpdateReloader {
  constructor(private deps: Pm2ReloaderDeps) {}

  async reload() {
    await this.step("git pull", ["git", "pull", "--ff-only"])
    if (await this.deps.lockfileChanged()) {
      await this.step("bun install", ["bun", "install"])
    }
    await this.step("bun run build", ["bun", "run", "build"])
    try {
      await this.deps.triggerPm2Reload(this.deps.processName)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UpdateInstallError(
        `pm2 reload failed: ${message}`,
        "install_failed",
        "Update failed",
      )
    }
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
  // Optional pm2 process name override (KANNA_PM2_PROCESS_NAME). Defaults to "kanna".
  pm2ProcessName?: string
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
        processName: deps.pm2ProcessName ?? "kanna",
        runCommand: (command, args) => runCommandThrow(command, args, repoDir),
        lockfileChanged: () => detectLockfileChange(repoDir),
        triggerPm2Reload,
      }),
    }
  }
  throw new Error(`Unknown KANNA_RELOADER value "${mode}". Supported values: supervisor, pm2`)
}

async function runCommandCapture(command: string, args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd: [command, ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
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

async function triggerPm2Reload(processName: string): Promise<void> {
  const pm2Module = await import("pm2")
  const pm2 = pm2Module.default ?? pm2Module
  await new Promise<void>((resolve, reject) => {
    pm2.connect((connectErr) => {
      if (connectErr) {
        pm2.disconnect()
        reject(connectErr instanceof Error ? connectErr : new Error(String(connectErr)))
        return
      }
      pm2.reload(processName, (reloadErr) => {
        pm2.disconnect()
        if (reloadErr) {
          reject(reloadErr instanceof Error ? reloadErr : new Error(String(reloadErr)))
          return
        }
        resolve()
      })
    })
  })
}

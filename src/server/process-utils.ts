import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"

function formatSpawnError(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(`Failed to start ${command}`)
  }

  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  if (code === "ENOENT") {
    return new Error(`Command not found: ${command}`)
  }

  return new Error(error.message || `Failed to start ${command}`)
}

export function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true })
    } catch (error) {
      reject(formatSpawnError(command, error))
      return
    }

    const handleError = (error: Error) => {
      reject(formatSpawnError(command, error))
    }

    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resolve()
    })
  })
}

export function hasCommand(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

function succeedsAsync(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore" })
    } catch {
      resolve(false)
      return
    }
    child.once("error", () => resolve(false))
    child.once("close", (code) => resolve(code === 0))
  })
}

/**
 * `hasCommand` without blocking the event loop — for probes run in bulk.
 *
 * Windows has no `sh`, so asking it there would report every command missing
 * and quietly grey out the whole menu; `where` is the equivalent lookup.
 */
export function commandExists(command: string) {
  if (process.platform === "win32") {
    return succeedsAsync("where", [command])
  }
  return succeedsAsync("sh", ["-lc", `command -v ${command}`])
}

/** `canOpenMacApp` without blocking the event loop. */
export function macAppExists(appName: string) {
  return succeedsAsync("open", ["-Ra", appName])
}

/**
 * Per-user bin dirs installers target without necessarily reaching the
 * sh login PATH: the native Claude Code installer uses ~/.local/bin but adds
 * its PATH line to the interactive shell rc (~/.zshrc on macOS), which
 * `sh -lc` never reads. Checked as a fallback when the login shell misses.
 */
const USER_BIN_DIRS = [".local/bin", ".bun/bin", ".npm-global/bin"]

function findInUserBinDirs(command: string, homeDir: string): string | null {
  for (const dir of USER_BIN_DIRS) {
    const candidate = path.join(homeDir, dir, command)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // missing or not executable — keep looking
    }
  }
  return null
}

/**
 * Resolve a command to an absolute path using a login shell, so binaries the
 * server process's own PATH misses (npm globals, ~/.local/bin) are still
 * found — the server may have been launched from launchd/systemd/cron.
 * Falls back to well-known per-user bin dirs the login shell may not cover.
 */
export function resolveCommandPath(command: string, homeDir = homedir()): string | null {
  if (!/^[\w.-]+$/.test(command)) return null
  const result = spawnSync("sh", ["-lc", `command -v -- ${command}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  if (result.status === 0) {
    const resolved = result.stdout?.trim().split("\n").pop()?.trim() ?? ""
    if (resolved.startsWith("/")) return resolved
  }
  return findInUserBinDirs(command, homeDir)
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}

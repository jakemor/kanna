import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

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

  // Fast path: the login shell below is a synchronous spawn that blocks the
  // event loop for ~5 ms (up to 24 ms observed here), and callers like
  // diff-store's `gh` runner hit this per invocation. `Bun.which` is ~0.045 ms.
  // It only sees the server's own PATH — which is exactly the gap the login
  // shell exists to cover — so it is a fast path, not a replacement.
  // Deliberately not memoized: callers that need to re-resolve after an install
  // (provider-auth's `fresh` option) must not be served a stale path.
  const direct = Bun.which(command)
  if (direct) return direct

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

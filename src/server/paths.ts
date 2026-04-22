import { spawn } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export function resolveLocalPath(localPath: string) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homedir()
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export async function ensureProjectDirectory(localPath: string) {
  const resolvedPath = resolveLocalPath(localPath)

  await mkdir(resolvedPath, { recursive: true })
  const info = await stat(resolvedPath)
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Pick a clone destination that doesn't already exist.
 * Tries `localPath` first, then falls back to `fallbackPath` if provided.
 * Returns the resolved absolute path that was chosen.
 */
export async function resolveClonePath(localPath: string, fallbackPath?: string): Promise<string> {
  const primary = resolveLocalPath(localPath)
  if (!(await pathExists(primary))) {
    return primary
  }
  if (fallbackPath) {
    const secondary = resolveLocalPath(fallbackPath)
    if (!(await pathExists(secondary))) {
      return secondary
    }
  }
  throw new Error(`Destination path '${primary}' already exists`)
}

/**
 * Clone a git repository into the given local path.
 * The parent directory is created if it doesn't exist.
 * Rejects if `git clone` exits with a non-zero code.
 */
export async function cloneRepository(cloneUrl: string, resolvedPath: string): Promise<void> {
  const parentDir = path.dirname(resolvedPath)

  await mkdir(parentDir, { recursive: true })

  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", cloneUrl, resolvedPath], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("error", (err) => {
      reject(new Error(`Failed to start git clone: ${err.message}`))
    })

    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        const message = stderr.trim() || `git clone exited with code ${code}`
        reject(new Error(message))
      }
    })
  })
}

export function getProjectUploadDir(localPath: string) {
  return path.join(resolveLocalPath(localPath), ".kanna", "uploads")
}

import { statSync } from "node:fs"
import { mkdir, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { DirectoryBrowserSnapshot } from "../shared/types"

export function getDefaultDirectoryRoot() {
  const home = homedir()
  const candidates = [
    path.join(home, "Documents"),
    path.join(home, "projects"),
    path.join(home, "Projects"),
    home,
  ]

  for (const candidate of candidates) {
    try {
      const info = statSync(candidate)
      if (info.isDirectory()) {
        return candidate
      }
    } catch {
      continue
    }
  }

  if (process.platform === "win32") {
    return path.parse(home).root || "C:\\"
  }
  return "/"
}

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

export async function requireProjectDirectory(localPath: string) {
  const resolvedPath = resolveLocalPath(localPath)
  const info = await stat(resolvedPath).catch(() => null)
  if (!info) {
    throw new Error(`Project folder not found: ${resolvedPath}`)
  }
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }
}

function getDirectoryRoots() {
  const home = homedir()
  if (process.platform === "win32") {
    const drive = path.parse(home).root || "C:\\"
    return [
      { name: "Home", localPath: home },
      { name: drive, localPath: drive },
    ]
  }

  return [
    { name: "Home", localPath: home },
    { name: "/", localPath: "/" },
  ]
}

export async function listProjectDirectories(localPath?: string): Promise<DirectoryBrowserSnapshot> {
  const currentPath = localPath ? resolveLocalPath(localPath) : getDefaultDirectoryRoot()
  const info = await stat(currentPath).catch(() => null)

  if (!info) {
    throw new Error(`Folder not found: ${currentPath}`)
  }
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }

  const directoryEntries = await readdir(currentPath, { withFileTypes: true })
  const entries = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      localPath: path.join(currentPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const parentPath = path.dirname(currentPath) === currentPath ? null : path.dirname(currentPath)

  return {
    currentPath,
    parentPath,
    roots: getDirectoryRoots(),
    entries,
  }
}

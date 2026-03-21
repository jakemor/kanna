import { readdir, watch, type FSWatcher } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import type { FileTreeEvent } from "../shared/protocol"
import type { FileTreeDirectoryPage, FileTreeSnapshot } from "../shared/types"

const DEFAULT_PAGE_SIZE = 200
const MAX_PAGE_SIZE = 500
const INVALIDATION_DEBOUNCE_MS = 90

interface ProjectLookup {
  localPath: string
}

interface ProjectRuntime {
  subscriberCount: number
  watchers: Map<string, FSWatcher>
  failedWatchDirectories: Set<string>
  pendingInvalidations: Set<string>
  invalidateTimer: Timer | null
}

interface GitIgnoreCacheEntry {
  repoRoot: string | null
  projectRealPath: string
}

interface CreateFileTreeManagerArgs {
  getProject: (projectId: string) => ProjectLookup | null
}

interface DirectoryCandidate {
  name: string
  absolutePath: string
  relativePath: string
  kind: "file" | "directory" | "symlink"
  extension?: string
}

let watchDirectory: typeof watch = watch

export function setWatchDirectoryForTesting(next: typeof watch | null) {
  watchDirectory = next ?? watch
}

export class FileTreeManager {
  private readonly getProject: CreateFileTreeManagerArgs["getProject"]
  private readonly projectRuntimes = new Map<string, ProjectRuntime>()
  private readonly gitIgnoreCache = new Map<string, GitIgnoreCacheEntry>()
  private readonly invalidateListeners = new Set<(event: FileTreeEvent) => void>()

  constructor(args: CreateFileTreeManagerArgs) {
    this.getProject = args.getProject
  }

  getSnapshot(projectId: string): FileTreeSnapshot {
    const project = this.requireProject(projectId)
    return {
      projectId,
      rootPath: project.localPath,
      pageSize: DEFAULT_PAGE_SIZE,
      supportsRealtime: true,
    }
  }

  async readDirectory(args: {
    projectId: string
    directoryPath: string
    cursor?: string
    limit?: number
  }): Promise<FileTreeDirectoryPage> {
    const project = this.requireProject(args.projectId)
    const rootPath = await realpath(project.localPath)
    const directoryPath = normalizeRelativeDirectoryPath(args.directoryPath)
    const absoluteDirectoryPath = resolveProjectPath(rootPath, directoryPath)
    const info = await lstat(absoluteDirectoryPath).catch(() => null)

    if (!info) {
      return {
        directoryPath,
        entries: [],
        nextCursor: null,
        hasMore: false,
        error: "Directory not found",
      }
    }

    if (!info.isDirectory()) {
      return {
        directoryPath,
        entries: [],
        nextCursor: null,
        hasMore: false,
        error: "Path is not a directory",
      }
    }

    const pageSize = clampPageSize(args.limit)
    const candidates = await new Promise<DirectoryCandidate[]>((resolve, reject) => {
      readdir(absoluteDirectoryPath, { withFileTypes: true }, async (error, dirents) => {
        if (error) {
          reject(error)
          return
        }

        try {
          const nextCandidates = await Promise.all(
            dirents.map(async (dirent): Promise<DirectoryCandidate | null> => {
              const name = dirent.name
              if (name === ".git") return null

              const childRelativePath = joinRelativePath(directoryPath, name)
              const childAbsolutePath = resolveProjectPath(rootPath, childRelativePath)

              let kind: DirectoryCandidate["kind"] = "file"
              if (dirent.isDirectory()) {
                kind = "directory"
              } else if (dirent.isSymbolicLink()) {
                kind = "symlink"
              }

              if (kind === "symlink") {
                const stat = await lstat(childAbsolutePath).catch(() => null)
                if (stat?.isDirectory()) {
                  kind = "symlink"
                }
              }

              return {
                name,
                absolutePath: childAbsolutePath,
                relativePath: childRelativePath,
                kind,
                extension: getExtension(name),
              }
            })
          )

          resolve(nextCandidates.filter((candidate): candidate is DirectoryCandidate => candidate !== null))
        } catch (caughtError) {
          reject(caughtError)
        }
      })
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return Promise.reject(new Error(message))
    })

    const visibleCandidates = await this.filterIgnored(args.projectId, rootPath, candidates)
    visibleCandidates.sort(compareCandidates)

    const start = parseCursor(args.cursor)
    const page = visibleCandidates.slice(start, start + pageSize)
    const nextCursor = start + page.length < visibleCandidates.length ? String(start + page.length) : null

    this.ensureWatchedDirectory(args.projectId, directoryPath)

    return {
      directoryPath,
      entries: page.map((candidate) => ({
        name: candidate.name,
        relativePath: candidate.relativePath,
        kind: candidate.kind,
        extension: candidate.extension,
      })),
      nextCursor,
      hasMore: nextCursor !== null,
    }
  }

  subscribe(projectId: string) {
    const runtime = this.ensureRuntime(projectId)
    runtime.subscriberCount += 1
    this.ensureWatchedDirectory(projectId, "")
  }

  unsubscribe(projectId: string) {
    const runtime = this.projectRuntimes.get(projectId)
    if (!runtime) return
    runtime.subscriberCount = Math.max(0, runtime.subscriberCount - 1)
    if (runtime.subscriberCount > 0) return
    this.disposeRuntime(projectId)
  }

  onInvalidate(listener: (event: FileTreeEvent) => void) {
    this.invalidateListeners.add(listener)
    return () => {
      this.invalidateListeners.delete(listener)
    }
  }

  dispose() {
    for (const projectId of [...this.projectRuntimes.keys()]) {
      this.disposeRuntime(projectId)
    }
  }

  private requireProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    return project
  }

  private ensureRuntime(projectId: string) {
    const existing = this.projectRuntimes.get(projectId)
    if (existing) {
      return existing
    }

    const runtime: ProjectRuntime = {
      subscriberCount: 0,
      watchers: new Map(),
      failedWatchDirectories: new Set(),
      pendingInvalidations: new Set(),
      invalidateTimer: null,
    }
    this.projectRuntimes.set(projectId, runtime)
    return runtime
  }

  private ensureWatchedDirectory(projectId: string, directoryPath: string) {
    const runtime = this.projectRuntimes.get(projectId)
    if (!runtime || runtime.subscriberCount === 0) return
    if (runtime.watchers.has(directoryPath)) return
    if (runtime.failedWatchDirectories.has(directoryPath)) return

    const project = this.requireProject(projectId)
    const absolutePath = resolveProjectPath(project.localPath, directoryPath)
    let watcher: FSWatcher
    try {
      watcher = watchDirectory(absolutePath, { persistent: false }, () => {
        this.queueInvalidation(projectId, directoryPath)
      })
    } catch (error) {
      runtime.failedWatchDirectories.add(directoryPath)
      console.warn(
        `[kanna] failed to watch ${absolutePath}; continuing without realtime file updates`,
        error instanceof Error ? error.message : String(error)
      )
      return
    }

    watcher.on("error", () => {
      runtime.failedWatchDirectories.add(directoryPath)
      this.queueInvalidation(projectId, directoryPath)
      watcher.close()
      runtime.watchers.delete(directoryPath)
    })

    runtime.watchers.set(directoryPath, watcher)
  }

  private queueInvalidation(projectId: string, directoryPath: string) {
    const runtime = this.projectRuntimes.get(projectId)
    if (!runtime) return
    runtime.pendingInvalidations.add(directoryPath)
    if (runtime.invalidateTimer) return

    runtime.invalidateTimer = setTimeout(() => {
      runtime.invalidateTimer = null
      const directoryPaths = [...runtime.pendingInvalidations]
      runtime.pendingInvalidations.clear()
      if (directoryPaths.length === 0) return
      const event: FileTreeEvent = {
        type: "file-tree.invalidate",
        projectId,
        directoryPaths: directoryPaths.sort(),
      }
      for (const listener of this.invalidateListeners) {
        listener(event)
      }
    }, INVALIDATION_DEBOUNCE_MS)
  }

  private disposeRuntime(projectId: string) {
    const runtime = this.projectRuntimes.get(projectId)
    if (!runtime) return
    for (const watcher of runtime.watchers.values()) {
      watcher.close()
    }
    runtime.watchers.clear()
    if (runtime.invalidateTimer) {
      clearTimeout(runtime.invalidateTimer)
    }
    runtime.pendingInvalidations.clear()
    this.projectRuntimes.delete(projectId)
  }

  private async filterIgnored(projectId: string, rootPath: string, candidates: DirectoryCandidate[]) {
    if (candidates.length === 0) return candidates

    const cache = this.getGitIgnoreCache(projectId, rootPath)
    if (!cache.repoRoot) return candidates

    const visible = candidates.filter((candidate) => isWithinPath(cache.repoRoot as string, candidate.absolutePath))
    const pathsToCheck = visible.map((candidate) => path.relative(cache.repoRoot as string, candidate.absolutePath))
    if (pathsToCheck.length === 0) return candidates

    const result = spawnSync("git", ["-C", cache.repoRoot, "check-ignore", "--stdin"], {
      input: pathsToCheck.join("\n"),
      encoding: "utf8",
    })

    if (result.status !== 0 && result.status !== 1) {
      return candidates
    }

    const ignored = new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    )

    return candidates.filter((candidate) => {
      if (!isWithinPath(cache.repoRoot as string, candidate.absolutePath)) {
        return true
      }
      const repoRelative = path.relative(cache.repoRoot as string, candidate.absolutePath)
      return !ignored.has(repoRelative)
    })
  }

  private getGitIgnoreCache(projectId: string, rootPath: string) {
    const cached = this.gitIgnoreCache.get(projectId)
    if (cached?.projectRealPath === rootPath) {
      return cached
    }

    const result = spawnSync("git", ["-C", rootPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
    const repoRoot = result.status === 0 ? result.stdout.trim() || null : null
    const nextEntry = {
      repoRoot,
      projectRealPath: rootPath,
    }
    this.gitIgnoreCache.set(projectId, nextEntry)
    return nextEntry
  }
}

function clampPageSize(limit?: number) {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)))
}

function parseCursor(cursor?: string) {
  if (!cursor) return 0
  const parsed = Number.parseInt(cursor, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function normalizeRelativeDirectoryPath(directoryPath: string) {
  if (!directoryPath || directoryPath === ".") return ""
  const normalized = directoryPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
  if (!normalized) return ""
  const segments = normalized.split("/")
  if (segments.includes("..")) {
    throw new Error("Directory path must stay within the project root")
  }
  return normalized
}

function resolveProjectPath(rootPath: string, relativePath: string) {
  const resolved = path.resolve(rootPath, relativePath || ".")
  if (!isWithinPath(rootPath, resolved)) {
    throw new Error("Path must stay within the project root")
  }
  return resolved
}

function isWithinPath(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function joinRelativePath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name
}

function compareCandidates(left: DirectoryCandidate, right: DirectoryCandidate) {
  if (left.kind === "directory" && right.kind !== "directory") return -1
  if (left.kind !== "directory" && right.kind === "directory") return 1
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
}

function getExtension(name: string) {
  const extension = path.extname(name)
  return extension ? extension.slice(1).toLowerCase() : undefined
}

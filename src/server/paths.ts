import path from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { FsDirEntry, FsListResult } from "../shared/types"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import { runCommand } from "./process-utils"

/**
 * A project folder could not be resolved, created, listed, cloned into or
 * initialized. `message` is what the client shows the user.
 */
export class ProjectDirectoryError extends Schema.TaggedError<ProjectDirectoryError>()(
  "@kanna/server/paths/ProjectDirectoryError",
  {
    operation: Schema.Literals(["resolve", "create", "list", "clone", "init"]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Render an absolute path with the home directory (the machine's) abbreviated to `~`. */
export function formatDisplayPath(filePath: string, homePath: string) {
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}

/** `localPath` made absolute, with `~` expanded to `homeDir` (the machine's home). */
export function resolveLocalPath(localPath: string, homeDir: string) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homeDir
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homeDir, trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

/** `resolveLocalPath` for Effect code, against the machine's home: a blank path is a typed failure. */
export const resolveProjectPath = Effect.fn("Paths.resolveProjectPath")(function* (localPath: string) {
  const { homeDirectory } = yield* Machine
  return yield* Effect.try({
    try: () => resolveLocalPath(localPath, homeDirectory),
    catch: (cause) => new ProjectDirectoryError({
      operation: "resolve",
      path: localPath,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  })
})

/** mkdir -p, then make sure what is there is a directory. */
const makeDirectory = Effect.fn("Paths.makeDirectory")(function* (
  resolved: string,
  operation: "create" | "init",
  notADirectoryMessage: string,
) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.makeDirectory(resolved, { recursive: true }).pipe(
    Effect.andThen(fs.stat(resolved)),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new ProjectDirectoryError({ operation, path: resolved, message: cause.message, cause }))),
  )
  if (info.type !== "Directory") {
    return yield* new ProjectDirectoryError({ operation, path: resolved, message: notADirectoryMessage })
  }
})

export const ensureProjectDirectory = Effect.fn("Paths.ensureProjectDirectory")(function* (localPath: string) {
  const resolved = yield* resolveProjectPath(localPath)
  yield* Effect.annotateCurrentSpan("path", resolved)
  yield* makeDirectory(resolved, "create", "Project path must be a directory")
})

/** A clone can target a path that doesn't exist yet, or an existing empty directory. */
const isAvailableCloneTarget = Effect.fn("Paths.isAvailableCloneTarget")(function* (p: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readDirectory(p).pipe(
    Effect.map((entries) => entries.length === 0),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  )
})

/**
 * Pick a clone destination that is missing or empty.
 * Tries `localPath` first, then falls back to `fallbackPath` if provided.
 * Returns the resolved absolute path that was chosen.
 */
export const resolveClonePath = Effect.fn("Paths.resolveClonePath")(function* (localPath: string, fallbackPath?: string) {
  const primary = yield* resolveProjectPath(localPath)
  if (yield* isAvailableCloneTarget(primary)) {
    return primary
  }
  if (fallbackPath) {
    const secondary = yield* resolveProjectPath(fallbackPath)
    if (yield* isAvailableCloneTarget(secondary)) {
      return secondary
    }
  }
  return yield* new ProjectDirectoryError({
    operation: "clone",
    path: primary,
    message: `Destination path '${primary}' already exists and is not empty`,
  })
})

/** Run git, failing with its stderr when it exits non-zero. */
const runGit = Effect.fn("Paths.runGit")(function* (
  operation: "clone" | "init",
  args: string[],
  target: string,
  cwd?: string,
) {
  const output = yield* runCommand(["git", ...args], { cwd, stderr: true }).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (cause) =>
      Effect.fail(new ProjectDirectoryError({
        operation,
        path: target,
        message: `Failed to start git ${operation}: ${cause.message}`,
        cause,
      }))),
  )
  if (output.exitCode !== 0) {
    return yield* new ProjectDirectoryError({
      operation,
      path: target,
      message: output.stderr.trim() || `git ${operation} exited with code ${output.exitCode}`,
    })
  }
})

/**
 * Clone a git repository into the given local path.
 * The parent directory is created if it doesn't exist.
 * Fails if `git clone` exits with a non-zero code.
 */
export const cloneRepository = Effect.fn("Paths.cloneRepository")(function* (cloneUrl: string, resolvedPath: string) {
  // The clone URL can carry a token, so only the destination is recorded.
  yield* Effect.annotateCurrentSpan("path", resolvedPath)
  const fs = yield* FileSystem.FileSystem
  const parentDir = path.dirname(resolvedPath)
  yield* fs.makeDirectory(parentDir, { recursive: true }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new ProjectDirectoryError({ operation: "clone", path: parentDir, message: cause.message, cause }))),
  )
  yield* runGit("clone", ["clone", cloneUrl, resolvedPath], resolvedPath)
})

/**
 * Prepare a directory for a brand-new project: mkdir -p, then `git init` —
 * but only when the directory is empty (never re-inits an existing repo or
 * touches a folder that already has contents; those degrade to a plain open).
 * Returns the resolved absolute path.
 */
export const initializeProjectDirectory = Effect.fn("Paths.initializeProjectDirectory")(function* (localPath: string) {
  const resolved = yield* resolveProjectPath(localPath)
  yield* Effect.annotateCurrentSpan("path", resolved)
  yield* makeDirectory(resolved, "init", `Not a folder: ${resolved}`)

  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(resolved).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new ProjectDirectoryError({ operation: "init", path: resolved, message: cause.message, cause }))),
  )
  if (entries.length > 0) {
    return resolved
  }

  yield* runGit("init", ["init"], resolved, resolved)
  return resolved
})

const FS_LIST_ENTRY_LIMIT = 2_000

function compareEntryNames(a: FsDirEntry, b: FsDirEntry) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

/** Walk up from `resolved` to the closest existing directory, collecting the missing segments. */
const findNearestDirectory = Effect.fn("Paths.findNearestDirectory")(function* (resolved: string) {
  const fs = yield* FileSystem.FileSystem
  let current = resolved
  const missing: string[] = []
  while (true) {
    const info = yield* fs.stat(current).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", () => Effect.succeedNone),
    )
    if (Option.isSome(info) && info.value.type === "Directory") return { path: current, missing }
    const parent = path.dirname(current)
    if (parent === current) return { path: current, missing }
    missing.unshift(path.basename(current))
    current = parent
  }
})

function listErrorMessage(resolved: string, cause: unknown) {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined
  if (code === "ENOENT") return `Folder not found: ${resolved}`
  if (code === "ENOTDIR") return `Not a folder: ${resolved}`
  if (code === "EACCES" || code === "EPERM") return `Permission denied: ${resolved}`
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * List a directory for the project browser. One readdir syscall pass:
 * git detection and dir/file split both come from the same dirent array.
 * Defaults to the home directory when no path is given. With `nearest`,
 * a missing path falls back to its closest existing ancestor and the
 * result carries the missing remainder in `missingSuffix`.
 */
export const listDirectory = Effect.fn("Paths.listDirectory")(function* (
  requestedPath?: string,
  opts?: { nearest?: boolean },
) {
  const { homeDirectory } = yield* Machine
  let resolved = requestedPath?.trim() ? yield* resolveProjectPath(requestedPath) : homeDirectory
  let missingSuffix: string | undefined

  if (opts?.nearest) {
    const nearest = yield* findNearestDirectory(resolved)
    resolved = nearest.path
    missingSuffix = nearest.missing.length > 0 ? nearest.missing.join("/") : undefined
  }
  yield* Effect.annotateCurrentSpan("path", resolved)

  // Entries with their kinds rather than FileSystem.readDirectory: only that
  // hands back each entry's type from the same syscall, and a symlink to a
  // folder lists as a file here, as it always has.
  const listed = resolved
  const extras = yield* FileSystemExtras
  const dirents = yield* extras.readDirectoryEntries(listed).pipe(
    Effect.catchTag("PlatformError", (error) => Effect.fail(new ProjectDirectoryError({
      operation: "list",
      path: listed,
      message: listErrorMessage(listed, error.reason.cause),
      cause: error.reason.cause,
    }))),
  )

  let isGitRepo = false
  const dirs: FsDirEntry[] = []
  const files: FsDirEntry[] = []
  for (const dirent of dirents) {
    if (dirent.kind === "Directory") {
      if (dirent.name === ".git") isGitRepo = true
      dirs.push({ name: dirent.name, kind: "dir" })
    } else {
      files.push({ name: dirent.name, kind: "file" })
    }
  }
  dirs.sort(compareEntryNames)
  files.sort(compareEntryNames)

  const entries = [...dirs, ...files]
  const truncated = entries.length > FS_LIST_ENTRY_LIMIT
  const parent = path.dirname(resolved)

  return {
    path: resolved,
    parentPath: parent === resolved ? null : parent,
    homePath: homeDirectory,
    isGitRepo,
    entries: truncated ? entries.slice(0, FS_LIST_ENTRY_LIMIT) : entries,
    truncated,
    ...(missingSuffix ? { missingSuffix } : {}),
  } satisfies FsListResult
})

/** Create a directory (parents included) and return its fresh listing. */
export const createDirectory = Effect.fn("Paths.createDirectory")(function* (requestedPath: string) {
  const resolved = yield* resolveProjectPath(requestedPath)
  yield* makeDirectory(resolved, "create", `Not a folder: ${resolved}`)
  return yield* listDirectory(resolved)
})

export function getProjectUploadDir(localPath: string, homeDir: string) {
  return path.join(resolveLocalPath(localPath, homeDir), ".kanna", "uploads")
}

export function getProjectExportDir(localPath: string, homeDir: string) {
  return path.join(resolveLocalPath(localPath, homeDir), ".kanna", "exports")
}

import { constants, type Stats } from "node:fs"
import { access, lstat, open, readdir, stat } from "node:fs/promises"
import { Effect, Layer, PlatformError } from "effect"
import { FileSystemExtras, type FileKind, type PreciseFileInfo } from "../file-system-extras"

function kindOf(stats: Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink">): FileKind {
  if (stats.isSymbolicLink()) return "SymbolicLink"
  if (stats.isFile()) return "File"
  if (stats.isDirectory()) return "Directory"
  return "Other"
}

const infoOf = (stats: Stats): PreciseFileInfo => ({
  kind: kindOf(stats),
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
  atimeMs: stats.atimeMs,
  ino: stats.ino,
  dev: stats.dev,
  mode: stats.mode,
})

const ERRNO_TAGS: Record<string, PlatformError.SystemErrorTag> = {
  ENOENT: "NotFound",
  ENOTDIR: "NotFound",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  EBUSY: "Busy",
  ETIMEDOUT: "TimedOut",
  EAGAIN: "WouldBlock",
}

/** node's errno error as Effect's `PlatformError`, so `catchReason("PlatformError", "NotFound", ...)` works. */
const platformError = (method: string, path: string) => (cause: unknown) => {
  const code = cause instanceof Error && "code" in cause ? String(cause.code) : ""
  return PlatformError.systemError({
    _tag: ERRNO_TAGS[code] ?? "Unknown",
    module: "FileSystem",
    method,
    syscall: cause instanceof Error && "syscall" in cause ? String(cause.syscall) : undefined,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : undefined,
    cause,
  })
}

const readFileHead = Effect.fn("BunFileSystemExtras.readFileHead")(function* (path: string, maxBytes: number) {
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(path, constants.O_RDONLY | constants.O_NONBLOCK), catch: platformError("open", path) }),
    (handle) => Effect.gen(function* () {
      const stats = yield* Effect.tryPromise({ try: () => handle.stat(), catch: platformError("stat", path) })
      const info = infoOf(stats)
      if (info.kind !== "File" || maxBytes <= 0) return { info, head: new Uint8Array(0) }
      const head = Buffer.alloc(Math.min(info.size, maxBytes))
      const { bytesRead } = yield* Effect.tryPromise({
        try: () => handle.read(head, 0, head.length, 0),
        catch: platformError("read", path),
      })
      return { info, head: new Uint8Array(head.buffer, head.byteOffset, bytesRead) }
    }),
    (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
  )
})

/** node's `fs` and `Bun.file`, on this computer. */
export const BunFileSystemExtrasLayer = Layer.succeed(FileSystemExtras, {
  stat: (path) => Effect.tryPromise({ try: () => stat(path), catch: platformError("stat", path) }).pipe(Effect.map(infoOf)),
  lstat: (path) => Effect.tryPromise({ try: () => lstat(path), catch: platformError("lstat", path) }).pipe(Effect.map(infoOf)),
  readDirectoryEntries: (path) =>
    Effect.tryPromise({ try: () => readdir(path, { withFileTypes: true }), catch: platformError("readDirectory", path) }).pipe(
      Effect.map((entries) => entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }))),
    ),
  isExecutableFile: (path) => Effect.tryPromise(async () => {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  }).pipe(Effect.orElseSucceed(() => false)),
  readFileHead,
  contentType: (path) => Bun.file(path).type,
  fileBody: (path) => Effect.sync(() => Bun.file(path)),

})

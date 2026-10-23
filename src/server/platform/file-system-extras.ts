import { Context, type Effect, type PlatformError } from "effect"

export type FileKind = "File" | "Directory" | "SymbolicLink" | "Other"

/**
 * A stat with node's full precision. Effect's `FileSystem.stat` rounds
 * mtimes to whole milliseconds, which breaks the caches and fingerprints
 * that compare them, and it has no lstat.
 */
export interface PreciseFileInfo {
  readonly kind: FileKind
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly atimeMs: number
  readonly ino: number
  readonly dev: number
  readonly mode: number
}

export interface DirectoryEntry {
  readonly name: string
  /** What the entry itself is: a symlink reads as "SymbolicLink", not its target. */
  readonly kind: FileKind
}

/**
 * File operations Effect's `FileSystem` doesn't cover, or covers with less
 * precision. Provided next to `FileSystem` by every binding.
 */
export class FileSystemExtras extends Context.Service<FileSystemExtras, {
  /** Follows symlinks, like `stat`. */
  readonly stat: (path: string) => Effect.Effect<PreciseFileInfo, PlatformError.PlatformError>
  /** Doesn't follow a final symlink, like `lstat`. */
  readonly lstat: (path: string) => Effect.Effect<PreciseFileInfo, PlatformError.PlatformError>
  /** A directory's entries with their kinds, without following symlinks. */
  readonly readDirectoryEntries: (path: string) => Effect.Effect<ReadonlyArray<DirectoryEntry>, PlatformError.PlatformError>
  /** A regular file with the execute bit for this user. Missing reads as false. */
  readonly isExecutableFile: (path: string) => Effect.Effect<boolean>
  /**
   * Opens `path` without blocking on it (a FIFO or device answers at once),
   * stats the open handle, and reads up to `maxBytes` from the start. The
   * stat is the handle's, so a path swapped between check and read can't
   * slip past a size or kind check.
   */
  readonly readFileHead: (path: string, maxBytes: number) => Effect.Effect<
    { readonly info: PreciseFileInfo; readonly head: Uint8Array },
    PlatformError.PlatformError
  >
  /**
   * The MIME type the platform infers from `path`'s name, as Bun's
   * `Bun.file(path).type` does; "" or a generic type when it can't tell.
   */
  readonly contentType: (path: string) => string
  /**
   * A response body that streams the file. Read lazily: the file is opened
   * when the body is read. Locally it carries its own content type, which a
   * `Response` uses when no header sets one.
   */
  readonly fileBody: (path: string) => Effect.Effect<Blob | ReadableStream<Uint8Array>>
}>()("@kanna/server/platform/FileSystemExtras") {}

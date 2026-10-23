import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { fileTypeFromBuffer } from "file-type"
import type { ChatAttachment } from "../shared/types"
import { getProjectUploadDir } from "./paths"
import { Machine } from "./platform/machine"

const DEFAULT_BINARY_MIME_TYPE = "application/octet-stream"
const IMAGE_MIME_PREFIX = "image/"
const TEXT_PLAIN_CONTENT_TYPE = "text/plain; charset=utf-8"

const TEXT_CONTENT_TYPE_BY_EXTENSION = new Map<string, string>([
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsonc", TEXT_PLAIN_CONTENT_TYPE],
  [".md", "text/markdown; charset=utf-8"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
])

const TEXT_LIKE_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".env", ".go", ".graphql", ".h", ".hpp", ".html",
  ".ini", ".java", ".js", ".jsx", ".kt", ".lua", ".mjs", ".php", ".pl", ".properties", ".py", ".rb", ".rs",
  ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zsh",
])

function sanitizeFileName(fileName: string) {
  const baseName = path.basename(fileName).trim()
  const cleaned = baseName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "upload"
}

function getUploadCandidateNames(originalName: string) {
  const sanitizedName = sanitizeFileName(originalName)
  const parsed = path.parse(sanitizedName)
  const extension = parsed.ext
  const name = parsed.name || "upload"

  return {
    first: sanitizedName,
    withCounter(counter: number) {
      return `${name}-${counter}${extension}`
    },
  }
}

export class UploadError extends Schema.TaggedError<UploadError>()(
  "@kanna/server/uploads/UploadError",
  {
    operation: Schema.Literals(["detect", "write"]),
    projectId: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export interface PersistProjectUploadArgs {
  projectId: string
  localPath: string
  fileName: string
  bytes: Uint8Array
  fallbackMimeType?: string
}

/**
 * Writes an upload into the project's `.kanna/uploads`, never over another
 * file: a taken name gets a counter (`notes-1.txt`), decided by an exclusive
 * create, so concurrent uploads of one name all land.
 */
export const persistProjectUpload = Effect.fn("Uploads.persist")(function* (args: PersistProjectUploadArgs) {
  yield* Effect.annotateCurrentSpan("projectId", args.projectId)
  const fs = yield* FileSystem.FileSystem
  const uploadDir = getProjectUploadDir(args.localPath, (yield* Machine).homeDirectory)
  const writeError = (filePath: string) => (cause: unknown) =>
    Effect.fail(new UploadError({ operation: "write", projectId: args.projectId, filePath, cause }))
  yield* fs.makeDirectory(uploadDir, { recursive: true }).pipe(Effect.catchTag("PlatformError", writeError(uploadDir)))

  const detectedType = yield* Effect.tryPromise({
    try: () => fileTypeFromBuffer(args.bytes),
    catch: (cause) => new UploadError({ operation: "detect", projectId: args.projectId, filePath: args.fileName, cause }),
  })
  const mimeType = detectedType?.mime ?? args.fallbackMimeType ?? DEFAULT_BINARY_MIME_TYPE
  const candidates = getUploadCandidateNames(args.fileName)

  const store = (storedName: string, counter: number): Effect.Effect<string, UploadError> => {
    const absolutePath = path.join(uploadDir, storedName)
    return fs.writeFile(absolutePath, args.bytes, { flag: "wx" }).pipe(
      Effect.as(storedName),
      Effect.catchReason("PlatformError", "AlreadyExists", () => store(candidates.withCounter(counter), counter + 1)),
      Effect.catchTag("PlatformError", writeError(absolutePath)),
    )
  }
  const storedName = yield* store(candidates.first, 1)
  const absolutePath = path.join(uploadDir, storedName)

  return {
    id: randomUUID(),
    kind: mimeType.startsWith(IMAGE_MIME_PREFIX) ? "image" : "file",
    displayName: args.fileName,
    absolutePath,
    relativePath: `./.kanna/uploads/${storedName}`,
    contentUrl: `/api/projects/${args.projectId}/uploads/${encodeURIComponent(storedName)}/content`,
    mimeType,
    size: args.bytes.byteLength,
  } satisfies ChatAttachment
})

export function inferAttachmentContentType(fileName: string, fallbackType?: string): string {
  const extension = path.extname(fileName).toLowerCase()
  const mappedType = TEXT_CONTENT_TYPE_BY_EXTENSION.get(extension)
  if (mappedType) {
    return mappedType
  }

  if (TEXT_LIKE_EXTENSIONS.has(extension)) {
    return TEXT_PLAIN_CONTENT_TYPE
  }

  return fallbackType || DEFAULT_BINARY_MIME_TYPE
}

export function inferProjectFileContentType(fileName: string, fallbackType?: string): string {
  return inferAttachmentContentType(fileName, fallbackType)
}

/** True when the upload is gone (or never was); false for a name outside the uploads dir or a failed delete. */
export const deleteProjectUpload = Effect.fn("Uploads.delete")(function* (args: {
  localPath: string
  storedName: string
}) {
  const storedName = args.storedName
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return false
  }

  const fs = yield* FileSystem.FileSystem
  const absolutePath = path.join(getProjectUploadDir(args.localPath, (yield* Machine).homeDirectory), storedName)
  return yield* fs.remove(absolutePath, { force: true }).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  )
})

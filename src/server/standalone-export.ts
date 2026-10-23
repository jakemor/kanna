import { randomBytes } from "node:crypto"
import path from "node:path"
import { Effect, FileSystem, type PlatformError, Schema } from "effect"
import type {
  StandaloneTranscriptAttachmentMode,
  StandaloneTranscriptBundle,
  StandaloneTranscriptExportCommandResult,
  StandaloneTranscriptTheme,
  TranscriptEntry,
} from "../shared/types"
import { APP_VERSION } from "../shared/branding"
import { getProjectExportDir } from "./paths"
import { Machine } from "./platform/machine"

const STANDALONE_TRANSCRIPT_BUNDLE_VERSION = 1 as const
const STANDALONE_SHARE_UPLOAD_BASE_URL = "https://kanna.sh/api/share"
const STANDALONE_SHARE_PUBLIC_BASE_URL = "https://share.kanna.sh"
const STANDALONE_SHARE_WORKSPACE_PATH = "/workspace"
const STANDALONE_SHARE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".manifest": "application/manifest+json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

export interface WriteStandaloneTranscriptExportArgs {
  sourceOrigin?: string
  chatId: string
  title: string
  localPath: string
  theme: StandaloneTranscriptTheme
  attachmentMode: StandaloneTranscriptAttachmentMode
  messages: TranscriptEntry[]
  /**
   * Absolute path behind a transcript media URL (images the store moved out
   * of tool results), or null when the URL is not one. Without it those
   * images are exported as metadata only.
   */
  resolveMediaPath?: (url: string) => string | null
}

export interface StandaloneExportDeps {
  viewerDistDir?: string
  now?: Date
  fetch?: FetchLike
  shareUploadBaseUrl?: string
  sharePublicBaseUrl?: string
  shareSlugSuffix?: string
}

/** The export could not be written locally. The share upload failing is not this: it is an `ok: false` result. */
export class StandaloneExportError extends Schema.TaggedError<StandaloneExportError>()(
  "@kanna/server/standalone-export/StandaloneExportError",
  {
    operation: Schema.Literals(["viewer", "write"]),
    chatId: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/** Uploading the export to the share host failed; `message` is what the client shows. */
export class ShareUploadError extends Schema.TaggedError<ShareUploadError>()(
  "@kanna/server/standalone-export/ShareUploadError",
  {
    shareSlug: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface PreparedMessagesResult {
  messages: TranscriptEntry[]
  totalAttachmentCount: number
  bundledAttachmentCount: number
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const writeStandaloneTranscriptExport = Effect.fn("StandaloneExport.write")(function* (
  args: WriteStandaloneTranscriptExportArgs,
  deps: StandaloneExportDeps = {},
): Effect.fn.Return<StandaloneTranscriptExportCommandResult, StandaloneExportError, FileSystem.FileSystem | Machine> {
  yield* Effect.annotateCurrentSpan("chatId", args.chatId)
  const fs = yield* FileSystem.FileSystem
  const viewerDistDir = deps.viewerDistDir
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? new Date()
  const shareUploadBaseUrl = deps.shareUploadBaseUrl ?? STANDALONE_SHARE_UPLOAD_BASE_URL
  const sharePublicBaseUrl = deps.sharePublicBaseUrl ?? STANDALONE_SHARE_PUBLIC_BASE_URL
  const writeError = (filePath: string) => (cause: unknown) =>
    Effect.fail(new StandaloneExportError({ operation: "write", chatId: args.chatId, filePath, cause }))

  if (viewerDistDir === undefined || !(yield* pathExists(fs, viewerDistDir))) {
    return yield* new StandaloneExportError({
      operation: "viewer",
      chatId: args.chatId,
      filePath: viewerDistDir ?? "",
      cause: new Error("Standalone viewer bundle not found. Run `bun run build`."),
    })
  }

  const exportRootDir = getProjectExportDir(args.localPath, (yield* Machine).homeDirectory)
  yield* fs.makeDirectory(exportRootDir, { recursive: true }).pipe(Effect.catchTag("PlatformError", writeError(exportRootDir)))

  const outputDir = yield* resolveUniqueExportDir(fs, exportRootDir, args.title || args.chatId, now)
  yield* fs.copy(viewerDistDir, outputDir, { overwrite: true }).pipe(Effect.catchTag("PlatformError", writeError(outputDir)))

  const attachmentsDir = path.join(outputDir, "attachments")
  const prepared = yield* prepareStandaloneMessages(fs, args.messages, {
    attachmentMode: args.attachmentMode,
    localPath: args.localPath,
    attachmentsDir,
    resolveMediaPath: args.resolveMediaPath ?? (() => null),
  }).pipe(Effect.catchTag("PlatformError", writeError(attachmentsDir)))

  const bundle: StandaloneTranscriptBundle = {
    sourceOrigin: readSourceOrigin(args.sourceOrigin),
    version: STANDALONE_TRANSCRIPT_BUNDLE_VERSION,
    chatId: args.chatId,
    title: args.title,
    localPath: STANDALONE_SHARE_WORKSPACE_PATH,
    exportedAt: now.toISOString(),
    viewerVersion: APP_VERSION,
    theme: args.theme,
    attachmentMode: args.attachmentMode,
    messages: prepared.messages,
  }

  const transcriptJson = `${JSON.stringify(bundle, null, 2)}\n`
  const transcriptJsonPath = path.join(outputDir, "transcript.json")
  yield* fs.writeFileString(transcriptJsonPath, transcriptJson).pipe(Effect.catchTag("PlatformError", writeError(transcriptJsonPath)))
  const shareSlug = buildStandaloneShareSlug(args.title || args.chatId, deps.shareSlugSuffix)
  const shareUrl = buildStandaloneShareUrl(sharePublicBaseUrl, shareSlug)

  return yield* uploadStandaloneExportDirectory(fs, {
    outputDir,
    shareSlug,
    uploadBaseUrl: shareUploadBaseUrl,
    fetch: fetchImpl,
  }).pipe(
    Effect.map((uploadedFileCount): StandaloneTranscriptExportCommandResult => ({
      ok: true,
      outputDir,
      indexHtmlPath: path.join(outputDir, "index.html"),
      transcriptJsonPath,
      attachmentMode: args.attachmentMode,
      totalAttachmentCount: prepared.totalAttachmentCount,
      bundledAttachmentCount: prepared.bundledAttachmentCount,
      shareSlug,
      shareUrl,
      uploadedFileCount,
    })),
    // The export is on disk; the client offers the JSON as a download instead.
    Effect.catchTag("@kanna/server/standalone-export/ShareUploadError", (error) =>
      Effect.succeed<StandaloneTranscriptExportCommandResult>({
        ok: false,
        error: error.message,
        outputDir,
        transcriptJsonPath,
        transcriptFileName: `${path.basename(outputDir)}-transcript.json`,
        transcriptJson,
        shareSlug,
        shareUrl,
      })),
  )
})

/** Keep only the HTTP origin, never credentials, paths, or query parameters. */
function readSourceOrigin(sourceOrigin: string | undefined): string | undefined {
  // Older clients do not send an origin. Relative chat links still work.
  if (!URL.canParse(sourceOrigin ?? "")) return undefined
  const url = new URL(sourceOrigin ?? "")
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
}

const prepareStandaloneMessages = Effect.fn("StandaloneExport.prepareMessages")(function* (
  fs: FileSystem.FileSystem,
  messages: TranscriptEntry[],
  args: {
    attachmentMode: StandaloneTranscriptAttachmentMode
    localPath: string
    attachmentsDir: string
    resolveMediaPath: (url: string) => string | null
  },
) {
  const preparedMessages = structuredClone(messages)
  let totalAttachmentCount = 0
  let bundledAttachmentCount = 0
  let attachmentsDirCreated = false
  const ensureAttachmentsDir = Effect.suspend(() => {
    if (attachmentsDirCreated) return Effect.void
    attachmentsDirCreated = true
    return fs.makeDirectory(args.attachmentsDir, { recursive: true })
  })

  for (const message of preparedMessages) {
    // Tool result images are files beside the transcript; bundle them like
    // attachments, or blank the URL so the viewer draws nothing rather than
    // a request against a server that is not there.
    if (message.kind === "tool_result" && Array.isArray(message.content)) {
      for (const block of message.content as Array<{ type?: unknown; url?: unknown }>) {
        if (!block || typeof block !== "object" || (block.type !== "image" && block.type !== "attachment" && block.type !== "visualization") || typeof block.url !== "string" || !block.url) {
          continue
        }
        if (/^https?:\/\//.test(block.url)) continue
        totalAttachmentCount += 1
        const sourcePath = args.attachmentMode === "metadata" ? null : args.resolveMediaPath(block.url)
        if (!sourcePath || !(yield* pathExists(fs, sourcePath))) {
          block.url = ""
          continue
        }
        yield* ensureAttachmentsDir
        const exportedFileName = sanitizeFileNameSegment(path.basename(sourcePath))
        yield* fs.copyFile(sourcePath, path.join(args.attachmentsDir, exportedFileName))
        bundledAttachmentCount += 1
        block.url = `./attachments/${exportedFileName}`
      }
      continue
    }

    if (message.kind !== "user_prompt" || !message.attachments?.length) {
      continue
    }

    totalAttachmentCount += message.attachments.length

    for (const attachment of message.attachments) {
      if (args.attachmentMode === "metadata") {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachment.absolutePath || !(yield* pathExists(fs, attachment.absolutePath))) {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      yield* ensureAttachmentsDir

      const exportedFileName = `${sanitizeFileNameSegment(attachment.id)}-${sanitizeFileNameSegment(path.basename(attachment.displayName || attachment.absolutePath))}`
      const destinationPath = path.join(args.attachmentsDir, exportedFileName)
      yield* fs.copyFile(attachment.absolutePath, destinationPath)
      bundledAttachmentCount += 1

      const relativeDestinationPath = `./attachments/${exportedFileName}`
      attachment.absolutePath = relativeDestinationPath
      attachment.relativePath = relativeDestinationPath
      attachment.contentUrl = relativeDestinationPath
    }
  }

  rewriteLocalPathsForShare(preparedMessages, args.localPath)

  return {
    messages: preparedMessages,
    totalAttachmentCount,
    bundledAttachmentCount,
  } satisfies PreparedMessagesResult
})

function rewriteAttachmentAsMetadata(attachment: {
  absolutePath: string
  relativePath: string
  contentUrl: string
}) {
  attachment.absolutePath = ""
  attachment.relativePath = ""
  attachment.contentUrl = ""
}

const resolveUniqueExportDir = Effect.fn("StandaloneExport.resolveUniqueExportDir")(function* (
  fs: FileSystem.FileSystem,
  exportRootDir: string,
  title: string,
  now: Date,
) {
  const baseName = `${sanitizeFileNameSegment(title) || "chat"}-${formatExportTimestamp(now)}`
  let candidate = path.join(exportRootDir, baseName)
  let suffix = 2

  while (yield* pathExists(fs, candidate)) {
    candidate = path.join(exportRootDir, `${baseName}-${suffix}`)
    suffix += 1
  }

  return candidate
})

function formatExportTimestamp(value: Date) {
  return value
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/u, "Z")
}

function sanitizeFileNameSegment(value: string) {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Anything `stat` cannot see counts as absent, whatever the reason. */
const pathExists = (fs: FileSystem.FileSystem, targetPath: string) =>
  fs.stat(targetPath).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  )

const uploadStandaloneExportDirectory = Effect.fn("StandaloneExport.upload")(function* (
  fs: FileSystem.FileSystem,
  args: {
    outputDir: string
    shareSlug: string
    uploadBaseUrl: string
    fetch: FetchLike
  },
) {
  const uploadError = (cause: unknown, message = cause instanceof Error ? cause.message : String(cause)) =>
    new ShareUploadError({ shareSlug: args.shareSlug, message, cause })
  const filePaths = yield* listShareUploadFiles(fs, args.outputDir).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(uploadError(cause))),
  )
  let uploadedFileCount = 0

  for (const filePath of filePaths) {
    const relativePath = path.relative(args.outputDir, filePath).split(path.sep).join("/")
    const body = yield* fs.readFile(filePath).pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(uploadError(cause))))
    const response = yield* Effect.tryPromise({
      try: (signal) => args.fetch(buildShareUploadUrl(args.uploadBaseUrl, args.shareSlug, relativePath), {
        method: "PUT",
        headers: {
          "Cache-Control": getShareUploadCacheControl(relativePath),
          "Content-Type": getContentTypeForPath(relativePath),
        },
        body,
        signal,
      }),
      catch: (cause) => uploadError(cause),
    })

    if (!response.ok) {
      // The body is a courtesy; a status is enough to report.
      const detail = yield* Effect.tryPromise(() => response.text()).pipe(Effect.orElseSucceed(() => ""))
      const suffix = detail ? `: ${detail}` : ` (status ${response.status})`
      return yield* uploadError(
        { status: response.status, relativePath },
        `Failed to upload shared transcript file ${relativePath}${suffix}`,
      )
    }

    uploadedFileCount += 1
  }

  return uploadedFileCount
})

const listShareUploadFiles = Effect.fn("StandaloneExport.listShareUploadFiles")(function* (
  fs: FileSystem.FileSystem,
  outputDir: string,
) {
  const filePaths = [path.join(outputDir, "transcript.json")]
  const attachmentsDir = path.join(outputDir, "attachments")

  if (yield* pathExists(fs, attachmentsDir)) {
    filePaths.push(...yield* listExportFiles(fs, attachmentsDir))
  }

  return filePaths
})

const listExportFiles = (fs: FileSystem.FileSystem, rootDir: string): Effect.Effect<string[], PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(rootDir)
    const files: string[] = []

    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      const entryPath = path.join(rootDir, name)
      const info = yield* fs.stat(entryPath)
      if (info.type === "Directory") {
        files.push(...yield* listExportFiles(fs, entryPath))
        continue
      }
      if (info.type === "File") {
        files.push(entryPath)
      }
    }

    return files
  })

function buildStandaloneShareSlug(title: string, providedSuffix?: string) {
  const baseSlug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "chat"
  const suffix = (providedSuffix ?? generateStandaloneShareSlugSuffix())
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12) || "share"
  return `${baseSlug}-${suffix}`
}

function generateStandaloneShareSlugSuffix() {
  return BigInt(`0x${randomBytes(8).toString("hex")}`).toString(36).slice(0, 10).padStart(10, "0")
}

function buildStandaloneShareUrl(baseUrl: string, shareSlug: string) {
  return `${baseUrl.replace(/\/+$/u, "")}/${shareSlug}`
}

function buildShareUploadUrl(baseUrl: string, shareSlug: string, relativePath: string) {
  const encodedSegments = [shareSlug, ...relativePath.split("/")].map((segment) => encodeURIComponent(segment))
  return `${baseUrl.replace(/\/+$/u, "")}/${encodedSegments.join("/")}`
}

function getShareUploadCacheControl(relativePath: string) {
  return STANDALONE_SHARE_ASSET_CACHE_CONTROL
}

function getContentTypeForPath(relativePath: string) {
  return CONTENT_TYPES_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ?? "application/octet-stream"
}

function rewriteLocalPathsForShare(value: unknown, localPath: string) {
  if (!localPath) {
    return
  }

  if (typeof value === "string") {
    return value.replaceAll(localPath, STANDALONE_SHARE_WORKSPACE_PATH)
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteLocalPathsForShare(value[index], localPath)
    }
    return value
  }

  if (!value || typeof value !== "object") {
    return value
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    ;(value as Record<string, unknown>)[key] = rewriteLocalPathsForShare(nestedValue, localPath)
  }

  return value
}

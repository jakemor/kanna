import { z } from "zod"
import path from "node:path"
import { Effect, FileSystem, type PlatformError, Schema } from "effect"
import { fileTypeFromBuffer } from "file-type"
import { type DisplayAttachment } from "../shared/display-tools"
import { SHOW_VISUALIZATION_TOOL } from "./kanna-visualization-tool"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import { FileSystemExtras } from "./platform/file-system-extras"
import { UrlString } from "./kanna-tool-arguments"
import {
  defineKannaTool,
  failureText,
  platformFailureText,
  type KannaTool,
} from "./kanna-tool-definition"

/** An attachment the tools will not store, and why, in the words the agent reads. */
export class AttachmentRefusal extends Schema.TaggedError<AttachmentRefusal>()(
  "@kanna/server/kanna-display-tools/AttachmentRefusal",
  {
    message: Schema.String,
  },
) {}

/** Reading or copying an attachment's file failed. The message is the file system's own. */
export class AttachmentFileError extends Schema.TaggedError<AttachmentFileError>()(
  "@kanna/server/kanna-display-tools/AttachmentFileError",
  {
    operation: Schema.String,
    filePath: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const fileError = (operation: string, filePath: string) => (cause: unknown) =>
  new AttachmentFileError({ operation, filePath, message: failureText(cause), cause })
const platformError = (operation: string, filePath: string) => (cause: PlatformError.PlatformError) =>
  Effect.fail(new AttachmentFileError({ operation, filePath, message: platformFailureText(cause), cause }))

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

/** One attachment as the tools take it: a local path or a web URL. */
export const AttachmentItem = Schema.Struct({
  path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Local file path, absolute or relative to the project directory." })),
  url: Schema.optionalKey(UrlString.annotate({ description: "HTTP or HTTPS URL. Provide path or url, not both." })),
  kind: Schema.optionalKey(Schema.Literals(["image", "video", "file"]).annotate({ description: "For web URLs without a file extension, specify the media kind. Local files use their detected type." })),
})
export type AttachmentItem = typeof AttachmentItem.Type

const AttachmentItems = Schema.Array(AttachmentItem).check(Schema.isMinLength(1), Schema.isMaxLength(24))

/**
 * `AttachmentItem` as zod, kept as the reference the test checks the Effect
 * schema against: both give providers the same JSON Schema.
 */
export const attachmentItemSchema = z.strictObject({
  path: z.string().min(1).optional().describe("Local file path, absolute or relative to the project directory."),
  url: z.string().url().optional().describe("HTTP or HTTPS URL. Provide path or url, not both."),
  kind: z.enum(["image", "video", "file"]).optional().describe("For web URLs without a file extension, specify the media kind. Local files use their detected type."),
})

// SVG and HTML stay downloads. They must not run scripts on the app's origin.
export function attachmentKind(mime: string): DisplayAttachment["kind"] {
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime)) return "image"
  if (["video/mp4", "video/webm", "video/quicktime", "video/ogg"].includes(mime)) return "video"
  return "file"
}

/** The type the bytes say they are, or nothing when they say nothing. */
export const sniffMimeType = (bytes: Uint8Array) =>
  Effect.tryPromise(() => fileTypeFromBuffer(bytes)).pipe(
    Effect.map((type) => type?.mime),
    Effect.catchTag("UnknownError", () => Effect.succeed(undefined)),
  )

/**
 * Size and type of a local file, checked on one open handle.
 *
 * `readFileHead` rather than `FileSystem.open`: the file is opened
 * `O_NONBLOCK`, so a FIFO or device path is refused at the `isFile` check
 * instead of blocking the open forever, and the stat is of the file that was
 * opened, not of whatever the path names a moment later.
 */
const inspectLocalFile = Effect.fn("KannaDisplayTools.inspectLocalFile")(function* (source: string) {
  const files = yield* FileSystemExtras
  const { info, head } = yield* files.readFileHead(source, 8192).pipe(
    // The operation that failed (open, stat or read) and node's own error, as before.
    Effect.catchTag("PlatformError", (error) => Effect.fail(fileError(error.reason.method, source)(error.reason.cause ?? error))),
  )
  if (info.kind !== "File") return yield* new AttachmentRefusal({ message: "Attachments must be files." })
  if (info.size > MAX_ATTACHMENT_BYTES) return yield* new AttachmentRefusal({ message: "Attachments must be 100 MB or smaller." })
  const detected = yield* sniffMimeType(head)
  return { size: info.size, mimeType: detected ?? files.contentType(source) ?? "application/octet-stream" }
})

/**
 * Copies a local file into the chat's media storage and describes it for the transcript.
 * Every tool that shows local files goes through here, so the files stay available
 * after the source changes and render through the same attachment card.
 */
export const storeLocalAttachment = Effect.fn("KannaDisplayTools.storeLocalAttachment")(function* (
  source: string,
  context: { chatId: string; dataDir?: string },
) {
  yield* Effect.annotateCurrentSpan("chatId", context.chatId)
  if (!context.dataDir) return yield* new AttachmentRefusal({ message: "Chat media storage is unavailable." })
  const { size, mimeType } = yield* inspectLocalFile(source)
  const fs = yield* FileSystem.FileSystem
  const name = path.basename(source)
  const storedName = `attachment-${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)}`
  const dir = getTranscriptMediaDir(context.dataDir, context.chatId)
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchTag("PlatformError", platformError("mkdir", dir)))
  const destination = path.join(dir, storedName)
  yield* fs.copyFile(source, destination).pipe(Effect.catchTag("PlatformError", platformError("copy", source)))
  const attachment: DisplayAttachment = { type: "attachment", url: buildTranscriptMediaUrl(context.chatId, storedName), name, kind: attachmentKind(mimeType), mimeType, size }
  return { destination, attachment }
})

/** Removes copies a caller made and no longer wants. A copy that is already gone is fine. */
export const removeStoredFiles = Effect.fn("KannaDisplayTools.removeStoredFiles")(function* (files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.forEach(files, (file) => fs.remove(file, { force: true }).pipe(
    Effect.tapError((cause) => Effect.logWarning("Could not remove a stored attachment", { file, cause })),
    Effect.ignore,
  ), { concurrency: "unbounded", discard: true })
})

const describeUrl = (item: AttachmentItem & { url: string }, files: FileSystemExtras["Service"]) => Effect.try({
  try: (): DisplayAttachment => {
    const url = new URL(item.url)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Attachment URLs must use HTTP or HTTPS without embedded credentials.")
    }
    const name = decodeURIComponent(url.pathname.split("/").pop() || "attachment")
    const mimeType = files.contentType(name) || "application/octet-stream"
    const kind = mimeType === "image/svg+xml" ? "file" : item.kind ?? attachmentKind(mimeType)
    return { type: "attachment", url: url.href, name, kind, mimeType, size: null }
  },
  catch: (cause) => new AttachmentRefusal({ message: failureText(cause) }),
})

/**
 * Attachments as the transcript stores them: local files copied into the
 * chat's media, URLs checked and named. `cleanup` removes the copies, for a
 * caller that fails after this succeeded; this removes them itself if it
 * fails or is interrupted.
 */
export const resolveDisplayAttachments = Effect.fn("KannaDisplayTools.resolveAttachments")(function* (
  items: ReadonlyArray<AttachmentItem>,
  context: { chatId: string; cwd: string; dataDir?: string },
) {
  yield* Effect.annotateCurrentSpan("chatId", context.chatId)
  const services = yield* Effect.context<FileSystem.FileSystem>()
  const copied: string[] = []
  const cleanup = removeStoredFiles(copied).pipe(Effect.provideContext(services))
  const attachments = yield* Effect.forEach(items, Effect.fnUntraced(function* (item) {
    if (Boolean(item.path) === Boolean(item.url)) return yield* new AttachmentRefusal({ message: "Each attachment needs exactly one path or url." })
    if (item.url) return yield* describeUrl({ ...item, url: item.url }, yield* FileSystemExtras)
    const stored = yield* storeLocalAttachment(path.resolve(context.cwd, item.path!), context)
    copied.push(stored.destination)
    return stored.attachment
  })).pipe(Effect.onError(() => cleanup))
  return { attachments, cleanup }
})

const SEND_ATTACHMENTS = "send_attachments"

export const SEND_ATTACHMENTS_TOOL = defineKannaTool({
  name: SEND_ATTACHMENTS,
  description: "Show images, videos, and file links in the chat. Supply local paths or HTTP/HTTPS URLs. Local files are copied into the chat so they remain available after the source changes. Images and videos appear inline; other files appear as download links.",
  parameters: Schema.Struct({
    attachments: AttachmentItems,
  }),
  execute: Effect.fn("KannaDisplayTools.sendAttachments")(function* ({ attachments }, context) {
    yield* Effect.annotateCurrentSpan("chatId", context.chatId)
    const { attachments: resolved } = yield* resolveDisplayAttachments(attachments, context)
    return {
      content: [{ type: "text" as const, text: `Displayed ${resolved.length} attachment${resolved.length === 1 ? "" : "s"}.` }],
      structuredContent: { displayed: true, attachments: resolved },
      transcriptContent: resolved,
    }
  }),
})

export const DISPLAY_TOOLS: readonly KannaTool[] = [SHOW_VISUALIZATION_TOOL, SEND_ATTACHMENTS_TOOL]

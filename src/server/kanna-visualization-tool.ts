import path from "node:path"
import { Effect, FileSystem, type PlatformError, Schema } from "effect"
import { VISUALIZATION_MAX_BYTES, VISUALIZATION_MAX_HEIGHT, VISUALIZATION_TOOL_NAME, type VisualizationArtifact } from "../shared/visualization"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import { FileSystemExtras } from "./platform/file-system-extras"
import { buildVisualizationDocument } from "./visualization-document"
import { SHOW_VISUALIZATION_DESCRIPTION } from "./visualization-instructions"
import { defineKannaTool, failureText, KannaToolCallError, KannaToolRefusal, platformFailureText } from "./kanna-tool-definition"

const parameters = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({ description: "Accessible name for the visualization. No title bar is added." }),
  html: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(VISUALIZATION_MAX_BYTES)).annotate({ description: "Self-contained HTML fragment, including inline CSS and JavaScript. Supply html or path, not both." })),
  path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1)).annotate({ description: "HTML file, absolute or relative to the project. Copied into this chat; source edits will not change the saved visualization." })),
  height: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(80), Schema.isLessThanOrEqualTo(VISUALIZATION_MAX_HEIGHT)).annotate({ description: "Initial height in CSS pixels, default 360. The frame then fits the content automatically." })),
})

/**
 * The first thing in a document that the frame's CSP will refuse to load. A
 * page built on a CDN chart library renders as an empty box, and the model
 * that wrote it is told it succeeded; refused here, the error says what to do
 * while the model can still do it.
 */
export function externalResource(html: string): string | null {
  const script = /<script\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(html)
  if (script) return `a script from ${script[1]}`
  const sheet = /<link\b[^>]*\shref\s*=\s*["']?(https?:[^"'\s>]+)/i.exec(html) ?? /@import\s+(?:url\()?["']?(https?:[^"')\s;]+)/i.exec(html)
  if (sheet) return `a stylesheet from ${sheet[1]}`
  const image = /<img\b[^>]*\ssrc\s*=\s*["']?(https?:[^"'\s>]+)/i.exec(html)
  return image ? `an image from ${image[1]}` : null
}

const refuse = (message: string) => new KannaToolRefusal({ tool: VISUALIZATION_TOOL_NAME, message })
const callError = (operation: string) => (cause: unknown) =>
  new KannaToolCallError({ tool: VISUALIZATION_TOOL_NAME, operation, message: failureText(cause), cause })
const platformError = (operation: string) => (cause: PlatformError.PlatformError) =>
  Effect.fail(new KannaToolCallError({ tool: VISUALIZATION_TOOL_NAME, operation, message: platformFailureText(cause), cause }))

/**
 * The HTML in a file the agent named, opened `O_NONBLOCK` (`readFileHead`),
 * as `storeLocalAttachment` does: a FIFO is refused instead of blocking the
 * call, and the size checked is the opened file's. At most the size limit is
 * read, so an oversized file is refused without reading it whole.
 */
const readHtmlFile = Effect.fn("KannaVisualizationTool.readHtmlFile")(function* (filePath: string) {
  const files = yield* FileSystemExtras
  const { info, head } = yield* files.readFileHead(filePath, VISUALIZATION_MAX_BYTES).pipe(
    // The operation that failed (open, stat or read) and node's own error, as before.
    Effect.catchTag("PlatformError", (error) => Effect.fail(callError(error.reason.method)(error.reason.cause ?? error))),
  )
  if (info.kind !== "File") return yield* refuse("The visualization path must be a file.")
  if (info.size > VISUALIZATION_MAX_BYTES) return yield* refuse("Visualizations must be 2 MB or smaller.")
  return Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString("utf8")
})

export const SHOW_VISUALIZATION_TOOL = defineKannaTool({
  name: VISUALIZATION_TOOL_NAME,
  description: SHOW_VISUALIZATION_DESCRIPTION,
  parameters,
  execute: Effect.fn("KannaVisualizationTool.execute")(function* (args, context) {
    yield* Effect.annotateCurrentSpan("chatId", context.chatId)
    if (Boolean(args.html) === Boolean(args.path)) return yield* refuse("Provide exactly one of html or path.")
    if (!context.dataDir) return yield* refuse("Chat media storage is unavailable.")
    const html = args.path ? yield* readHtmlFile(path.resolve(context.cwd, args.path)) : args.html
    if (!html?.trim()) return yield* refuse("The visualization HTML is empty.")
    if (Buffer.byteLength(html) > VISUALIZATION_MAX_BYTES) return yield* refuse("Visualizations must be 2 MB or smaller.")
    const external = externalResource(html)
    if (external) return yield* refuse(`The visualization loads ${external}, and nothing external loads in the frame. Inline the script, style, font or image (a data: URI works for images and fonts) and call the tool again.`)
    const height = args.height ?? 360
    const name = `visualization-${crypto.randomUUID()}.html`
    const dir = getTranscriptMediaDir(context.dataDir, context.chatId)
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchTag("PlatformError", platformError("mkdir")))
    const destination = path.join(dir, name)
    yield* fs.writeFileString(destination, buildVisualizationDocument(html, args.title, height), { flag: "wx" }).pipe(
      Effect.catchTag("PlatformError", platformError("write")),
      Effect.onError(() => fs.remove(destination, { force: true }).pipe(Effect.ignore)),
    )
    const artifact: VisualizationArtifact = { type: "visualization", version: 1, title: args.title, height, url: buildTranscriptMediaUrl(context.chatId, name) }
    return {
      content: [{ type: "text" as const, text: "Visualization displayed inline in Kanna. Do not repeat it as an image, file attachment, or visualization marker." }],
      structuredContent: { displayed: true, visualization: artifact },
      transcriptContent: [artifact],
    }
  }),
})

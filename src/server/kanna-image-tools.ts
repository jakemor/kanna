import path from "node:path"
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect"
import type { DisplayAttachment } from "../shared/display-tools"
import { removeStoredFiles, sniffMimeType, storeLocalAttachment } from "./kanna-display-tools"
import { OPENROUTER_BASE_URL, readLlmProviderSnapshot } from "./llm-provider"
import { Machine } from "./platform/machine"
import { defineKannaTool, failureText, platformFailureText, type KannaTool, type KannaToolServices } from "./kanna-tool-definition"

/** Nano Banana 2 Lite on OpenRouter. It serves 1K images and takes up to 14 reference images. */
export const IMAGE_MODEL = "google/gemini-3.1-flash-lite-image"

const MAX_IMAGES = 12
const MAX_REFERENCE_IMAGES = 14
// A reference travels inline as a data URL, so one large file would fail the whole request.
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const ASPECT_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"] as const

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const ImageRequest = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "What to draw. Describe the subject, composition, palette, and style. The image model cannot see the conversation." }),
  path: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Where to save the image, absolute or relative to the project directory. Parent directories are created. The extension is corrected to match the returned bytes." }),
  aspectRatio: Schema.optionalKey(Schema.Literals(ASPECT_RATIOS)),
  referenceImages: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(MAX_REFERENCE_IMAGES))
    .annotate({ description: "Images to work from. Each entry is a local path, the filename of a file the user attached to this chat, or an HTTP/HTTPS URL. A path may name an image that an earlier call saved." })),
})
type ImageRequest = typeof ImageRequest.Type

const parameters = Schema.Struct({
  images: Schema.Array(ImageRequest).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_IMAGES))
    .annotate({ description: "One entry per image. All entries generate in parallel, so put a whole batch in one call. An entry cannot reference an image from the same call." }),
})

/** Making one image failed, in the words the agent reads. */
export class ImageGenerationError extends Schema.TaggedError<ImageGenerationError>()(
  "@kanna/server/kanna-image-tools/ImageGenerationError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const imageError = (message: string, cause: unknown = null) => new ImageGenerationError({ message, cause })

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ImageCredentials {
  apiKey: string
  baseUrl: string
}

/** The key from Settings › Providers › Model Registry, the same one voice input uses. */
export const readImageCredentials = Effect.fn("KannaImageTools.readCredentials")(function* () {
  const registry = yield* readLlmProviderSnapshot().pipe(
    Effect.catchTag("@kanna/server/llm-provider/LlmProviderFileError", (cause) => Effect.fail(imageError(cause.message, cause))),
  )
  if (registry.provider === "openrouter" && registry.apiKey.trim()) {
    return { apiKey: registry.apiKey.trim(), baseUrl: registry.resolvedBaseUrl } satisfies ImageCredentials
  }
  const envKey = (yield* Machine).env.get("OPENROUTER_API_KEY")?.trim()
  if (envKey) return { apiKey: envKey, baseUrl: OPENROUTER_BASE_URL } satisfies ImageCredentials
  return yield* imageError("Image generation needs an OpenRouter API key. Set one under Settings › Providers › Model Registry.")
})

/**
 * A reference entry as a URL the provider can read.
 *
 * Kanna runs on the user's machine, so a local file has no public URL. It
 * travels inline as a data URL. A bare filename that is not in the project is
 * looked up in `.kanna/uploads`, where chat attachments land.
 */
export const resolveReferenceImage = Effect.fn("KannaImageTools.resolveReferenceImage")(function* (entry: string, cwd: string) {
  if (/^https?:\/\//i.test(entry)) return entry
  const fs = yield* FileSystem.FileSystem
  for (const candidate of [path.resolve(cwd, entry), path.resolve(cwd, ".kanna/uploads", entry)]) {
    const read = yield* fs.readFile(candidate).pipe(Effect.option)
    if (Option.isNone(read)) continue
    const bytes = Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength)
    if (bytes.byteLength > MAX_REFERENCE_BYTES) return yield* imageError(`Reference image "${entry}" is over 10 MB. Downscale it first.`)
    const mimeType = yield* sniffMimeType(bytes)
    if (!mimeType || !(mimeType in EXTENSION_BY_MIME)) return yield* imageError(`Reference "${entry}" is not a png, jpg, gif, or webp image.`)
    return `data:${mimeType};base64,${bytes.toString("base64")}`
  }
  // A missing reference fails the image. Dropping it would return a plausible
  // picture that ignores the one thing the user pointed at.
  return yield* imageError(`No reference image "${entry}". Expected a local path, an attached filename, or an HTTP/HTTPS URL.`)
})

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined

/** OpenRouter's `/images` endpoint: one JSON request, one JSON response that carries base64. */
export const requestImage = Effect.fn("KannaImageTools.requestImage")(function* (
  request: { prompt: string; aspectRatio?: string; references: string[] },
  credentials: ImageCredentials,
  fetchImpl: Fetch = fetch,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchImpl(`${credentials.baseUrl.replace(/\/+$/, "")}/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio,
        input_references: request.references.length
          ? request.references.map((url) => ({ type: "image_url", image_url: { url } }))
          : undefined,
      }),
      signal,
    }),
    catch: (cause) => imageError(failureText(cause), cause),
  })
  const body = yield* Effect.tryPromise({ try: () => response.text(), catch: (cause) => imageError(failureText(cause), cause) })
  // A non-JSON body is reported below, as the status and the start of the text.
  const payload = Option.getOrUndefined(decodeJson(body))
  const error = field(payload, "error")
  if (!response.ok) return yield* imageError(`Image generation failed (${response.status}): ${field(error, "message") ?? body.slice(0, 300)}`)
  // A 200 can still be a refusal. It carries `error` and no data.
  if (error) return yield* imageError(`Image generation failed: ${field(error, "message") ?? "unknown error"}`)
  const data = field(payload, "data")
  const base64 = Array.isArray(data) ? field(data[0], "b64_json") : undefined
  if (typeof base64 !== "string" || !base64) return yield* imageError("Image generation returned no image.")
  const bytes = Buffer.from(base64, "base64")
  const mimeType = yield* sniffMimeType(bytes)
  if (!mimeType || !(mimeType in EXTENSION_BY_MIME)) return yield* imageError("Image generation returned bytes that are not an image.")
  return { bytes, mimeType }
})

/** The model names the file before it knows the format. Build tools read the extension, so it follows the bytes. */
export function pathForMimeType(filePath: string, mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType]
  if (!extension) return filePath
  const current = path.extname(filePath).slice(1).toLowerCase()
  if (current === extension || (extension === "jpg" && current === "jpeg")) return filePath
  return current ? `${filePath.slice(0, -current.length - 1)}.${extension}` : `${filePath}.${extension}`
}

export const generateImageFile = Effect.fn("KannaImageTools.generateImageFile")(function* (
  image: ImageRequest,
  context: { cwd: string },
  credentials: ImageCredentials,
  fetchImpl: Fetch = fetch,
) {
  const references = yield* Effect.forEach(image.referenceImages ?? [], (entry) => resolveReferenceImage(entry, context.cwd), { concurrency: "unbounded" })
  const { bytes, mimeType } = yield* requestImage({ prompt: image.prompt, aspectRatio: image.aspectRatio, references }, credentials, fetchImpl)
  const destination = pathForMimeType(path.resolve(context.cwd, image.path), mimeType)
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
    Effect.andThen(fs.writeFile(destination, bytes)),
    Effect.catchTag("PlatformError", (cause) => Effect.fail(imageError(platformFailureText(cause), cause))),
  )
  return destination
})

const GENERATE_IMAGES = "generate_images"

export function createGenerateImagesTool(deps: {
  readCredentials?: Effect.Effect<ImageCredentials, ImageGenerationError, KannaToolServices>
  fetchImpl?: Fetch
} = {}): KannaTool<typeof parameters.Type> {
  return defineKannaTool({
    name: GENERATE_IMAGES,
    description: "Generate images with Nano Banana 2 Lite, save each one to the path you give, and show them in the chat. All entries generate in parallel, so request a whole batch in one call. The images are not returned to you inline. Read a saved path if you need to look at one. Reference images carry a character or a style from one image to the next.",
    parameters,
    execute: Effect.fn("KannaImageTools.generateImages")(function* ({ images }, context) {
      yield* Effect.annotateCurrentSpan("chatId", context.chatId)
      const credentials = yield* (deps.readCredentials ?? readImageCredentials())
      // Every image runs to its own end: one failure is a line in the result, not the call's failure.
      const results = yield* Effect.forEach(images, (image) => Effect.exit(generateImageFile(image, context, credentials, deps.fetchImpl)), { concurrency: "unbounded" })

      const attachments: DisplayAttachment[] = []
      const copied: string[] = []
      const lines: string[] = []
      yield* Effect.forEach(results, Effect.fnUntraced(function* (result, index) {
        if (Exit.isFailure(result)) {
          lines.push(`Failed ${images[index]!.path}: ${failureText(Cause.squash(result.cause))}`)
          return
        }
        const stored = yield* storeLocalAttachment(result.value, context)
        copied.push(stored.destination)
        attachments.push(stored.attachment)
        lines.push(`Saved ${path.relative(context.cwd, result.value) || result.value}`)
      })).pipe(Effect.onError(() => removeStoredFiles(copied)))
      // With nothing to show there is no card, so the call reports as an error.
      if (!attachments.length) return yield* imageError(lines.join("\n"))
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { displayed: true, attachments },
        // The same shape `send_attachments` stores, so both render through one attachment card.
        transcriptContent: attachments,
      }
    }),
  })
}

export const GENERATE_IMAGES_TOOL = createGenerateImagesTool()

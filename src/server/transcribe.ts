import { Effect, Option, Schema } from "effect"
import type { LlmProviderSnapshot } from "../shared/types"

// Speech to text for the composer's voice input. The clients POST the raw
// recording to /api/transcribe and get back { text }. The key comes from
// the Model Registry, which must point at OpenRouter: this is OpenRouter's
// /audio/transcriptions call (base64 in JSON, not multipart).
//
// The model is the same one Tressa settled on. microsoft/mai-transcribe-1.5
// rejects the m4a and webm that AVAudioRecorder and MediaRecorder produce.
export const TRANSCRIPTION_MODEL = "openai/gpt-transcribe"

// Base64 plus JSON.stringify keeps about three copies of the audio in
// memory; a minute of 16 kHz AAC is well under 1 MB, so this is generous.
export const MAX_TRANSCRIBE_BYTES = 25_000_000

/** A failure the client is told about, as `{ error: { code, message } }` with `status`. */
export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "@kanna/server/transcribe/TranscriptionError",
  {
    message: Schema.String,
    code: Schema.Literals([
      "method_not_allowed",
      "missing_openrouter_key",
      "empty_audio",
      "request_too_large",
      "transcription_failed",
    ]),
    status: Schema.Number,
  },
) {}

/** The request to OpenRouter, or reading the upload, failed outright. Becomes a 500, as before. */
export class TranscriptionRequestError extends Schema.TaggedError<TranscriptionRequestError>()(
  "@kanna/server/transcribe/TranscriptionRequestError",
  {
    operation: Schema.Literals(["read upload", "fetch", "read response"]),
    cause: Schema.Defect(),
  },
) {}

/** The `format` OpenRouter expects for a recorded Content-Type. */
export function audioFormat(contentType: string): string {
  const subtype = contentType.split(";")[0].trim().toLowerCase().replace(/^audio\//, "")
  switch (subtype) {
    case "mp4":
    case "m4a":
    case "x-m4a":
      return "m4a"
    case "mpeg":
    case "mp3":
      return "mp3"
    case "wav":
    case "x-wav":
      return "wav"
    case "flac":
    case "ogg":
    case "webm":
    case "aac":
      return subtype
    default:
      return "m4a"
  }
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** `value[key]` when `value` is an object, as JSON property access reads it. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

export const transcribeAudioBytes = Effect.fn("Transcribe.transcribeAudioBytes")(function* (
  audio: ArrayBuffer | Uint8Array,
  contentType: string,
  registry: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "resolvedBaseUrl">,
  fetchImpl: Fetch = fetch,
) {
  if (registry.provider !== "openrouter" || !registry.apiKey.trim()) {
    return yield* new TranscriptionError({
      message: "Voice input needs an OpenRouter API key. Set one under Settings › Providers › Model Registry.",
      code: "missing_openrouter_key",
      status: 400,
    })
  }
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
  if (bytes.byteLength === 0) {
    return yield* new TranscriptionError({ message: "The recording was empty.", code: "empty_audio", status: 400 })
  }
  if (bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    return yield* new TranscriptionError({ message: "The recording is too large to transcribe.", code: "request_too_large", status: 413 })
  }

  const baseUrl = registry.resolvedBaseUrl.replace(/\/+$/, "")
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${registry.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Kanna",
      },
      body: JSON.stringify({
        model: TRANSCRIPTION_MODEL,
        input_audio: {
          data: Buffer.from(bytes).toString("base64"),
          format: audioFormat(contentType),
        },
      }),
      signal,
    }),
    catch: (cause) => new TranscriptionRequestError({ operation: "fetch", cause }),
  })

  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new TranscriptionRequestError({ operation: "read response", cause }),
  })
  if (!response.ok) {
    return yield* new TranscriptionError({
      message: `Transcription failed (${response.status}): ${upstreamMessage(body) || response.statusText}`,
      code: "transcription_failed",
      // A bad key stays a 401 instead of turning into a 500.
      status: response.status >= 400 && response.status <= 599 ? response.status : 502,
    })
  }

  // `{ text }`, or a 200 with `{ error }` when the provider declines.
  const payload = decodeJson(body)
  if (Option.isNone(payload)) {
    return yield* new TranscriptionError({ message: "Transcription returned invalid JSON.", code: "transcription_failed", status: 502 })
  }
  const error = field(payload.value, "error")
  const text = field(payload.value, "text")
  if (error) {
    return yield* new TranscriptionError({
      message: `Transcription failed: ${field(error, "message") || "unknown error"}`,
      code: "transcription_failed",
      status: 502,
    })
  }
  return typeof text === "string" ? text : ""
})

/** The provider's own words from an error body, else the start of the body. */
function upstreamMessage(body: string): string {
  return Option.match(decodeJson(body), {
    onNone: () => body.slice(0, 200),
    onSome: (parsed) => {
      const error = field(parsed, "error")
      if (typeof error === "string") return error
      const message = field(error, "message")
      return typeof message === "string" ? message : ""
    },
  })
}

/**
 * POST /api/transcribe. Succeeds with null for any other path so the router
 * falls through. `readRegistry` reads the Model Registry; its failures, and
 * a failed request to OpenRouter, are left to the caller (a 500).
 */
export const handleTranscribe = Effect.fn("Transcribe.handleTranscribe")(function* <E>(
  req: Request,
  url: URL,
  readRegistry: Effect.Effect<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "resolvedBaseUrl">, E>,
  fetchImpl: Fetch = fetch,
) {
  if (url.pathname !== "/api/transcribe") {
    return null
  }
  if (req.method !== "POST") {
    return errorEnvelope("method_not_allowed", "Use POST for transcription.", 405)
  }
  // The declared length first, so an oversized upload is refused before
  // it is buffered. The real check is on the bytes; the header can be absent.
  const contentLength = Number(req.headers.get("content-length") ?? 0)
  if (contentLength > MAX_TRANSCRIBE_BYTES) {
    return errorEnvelope("request_too_large", "The recording is too large to transcribe.", 413)
  }
  const audio = yield* Effect.tryPromise({
    try: () => req.arrayBuffer(),
    catch: (cause) => new TranscriptionRequestError({ operation: "read upload", cause }),
  })
  const registry = yield* readRegistry
  return yield* transcribeAudioBytes(audio, req.headers.get("content-type") ?? "audio/mp4", registry, fetchImpl).pipe(
    Effect.map((text) => Response.json({ text }, { headers: { "Cache-Control": "no-store" } })),
    Effect.catchTag("@kanna/server/transcribe/TranscriptionError", (error) =>
      Effect.succeed(errorEnvelope(error.code, error.message, error.status))),
  )
})

function errorEnvelope(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status })
}

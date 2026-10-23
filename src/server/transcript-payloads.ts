import { Effect, FileSystem, Option, Schema } from "effect"
import type { TranscriptEntry } from "../shared/types"
import { INLINE_TOOL_KINDS, UNBOUNDED_TOOL_INPUT_FIELDS, trimToolCallEntry } from "./events"

/**
 * Tool payloads live in a sidecar, not in the transcript.
 *
 * `transcripts/<chat>.jsonl` holds what a transcript render needs: every
 * entry, with tool calls and results cut down to their headers. The bodies
 * (a file written, an edit's old and new text, a command's output) go to
 * `transcripts/<chat>.payloads.jsonl`, one line per entry id, and come back
 * only when a row is opened.
 *
 * This is what makes a cold open scale with the number of entries instead
 * of their bytes. The 2,300-entry chat that motivated it parsed 41 MB to
 * paint 1.5 MB of headers; now it parses the 1.5 MB. The sidecar is never
 * parsed whole except by the full-fidelity readers (export, handoff, fork).
 *
 * Reads are by byte offset. The index (id to offset and length) is built
 * once per chat by scanning the sidecar for newlines, without parsing, and
 * then kept current as lines are appended.
 *
 * Every read (`loadTranscriptPayloadIndex`, `readTranscriptPayloadsById`,
 * `readTranscriptPayloads`) goes through `FileSystem` and backs the
 * EventStore's Effect reads (`readEntriesById`, `readMessages`).
 */

/** A header's dropped fields, keyed by entry id. */
export interface TranscriptPayload {
  _id: string
  /** Tool call: the unbounded input fields and the raw input, if any. */
  tool?: { rawInput?: unknown; input?: Record<string, unknown> }
  /** Tool result: the body. */
  content?: unknown
}

export interface SplitTranscriptEntry {
  header: TranscriptEntry
  payload: TranscriptPayload | null
}

/**
 * Cut an entry into the header the transcript keeps and the payload the
 * sidecar keeps. Entries with nothing to move come back as the same object
 * with a null payload.
 *
 * `isInlineResult` says whether a result belongs to a tool that renders
 * inline (`INLINE_TOOL_KINDS`); those keep their content in the header
 * because there is no row to open.
 */
export function splitTranscriptEntry(entry: TranscriptEntry, isInlineResult: (toolId: string) => boolean): SplitTranscriptEntry {
  if (entry.kind === "tool_call") {
    if (INLINE_TOOL_KINDS.has(entry.tool.toolKind)) return { header: entry, payload: null }
    const header = trimToolCallEntry(entry)
    if (header === entry) return { header: entry, payload: null }
    const input: Record<string, unknown> = {}
    for (const field of UNBOUNDED_TOOL_INPUT_FIELDS[entry.tool.toolKind] ?? []) {
      const value = (entry.tool.input as Record<string, unknown>)[field]
      if (value !== undefined) input[field] = value
    }
    const payload: TranscriptPayload = { _id: entry._id, tool: {} }
    if (entry.tool.rawInput !== undefined) payload.tool!.rawInput = entry.tool.rawInput
    if (Object.keys(input).length > 0) payload.tool!.input = input
    return { header, payload }
  }

  if (entry.kind === "tool_result") {
    if (entry.trimmed || entry.content === undefined || isInlineResult(entry.toolId)) {
      return { header: entry, payload: null }
    }
    const { content, ...rest } = entry
    return {
      header: { ...rest, trimmed: true } as TranscriptEntry,
      payload: { _id: entry._id, content },
    }
  }

  return { header: entry, payload: null }
}

/** The whole entry again: header plus what the sidecar held for it. */
export function mergeTranscriptPayload(header: TranscriptEntry, payload: TranscriptPayload | undefined): TranscriptEntry {
  if (!payload) return header
  const { trimmed, ...rest } = header as TranscriptEntry & { trimmed?: true }
  if (rest.kind === "tool_call" && payload.tool) {
    return {
      ...rest,
      tool: {
        ...rest.tool,
        ...(payload.tool.rawInput !== undefined ? { rawInput: payload.tool.rawInput } : {}),
        input: { ...(rest.tool.input as Record<string, unknown>), ...(payload.tool.input ?? {}) },
      },
    } as TranscriptEntry
  }
  if (rest.kind === "tool_result" && "content" in payload) {
    return { ...rest, content: payload.content } as TranscriptEntry
  }
  return header
}

export interface PayloadSpan {
  offset: number
  length: number
}

const ID_PREFIX = '{"_id":"'

/**
 * Where each payload line sits in the sidecar. Lines are written with `_id`
 * first, so the id is read straight off the line's prefix and nothing is
 * parsed. A repeated id (a rewrite that died before its rename) resolves
 * to the last line, which is the newest.
 */
export class TranscriptPayloadIndex {
  private readonly spans = new Map<string, PayloadSpan>()
  /** Bytes of the sidecar covered by the index; the next append starts here. */
  private scannedBytes = 0

  /** Scans `bytes`, the sidecar as `loadTranscriptPayloadIndex` read it. */
  constructor(readonly sidecarPath: string, bytes: Uint8Array) {
    this.scan(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }

  /** Account for a line this process just appended, without touching disk. */
  noteAppended(payloadId: string, lineBytes: number) {
    this.spans.set(payloadId, { offset: this.scannedBytes, length: lineBytes })
    this.scannedBytes += lineBytes
  }

  has(payloadId: string) {
    return this.spans.has(payloadId)
  }

  /** Where a payload's line sits, for `readTranscriptPayloadsById`. */
  span(payloadId: string): PayloadSpan | undefined {
    return this.spans.get(payloadId)
  }

  private scan(bytes: Buffer) {
    let start = 0
    while (start < bytes.length) {
      let end = bytes.indexOf(0x0a, start)
      if (end === -1) end = bytes.length
      const length = end - start
      const id = readIdPrefix(bytes, start, end)
      if (id !== null) this.spans.set(id, { offset: start, length })
      start = end + 1
    }
    this.scannedBytes = bytes.length
  }
}

function readIdPrefix(bytes: Buffer, start: number, end: number): string | null {
  const head = bytes.toString("utf8", start, Math.min(end, start + 256))
  if (!head.startsWith(ID_PREFIX)) return null
  const close = head.indexOf('"', ID_PREFIX.length)
  if (close === -1) return null
  const raw = head.slice(ID_PREFIX.length, close)
  // Ids are UUIDs and tool ids; neither needs JSON unescaping. Anything
  // with a backslash is not one of ours.
  return raw.includes("\\") ? null : raw
}

/** Serialize a payload with `_id` first, which the index scan depends on. */
export function serializeTranscriptPayload(payload: TranscriptPayload) {
  const { _id, ...rest } = payload
  return `${JSON.stringify({ _id, ...rest })}\n`
}

function parsePayloadLines(text: string) {
  const payloads = new Map<string, TranscriptPayload>()
  for (const line of text.split("\n")) {
    if (!line) continue
    // Skip a garbled line rather than fail the whole read.
    const payload = decodePayloadLine(line)
    if (Option.isSome(payload)) payloads.set(payload.value._id, payload.value)
  }
  return payloads
}

export class TranscriptPayloadReadError extends Schema.TaggedError<TranscriptPayloadReadError>()(
  "@kanna/server/transcript-payloads/TranscriptPayloadReadError",
  {
    sidecarPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/** The index of a sidecar, read through `FileSystem`. No sidecar is an empty index. */
export const loadTranscriptPayloadIndex = Effect.fn("TranscriptPayloads.loadIndex")(function* (sidecarPath: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(sidecarPath).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(new Uint8Array(0))),
    Effect.catchTag("PlatformError", (cause) => Effect.fail(new TranscriptPayloadReadError({ sidecarPath, cause }))),
  )
  return new TranscriptPayloadIndex(sidecarPath, bytes)
})

/**
 * The payloads of `payloadIds`, one positional read each through one open
 * file. Ids the index does not have are absent. A line that cannot be read
 * or decoded loses that payload, not the batch.
 */
export const readTranscriptPayloadsById = Effect.fn("TranscriptPayloads.readById")(function* (
  index: TranscriptPayloadIndex,
  payloadIds: Iterable<string>,
) {
  const payloads = new Map<string, TranscriptPayload>()
  const spans = [...payloadIds].flatMap((payloadId) => {
    const span = index.span(payloadId)
    return span ? [[payloadId, span] as const] : []
  })
  if (spans.length === 0) return payloads
  const fs = yield* FileSystem.FileSystem
  yield* Effect.scoped(Effect.gen(function* () {
    const file = yield* fs.open(index.sidecarPath)
    for (const [payloadId, span] of spans) {
      const bytes = yield* file.readAlloc(span.length, { position: BigInt(span.offset) }).pipe(
        Effect.catchTag("PlatformError", () => Effect.succeedNone),
      )
      if (Option.isNone(bytes)) continue
      const line = Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength).toString("utf8")
      const payload = decodePayloadLine(line)
      if (Option.isSome(payload)) payloads.set(payloadId, payload.value)
    }
  })).pipe(Effect.catchTag("PlatformError", () => Effect.void))
  return payloads
})

/** Every payload in a sidecar, through `FileSystem`. */
export const readTranscriptPayloads = Effect.fn("TranscriptPayloads.readAll")(function* (sidecarPath: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(sidecarPath).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
    Effect.catchTag("PlatformError", (cause) => Effect.fail(new TranscriptPayloadReadError({ sidecarPath, cause }))),
  )
  return parsePayloadLines(text)
})

/**
 * One sidecar line. Only `_id` is checked: the bodies are whatever the
 * provider sent, and every sidecar line ever written has to keep loading.
 * Keys this does not name are dropped; `mergeTranscriptPayload` reads only
 * these.
 */
const TranscriptPayloadLine = Schema.Struct({
  _id: Schema.String,
  tool: Schema.optionalKey(Schema.Struct({
    rawInput: Schema.optionalKey(Schema.Unknown),
    input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  })),
  content: Schema.optionalKey(Schema.Unknown),
})

const decodePayloadLine: (line: string) => Option.Option<TranscriptPayload> =
  Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptPayloadLine))

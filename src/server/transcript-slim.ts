import { Effect, FileSystem, Option, Predicate, Schema, Stream } from "effect"
import type { TranscriptEntry } from "../shared/types"
import { STRUCTURED_RESULT_TOOL_KINDS, readStructuredResult } from "./events"

/**
 * Rewrite of transcripts written before tool results stopped carrying
 * `debugRaw`.
 *
 * Every Claude tool result used to store the whole raw provider message next
 * to its own `content`. For a screenshot read that is 600 KB of base64 held
 * twice, and three chats here passed 100 MB on disk. Nothing reads that copy
 * except the lift of `tool_use_result` for `ask_user_question` and
 * `exit_plan_mode`, so the rewrite keeps that one field as `structuredResult`
 * and drops the rest. `system_init` keeps its `debugRaw`: the raw JSON view
 * shows it, and it is a few KB. Every other kind loses the field. Inline images move to disk in the same pass
 * (see `transcript-media.ts`), through the `transform` hook.
 *
 * The file is streamed line by line and never held whole: the point is to
 * shrink files too large to parse comfortably, so parsing them whole first
 * would defeat it.
 */

export interface SlimTranscriptFileResult {
  /** True when the file was rewritten. */
  changed: boolean
  bytesBefore: number
  bytesAfter: number
}

/**
 * The entry as it should be on disk, or the same object when nothing needs
 * to change. Tool calls of the structured kinds must be recorded in
 * `structuredToolIds` before their result is seen; the call always precedes
 * its result in a transcript.
 */
export function slimTranscriptEntry(entry: TranscriptEntry, structuredToolIds: Set<string>): TranscriptEntry {
  if (entry.kind === "tool_call") {
    if (STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) {
      structuredToolIds.add(entry.tool.toolId)
    }
    return entry
  }
  if (entry.kind === "system_init" || entry.debugRaw === undefined) return entry

  const { debugRaw, ...rest } = entry
  // Older builds stamped other kinds too (assistant text, results); nothing
  // reads those, so they just go.
  if (rest.kind !== "tool_result") return rest
  if (!structuredToolIds.has(rest.toolId) || rest.structuredResult !== undefined) {
    return rest
  }
  const structured = readStructuredResult(debugRaw)
  return structured === undefined ? rest : { ...rest, structuredResult: structured }
}

/**
 * Rewrite one transcript file in place through a temp file and rename.
 * Unparseable lines, and `null` lines, are copied through untouched. When no line changes the temp file
 * is never written and the original is left alone, mtime included.
 *
 * `transform` runs on every parsed entry after the slim, for rewrites that
 * need I/O of their own (moving inline images to disk). It must return the
 * same object when it changes nothing. Its failure fails the rewrite, and
 * the file is left as it was.
 */
export const slimTranscriptFile = Effect.fn("TranscriptSlim.slimFile")(function* <E = never, R = never>(
  transcriptPath: string,
  transform?: (entry: TranscriptEntry) => Effect.Effect<TranscriptEntry, E, R>,
): Effect.fn.Return<SlimTranscriptFileResult, TranscriptSlimError | E, FileSystem.FileSystem | R> {
  yield* Effect.annotateCurrentSpan("transcriptPath", transcriptPath)
  const fs = yield* FileSystem.FileSystem
  const fail = (cause: unknown) => Effect.fail(new TranscriptSlimError({ transcriptPath, cause }))
  const bytesBefore = Number((yield* fs.stat(transcriptPath).pipe(Effect.catchTag("PlatformError", fail))).size)
  const tempPath = `${transcriptPath}.slim.tmp`
  const structuredToolIds = new Set<string>()
  const output: string[] = []
  let changed = false

  // Split as `readline` did: on \n, \r\n and a lone \r.
  yield* fs.stream(transcriptPath).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((rawLine) => {
      const line = rawLine.trim()
      if (!line) return Effect.void
      const entry = Option.filter(decodeJsonLine(line), Predicate.isNotNull)
      if (Option.isNone(entry)) {
        output.push(rawLine)
        return Effect.void
      }
      // TranscriptEntry has no Schema (shared/types.ts stays plain types).
      // The slim reads only the fields it checks, and a line it does not
      // recognise comes back as the same object and is copied through.
      const parsed = entry.value as TranscriptEntry
      const slimmed = slimTranscriptEntry(parsed, structuredToolIds)
      const record = (next: TranscriptEntry) => {
        if (next === parsed) {
          output.push(line)
          return
        }
        changed = true
        output.push(JSON.stringify(next))
      }
      if (!transform) return Effect.sync(() => record(slimmed))
      return transform(slimmed).pipe(Effect.map(record))
    }),
    Effect.catchTag("PlatformError", fail),
  )

  if (!changed) {
    return { changed: false, bytesBefore, bytesAfter: bytesBefore }
  }

  const payload = output.length > 0 ? `${output.join("\n")}\n` : ""
  yield* fs.writeFileString(tempPath, payload).pipe(
    Effect.andThen(fs.rename(tempPath, transcriptPath)),
    Effect.catchTag("PlatformError", fail),
    Effect.onError(() => fs.remove(tempPath, { force: true }).pipe(Effect.ignore)),
  )
  return { changed: true, bytesBefore, bytesAfter: Buffer.byteLength(payload, "utf8") }
})

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export class TranscriptSlimError extends Schema.TaggedError<TranscriptSlimError>()(
  "@kanna/server/transcript-slim/TranscriptSlimError",
  {
    transcriptPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

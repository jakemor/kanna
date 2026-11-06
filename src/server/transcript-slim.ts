import { createReadStream } from "node:fs"
import { rename, rm, stat, writeFile } from "node:fs/promises"
import { iterateLfLines } from "./lf-lines"
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
 * Unparseable lines are copied through untouched. When no line changes the
 * temp file is discarded and the original is left alone, mtime included.
 *
 * `transform` runs on every parsed entry after the slim, for rewrites that
 * need I/O of their own (moving inline images to disk). It must return the
 * same object when it changes nothing.
 */
export async function slimTranscriptFile(
  transcriptPath: string,
  transform?: (entry: TranscriptEntry) => Promise<TranscriptEntry>
): Promise<SlimTranscriptFileResult> {
  const bytesBefore = (await stat(transcriptPath)).size
  const tempPath = `${transcriptPath}.slim.tmp`
  const structuredToolIds = new Set<string>()
  const output: string[] = []
  let changed = false

  const lines = iterateLfLines(createReadStream(transcriptPath))
  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      output.push(rawLine)
      continue
    }
    let slimmed = slimTranscriptEntry(entry, structuredToolIds)
    if (transform) slimmed = await transform(slimmed)
    if (slimmed === entry) {
      output.push(line)
      continue
    }
    changed = true
    output.push(JSON.stringify(slimmed))
  }

  if (!changed) {
    return { changed: false, bytesBefore, bytesAfter: bytesBefore }
  }

  const payload = output.length > 0 ? `${output.join("\n")}\n` : ""
  try {
    await writeFile(tempPath, payload, "utf8")
    await rename(tempPath, transcriptPath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
  return { changed: true, bytesBefore, bytesAfter: Buffer.byteLength(payload, "utf8") }
}

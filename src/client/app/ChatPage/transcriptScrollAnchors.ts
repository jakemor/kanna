import type { HydratedTranscriptMessage, ResolvedChatReadAnchor } from "../../../shared/types"
import type { ChatJumpTarget } from "../../lib/chat-navigation"
import type { ResolvedTranscriptRow } from "../KannaTranscript"
import { getUserPromptSignature } from "../kannaStateHelpers"

/**
 * Pure helpers backing transcript scroll restoration. Kept out of the viewport
 * component so the tricky identity rules stay unit testable.
 */

/** Prefix optimistic prompt ids carry until the server echoes them back. */
const OPTIMISTIC_ID_PREFIX = "optimistic:"

export function isOptimisticMessageId(messageId: string) {
  return messageId.startsWith(OPTIMISTIC_ID_PREFIX)
}

/**
 * The message id a row should be remembered by. For a tool group we use its
 * first member, which is also what the row id embeds. A fold's header is no
 * message; the reader's place is taken from the rows around it instead.
 */
export function getRowAnchorMessageId(row: ResolvedTranscriptRow): string | null {
  if (row.kind === "single") return row.message.id
  if (row.kind === "fold-header") return null
  return row.messages[0]?.id ?? null
}

/**
 * Maps every message id to the row that renders it.
 *
 * Tool-group rows map *all* their members, not just the head: grouping shifts
 * as a run grows, so a message that headed a group when the anchor was written
 * may sit mid-group when we restore it.
 */
export function buildRowIndexByMessageId(rows: ResolvedTranscriptRow[]): Map<string, number> {
  const map = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row.kind === "single") {
      map.set(row.message.id, index)
      return
    }
    if (row.kind === "fold-header") return
    for (const message of row.messages) {
      map.set(message.id, index)
    }
  })
  return map
}

/** Index of the row rendering a tool call (its own row, or its tool group's), or null. */
export function findToolCallRowIndex(rows: ResolvedTranscriptRow[], toolId: string): number | null {
  const isCall = (message: HydratedTranscriptMessage) => message.kind === "tool" && message.toolId === toolId
  const index = rows.findIndex((row) => (
    row.kind === "single" ? isCall(row.message) : row.kind === "tool-group" && row.messages.some(isCall)
  ))
  return index === -1 ? null : index
}

/** Index of the row rendering the most recent user prompt, or null. */
export function findLatestUserPromptRowIndex(rows: ResolvedTranscriptRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.kind === "single" && row.message.kind === "user_prompt") {
      return index
    }
  }
  return null
}

export interface LatestUserPrompt {
  messageId: string
  /** Content signature, used to recognise an optimistic prompt across reconciliation. */
  signature: string
  rowIndex: number
  /** `ResolvedTranscriptRow.id` — the scroll target for pinning this prompt. */
  rowId: string
}

export function getLatestUserPrompt(rows: ResolvedTranscriptRow[]): LatestUserPrompt | null {
  const rowIndex = findLatestUserPromptRowIndex(rows)
  if (rowIndex === null) return null
  const row = rows[rowIndex]
  if (row?.kind !== "single" || row.message.kind !== "user_prompt") return null
  return {
    messageId: row.message.id,
    signature: getUserPromptSignature(row.message.content, row.message.attachments ?? []),
    rowIndex,
    rowId: row.id,
  }
}

/**
 * Whether the latest user prompt changed in a way that means "the user just
 * sent something" and we should pin it to the top.
 *
 * Handles the four cases that matter:
 * - streaming: the latest prompt is untouched -> false, so live output is never
 *   fought,
 * - optimistic id reconciled to the server id: same content -> false, so the
 *   echo doesn't cause a second jump,
 * - the same text sent twice: the new prompt arrives optimistic while the
 *   previous is a real id -> true,
 * - older history prepended: the *latest* prompt is unchanged -> false.
 */
export function shouldPinForNewPrompt(
  previous: LatestUserPrompt | null,
  next: LatestUserPrompt | null,
): boolean {
  if (!next) return false
  // No prior observation means this is the chat-open path, which the restore
  // logic owns — don't treat it as a send.
  if (!previous) return false
  if (previous.messageId === next.messageId) return false
  if (isOptimisticMessageId(previous.messageId) && previous.signature === next.signature) return false
  return true
}

export type TranscriptScrollTarget =
  | { kind: "end" }
  /**
   * `rowId` is a `ResolvedTranscriptRow.id` — what the scroller addresses rows
   * by.
   *
   * `offsetFromMessage` moves the landing point relative to the row's top,
   * measured downward. Positive puts the reader back where they were *inside* a
   * message (a restored anchor, and only when the column is the same width it
   * was recorded at). Negative leaves a gap above it, which is what an explicit
   * jump wants — see `JUMP_LEAD_IN_RATIO`.
   */
  | { kind: "pin"; rowId: string; offsetFromMessage?: number }

/** Whether two targets put the same row at the same place. */
export function sameScrollTarget(left: TranscriptScrollTarget, right: TranscriptScrollTarget): boolean {
  if (left.kind === "end" || right.kind === "end") return left.kind === right.kind
  return left.rowId === right.rowId && (left.offsetFromMessage ?? 0) === (right.offsetFromMessage ?? 0)
}

/** Index of the row rendering the most recent assistant message, or null. */
export function findLatestAssistantTextRowIndex(rows: ResolvedTranscriptRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.kind === "single" && row.message.kind === "assistant_text") {
      return index
    }
  }
  return null
}

/**
 * A request to land on one end of the last exchange, made from outside the
 * transcript — today, clicking a message in the sidebar's chat hover card.
 *
 * Carries a `requestId` because the role alone can't say "again": clicking the
 * same preview twice, or clicking back into a chat you already jumped into,
 * has to move the viewport a second time. The id is what the viewport marks as
 * spent, so a request survives exactly one landing.
 */
export interface TranscriptJumpRequest {
  target: ChatJumpTarget
  requestId: string
}

/**
 * Where a jump request should land, or null when the transcript has no such
 * message.
 *
 * The sidebar names a role and this resolves it, for the same reason the
 * minimap slices its own turns out of these rows: the transcript is the only
 * thing that knows which message is which. A card built from a snapshot string
 * would have to be told, and would then be wrong the moment the chat moved on.
 *
 * Returns a *row*, not a message: the scroller addresses rows, and a message
 * swept into a tool group is reachable only by its group's id.
 */
export function resolveJumpTarget(
  rows: ResolvedTranscriptRow[],
  target: ChatJumpTarget,
): TranscriptScrollTarget | null {
  const index = typeof target !== "string"
    ? findToolCallRowIndex(rows, target.toolId)
    : target === "prompt"
      ? findLatestUserPromptRowIndex(rows)
      : findLatestAssistantTextRowIndex(rows)
  const rowId = index === null ? undefined : rows[index]?.id
  return rowId === undefined ? null : { kind: "pin", rowId }
}

/**
 * Decide where a freshly opened chat should land.
 *
 * Order: an `atEnd` anchor keeps following the stream; a message anchor pins
 * exactly where the user left off; otherwise fall back to the latest user
 * prompt so you at least land on what you asked for; finally the bottom.
 */
export function resolveRestoreTarget(
  rows: ResolvedTranscriptRow[],
  anchor: ResolvedChatReadAnchor | null,
  rowIndexByMessageId: Map<string, number>,
  transcriptWidth?: number,
): TranscriptScrollTarget {
  if (rows.length === 0) return { kind: "end" }
  if (anchor?.atEnd) return { kind: "end" }

  if (anchor) {
    const index = rowIndexByMessageId.get(anchor.messageId)
    // Absent when the anchored message is gone from the transcript.
    const rowId = index === undefined ? undefined : rows[index]?.id
    if (rowId !== undefined) {
      // The offset says how far into the message the reader was, which only
      // holds if the message wraps the same way it did then. At a different
      // column width the message is a different shape, so the best we can
      // honestly do is put its top back at the top.
      const sameWidth = anchor.transcriptWidth !== undefined
        && transcriptWidth !== undefined
        && Math.abs(anchor.transcriptWidth - transcriptWidth) < 1
      return sameWidth && anchor.offsetFromMessage !== undefined
        ? { kind: "pin", rowId, offsetFromMessage: anchor.offsetFromMessage }
        : { kind: "pin", rowId }
    }
  }

  const latestPromptIndex = findLatestUserPromptRowIndex(rows)
  const latestPromptRowId = latestPromptIndex === null ? undefined : rows[latestPromptIndex]?.id
  if (latestPromptRowId !== undefined) return { kind: "pin", rowId: latestPromptRowId }

  return { kind: "end" }
}

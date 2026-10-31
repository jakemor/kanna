import type { ResolvedTranscriptRow } from "../KannaTranscript"

/**
 * Pure helpers backing the transcript overview minimap. Kept out of the
 * component so the turn-slicing and dock-magnification math stay unit testable.
 */

/** One conversational turn: a user prompt plus everything until the next one. */
export interface TranscriptTurn {
  /** Message id of the user prompt that opens the turn. */
  id: string
  /** Row index of the user prompt — the scroll target. */
  rowIndex: number
  /** Last row belonging to this turn, inclusive. */
  endRowIndex: number
  /**
   * The row that produced the reply shown for this turn — the scroll target
   * when you aim at the answer.
   *
   * The message the preview was taken from, not the turn's last row: a jump
   * pins its target to the top of the viewport, so anything else puts the very
   * text you clicked off the top of the screen. Tracks the card's own
   * precedence, so `error` displacing `response` moves this with it.
   *
   * Null on a turn with nothing to show yet, which is also a turn whose card
   * renders no reply to click.
   */
  replyRowId: string | null
  /** The user's question. */
  prompt: string
  /** The turn's final assistant message, if it has produced one yet. */
  response: string | null
  /**
   * How much the agent did here: every message it sent, counting its text and
   * its tool calls alike.
   *
   * Tool *results* are not the agent's, so they don't count — and client-side
   * they aren't separate messages anyway, having been folded into the call they
   * answer. Empty assistant text doesn't count either: a streaming turn emits
   * blank entries before its first token, and counting those would tick the
   * number up while nothing had been said.
   */
  agentMessageCount: number
  /**
   * False for a turn known only from the outline: its rows are before the
   * loaded window, so `rowIndex` is -1 and a jump to it has to load first.
   * Absent (undefined) means loaded, which is every turn this file builds.
   */
  loaded?: boolean
  /**
   * Failure text, when the turn ended in an error result.
   *
   * A failed turn usually emits no assistant text at all — the provider dies
   * before it can say anything — so without this the turn would read as blank.
   */
  error: string | null
  /** ISO time the turn was asked, or null if the entry carries no usable one. */
  timestamp: string | null
  /** Wall time the turn took, or null while it is still running. */
  durationMs: number | null
}

/**
 * Coerce a transcript text field to a trimmed string.
 *
 * The entry types declare these as required strings, but the transcript log is
 * append-only and replays entries written by older versions — a `result` or
 * `content` that was never written comes back undefined and would throw here,
 * taking the whole viewport render with it. Normalise once at the boundary so
 * everything downstream can trust the type.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** An ISO timestamp only if it is one — same append-only-log caveat as asText. */
function asTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null
  return value
}

/**
 * Slice the flat row list into turns.
 *
 * Rows before the first user prompt (system init, account info, a restored
 * session's tail) belong to no turn and are simply dropped — the map is a map
 * of things you asked for.
 */
export function buildTranscriptTurns(rows: ResolvedTranscriptRow[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue

    // Grouped tool calls are the only thing the loop cares about that isn't a
    // single row: a run of them collapses into one row, but it is still that
    // many things the agent did.
    if (row.kind === "tool-group") {
      const current = turns[turns.length - 1]
      if (current) current.agentMessageCount += row.messages.length
      continue
    }

    // A closed fold still did what it hides.
    if (row.kind === "fold-header") {
      const current = turns[turns.length - 1]
      if (current) current.agentMessageCount += row.hiddenAgentCount
      continue
    }

    if (row.message.kind === "user_prompt") {
      const previous = turns[turns.length - 1]
      if (previous) previous.endRowIndex = index - 1
      turns.push({
        id: row.message.id,
        rowIndex: index,
        endRowIndex: index,
        replyRowId: null,
        prompt: asText(row.message.content),
        response: null,
        agentMessageCount: 0,
        error: null,
        timestamp: asTimestamp(row.message.timestamp),
        durationMs: null,
      })
      continue
    }

    const current = turns[turns.length - 1]
    if (!current) continue

    // Later assistant text overwrites earlier text, leaving the turn's last
    // word — which is the summary you actually want when scanning back. Blank
    // text never overwrites: a streaming turn emits empty entries before its
    // first token, and those would wipe a summary we already have.
    if (row.message.kind === "assistant_text") {
      const text = asText(row.message.text)
      // The row moves with the text it holds, so the reply the card shows and
      // the message a click lands on are always the same message.
      if (text) {
        current.response = text
        current.replyRowId = row.id
        current.agentMessageCount += 1
      }
      continue
    }

    // A tool call that didn't get swept into a group — one on its own, or the
    // one still running at the end of a live turn.
    if (row.message.kind === "tool") {
      current.agentMessageCount += 1
      continue
    }

    if (row.message.kind === "result") {
      // Every result carries a duration, including a failed one — how long a
      // turn ran before dying is worth as much as how long a good one took.
      if (typeof row.message.durationMs === "number") {
        current.durationMs = row.message.durationMs
      }
      // A cancelled turn is a choice, not a failure, so it stays unmarked and
      // keeps whatever text it managed to produce.
      if (!row.message.success && !row.message.cancelled) {
        current.error = asText(row.message.result) || "Turn failed"
        // The error displaces the response in the card, so it takes the click
        // with it — onto the result row, which is where the failure is written.
        current.replyRowId = row.id
      }
    }
  }

  const last = turns[turns.length - 1]
  // Always a number here: every turn this function creates carries a row span.
  if (last) last.endRowIndex = Math.max(last.rowIndex, rows.length - 1)

  return turns
}

/**
 * Whether a turn has any part of itself on screen.
 *
 * `visibleStart`/`visibleEnd` are LegendList's rendered row range, so this is
 * an interval overlap rather than a point test — a single long turn can span
 * the whole viewport with neither of its edges inside it.
 */
export function isTurnInView(turn: TranscriptTurn, visibleStart: number, visibleEnd: number): boolean {
  return turn.rowIndex <= visibleEnd && turn.endRowIndex >= visibleStart
}

export function getMinimapCapacity(availableHeightPx: number, pitchPx: number, maxTicks: number): number {
  if (!Number.isFinite(availableHeightPx) || availableHeightPx <= 0 || pitchPx <= 0) return 0
  return Math.max(0, Math.min(maxTicks, Math.floor(availableHeightPx / pitchPx)))
}

/** The most recent `capacity` turns — the map covers where you are, not all history. */
export function selectVisibleTurns(turns: TranscriptTurn[], capacity: number): TranscriptTurn[] {
  if (capacity <= 0) return []
  if (turns.length <= capacity) return turns
  return turns.slice(turns.length - capacity)
}

/**
 * macOS-dock falloff: 1 at the cursor, 0 at `radiusPx` and beyond, smoothstepped
 * in between so neighbours swell rather than stepping.
 */
export function getMagnifyFalloff(distancePx: number, radiusPx: number): number {
  if (radiusPx <= 0) return 0
  const t = 1 - Math.min(1, Math.abs(distancePx) / radiusPx)
  if (t <= 0) return 0
  return t * t * (3 - 2 * t)
}

/**
 * Horizontal gutter available on each side of the centred transcript column.
 *
 * The column is `min(maxColumnWidth, width - padding)` wide and centred, so
 * everything left over splits evenly. Returns 0 once the column fills the pane.
 */
export function getTranscriptGutterWidth(
  containerWidthPx: number,
  maxColumnWidthPx: number,
  horizontalPaddingPx: number,
): number {
  const usable = containerWidthPx - horizontalPaddingPx
  if (!Number.isFinite(usable) || usable <= 0) return 0
  return Math.max(0, (usable - maxColumnWidthPx) / 2)
}

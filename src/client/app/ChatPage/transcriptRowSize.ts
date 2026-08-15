import type { ResolvedTranscriptRow } from "../KannaTranscript"

/**
 * Height estimates for the virtualized transcript, per row.
 *
 * Transcript rows are strongly bimodal: most are collapsed tool headers around
 * 40px, while user prompts and assistant answers run from one line to well over
 * a thousand pixels. A single `estimatedItemSize` cannot describe both, and the
 * list's own fallback — averaging measured rows — converges on a number that is
 * wrong for every row rather than right for any.
 *
 * The cost of a bad estimate is not just wasted layout: unmeasured rows are
 * assumed to be the estimate, so `scrollToIndex` computes its target from it.
 * Restoring to a row a few hundred entries up lands in the wrong place and then
 * visibly settles as real sizes arrive. These numbers only need to be close
 * enough that the first pass is nearly right; the list replaces each one with a
 * real measurement as the row renders.
 */

/** Vertical padding + timestamp gutter every row carries. */
const ROW_CHROME = 12

/** A collapsed tool call: icon, name, one line of argument summary. */
const TOOL_ROW = 40

/** Roughly the character count that fits on one line at the transcript width. */
const CHARS_PER_LINE = 88
const LINE_HEIGHT = 22

/** Markdown blocks add separation that raw character count misses. */
const PARAGRAPH_SPACING = 10

/** Stand-in body for a thought, whose text the snapshot trims away. */
const THINKING_BODY = 4 * LINE_HEIGHT

function textHeight(text: string | undefined) {
  if (!text) return LINE_HEIGHT
  let lines = 0
  let paragraphs = 0
  for (const block of text.split("\n")) {
    paragraphs += 1
    lines += Math.max(1, Math.ceil(block.length / CHARS_PER_LINE))
  }
  return lines * LINE_HEIGHT + Math.max(0, paragraphs - 1) * PARAGRAPH_SPACING
}

export function estimateTranscriptRowSize(row: ResolvedTranscriptRow): number {
  if (row.kind === "tool-group") {
    // Collapsed by default, so the group reads as one header regardless of how
    // many calls it holds.
    return TOOL_ROW + ROW_CHROME
  }

  const message = row.message
  switch (message.kind) {
    case "user_prompt":
      return textHeight(message.content) + ROW_CHROME + 16
    case "assistant_text":
      return textHeight(message.text) + ROW_CHROME
    case "thinking":
      return TOOL_ROW + (message.text ? textHeight(message.text) : THINKING_BODY) + ROW_CHROME
    case "tool":
      return TOOL_ROW + ROW_CHROME
    case "system_init":
      // A dense metadata block, and only rendered at boundaries.
      return 120
    case "account_info":
      return 72
    case "compact_summary":
      return textHeight(message.summary) + ROW_CHROME
    case "result":
      return 44
    case "context_window_updated":
    case "compact_boundary":
    case "context_cleared":
    case "handoff_boundary":
    case "session_restored":
    case "interrupted":
    case "status":
      // Single-line dividers and badges.
      return 32
    case "unknown":
      return textHeight(message.json) + ROW_CHROME
    default:
      return TOOL_ROW + ROW_CHROME
  }
}

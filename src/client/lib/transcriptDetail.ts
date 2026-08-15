/** A view setting: every level reads the same snapshot, and the agent is never told which one is active. */

export type TranscriptDetail = "summary" | "normal" | "thinking" | "verbose"

export const DEFAULT_TRANSCRIPT_DETAIL: TranscriptDetail = "normal"

/** Least detail first, so the picker reads top to bottom as quieter to louder. */
export const TRANSCRIPT_DETAIL_ORDER = ["summary", "normal", "thinking", "verbose"] as const

export const TRANSCRIPT_DETAIL_LABELS: Record<TranscriptDetail, { label: string; description: string }> = {
  summary: { label: "Summary", description: "Replies and file changes only" },
  normal: { label: "Normal", description: "Tool calls grouped into one row" },
  thinking: { label: "Thinking", description: "Replies and the model's reasoning" },
  verbose: { label: "Verbose", description: "Every tool call and every thought" },
}

export function isTranscriptDetail(value: unknown): value is TranscriptDetail {
  return value === "summary" || value === "normal" || value === "thinking" || value === "verbose"
}

export function showsThinking(detail: TranscriptDetail) {
  return detail === "thinking" || detail === "verbose"
}

/** Hiding one of these would leave the turn stuck with no visible way to respond, so every level keeps them. */
const BLOCKING_TOOL_KINDS = ["ask_user_question", "exit_plan_mode"] as const

/** The kinds that changed the workspace, plus the ones the user has to act on. */
const SUMMARY_VISIBLE_TOOL_KINDS = new Set<string>([
  ...BLOCKING_TOOL_KINDS,
  "todo_write",
  "write_file",
  "edit_file",
])

const BLOCKING_TOOL_KIND_SET = new Set<string>(BLOCKING_TOOL_KINDS)

export function isSummaryVisibleToolKind(toolKind: string) {
  return SUMMARY_VISIBLE_TOOL_KINDS.has(toolKind)
}

export function isBlockingToolKind(toolKind: string) {
  return BLOCKING_TOOL_KIND_SET.has(toolKind)
}

/** Thinking trades every tool row for the thoughts between them; Verbose shows both. */
export function showsToolCalls(detail: TranscriptDetail) {
  return detail !== "thinking"
}

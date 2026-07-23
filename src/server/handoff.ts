import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { getProviderCatalog } from "../shared/types"

/**
 * Handoff context for mid-conversation harness switches.
 *
 * When a chat's provider changes, the new harness starts a fresh native
 * session that knows nothing about the conversation. We render the Kanna
 * transcript (the source of truth) to a plain-text record and prepend it —
 * wire-only, never persisted — to the first prompt sent to the new harness.
 *
 * Budgeting (approximating 1 token ≈ 4 chars):
 * - The rendered transcript is capped at ~HANDOFF_TOKEN_BUDGET tokens.
 * - Tool call inputs / results outside the most recent
 *   RECENT_VERBATIM_CHARS window are elided when large — the preamble points
 *   the harness at the full JSONL transcript, so elided content stays
 *   retrievable (same path the concurrent-agents notice already shares).
 * - When the whole transcript still doesn't fit, older turns are dropped
 *   wholesale, cutting on a user-prompt boundary so tool calls never lose
 *   their results.
 */
export const HANDOFF_TOKEN_BUDGET = 100_000
const CHARS_PER_TOKEN = 4
export const HANDOFF_CHAR_BUDGET = HANDOFF_TOKEN_BUDGET * CHARS_PER_TOKEN
/** Trailing window (chars) whose tool inputs/results are always verbatim. */
const RECENT_VERBATIM_CHARS = 100_000
/** Older tool inputs/results above this size (chars) get elided. */
const TOOL_IO_ELIDE_CHARS = 2_000
/** Error results from the harness are capped at this many chars. */
const ERROR_RESULT_MAX_CHARS = 2_000

interface HandoffBlock {
  entry: TranscriptEntry
  header: string
  body: string
  /** Tool call input / tool result content — elidable outside the recent window. */
  elidableBody: boolean
  elided: boolean
}

export interface HandoffStats {
  totalEntries: number
  includedEntries: number
  elidedToolResults: number
  approxTokens: number
}

export interface HandoffContext {
  text: string
  stats: HandoffStats
}

function providerLabel(provider: AgentProvider) {
  try {
    return getProviderCatalog(provider).label
  } catch {
    return provider
  }
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Tool result contents vary by harness: Claude sends strings or arrays of
 * content blocks; codex/cursor/pi send strings or structured objects. Text
 * blocks render verbatim (no JSON string escaping — that's the token sink);
 * everything else falls back to compact JSON.
 */
export function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block
        if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
          const text = (block as { text?: unknown }).text
          if (typeof text === "string") return text
        }
        return compactJson(block)
      })
      .join("\n")
  }
  if (content === null || content === undefined) return ""
  return compactJson(content)
}

function renderAttachmentLines(entry: Extract<TranscriptEntry, { kind: "user_prompt" }>) {
  if (!entry.attachments || entry.attachments.length === 0) return ""
  const lines = entry.attachments.map(
    (attachment) => `[attached: ${attachment.displayName} (${attachment.relativePath || attachment.absolutePath})]`
  )
  return `\n${lines.join("\n")}`
}

function blockFromEntry(entry: TranscriptEntry): Omit<HandoffBlock, "elided"> | null {
  switch (entry.kind) {
    case "user_prompt":
      return {
        entry,
        header: "--- user ---",
        body: `${entry.content}${renderAttachmentLines(entry)}`,
        elidableBody: false,
      }
    case "assistant_text":
      return {
        entry,
        header: "--- assistant ---",
        body: entry.text,
        elidableBody: false,
      }
    case "tool_call":
      return {
        entry,
        header: `--- assistant tool call: ${entry.tool.toolName} ---`,
        body: compactJson(entry.tool.rawInput ?? entry.tool.input ?? {}),
        elidableBody: true,
      }
    case "tool_result":
      return {
        entry,
        header: `--- tool result${entry.isError ? " (error)" : ""} ---`,
        body: renderToolResultContent(entry.content),
        elidableBody: true,
      }
    case "compact_summary":
      return {
        entry,
        header: "--- summary of earlier conversation (previous agent's context compaction) ---",
        body: entry.summary,
        elidableBody: false,
      }
    case "interrupted":
      return { entry, header: "--- turn interrupted by user ---", body: "", elidableBody: false }
    case "handoff_boundary":
      return {
        entry,
        header: `--- conversation handed off from ${providerLabel(entry.fromProvider)} to ${providerLabel(entry.toProvider)} ---`,
        body: "",
        elidableBody: false,
      }
    case "result":
      if (!entry.isError) return null
      return {
        entry,
        header: "--- turn ended with error ---",
        body: entry.result.slice(0, ERROR_RESULT_MAX_CHARS),
        elidableBody: false,
      }
    // Harness/plumbing noise the new agent doesn't need.
    case "system_init":
    case "account_info":
    case "status":
    case "context_window_updated":
    case "compact_boundary":
    case "context_cleared":
    case "workflow_state":
      return null
  }
}

function blockLength(block: HandoffBlock) {
  return block.header.length + (block.body ? block.body.length + 1 : 0) + 2
}

function renderBlock(block: HandoffBlock) {
  return block.body ? `${block.header}\n${block.body}` : block.header
}

function elideBody(block: HandoffBlock): HandoffBlock {
  const approxTokens = Math.round(block.body.length / CHARS_PER_TOKEN)
  const label = block.entry.kind === "tool_result" ? "tool result" : "tool input"
  return {
    ...block,
    body: `[${label} elided (~${approxTokens} tokens) — entry ${block.entry._id} in the transcript JSONL]`,
    elided: true,
  }
}

/**
 * Render the transcript into a budgeted handoff block for the new harness,
 * or null when there is nothing worth handing off.
 */
export function buildHandoffContext(args: {
  entries: TranscriptEntry[]
  fromProvider: AgentProvider
  toProvider: AgentProvider
  transcriptPath: string
  charBudget?: number
}): HandoffContext | null {
  const charBudget = args.charBudget ?? HANDOFF_CHAR_BUDGET

  let blocks: HandoffBlock[] = []
  for (const entry of args.entries) {
    if (entry.hidden) continue
    const block = blockFromEntry(entry)
    if (block) blocks.push({ ...block, elided: false })
  }
  if (blocks.length === 0 || !blocks.some((block) => block.entry.kind === "user_prompt")) {
    return null
  }
  const totalEntries = blocks.length

  // Pass 1 — find the start of the recent verbatim window.
  let recentStart = blocks.length
  for (let chars = 0; recentStart > 0; recentStart -= 1) {
    chars += blockLength(blocks[recentStart - 1]!)
    if (chars > RECENT_VERBATIM_CHARS) break
  }

  // Pass 2 — elide large tool IO outside the recent window.
  let elidedToolResults = 0
  blocks = blocks.map((block, index) => {
    if (index >= recentStart || !block.elidableBody || block.body.length <= TOOL_IO_ELIDE_CHARS) {
      return block
    }
    elidedToolResults += 1
    return elideBody(block)
  })

  // Pass 3 — apply the overall budget from the end.
  let cutIndex = blocks.length
  for (let chars = 0; cutIndex > 0; cutIndex -= 1) {
    const next = chars + blockLength(blocks[cutIndex - 1]!)
    if (next > charBudget) break
    chars = next
  }

  // Snap the cut forward to a turn boundary so a tool call never loses its
  // result. Falls back to skipping orphaned results when a single turn is
  // itself bigger than the budget.
  if (cutIndex > 0) {
    const nextPromptIndex = blocks.findIndex(
      (block, index) => index >= cutIndex && block.entry.kind === "user_prompt"
    )
    if (nextPromptIndex !== -1) {
      cutIndex = nextPromptIndex
    } else {
      while (cutIndex < blocks.length && blocks[cutIndex]!.entry.kind === "tool_result") {
        cutIndex += 1
      }
    }
  }

  const included = blocks.slice(cutIndex)
  if (!included.some((block) => block.entry.kind === "user_prompt" || block.entry.kind === "assistant_text")) {
    return null
  }
  const omitted = cutIndex

  const bodyLines: string[] = []
  if (omitted > 0) {
    bodyLines.push(`[${omitted} earlier entries omitted for length — read the full transcript JSONL at ${args.transcriptPath}]`)
  }
  bodyLines.push(...included.map(renderBlock))
  const body = bodyLines.join("\n\n")

  const fromLabel = providerLabel(args.fromProvider)
  const text = [
    "<system-message>",
    `This conversation is being handed off to you from another coding agent (${fromLabel}). You are taking over mid-conversation.`,
    "",
    "Everything inside <handoff_transcript> is a read-only record of the conversation so far: the user's messages, the previous agent's replies, and its tool activity. Do not imitate its formatting and do not continue or reply to the transcript itself — treat the conversation as your own history and respond to the user's message that follows it.",
    "",
    `Some older tool inputs/results may be elided and earlier turns omitted for length. The complete conversation record (JSONL, one entry per line) is at: ${args.transcriptPath}. Read it if you need elided or omitted context.`,
    "",
    "<handoff_transcript>",
    body,
    "</handoff_transcript>",
    "</system-message>",
  ].join("\n")

  return {
    text,
    stats: {
      totalEntries,
      includedEntries: included.length,
      elidedToolResults,
      approxTokens: Math.round(text.length / CHARS_PER_TOKEN),
    },
  }
}

/**
 * Combine the handoff block with the user's prompt for the wire. Mirrors
 * buildSteeredMessageContent: slash invocations must stay at the very start
 * of the message (claude/pi only expand a leading "/name"), so the handoff
 * trails for them and leads otherwise (context first, task last).
 */
export function buildHandoffMessageContent(handoffText: string, content: string) {
  const trimmed = content.trim()
  if (trimmed.length === 0) return handoffText
  if (trimmed.startsWith("/")) {
    return `${content}\n\n${handoffText}`
  }
  return `${handoffText}\n\n${content}`
}

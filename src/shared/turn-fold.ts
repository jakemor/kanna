import { CHAT_TOOL_NAMES, SCHEDULE_TOOL_NAMES } from "./tools"
import type { HydratedTranscriptMessage, TranscriptEntry } from "./types"

/**
 * Folding a finished turn behind one header ("Worked for 2m 14s"), so a chat
 * reads as what was asked and what came back.
 *
 * The unit is the exchange, not the provider's turn: everything from a prompt
 * someone sent to the next one. A delegator's turn ends while its sub-chats
 * work and resumes when each one reports, and the reader saw that as one turn.
 * So a report, or a prompt nobody sees, carries the exchange on; the user's
 * own prompt, another agent's message and a schedule firing each open one.
 *
 * Closed, a fold still shows what the turn made or decided, and what it
 * handed to other chats: the reply (its last text), pictures, files and
 * visualizations, chat and schedule cards with the reports that came back, a
 * plan with nothing said after it, and errors. Edits, commands, reads and the
 * text between them fold away.
 *
 * Decided on the client, from the entries alone, so web and iOS agree without
 * the server stamping anything. The Swift port is `TurnFolds` in
 * ios/App/Chat/TurnFold.swift; both run `turn-fold.fixtures.json`, and a
 * change here changes both and the fixtures with them.
 */

export type FoldEntryKind = "prompt" | "text" | "tool" | "result" | "interrupted" | "meta" | "other"

/** What folding needs to know of one transcript row, from either shape the clients hold. */
export interface FoldEntry {
  id: string
  kind: FoldEntryKind
  hidden: boolean
  /** Epoch milliseconds. */
  createdAt: number
  /** On a prompt: who sent it, when the user did not. */
  source?: "agent" | "report" | "schedule"
  /** On a tool call. */
  toolKind?: string
  toolName?: string
  /** On a tool call: its result has arrived. */
  answered?: boolean
  /** On a result. */
  subtype?: "success" | "error" | "cancelled"
  durationMs?: number
}

/**
 * What a row is to its fold.
 * - `folded`: drawn only while the fold is open.
 * - `kept`: drawn either way, in place.
 * - `reply`: the turn's last text, drawn either way.
 * - `end`: the result that closes the exchange, drawn either way as the rule
 *   between turns. The header says how long it took, so the rule does not.
 */
export type FoldRole = "folded" | "kept" | "reply" | "end"

export type FoldOutcome = "completed" | "failed" | "stopped"

export interface TurnFold {
  /**
   * The id of the prompt that opened the exchange, which is also what an
   * open fold is remembered by. An exchange the loaded window cut the start
   * off has no prompt to name it, so it is named by its first row instead.
   */
  id: string
  /** Index of that prompt, or null when it is before the window. */
  openerIndex: number | null
  /**
   * First index inside the fold: where the header goes. After the prompt and
   * after the model and session rows that follow it, so those stay where
   * they are whether the fold is open or not.
   */
  start: number
  /** Last index of the exchange, inclusive. */
  end: number
  /** The exchange is over: nothing more will be added to it. */
  settled: boolean
  /** Settled, with something to hide: the header is drawn and the fold can close. */
  folds: boolean
  outcome: FoldOutcome
  /** Time spent working, the turns' own durations summed. Undefined when any of them is unknown. */
  workedMs?: number
  /** `roles[i - start]` is the role of row `i`. */
  roles: FoldRole[]
}

export interface TurnFoldContext {
  /**
   * The chat is at rest: not running, not waiting for the user, not waiting
   * on sub-chats. Only then is the last exchange over.
   */
  atRest: boolean
}

const META_KINDS = new Set<string>([
  "system_init",
  "account_info",
  "status",
  "context_window_updated",
  "compact_boundary",
  "compact_summary",
  "context_cleared",
  "handoff_boundary",
  "session_restored",
])

/** Cards that wait on the user. One still unanswered holds its exchange open. */
const CARD_TOOL_KINDS = new Set(["ask_user_question", "exit_plan_mode", "request_secrets"])

function isChatOrScheduleTool(toolKind: string | undefined, toolName: string | undefined) {
  if (toolKind === "chat" || toolKind === "schedule") return true
  return toolKind === "unknown_tool" && toolName !== undefined
    && (CHAT_TOOL_NAMES.includes(toolName) || SCHEDULE_TOOL_NAMES.includes(toolName))
}

function opensExchange(entry: FoldEntry) {
  return entry.kind === "prompt" && !entry.hidden && entry.source !== "report"
}

function isTerminal(entry: FoldEntry) {
  return entry.kind === "result" || entry.kind === "interrupted"
}

/** Rows whose absence a reader would notice: there has to be one for a fold to be worth a header. */
function isWork(entry: FoldEntry) {
  if (entry.hidden) return false
  return entry.kind === "text" || entry.kind === "tool" || entry.kind === "interrupted" || entry.kind === "other"
}

export function computeTurnFolds(entries: readonly FoldEntry[], context: TurnFoldContext): TurnFold[] {
  const folds: TurnFold[] = []
  // Exchange boundaries: the index each one opens at. A window cut mid-turn
  // starts with an exchange that has no opener.
  const starts: number[] = []
  entries.forEach((entry, index) => {
    if (opensExchange(entry)) starts.push(index)
  })
  if (entries.length > 0 && starts[0] !== 0) starts.unshift(-1)

  for (let n = 0; n < starts.length; n += 1) {
    const openerIndex = starts[n]! >= 0 ? starts[n]! : null
    const first = openerIndex ?? 0
    const end = (n + 1 < starts.length ? starts[n + 1]! : entries.length) - 1
    const isLast = n === starts.length - 1

    let start = openerIndex === null ? first : first + 1
    while (start <= end && entries[start]!.kind === "meta") start += 1

    let replyIndex = -1
    let lastTerminalIndex = -1
    let holdsLiveCard = false
    for (let index = first; index <= end; index += 1) {
      const entry = entries[index]!
      if (entry.kind === "text" && !entry.hidden && index >= start) replyIndex = index
      if (isTerminal(entry)) lastTerminalIndex = index
      if (entry.kind === "tool" && !entry.answered && CARD_TOOL_KINDS.has(entry.toolKind ?? "")) holdsLiveCard = true
    }

    const roles: FoldRole[] = []
    let hasWork = false
    for (let index = start; index <= end; index += 1) {
      const entry = entries[index]!
      const role = roleOf(entry, index, { replyIndex, lastTerminalIndex })
      roles.push(role)
      if (role === "folded" && isWork(entry)) hasWork = true
    }

    const settled = !isLast || (context.atRest && !holdsLiveCard)
    const id = openerIndex !== null ? entries[openerIndex]!.id : `partial:${entries[first]!.id}`
    folds.push({
      id,
      openerIndex,
      start,
      end,
      settled,
      folds: settled && hasWork,
      outcome: outcomeOf(lastTerminalIndex >= 0 ? entries[lastTerminalIndex]! : undefined),
      workedMs: workedMsOf(entries, first, end),
      roles,
    })
  }

  return folds

  function roleOf(entry: FoldEntry, index: number, marks: { replyIndex: number; lastTerminalIndex: number }): FoldRole {
    switch (entry.kind) {
      case "meta":
        return "kept"
      case "prompt":
        // A sub-chat's report is the sub-chat's, not this turn's work.
        return entry.source === "report" && !entry.hidden ? "kept" : "folded"
      case "text":
        return index === marks.replyIndex ? "reply" : "folded"
      case "tool":
        if (entry.toolKind === "display" || isChatOrScheduleTool(entry.toolKind, entry.toolName)) return "kept"
        // A plan nothing was said after is what the turn came back with.
        if (entry.toolKind === "exit_plan_mode" && marks.replyIndex < index) return "kept"
        return "folded"
      case "result":
        if (entry.subtype === "error") return "kept"
        return index === marks.lastTerminalIndex ? "end" : "folded"
      default:
        return "folded"
    }
  }
}

function outcomeOf(terminal: FoldEntry | undefined): FoldOutcome {
  if (!terminal) return "stopped"
  if (terminal.kind === "interrupted") {
    // A steer hides its interrupt: the user redirected the turn, nobody stopped it.
    return terminal.hidden ? "completed" : "stopped"
  }
  if (terminal.subtype === "error") return "failed"
  if (terminal.subtype === "cancelled") return "stopped"
  return "completed"
}

/**
 * The turns' durations, summed. A turn's own when the provider reported one,
 * otherwise from the prompt that started it to the row that ended it. Undefined
 * when a turn has neither, such as one whose prompt is before the window.
 */
function workedMsOf(entries: readonly FoldEntry[], first: number, end: number): number | undefined {
  let total = 0
  let turns = 0
  let turnStartedAt: number | null = null
  for (let index = first; index <= end; index += 1) {
    const entry = entries[index]!
    if (entry.kind === "prompt") {
      turnStartedAt ??= entry.createdAt
      continue
    }
    if (!isTerminal(entry)) continue
    const reported = entry.kind === "result" && entry.durationMs !== undefined && entry.durationMs > 0 ? entry.durationMs : null
    const measured = turnStartedAt !== null ? Math.max(0, entry.createdAt - turnStartedAt) : null
    const duration = reported ?? measured
    if (duration === null) return undefined
    total += duration
    turns += 1
    turnStartedAt = null
  }
  return turns > 0 ? total : undefined
}

/** "32s", "23m 0s", "6h 23m 32s". Minutes always carry their seconds, so the width barely moves. */
export function formatWorkedDuration(ms: number): string {
  if (ms < 1000) return "<1s"
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** The header's words. Nothing about what is inside: opening it says that. */
export function turnFoldLabel(fold: Pick<TurnFold, "outcome" | "workedMs">, open: boolean): string {
  if (fold.workedMs === undefined) {
    if (fold.outcome === "failed") return "Failed"
    if (fold.outcome === "stopped") return "Stopped"
    return open ? "Hide work" : "Show work"
  }
  const worked = formatWorkedDuration(fold.workedMs)
  if (fold.outcome === "failed") return `Failed after ${worked}`
  if (fold.outcome === "stopped") return `Stopped after ${worked}`
  return `Worked for ${worked}`
}

/** When the turn now running started, for the live "Working for 12s" line; null when none is. */
export function runningTurnStartedAt(entries: readonly FoldEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (isTerminal(entry)) return null
    if (entry.kind === "prompt") {
      // The first prompt of the run: one sent while it was starting joins it.
      let startedAt = entry.createdAt
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const previous = entries[earlier]!
        if (isTerminal(previous)) break
        if (previous.kind === "prompt") startedAt = previous.createdAt
      }
      return startedAt
    }
  }
  return null
}

/** The rows of a raw transcript, as folding sees them. A subagent's own rows fold under its call, so they are left out. */
export function foldEntriesFromTranscript(entries: readonly TranscriptEntry[]): FoldEntry[] {
  const answered = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "tool_result") answered.add(entry.toolId)
  }
  const result: FoldEntry[] = []
  for (const entry of entries) {
    if (entry.parentToolUseId) continue
    const base = { id: entry._id, hidden: entry.hidden === true, createdAt: entry.createdAt }
    switch (entry.kind) {
      case "user_prompt":
        result.push({ ...base, kind: "prompt", source: entry.source?.kind })
        break
      case "assistant_text":
        result.push({ ...base, kind: "text" })
        break
      case "tool_call":
        result.push({
          ...base,
          kind: "tool",
          toolKind: entry.tool.toolKind,
          toolName: entry.tool.toolName,
          answered: answered.has(entry.tool.toolId),
        })
        break
      case "tool_result":
        break
      case "result":
        result.push({ ...base, kind: "result", subtype: entry.subtype, durationMs: entry.durationMs })
        break
      case "interrupted":
        result.push({ ...base, kind: "interrupted" })
        break
      default:
        result.push({ ...base, kind: META_KINDS.has(entry.kind) ? "meta" : "other" })
    }
  }
  return result
}

/** The web client's hydrated rows, as folding sees them. One per message, so indices line up. */
export function foldEntriesFromMessages(messages: readonly HydratedTranscriptMessage[]): FoldEntry[] {
  return messages.map((message) => {
    const base = { id: message.id, hidden: message.hidden === true, createdAt: Date.parse(message.timestamp) || 0 }
    switch (message.kind) {
      case "user_prompt":
        return { ...base, kind: "prompt", source: message.source?.kind }
      case "assistant_text":
        return { ...base, kind: "text" }
      case "tool":
        return {
          ...base,
          kind: "tool",
          toolKind: message.toolKind,
          toolName: message.toolName,
          answered: message.resultEntryId !== undefined,
        }
      case "result":
        return {
          ...base,
          kind: "result",
          subtype: message.cancelled ? "cancelled" : message.success ? "success" : "error",
          durationMs: message.durationMs,
        }
      case "interrupted":
        return { ...base, kind: "interrupted" }
      case "unknown":
        return { ...base, kind: "other" }
      default:
        return { ...base, kind: "meta" }
    }
  })
}

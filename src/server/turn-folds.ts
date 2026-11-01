import { CHAT_TOOL_NAMES, SCHEDULE_TOOL_NAMES } from "../shared/tools"
import { toMessagePreview } from "../shared/message-preview"
import { splitReportSections } from "../shared/report-sections"
import type { ChatTurnFolds, KannaStatus, TranscriptEntry, TranscriptTurnFold, TurnFoldChatCard, TurnFoldOutcome } from "../shared/types"

/**
 * Folding a finished turn behind one header ("Worked for 2m 14s"), so a chat
 * reads as what was asked and what came back.
 *
 * The unit is the agent's turn: from the prompt that started it to the result
 * or stop that ended it. A delegator ends a turn when it hands work to its
 * sub-chats, and each report that comes back starts another; each is a fold
 * of its own, with the report above it where a user's prompt would be.
 * (`turnStarts` is the one place that says where a turn starts.)
 *
 * Closed, a fold still shows what the turn made or decided, and what it
 * handed to other chats: its reply (its last text), pictures, files and
 * visualizations, chat and schedule cards, a plan with nothing said after it,
 * and errors. Edits, commands, reads and the text between them fold away.
 *
 * What the turn sent to other chats closes to one card per chat: every chat
 * it started, forked or messaged, once each, in the order they first came up,
 * saying the last thing that passed. The calls it stands for fold away;
 * opened, the fold shows them as they happened.
 *
 * Decided here, on the server, and sent with the chat snapshot
 * (`ChatSnapshot.turnFolds`), so web and iOS draw the same folds and neither
 * works them out. Cases in `turn-folds.fixtures.json`.
 */

export type FoldEntryKind = "prompt" | "text" | "tool" | "result" | "interrupted" | "meta" | "other"

/** What folding needs to know of one transcript entry. */
export interface FoldEntry {
  id: string
  /** Its index in the transcript. */
  index: number
  /** Its own kind, for the meta rows that need telling apart. */
  entryKind?: TranscriptEntry["kind"]
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
  /** On a tool call that has its result: when it came, epoch milliseconds. */
  answeredAt?: number
  /** On a result. */
  subtype?: "success" | "error" | "cancelled"
  durationMs?: number
  /**
   * The sub-chats this entry passed something to or from: the chat a
   * successful chat call reached, or each chat a report is from.
   */
  chats?: Array<{ chatId: string; kind: TurnFoldChatCard["last"]; preview?: string; title?: string }>
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

export type FoldOutcome = TurnFoldOutcome

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
  /**
   * Settled, with something to hide and something left when it is hidden:
   * the header is drawn and the fold can close. A turn whose every row would
   * fold away (stopped before it said anything, or left on a card when the
   * next prompt came) stays drawn whole, so the reader sees what happened.
   */
  folds: boolean
  outcome: FoldOutcome
  /** Time spent working, the turns' own durations summed. Undefined when any of them is unknown. */
  workedMs?: number
  /** `roles[i - start]` is the role of row `i`. */
  roles: FoldRole[]
  /** One card per sub-chat the turn dealt with, in the order they first came up. */
  chatCards: TurnFoldChatCard[]
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

function isTerminal(entry: FoldEntry) {
  return entry.kind === "result" || entry.kind === "interrupted"
}

/**
 * Where each turn starts, as indices into `entries`. A prompt the reader sees
 * that someone sent (the user, another agent, a schedule) always starts one.
 * Any other prompt (a sub-chat's report, one nobody sees) starts one when the
 * turn before it has ended, so a fold ends at every result or stop. Nothing
 * before the first entry is running: one turn's own entries, which start
 * with its report, are read the same as the whole transcript.
 */
export function turnStarts(entries: readonly FoldEntry[]): number[] {
  const starts: number[] = []
  let ended = true
  entries.forEach((entry, index) => {
    if (entry.kind === "prompt" && ((!entry.hidden && entry.source !== "report") || ended)) {
      starts.push(index)
      ended = false
    } else if (isTerminal(entry)) {
      ended = true
    }
  })
  return starts
}

/** Rows whose absence a reader would notice: there has to be one for a fold to be worth a header. */
function isWork(entry: FoldEntry) {
  if (entry.hidden) return false
  return entry.kind === "text" || entry.kind === "tool" || entry.kind === "interrupted" || entry.kind === "other"
}

export function computeTurnFolds(entries: readonly FoldEntry[], context: TurnFoldContext): TurnFold[] {
  const folds: TurnFold[] = []
  // Turn boundaries: the index each one opens at. A window cut mid-turn
  // starts with a turn that has no opener.
  const starts = turnStarts(entries)
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
    const chatCards = new Map<string, TurnFoldChatCard>()
    let hasWork = false
    let hasSurvivor = false
    for (let index = start; index <= end; index += 1) {
      const entry = entries[index]!
      const role = roleOf(entry, index, { replyIndex, lastTerminalIndex })
      roles.push(role)
      if (role === "folded" && isWork(entry)) hasWork = true
      if (!entry.hidden) {
        for (const chat of entry.chats ?? []) {
          const card = chatCards.get(chat.chatId)
          chatCards.set(chat.chatId, {
            chatId: chat.chatId,
            anchorEntryId: card?.anchorEntryId ?? entry.id,
            last: chat.kind,
            lastEntryId: entry.id,
            ...(chat.preview ? { preview: chat.preview } : {}),
            ...((chat.title ?? card?.title) ? { title: chat.title ?? card?.title } : {}),
          })
          hasSurvivor = true
        }
      }
      // The rule that ends the turn and the model rows are not what it came
      // back with: a fold that leaves only those shows nothing of the turn.
      if ((role === "reply" || role === "kept") && entry.kind !== "meta") hasSurvivor = true
    }

    const settled = !isLast || (context.atRest && !holdsLiveCard)
    const id = openerIndex !== null ? entries[openerIndex]!.id : `partial:${entries[first]!.id}`
    folds.push({
      id,
      openerIndex,
      start,
      end,
      settled,
      folds: settled && hasWork && hasSurvivor,
      outcome: outcomeOf(lastTerminalIndex >= 0 ? entries[lastTerminalIndex]! : undefined),
      workedMs: workedMsOf(entries, first, end),
      roles,
      chatCards: [...chatCards.values()],
    })
  }

  return folds

  function roleOf(entry: FoldEntry, index: number, marks: { replyIndex: number; lastTerminalIndex: number }): FoldRole {
    switch (entry.kind) {
      case "meta":
        return "kept"
      case "prompt":
        // A sub-chat's report is its reply, which its card opens: it folds
        // with the rest. The turn's own reply is what stays.
        return "folded"
      case "text":
        return index === marks.replyIndex ? "reply" : "folded"
      case "tool":
        // A chat call that reached its chat is that chat's card now. One that
        // failed keeps its own row, which says what went wrong.
        if (entry.chats?.length) return "folded"
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
 *
 * Less the time a card (a question, a plan, a secrets form) sat waiting for
 * the user: that time is theirs, not the agent's, and Claude counts it in its
 * own duration. A form left open for nine minutes read "Worked for 9m 13s".
 */
function workedMsOf(entries: readonly FoldEntry[], first: number, end: number): number | undefined {
  let total = 0
  let turns = 0
  let turnStartedAt: number | null = null
  for (let index = first; index <= end; index += 1) {
    const entry = entries[index]!
    if (entry.kind === "tool" && CARD_TOOL_KINDS.has(entry.toolKind ?? "") && entry.answeredAt !== undefined) {
      total -= Math.max(0, entry.answeredAt - entry.createdAt)
      continue
    }
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
  return turns > 0 ? Math.max(0, total) : undefined
}

/**
 * When the turn now running started, for the live "Working for 12s" line:
 * the latest prompt, which is what started it. Null when a turn ended after
 * it. Never an earlier prompt: a turn that ended with no result written (left
 * on a card, cut by a restart) has no terminal row, and walking back past it
 * counted the new turn from days ago.
 */
export function runningTurnStartedAt(entries: readonly FoldEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (isTerminal(entry)) return null
    if (entry.kind === "prompt") return entry.createdAt
  }
  return null
}

/** The rows of a raw transcript, as folding sees them. A subagent's own rows fold under its call, so they are left out. */
export function foldEntriesFromTranscript(entries: readonly TranscriptEntry[]): FoldEntry[] {
  const answered = new Map<string, number>()
  const results = new Map<string, { content: unknown; isError: boolean }>()
  for (const entry of entries) {
    if (entry.kind === "tool_result" && !answered.has(entry.toolId)) {
      answered.set(entry.toolId, entry.createdAt)
      results.set(entry.toolId, { content: entry.content, isError: entry.isError === true })
    }
  }
  const result: FoldEntry[] = []
  entries.forEach((entry, index) => {
    if (entry.parentToolUseId) return
    const base = { id: entry._id, index, entryKind: entry.kind, hidden: entry.hidden === true, createdAt: entry.createdAt }
    switch (entry.kind) {
      case "user_prompt":
        result.push({
          ...base,
          kind: "prompt",
          source: entry.source?.kind,
          ...(entry.source?.kind === "report" ? { chats: reportChats(entry.content, entry.source.chatIds) } : {}),
        })
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
          answeredAt: answered.get(entry.tool.toolId),
          ...chatCallField(entry, results.get(entry.tool.toolId)),
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
  })
  return result
}

/**
 * Statuses in which the newest turn is still going: it does not fold yet. Not
 * waiting on sub-chats: the delegator's turn has ended, and the report that
 * comes back starts a turn of its own.
 */
const GOING: ReadonlySet<KannaStatus> = new Set<KannaStatus>(["starting", "running", "waiting_for_user"])

/** One turn of a transcript: entries `[start, end)`, named by the prompt that opened it. */
export interface TurnSpan {
  id: string
  start: number
  end: number
}

/**
 * The transcript's turns, oldest first, by `turnStarts`. Entries before the
 * first turn's prompt are a turn of their own.
 */
export function splitTurns(entries: readonly TranscriptEntry[]): TurnSpan[] {
  const foldEntries = foldEntriesFromTranscript(entries)
  const turns: TurnSpan[] = []
  for (const start of turnStarts(foldEntries).map((index) => foldEntries[index]!.index)) {
    const last = turns[turns.length - 1]
    if (last) last.end = start
    else if (start > 0) turns.push({ id: `partial:${entries[0]!._id}`, start: 0, end: start })
    turns.push({ id: entries[start]!._id, start, end: entries.length })
  }
  if (turns.length === 0 && entries.length > 0) turns.push({ id: `partial:${entries[0]!._id}`, start: 0, end: entries.length })
  return turns
}

/**
 * A turn's fold, from that turn's entries alone. `settled` is false while
 * the turn is going: it has no fold then. A settled turn with nothing to
 * hide, or nothing left once hidden, has none either.
 */
function foldOfTurn(entries: readonly TranscriptEntry[], turn: TurnSpan, atRest: boolean): { settled: boolean; fold: TranscriptTurnFold | null } {
  const foldEntries = foldEntriesFromTranscript(entries.slice(turn.start, turn.end))
  const [computed] = computeTurnFolds(foldEntries, { atRest })
  if (!computed) return { settled: true, fold: null }
  return {
    settled: computed.settled,
    fold: computed.folds ? { ...toWireFold(foldEntries, computed), id: turn.id } : null,
  }
}

/**
 * The wire form of the folds (`ChatSnapshot.turnFolds`): every finished
 * turn's fold that ends at or after `fromIndex`, by turn, and which turn is
 * going. The newest turn is going when the chat's status says so, or it
 * waits on a card; every other turn is over, since a prompt came after it.
 */
export function buildChatTurnFolds(
  entries: readonly TranscriptEntry[],
  { status, fromIndex = 0 }: { status: KannaStatus; fromIndex?: number },
  cached: (turn: TurnSpan, atRest: boolean) => { settled: boolean; fold: TranscriptTurnFold | null } = (turn, atRest) => foldOfTurn(entries, turn, atRest),
): ChatTurnFolds {
  const folds: Record<string, TranscriptTurnFold> = {}
  let runningTurnId: string | undefined
  let workingSince: number | undefined
  const turns = splitTurns(entries)
  turns.forEach((turn, index) => {
    if (turn.end <= fromIndex) return
    const isLast = index === turns.length - 1
    const result = cached(turn, isLast ? !GOING.has(status) : true)
    if (result.fold) folds[turn.id] = result.fold
    if (result.settled) return
    runningTurnId = turn.id
    if (status === "running" || status === "starting") {
      workingSince = runningTurnStartedAt(foldEntriesFromTranscript(entries.slice(turn.start, turn.end))) ?? undefined
    }
  })
  return {
    folds,
    ...(runningTurnId ? { runningTurnId } : {}),
    ...(workingSince !== undefined ? { workingSince } : {}),
  }
}

function toWireFold(entries: readonly FoldEntry[], fold: TurnFold): TranscriptTurnFold {
  let replyEntryId: string | undefined
  let endEntryId: string | undefined
  const keptEntryIds: string[] = []
  fold.roles.forEach((role, offset) => {
    const entry = entries[fold.start + offset]!
    if (role === "reply") replyEntryId = entry.id
    else if (role === "end") endEntryId = entry.id
    // Usage updates are never drawn, and there is one per step: listing them
    // would only make the list long.
    else if (role === "kept" && entry.entryKind !== "context_window_updated") keptEntryIds.push(entry.id)
  })
  return {
    id: fold.id,
    firstEntryId: entries[fold.start]!.id,
    lastEntryId: entries[fold.end]!.id,
    outcome: fold.outcome,
    ...(fold.workedMs !== undefined ? { workedMs: fold.workedMs } : {}),
    ...(replyEntryId ? { replyEntryId } : {}),
    ...(endEntryId ? { endEntryId } : {}),
    keptEntryIds,
    ...(fold.chatCards.length > 0 ? { chatCards: fold.chatCards } : {}),
  }
}

/**
 * Each turn's fold, worked out once. A turn a later prompt closed never
 * changes (the transcript only grows at its end), so its fold is computed
 * the first time it is asked for and kept. Only the newest turn is looked
 * at again, when it has grown or the chat's status moved.
 */
export class TurnFoldCache {
  private readonly cache = new WeakMap<readonly TranscriptEntry[], Map<string, { end: number; atRest: boolean; result: { settled: boolean; fold: TranscriptTurnFold | null } }>>()

  get(entries: readonly TranscriptEntry[], status: KannaStatus, fromIndex: number): ChatTurnFolds {
    let turns = this.cache.get(entries)
    if (!turns) {
      turns = new Map()
      this.cache.set(entries, turns)
    }
    const known = turns
    return buildChatTurnFolds(entries, { status, fromIndex }, (turn, atRest) => {
      const hit = known.get(turn.id)
      if (hit && hit.end === turn.end && hit.atRest === atRest) return hit.result
      const result = foldOfTurn(entries, turn, atRest)
      known.set(turn.id, { end: turn.end, atRest, result })
      return result
    })
  }
}

/** At most this much of a message or reply rides a card: one line of it. */
const CARD_PREVIEW_CHARS = 160

function preview(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined
  const line = toMessagePreview(text).replace(/\s+/g, " ").trim()
  if (!line) return undefined
  return line.length > CARD_PREVIEW_CHARS ? `${line.slice(0, CARD_PREVIEW_CHARS - 1).trimEnd()}…` : line
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** A Kanna tool's result: an object, or JSON as text, bare or in a text block. */
function resultRecord(content: unknown): Record<string, unknown> | null {
  const direct = record(content)
  if (direct) return direct
  const first = Array.isArray(content) ? record(content[0])?.text : content
  if (typeof first !== "string") return null
  try {
    return record(JSON.parse(first))
  } catch {
    return null
  }
}

/** The chat a successful chat call reached, and what it did there. */
function chatCallField(entry: Extract<TranscriptEntry, { kind: "tool_call" }>, answer: { content: unknown; isError: boolean } | undefined): Pick<FoldEntry, "chats"> {
  const { toolKind, toolName } = entry.tool
  const isChat = toolKind === "chat" || (toolKind === "unknown_tool" && CHAT_TOOL_NAMES.includes(toolName))
  if (!isChat || !answer || answer.isError) return {}
  const input = record(record(entry.tool.input)?.payload) ?? record(entry.tool.rawInput) ?? {}
  const result = resultRecord(answer.content)
  const chatId = (typeof result?.chatId === "string" && result.chatId)
    || (toolName === "send_message" && typeof input.chatId === "string" && input.chatId)
    || null
  if (!chatId) return {}
  const kind: TurnFoldChatCard["last"] = toolName === "fork_chat" ? "forked" : toolName === "send_message" ? "sent" : "started"
  const title = typeof result?.title === "string" ? result.title : typeof input.title === "string" ? input.title : undefined
  return { chats: [{ chatId, kind, preview: preview(input.message), ...(title ? { title } : {}) }] }
}

/** Each chat a report is from, with the first line of what it said. */
function reportChats(content: string, chatIds: readonly string[]): NonNullable<FoldEntry["chats"]> {
  const chats: NonNullable<FoldEntry["chats"]> = []
  const seen = new Set<string>()
  for (const section of splitReportSections(content, chatIds)) {
    if (!section.chatId || seen.has(section.chatId)) continue
    seen.add(section.chatId)
    chats.push({ chatId: section.chatId, kind: "replied", preview: preview(section.body) })
  }
  // A chat the report names but says nothing for still reported.
  for (const chatId of chatIds) {
    if (!seen.has(chatId)) chats.push({ chatId, kind: "replied" })
  }
  return chats
}

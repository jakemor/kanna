import type {
  AgentProvider,
  ChatSchedule,
  KannaStatus,
  MessageSource,
  ModelOptions,
  ScheduleTrigger,
  SubagentActivity,
  TranscriptEntry,
} from "../shared/types"
import { stripSystemMessages } from "../shared/message-preview"
import { buildAgentToAgentNote, type AgentToAgentTurn } from "./agent-to-agent"
import type { ChatChange, ChatCommands } from "./chat-commands"
import type { EventStore } from "./event-store"
import type { ChatRecord } from "./events"
import { renderToolResultContent } from "./handoff"
import { getServerProviderCatalog, SERVER_PROVIDERS } from "./provider-catalog"
import {
  computeFirstRun,
  MIN_SCHEDULE_INTERVAL_MS,
  parseTimeOfDay,
  ScheduleRunner,
  type ScheduleFireResult,
} from "./schedules"

/**
 * What an agent can do to chats, and the rules that keep that safe.
 *
 * Every write here is something the user can already do from the client, and
 * it runs the same function the WebSocket router runs for the user
 * (`chat-commands.ts`). What this file adds is the actor: each method takes
 * the id of the chat whose agent is asking, and checks the rules that apply
 * to an agent before the command runs.
 *
 * A sub-chat is a chat with a parent link, not a separate kind of object. The
 * link carries three behaviours: the sub-chat's result goes back to the parent
 * as a message, the parent is not finished while the sub-chat runs, and
 * stopping the parent stops the sub-chat.
 *
 * A chat the parent adopted (`send_message` with `adopt`) was not started by
 * it and may be one the user works in. It gets the first behaviour whole. It
 * holds the parent only while it owes a report, and stopping the parent
 * leaves it running. `ChatRecord.adopted` marks it.
 *
 * A delegator (`ChatRecord.delegator`) is a chat whose job is to hand work
 * on and hear back. Its agent is asked to keep every chat it uses under it,
 * and that is not left to the asking: whatever it passes, a chat it creates
 * or forks is its sub-chat, and a chat it messages is adopted.
 *
 * Whether the sidebar lists a chat is its own field (`ChatRecord.hidden`),
 * not the parent link. A chat started under another is hidden and an adopted
 * one is listed, unless the agent passes `showInSidebar`. A delegator's
 * listed chat is still its sub-chat: the user asked to see the work, not to
 * take it from the chat that runs it.
 */

/** A chat with no parent is in no task log, so a list is the only place it is shown. */
const UNLISTED_ORPHAN_ERROR = "A chat that is not a sub-chat of this one has to be in the sidebar: nothing else would show it. Leave showInSidebar unset, or keep the chat a sub-chat."

/** Agent-created chats nest at most this deep below a chat the user started. */
export const MAX_CHAT_DEPTH = 3
/** Chats one user-started chat can have running under it at once, at any depth. */
export const MAX_LIVE_CHATS = 8

/** How far back a chat's final message is looked for. */
const TAIL_ENTRIES = 400
/**
 * A report carries the sub-chat's last reply whole. A parent that got part of
 * one went back to read the rest four times out of five, so this is only a
 * guard against pathological output. It matches what one `read_chat` call
 * returns, so a reply cut here is read whole in one call.
 */
const REPORT_TEXT_LIMIT = 50_000
/**
 * Characters of entry text one `read_chat` call returns. Entries come whole
 * up to it; one that does not fit is cut, marked, and read on with `next`.
 * Claude Code drops MCP results over about 25k tokens, so it stays under.
 */
const READ_TOTAL_TEXT_LIMIT = 50_000
/** Entries back from the end a `read_chat` with no `after` reads first, before reading the whole transcript. */
const READ_TAIL_WINDOW = 2_000
const SUBCHAT_TASK_PREFIX = "chat:"
/** Sub-chats listed in a parent's task log. Everything running is always listed. */
const TASK_LOG_CHATS = 20
const BOOT_SWEEP_MS = 60_000
/**
 * How long a sub-chat whose background work ended is given to start the turn
 * that answers it, before its parent is told it is finished. Long, because a
 * provider can think for a while before the first thing it says, and nothing
 * is lost by the parent reading "waiting" a little longer.
 */
const CLOSE_OUT_GRACE_MS = 60_000

/** The coordinator, as far as the orchestrator needs it. Narrow so tests can stand in for it. */
export interface OrchestratorAgent {
  isBusy(chatId: string): boolean
  /** Whether its running turn was told it is a delegator. Undefined with none running. */
  turnDelegator?(chatId: string): boolean | undefined
  isDraining(chatId: string): boolean
  /** Work handed to another agent of the provider's is still going. What a chat waits on. */
  hasDelegatedWork(chatId: string): boolean
  /** The kinds of task it left running that it is not waiting on: `shell`, `monitor`. */
  getLeftRunning(chatId: string): string[]
  isPlanning(chatId: string): boolean
  getActiveStatuses(): Map<string, KannaStatus>
  /** Used directly only for the cascade, which is not an action anyone asked for. */
  cancel(chatId: string): Promise<void>
}

interface OrchestratorArgs {
  store: EventStore
  agent: OrchestratorAgent
  commands: ChatCommands
  /** Push the snapshots an action changed. */
  push: (change: ChatChange) => void
  onError?: (message: string) => void
  now?: () => number
  /** Tests shorten it. See `CLOSE_OUT_GRACE_MS`. */
  closeOutGraceMs?: number
}

/**
 * A chat's state as an agent should read it. `running` covers queued work.
 * The two waiting states are a chat whose own turn ended while work it handed
 * off is still going: `waiting_on_subagent` for its provider's own agents (a
 * subagent, a workflow), `waiting_on_subchats` for chats it started. A shell
 * or a monitor it left running is neither: that chat reads as its last turn
 * ended.
 *
 * They are one state to the user (`KannaStatus`), and two here because an
 * agent can act on one and not the other: a sub-chat can be read, messaged
 * and stopped with the chat tools, and a provider's task cannot. A chat with
 * both reads `waiting_on_subagent`.
 */
export type AgentChatStatus =
  | "idle"
  | "running"
  | "needs_input"
  | "waiting_on_subagent"
  | "waiting_on_subchats"
  | "completed"
  | "failed"
  | "cancelled"

/** "a shell", "a shell and a monitor": what a chat left running, as a report says it. Null for nothing. */
function describeLeftRunning(types: string[]) {
  const names = [...new Set(types.map((type) => (
    type === "shell" ? "a shell" : type === "monitor" ? "a monitor" : "a background task"
  )))]
  if (names.length <= 1) return names[0] ?? null
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** The chat, or something under it, is still working. Its result is not in yet. */
function isStillGoing(status: AgentChatStatus) {
  return status === "running" || status === "waiting_on_subagent" || status === "waiting_on_subchats"
}

export interface AgentChatSummary {
  chatId: string
  title: string
  link: string
  projectId: string
  status: AgentChatStatus
  provider: AgentProvider | null
  model?: string
  planMode: boolean
  parentChatId?: string
  /** The parent adopted it and did not start it. See `ChatRecord.adopted`. */
  adopted?: true
  /** Not in the user's sidebar: shown with its parent. See `ChatRecord.hidden`. */
  hidden?: true
  /** It hands work to the chats under it instead of doing it. See `ChatRecord.delegator`. */
  delegator?: true
  forkedFromChatId?: string
  createdByChatId?: string
  lastMessageAt?: string
  turnCount: number
  queuedMessages: number
  archived?: true
  pinned?: true
  done?: true
  unread?: true
}

export interface ChatOutcome {
  chatId: string
  title: string
  link: string
  status: AgentChatStatus
  /** The chat's last reply, or the error that ended its turn. */
  finalMessage?: string
  /** `finalMessage` is the start of a reply longer than `REPORT_TEXT_LIMIT`: where `read_chat` picks it up. */
  cut?: { index: number; textOffset: number; totalChars: number }
}

/**
 * What `read_chat` can filter on. The names are the transcript's entry kinds,
 * with two of its own: `report` is a prompt that is a report from sub-chats
 * (a `user_prompt` with a report source), and `reply` is each turn's last
 * `assistant_text`, the agent's answer without its narration.
 */
export const READ_CHAT_KINDS = ["user_prompt", "report", "assistant_text", "reply", "tool_call", "tool_result", "result", "interrupted"] as const
export type ReadChatKind = typeof READ_CHAT_KINDS[number]
/** What was said: no tool traffic. */
const DEFAULT_READ_KINDS: readonly ReadChatKind[] = ["user_prompt", "report", "assistant_text", "result", "interrupted"]

export interface ReadChatEntry {
  /** Position in the transcript, for `after` and `before`. */
  index: number
  kind: Exclude<ReadChatKind, "reply">
  text: string
  at: string
  /** Set when a prompt did not come from the user. */
  from?: MessageSource
  /** An `assistant_text` that ends its turn: the reply. */
  final?: true
  /** On `tool_call`: the tool's name. */
  tool?: string
  /** On `tool_call` and `tool_result`: pairs a result with its call. */
  toolId?: string
  error?: true
  /** `text` is part of the entry, from `textOffset` on, out of `totalChars`. */
  truncated?: true
  textOffset?: number
  totalChars?: number
}

/** The arguments that read the next or the previous page, as `read_chat` takes them. */
interface ReadChatPosition {
  after?: number
  before?: number
  textOffset?: number
  kinds?: ReadChatKind[]
  lastTurns?: number
}

interface ReadableRow {
  index: number
  kind: ReadChatEntry["kind"]
  entry: TranscriptEntry
  final: boolean
}

/** One sub-chat's part of a report: the line for the agent, and what it said. */
interface ReportSection {
  header: string
  reply?: string
}

interface RunOptions {
  provider?: AgentProvider
  model?: string
  effort?: string
  planMode?: boolean
}

function chatLink(chatId: string) {
  return `/chat/${chatId}`
}

/**
 * The options a chat last ran with (`ChatRecord.lastModelOptions`), for a turn
 * that inherits its model. Only the provider's own entry carries over, and an
 * effort the caller names wins: options outrank the bare `effort` when the
 * agent resolves a turn's settings.
 */
function inheritModelOptions(options: ModelOptions | undefined, provider: AgentProvider, effort?: string): ModelOptions | undefined {
  const own = options?.[provider]
  if (!own) return undefined
  if (!effort) return { [provider]: own }
  const { reasoningEffort: _, ...rest } = own as { reasoningEffort?: unknown }
  return { [provider]: rest }
}

function clip(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}…`, truncated: true }
}

/** An entry's whole text as `read_chat` returns it. Tool entries need their payload merged back first. */
function readableText(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user_prompt": return entry.content
    case "assistant_text": return entry.text
    case "tool_call": return `${entry.tool.toolName} ${JSON.stringify(entry.tool.input)}`
    case "tool_result": return renderToolResultContent(entry.content)
    case "result": return entry.result || "unknown error"
    case "interrupted": return "Turn stopped."
    default: return ""
  }
}

function toReadChatEntry(row: ReadableRow, text: string): ReadChatEntry {
  const { entry } = row
  return {
    index: row.index,
    kind: row.kind,
    text,
    at: iso(entry.createdAt),
    ...(entry.kind === "user_prompt" && entry.source ? { from: entry.source } : {}),
    ...(row.final ? { final: true as const } : {}),
    ...(entry.kind === "tool_call" ? { tool: entry.tool.toolName, toolId: entry.tool.toolId } : {}),
    ...(entry.kind === "tool_result" ? { toolId: entry.toolId } : {}),
    ...((entry.kind === "tool_result" || entry.kind === "result") && entry.isError ? { error: true as const } : {}),
  }
}

/**
 * Sections joined into one report, or added to one already waiting in the
 * parent's queue. A rule goes ahead of a sub-chat's words only when words
 * came before them (`splitReportSections` reads it that way).
 */
function appendReportSection(report: string, section: ReportSection) {
  const shown = stripSystemMessages(report) !== ""
  const body = section.reply ? `${section.header}\n\n${shown ? "---\n\n" : ""}${section.reply}` : section.header
  return report ? `${report}\n\n${body}` : body
}

function iso(timestamp: number) {
  return new Date(timestamp).toISOString()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class ChatOrchestrator {
  private readonly store: EventStore
  private readonly agent: OrchestratorAgent
  private readonly commands: ChatCommands
  private readonly push: (change: ChatChange) => void
  private readonly onError: (message: string) => void
  private readonly now: () => number
  private readonly schedules: ScheduleRunner
  /** Reports being written, so two turn ends in a row send one. */
  private readonly reporting = new Set<string>()
  /** The last report delivery under way per parent, for the next one to follow. */
  private readonly deliveries = new Map<string, Promise<void>>()
  /**
   * Sub-chats whose report is in, with a shell or a monitor of their own still
   * running. Such a chat is not waiting on anything, so it owes nothing and
   * holds nobody. But a shell can give it another turn when it ends, and a
   * monitor each time it fires, and that turn is its parent's to hear of: a
   * turn starting in one of these owes a report again. When that turn's
   * report goes with the monitor still running, the chat is watched again.
   * The value is the timer that drops the entry, set once nothing is left
   * running (see `handleChatSettled`).
   *
   * In memory only. A restart ends the provider's session and its tasks with
   * it, so there is no later turn left to watch for.
   */
  private readonly laterTurns = new Map<string, ReturnType<typeof setTimeout> | null>()
  /**
   * Sub-chats whose latest turn started while they owed their parent a
   * report, until a report covers it. The turn that starts next looks here to
   * know whether the one before it was the parent's to hear (`reportEndedTurn`).
   *
   * In memory only. A restart resumes a turn, and its start sets this again.
   */
  private readonly owedTurns = new Set<string>()
  /** Sub-chats waiting out `closeOutGraceMs` before their last report. See `closeOutDue`. */
  private readonly closeOuts = new Map<string, { ready: boolean; timer?: ReturnType<typeof setTimeout> }>()
  private readonly closeOutGraceMs: number
  private childIndex: { version: number; byParent: Map<string, ChatRecord[]> } | null = null
  private bootSweep: ReturnType<typeof setTimeout> | null = null

  constructor(args: OrchestratorArgs) {
    this.store = args.store
    this.agent = args.agent
    this.commands = args.commands
    this.push = args.push
    this.onError = args.onError ?? (() => {})
    this.now = args.now ?? Date.now
    this.closeOutGraceMs = args.closeOutGraceMs ?? CLOSE_OUT_GRACE_MS
    this.schedules = new ScheduleRunner({
      store: this.store,
      fire: (schedule) => this.fireSchedule(schedule),
      onFired: (schedule, result) => {
        // A run can create a chat, which the sidebar and the project list show.
        if (result.outcome === "sent") this.push({ sidebar: true, localProjects: true, chatIds: [result.chatId] })
        // Every run, skipped ones too, is a new line in the schedule's history.
        this.pushSchedule(this.store.getSchedule(schedule.id) ?? schedule)
      },
      onError: (schedule, error) => {
        this.onError(`schedule ${schedule.id} (${schedule.name}) failed to run: ${errorMessage(error)}`)
      },
      now: this.now,
    })
  }

  /**
   * Arms the schedules and sends any report a restart interrupted: a sub-chat
   * that finished just before the process went down still owes its parent.
   */
  start() {
    this.schedules.start()
    this.sweepReports()
    // Once more after boot has resumed what it is going to resume. A sub-chat
    // whose resume was skipped has no turn end coming to send its report.
    this.bootSweep = setTimeout(() => this.sweepReports(), BOOT_SWEEP_MS)
    this.bootSweep.unref?.()
  }

  dispose() {
    this.schedules.dispose()
    if (this.bootSweep) clearTimeout(this.bootSweep)
    for (const chatId of [...this.closeOuts.keys()]) this.cancelCloseOut(chatId)
    for (const chatId of [...this.laterTurns.keys()]) this.forgetLaterTurn(chatId)
  }

  private sweepReports() {
    for (const chat of this.store.state.chatsById.values()) {
      if (chat.reportOwed && !chat.deletedAt) void this.maybeReport(chat.id)
    }
  }

  // ── State ──────────────────────────────────────────────────────────────

  private childrenOf(chatId: string): ChatRecord[] {
    const version = this.store.stateVersion
    if (this.childIndex?.version !== version) {
      const byParent = new Map<string, ChatRecord[]>()
      for (const chat of this.store.state.chatsById.values()) {
        if (!chat.parentChatId || chat.deletedAt) continue
        const siblings = byParent.get(chat.parentChatId)
        if (siblings) siblings.push(chat)
        else byParent.set(chat.parentChatId, [chat])
      }
      this.childIndex = { version, byParent }
    }
    return this.childIndex.byParent.get(chatId) ?? []
  }

  /** A turn of the chat's own is running, about to run, or still closing its stream. */
  private hasTurnInFlight(chat: ChatRecord) {
    // Cut short by a shutdown and about to be picked back up.
    if (chat.resumePending) return true
    if (this.agent.isBusy(chat.id) || this.agent.isDraining(chat.id)) return true
    // A queue normally drains as soon as the turn ends, so messages in it mean
    // a turn is about to start. The exception is a stopped chat, whose queue
    // is parked until someone sends again.
    const queued = this.store.getQueuedMessages(chat.id).length
    return queued > 0 && chat.lastTurnOutcome !== "cancelled"
  }

  /**
   * The chat itself has nothing running and nothing about to run. Says nothing
   * of its sub-chats. A shell or a monitor it left running does not keep it
   * from this: neither is work the chat is waiting on (`laterTurns` covers
   * what they may wake).
   */
  private isSelfSettled(chat: ChatRecord) {
    return !this.hasTurnInFlight(chat) && !this.agent.hasDelegatedWork(chat.id)
  }

  /** A chat this one started is still going, or has a report on its way here. */
  private hasLiveSubchats(chatId: string) {
    return this.childrenOf(chatId).some((child) => this.holdsParent(child))
  }

  /** How many sub-chats are holding this chat in its wait: the count behind `hasLiveSubchats`. */
  countSubchatsHolding(chatId: string) {
    return this.childrenOf(chatId).filter((child) => this.holdsParent(child)).length
  }

  /**
   * Whether this sub-chat keeps its parent from being finished. One the
   * parent started does for as long as it works. An adopted one has turns its
   * parent never asked for (the user typing in it), so it holds the parent
   * only until the report it owes is in.
   */
  private holdsParent(child: ChatRecord, seen?: Set<string>) {
    if (this.isReportDue(child)) return true
    return !child.adopted && this.isLive(child.id, seen)
  }

  /**
   * Every chat with a sub-chat still going under it, for the status the user
   * sees (`AgentCoordinator.getChatStatuses`). The same answer as asking
   * `hasLiveSubchats` of each chat. `unsettled` is the chats the coordinator
   * knows to have a turn or background work going.
   *
   * Worked out from the bottom up, because it runs on every push: nearly
   * every sub-chat there has ever been finished long ago, and going down from
   * each parent would look at all of them. Only a chat that is still going,
   * or owes a report, puts the chats above it in the set.
   */
  getChatsWaitingOnSubchats(unsettled: Iterable<string>): Set<string> {
    const candidates = new Set(unsettled)
    for (const chatId of this.reporting) candidates.add(chatId)
    for (const chatId of this.store.state.queuedMessagesByChatId.keys()) candidates.add(chatId)
    for (const chat of this.store.state.chatsById.values()) {
      if (chat.parentChatId && (chat.reportOwed || chat.resumePending)) candidates.add(chat.id)
    }
    const waiting = new Set<string>()
    for (const chatId of candidates) {
      let chat = this.store.getChat(chatId)
      if (!chat?.parentChatId) continue
      if (!this.isReportDue(chat) && this.isSelfSettled(chat)) continue
      // A chat with a live sub-chat is live itself, so the wait goes all the
      // way up. A parent already in the set has had its own walked. The walk
      // ends at an adopted chat that owes nothing (`holdsParent`).
      while (chat?.parentChatId && (!chat.adopted || this.isReportDue(chat)) && !waiting.has(chat.parentChatId)) {
        waiting.add(chat.parentChatId)
        chat = this.store.getChat(chat.parentChatId)
      }
    }
    return waiting
  }

  /**
   * Work is still going in this chat or under it. A sub-chat that has finished
   * but not yet reported counts: its report is about to start a turn here.
   */
  private isLive(chatId: string, seen = new Set<string>()): boolean {
    if (seen.has(chatId)) return false
    seen.add(chatId)
    const chat = this.store.getChat(chatId)
    if (!chat) return false
    if (!this.isSelfSettled(chat)) return true
    return this.childrenOf(chatId).some((child) => this.holdsParent(child, seen))
  }

  /**
   * A report from this sub-chat is owed or on its way. "On its way" matters:
   * the flag is cleared before the message is queued, and in between the
   * parent would otherwise look finished to a chat above it.
   */
  private isReportDue(child: ChatRecord) {
    return Boolean(child.reportOwed) || this.reporting.has(child.id)
  }

  private statusOf(chat: ChatRecord): AgentChatStatus {
    if (this.agent.getActiveStatuses().get(chat.id) === "waiting_for_user") return "needs_input"
    if (this.hasTurnInFlight(chat)) return "running"
    if (this.agent.hasDelegatedWork(chat.id)) return "waiting_on_subagent"
    if (this.hasLiveSubchats(chat.id)) return "waiting_on_subchats"
    if (chat.lastTurnOutcome === "success") return "completed"
    if (chat.lastTurnOutcome === "failed") return "failed"
    if (chat.lastTurnOutcome === "cancelled") return "cancelled"
    return "idle"
  }

  private summarize(chat: ChatRecord): AgentChatSummary {
    return {
      chatId: chat.id,
      title: chat.title,
      link: chatLink(chat.id),
      projectId: chat.projectId,
      status: this.statusOf(chat),
      provider: chat.provider,
      ...(chat.lastModel ? { model: chat.lastModel } : {}),
      planMode: chat.planMode,
      ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
      ...(chat.adopted ? { adopted: true as const } : {}),
      ...(chat.hidden ? { hidden: true as const } : {}),
      ...(chat.delegator ? { delegator: true as const } : {}),
      ...(chat.forkedFromChatId ? { forkedFromChatId: chat.forkedFromChatId } : {}),
      ...(chat.createdByChatId ? { createdByChatId: chat.createdByChatId } : {}),
      ...(chat.lastMessageAt ? { lastMessageAt: iso(chat.lastMessageAt) } : {}),
      turnCount: chat.turnCount ?? 0,
      queuedMessages: this.store.getQueuedMessages(chat.id).length,
      ...(chat.archivedAt ? { archived: true as const } : {}),
      ...(chat.pinnedAt ? { pinned: true as const } : {}),
      ...(chat.doneAt ? { done: true as const } : {}),
      ...(chat.unread ? { unread: true as const } : {}),
    }
  }

  private requireChat(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat) throw new Error(`Chat ${chatId} not found. list_chats shows the chats that exist.`)
    return chat
  }

  private tailEntries(chatId: string, count = TAIL_ENTRIES): { entries: TranscriptEntry[]; startIndex: number } {
    const start = Math.max(0, this.store.getTranscriptLength(chatId) - count)
    const transcript = this.store.getClientTranscript(chatId, start)
    return { entries: transcript.messages, startIndex: transcript.startIndex }
  }

  /**
   * How the chat's last turn ended, in words: its final reply whole, or the
   * error. Only the main agent's own text counts, not a subagent's.
   *
   * A chat that is running went straight on into another turn
   * (`reportEndedTurn`), so its reply is the one before the entry that ended
   * the last turn, not whatever the new turn has said so far.
   */
  private outcomeOf(chat: ChatRecord): ChatOutcome {
    const status = this.statusOf(chat)
    const outcome: ChatOutcome = { chatId: chat.id, title: chat.title, link: chatLink(chat.id), status }
    // Its reply is not in yet: the turn is parked on a question.
    if (status === "needs_input") return outcome
    const { entries, startIndex } = this.tailEntries(chat.id)
    let end = entries.length
    if (status === "running") {
      while (end > 0 && entries[end - 1]!.kind !== "result" && entries[end - 1]!.kind !== "interrupted") end -= 1
    }
    const lastEnd = entries[end - 1]
    const endedInError = status === "failed" || (status === "running" && lastEnd?.kind === "result" && Boolean(lastEnd.isError))
    const take = (index: number, raw: string) => {
      // Offsets count from the entry's own text, untrimmed, which is what read_chat reads.
      const lead = raw.length - raw.trimStart().length
      const text = raw.trim()
      if (text.length <= REPORT_TEXT_LIMIT) {
        outcome.finalMessage = text
        return
      }
      outcome.finalMessage = `${text.slice(0, REPORT_TEXT_LIMIT)}…`
      outcome.cut = { index: startIndex + index, textOffset: lead + REPORT_TEXT_LIMIT, totalChars: text.length }
    }
    for (let index = end - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (entry.kind === "user_prompt") break
      if (entry.kind === "result" && entry.isError && entry.result && endedInError) {
        take(index, entry.result)
        break
      }
      if (entry.kind === "assistant_text" && !entry.hidden && !entry.parentToolUseId && entry.text.trim()) {
        take(index, entry.text)
        break
      }
    }
    return outcome
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  /** The chat that created this one, followed up to a chat the user started. */
  private creationChain(chatId: string): ChatRecord[] {
    const chain: ChatRecord[] = []
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.push(current)
      current = current.createdByChatId ? this.store.getChat(current.createdByChatId) : null
    }
    return chain
  }

  /**
   * Refuses a new chat that would nest too deep or run too many at once.
   * Both are counted from the chat the user started, across every chat the
   * agents under it created, so a sub-chat cannot get round a limit by
   * starting chats of its own.
   */
  private checkBudget(actorChatId: string) {
    const chain = this.creationChain(actorChatId)
    if (chain.length > MAX_CHAT_DEPTH) {
      throw new Error(`Chats started by agents can nest ${MAX_CHAT_DEPTH} deep, and this chat is already at that depth. Do the work here instead.`)
    }
    const rootId = chain[chain.length - 1]!.id
    let live = 0
    for (const chat of this.store.state.chatsById.values()) {
      if (chat.deletedAt || !chat.createdByChatId || chat.id === rootId) continue
      const chatChain = this.creationChain(chat.id)
      if (chatChain[chatChain.length - 1]!.id === rootId && this.isLive(chat.id)) live += 1
    }
    if (live >= MAX_LIVE_CHATS) {
      throw new Error(`${live} chats started from this conversation are still running, which is the limit. End this turn, and the next one to finish wakes this chat with its report and frees a place. Or stop one with cancel_chat.`)
    }
  }

  private isParentOf(chatId: string, ancestorId: string) {
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current?.parentChatId && !seen.has(current.id)) {
      if (current.parentChatId === ancestorId) return true
      seen.add(current.id)
      current = this.store.getChat(current.parentChatId)
    }
    return false
  }

  /**
   * The provider, model and mode a message runs with. Unset fields fall back
   * to `defaults`, which is the receiving chat's own last turn, or the
   * sender's for a new chat.
   *
   * A chat in plan mode is read-only, and that is a ceiling: it cannot start
   * or message a chat that would do the editing for it.
   */
  private resolveRun(
    actorChatId: string,
    requested: RunOptions,
    defaults: { provider: AgentProvider | null; model?: string; modelOptions?: ModelOptions; planMode: boolean; autoPlan: boolean },
  ) {
    const provider = requested.provider ?? defaults.provider ?? "claude"
    if (!SERVER_PROVIDERS.some((entry) => entry.id === provider)) {
      throw new Error(`Unknown provider "${provider}". get_context lists the providers.`)
    }
    const catalog = getServerProviderCatalog(provider)
    const sameProvider = provider === defaults.provider
    const planning = this.agent.isPlanning(actorChatId)
    if (planning && !catalog.supportsPlanMode) {
      throw new Error(`This chat is in plan mode, and ${catalog.label} has no read-only mode to match it. Pick a provider with plan mode.`)
    }
    if (planning && requested.planMode === false) {
      throw new Error("This chat is in plan mode, so a chat it starts or messages must be in plan mode too.")
    }
    return {
      provider,
      // A model belongs to its provider, so a default is not carried across a switch.
      model: requested.model ?? (sameProvider ? defaults.model : undefined),
      // And its options go with it: a named model starts from that model's defaults.
      modelOptions: !requested.model && sameProvider ? inheritModelOptions(defaults.modelOptions, provider, requested.effort) : undefined,
      effort: requested.effort,
      planMode: catalog.supportsPlanMode && (planning || (requested.planMode ?? defaults.planMode)),
      autoPlan: sameProvider && catalog.supportsAutoPlanMode ? defaults.autoPlan : false,
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  getContext(actorChatId: string) {
    const chat = this.requireChat(actorChatId)
    const project = this.store.getProject(chat.projectId)
    return {
      now: iso(this.now()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      chat: { ...this.summarize(chat), projectPath: project?.localPath },
      projects: this.store.listProjects().map((entry) => ({
        projectId: entry.id,
        title: entry.sidebarTitle ?? entry.title,
        path: entry.localPath,
      })),
      providers: SERVER_PROVIDERS.map((entry) => ({
        provider: entry.id,
        label: entry.label,
        defaultModel: entry.defaultModel,
        models: entry.models.map((model) => model.id),
        efforts: entry.efforts.map((effort) => effort.id),
        supportsPlanMode: entry.supportsPlanMode,
      })),
      limits: { maxDepth: MAX_CHAT_DEPTH, maxLiveChats: MAX_LIVE_CHATS },
    }
  }

  listChats(input: {
    projectId?: string
    query?: string
    status?: AgentChatStatus
    parentChatId?: string
    includeArchived?: boolean
    limit?: number
    offset?: number
  }) {
    const query = input.query?.trim().toLowerCase()
    const matches: AgentChatSummary[] = []
    const chats = [...this.store.state.chatsById.values()]
      .filter((chat) => !chat.deletedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
    for (const chat of chats) {
      if (chat.archivedAt && !input.includeArchived) continue
      if (input.projectId && chat.projectId !== input.projectId) continue
      if (input.parentChatId && chat.parentChatId !== input.parentChatId) continue
      if (query) {
        // Titles and the last message each way. The transcripts are not
        // searched: that is a file read per chat.
        const haystack = `${chat.title}\n${chat.lastUserMessagePreview ?? ""}\n${chat.lastAgentMessagePreview ?? ""}`.toLowerCase()
        if (!haystack.includes(query)) continue
      }
      const summary = this.summarize(chat)
      if (input.status && summary.status !== input.status) continue
      matches.push(summary)
    }
    const offset = input.offset ?? 0
    const limit = input.limit ?? 30
    return {
      total: matches.length,
      chats: matches.slice(offset, offset + limit),
      ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
    }
  }

  /**
   * A chat's transcript, for an agent to read on its own: whole entries,
   * filtered by kind and position, up to `READ_TOTAL_TEXT_LIMIT` characters a
   * call. `after` reads forward from an index, `before` back from one, and
   * neither reads back from the end. `lastTurns` keeps to the latest turns.
   *
   * Nothing is cut silently. An entry that does not fit in what is left of
   * the budget ends the page, unless it is the first, which is cut, marked,
   * and finished by `next` (`textOffset` resumes inside it). Tool bodies come
   * from the payload sidecar, only for the tool entries on the page.
   */
  readChat(input: {
    chatId: string
    after?: number
    before?: number
    textOffset?: number
    lastTurns?: number
    kinds?: ReadChatKind[]
    limit?: number
  }) {
    const chat = this.requireChat(input.chatId)
    const limit = input.limit ?? 40
    const kinds = new Set<ReadChatKind>(input.kinds?.length ? input.kinds : DEFAULT_READ_KINDS)
    const total = this.store.getTranscriptLength(chat.id)
    const forward = input.after !== undefined
    const lower = forward ? Math.max(0, input.after! + 1) : 0
    const upper = Math.min(total, input.before ?? total)
    const matches = (row: ReadableRow) => (
      kinds.has(row.kind) || (row.kind === "assistant_text" && row.final && kinds.has("reply"))
    )

    // Reading back, or counting turns from the end, the end is read first. The
    // whole transcript is read only when that is too short to fill the page
    // (one more than it, to know whether there is an earlier one) or to reach
    // back to the turns asked for.
    const tail = Math.max(0, (forward ? total : upper) - READ_TAIL_WINDOW)
    let rows = this.readableRows(chat, !forward ? tail : input.lastTurns ? Math.min(lower, tail) : lower)
    const select = () => {
      let from = lower
      let turnsFound = true
      if (input.lastTurns) {
        // A turn starts at a prompt: the user's, an agent's, or a report.
        const prompts = rows.rows.filter((row) => row.kind === "user_prompt" || row.kind === "report")
        const turnStart = prompts[prompts.length - input.lastTurns]
        if (turnStart) from = Math.max(from, turnStart.index)
        else turnsFound = false
      }
      const candidates = rows.rows.filter((row) => row.index >= from && row.index < upper && matches(row))
      const complete = rows.startIndex === 0
        || (turnsFound && (rows.startIndex <= from || (!forward && candidates.length > limit)))
      return { candidates, complete }
    }
    let selected = select()
    if (!selected.complete) {
      rows = this.readableRows(chat, 0)
      selected = select()
    }
    const { candidates } = selected
    const page = forward ? candidates.slice(0, limit) : candidates.slice(-limit)

    // Tool bodies live in the sidecar. One read for the whole page.
    const toolIds = page.filter((row) => row.kind === "tool_call" || row.kind === "tool_result").map((row) => row.entry._id)
    const whole = new Map(this.store.getEntriesById(chat.id, toolIds).map((entry) => [entry._id, entry]))
    const textOf = (row: ReadableRow) => readableText(whole.get(row.entry._id) ?? row.entry)

    let budget = READ_TOTAL_TEXT_LIMIT
    const entries: ReadChatEntry[] = []
    let cut: { index: number; textOffset: number } | null = null
    const ordered = forward ? page : [...page].reverse()
    for (const [position, row] of ordered.entries()) {
      const full = textOf(row)
      const start = forward && position === 0 && input.textOffset ? Math.min(input.textOffset, full.length) : 0
      const rest = full.length - start
      const fits = rest <= budget
      // Only the first entry may be cut. Any other that does not fit starts the next page.
      if (!fits && entries.length > 0) break
      const shown = fits ? rest : budget
      const entry = toReadChatEntry(row, full.slice(start, start + shown))
      if (start > 0 || !fits) Object.assign(entry, { truncated: true as const, textOffset: start, totalChars: full.length })
      if (forward) entries.push(entry)
      else entries.unshift(entry)
      budget -= shown
      if (!fits) {
        cut = { index: row.index, textOffset: start + shown }
        break
      }
    }

    // How to go on: the arguments for the page after this one and the one before.
    const filters: ReadChatPosition = {
      ...(input.kinds?.length ? { kinds: input.kinds } : {}),
      ...(input.lastTurns ? { lastTurns: input.lastTurns } : {}),
    }
    const first = entries[0]
    const last = entries[entries.length - 1]
    let next: ReadChatPosition | undefined
    if (cut) next = { after: cut.index - 1, textOffset: cut.textOffset, ...filters }
    else if (last && candidates.some((row) => row.index > last.index)) next = { after: last.index, ...filters }
    const earlier: ReadChatPosition | undefined = first && candidates.some((row) => row.index < first.index)
      ? { before: first.index, ...filters }
      : undefined

    return {
      chat: this.summarize(chat),
      subchats: this.childrenOf(chat.id).map((child) => this.summarize(child)),
      queue: this.store.getQueuedMessages(chat.id).map((message) => {
        const preview = clip(message.content, 500)
        return {
          queuedMessageId: message.id,
          text: preview.text,
          ...(preview.truncated ? { truncated: true as const } : {}),
          ...(message.source ? { from: message.source } : {}),
        }
      }),
      entries,
      transcriptEntries: total,
      ...(next ? { next } : {}),
      ...(earlier ? { earlier } : {}),
    }
  }

  /**
   * The transcript from `fromIndex` to its end, as rows `read_chat` can
   * return. Always to the end, because whether an `assistant_text` is its
   * turn's reply depends on what follows it.
   */
  private readableRows(chat: ChatRecord, fromIndex: number) {
    const transcript = this.store.getClientTranscript(chat.id, fromIndex)
    const rows: ReadableRow[] = []
    // Walked from the end: text is final when its turn ended before more text
    // came. At the very end that is only so when no turn is running.
    let closed = !this.hasTurnInFlight(chat)
    for (let offset = transcript.messages.length - 1; offset >= 0; offset -= 1) {
      const entry = transcript.messages[offset]!
      const index = transcript.startIndex + offset
      if (entry.hidden) continue
      let kind: ReadChatEntry["kind"] | null = null
      let final = false
      if (entry.kind === "user_prompt") {
        kind = entry.source?.kind === "report" ? "report" : "user_prompt"
        closed = true
      } else if (entry.kind === "result" || entry.kind === "interrupted") {
        // A successful result says nothing the reply did not.
        if (entry.kind === "interrupted" || entry.isError) kind = entry.kind
        closed = true
      } else if (entry.kind === "assistant_text") {
        if (entry.parentToolUseId || !entry.text.trim()) continue
        kind = "assistant_text"
        final = closed
        closed = false
      } else if (entry.kind === "tool_call" || entry.kind === "tool_result") {
        kind = entry.kind
      }
      if (kind) rows.push({ index, kind, entry, final })
    }
    return { rows: rows.reverse(), startIndex: transcript.startIndex }
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async createChat(actorChatId: string, input: RunOptions & {
    message: string
    /** The work it does. Required by the tool; the user's own creations may have none. */
    title?: string
    projectId?: string
    subchat?: boolean
    /** Overrides where it is shown. By default a sub-chat is hidden and any other chat listed. */
    showInSidebar?: boolean
  }) {
    const caller = this.requireChat(actorChatId)
    // A delegator's chats are always under it. See the note at the top.
    const subchat = this.isDelegating(caller) ? true : input.subchat ?? true
    const hidden = input.showInSidebar === undefined ? subchat : !input.showInSidebar
    if (hidden && !subchat) throw new Error(UNLISTED_ORPHAN_ERROR)
    const projectId = input.projectId ?? caller.projectId
    if (!this.store.getProject(projectId)) {
      throw new Error(`Project ${projectId} not found. get_context lists the projects.`)
    }
    this.checkBudget(actorChatId)
    const run = this.resolveRun(actorChatId, input, {
      provider: caller.provider,
      model: caller.lastModel,
      modelOptions: caller.lastModelOptions,
      planMode: false,
      autoPlan: false,
    })

    const created = await this.commands.create(projectId, {
      createdByChatId: actorChatId,
      ...(subchat ? { parentChatId: actorChatId } : {}),
    }, { hidden })
    const chat = this.requireChat(created.result.chatId)
    if (input.title?.trim()) await this.commands.rename(chat.id, input.title)
    await this.send(actorChatId, chat, input.message, run, { report: subchat })
    this.push(created.changed!)
    return this.summarize(this.requireChat(chat.id))
  }

  async forkChat(actorChatId: string, input: RunOptions & {
    chatId?: string
    message?: string
    /** The new work's. A fork is how a chat's context is reused for new work, so the tool requires one. */
    title?: string
    subchat?: boolean
    /** As for `createChat`. */
    showInSidebar?: boolean
  }) {
    const source = this.requireChat(input.chatId ?? actorChatId)
    const caller = this.requireChat(actorChatId)
    // A fork handed work is delegation, so it reports back unless told not to.
    // A delegator's fork is under it either way.
    const subchat = this.isDelegating(caller) ? true : input.subchat ?? Boolean(input.message)
    const hidden = input.showInSidebar === undefined ? subchat : !input.showInSidebar
    if (hidden && !subchat) throw new Error(UNLISTED_ORPHAN_ERROR)
    this.checkBudget(actorChatId)
    const forked = await this.commands.fork(source.id, {
      createdByChatId: actorChatId,
      ...(subchat ? { parentChatId: actorChatId } : {}),
    }, { hidden })
    const chat = this.requireChat(forked.result.chatId)
    if (input.title?.trim()) await this.commands.rename(chat.id, input.title.trim())
    if (input.message) {
      const run = this.resolveRun(actorChatId, input, {
        provider: chat.provider,
        model: source.lastModel,
        modelOptions: source.lastModelOptions,
        planMode: chat.planMode,
        autoPlan: chat.autoPlan,
      })
      await this.send(actorChatId, chat, input.message, run, { report: subchat })
    }
    this.push({ ...forked.changed, chatIds: [chat.id] })
    return this.summarize(this.requireChat(chat.id))
  }

  async sendMessage(actorChatId: string, input: RunOptions & {
    chatId: string
    message: string
    /**
     * What the chat works on: its title unchanged for a follow-up on its own
     * work, a new one when it is reused for new work. The tool requires it,
     * so keeping it is a choice; none keeps it too. Applied to this chat's
     * own sub-chats only; see below.
     */
    title?: string
    delivery?: "queue" | "steer"
    adopt?: boolean
    /**
     * Lists the chat in the sidebar, or takes it out. Only for a sub-chat of
     * this one: one it started, or adopts with this message. Applied once the
     * message is sent.
     */
    showInSidebar?: boolean
  }) {
    if (input.chatId === actorChatId) {
      throw new Error("A chat cannot message itself. Use set_schedule to send this chat a message later.")
    }
    const target = this.requireChat(input.chatId)
    const run = this.resolveRun(actorChatId, input, {
      provider: target.provider,
      model: target.lastModel,
      modelOptions: target.lastModelOptions,
      planMode: target.planMode,
      autoPlan: target.autoPlan,
    })
    // Before the send: the turn it starts is told who its parent is, and the
    // report it earns is addressed by the link.
    const delegating = this.isDelegating(this.requireChat(actorChatId))
    // Checked before anything is done, so a refusal leaves nothing behind.
    if (input.showInSidebar !== undefined && target.parentChatId !== actorChatId && !input.adopt && !delegating) {
      throw new Error("showInSidebar is only for a sub-chat of this chat. Pass adopt: true to make it one with this message.")
    }
    const adoption = input.adopt || delegating ? await this.adopt(actorChatId, target, { forced: delegating && !input.adopt }) : null
    // Named for the work it is given, before the message lands, so the
    // sidebar says what it is doing from the start. Only a chat of this
    // one's: one it started, or adopts here. A message to anyone else's chat,
    // the user's own among them, leaves its name alone. One adopted is
    // renamed even while the user has it open: the server cannot tell.
    const title = input.title?.trim() || target.title
    const ownChat = this.requireChat(target.id).parentChatId === actorChatId
    const previousTitle = ownChat && title !== target.title ? target.title : null
    if (previousTitle !== null) {
      await this.commands.rename(target.id, title)
      this.push({ sidebar: true, chatIds: [target.id] })
    }
    let sent: { queuedMessageId?: string }
    try {
      sent = await this.send(actorChatId, target, input.message, run, {
        // Only its own parent is owed a sub-chat's result.
        report: this.requireChat(target.id).parentChatId === actorChatId,
        steer: input.delivery === "steer",
      })
    } catch (error) {
      // The caller is told the send failed, so nothing of it may remain.
      if (previousTitle !== null) await this.commands.rename(target.id, previousTitle).catch(() => {})
      await adoption?.undo().catch(() => {})
      throw error
    }
    if (input.showInSidebar !== undefined) await this.store.setChatHidden(target.id, !input.showInSidebar)
    if (!adoption) {
      this.push({ sidebar: true, chatIds: [target.id] })
    } else {
      if (adoption.formerParentChatId) {
        await this.tellFormerParent(adoption.formerParentChatId, target.id, adoption.owedFormerParent)
      }
      // Both task logs changed: the new parent's gained a row, the old one's lost it.
      this.push({
        sidebar: true,
        chatIds: [target.id, actorChatId, ...(adoption.formerParentChatId ? [adoption.formerParentChatId] : [])],
      })
    }
    return {
      ...this.summarize(this.requireChat(target.id)),
      started: sent.queuedMessageId === undefined,
      ...(sent.queuedMessageId === undefined ? {} : { queuedMessageId: sent.queuedMessageId }),
      // What it did with the title, so the agent sees whether it kept or changed it.
      titleChanged: previousTitle !== null,
      ...(!ownChat && title !== target.title ? { note: "Not renamed: it is not a sub-chat of this chat. Pass adopt: true to hand it work as yours, and title it." } : {}),
    }
  }

  /**
   * Whether the parent rule applies to what this chat does. Its running turn
   * decides: the agent hears of a flip on its next turn, and enforcing the
   * new flag sooner would hold it to what it was never told, or drop the
   * adoption its instructions promised it.
   */
  private isDelegating(chat: ChatRecord) {
    return this.agent.turnDelegator?.(chat.id) ?? Boolean(chat.delegator)
  }

  /**
   * Makes the actor the parent of a chat it did not start, ahead of the
   * message that hands it work. Null when it already is the parent.
   *
   * Any chat can be adopted, mid-turn or idle, in any project, the user's own
   * included: what an adopted chat keeps of its own life is in
   * `ChatRecord.adopted`. The one refusal is a chat above the actor, which
   * would close the parent chain into a loop.
   *
   * The depth limit and the live-chat budget are not checked. Both count
   * chats an agent created, and this creates none: the adopted chat, and
   * every chat under it, goes on counting against whichever conversation
   * created it.
   */
  private async adopt(actorChatId: string, target: ChatRecord, options?: { forced?: boolean }) {
    if (target.parentChatId === actorChatId) return null
    if (this.isParentOf(actorChatId, target.id)) {
      throw new Error(`Chat ${target.id} is above this chat in the chain of chats that started it, so adopting it would make a loop. ${options?.forced
        ? "This chat is a delegator, which adopts every chat it messages, so it cannot message that one. What this chat says when its turn ends is reported to it."
        : "Send the message without adopt."}`)
    }
    const former = {
      parent: target.parentChatId ? { parentChatId: target.parentChatId, adopted: Boolean(target.adopted) } : null,
      reportOwed: Boolean(target.reportOwed),
      reportedThrough: target.reportedThrough,
      hidden: Boolean(target.hidden),
    }
    await this.store.setChatParent(target.id, { parentChatId: actorChatId, adopted: true })
    // An adopted chat is listed, as it was when visibility followed the parent
    // link: one hidden under the parent that started it comes out from there.
    // `showInSidebar` on the same message can still hide it.
    await this.store.setChatHidden(target.id, false)
    // What it owed, and what it had already told, were the former parent's.
    // The new one starts with nothing heard, and a turn in flight was not its.
    await this.store.setReportOwed(target.id, false)
    this.owedTurns.delete(target.id)
    return {
      formerParentChatId: former.parent?.parentChatId,
      /** The former parent was still waiting for a result from this chat. */
      owedFormerParent: former.parent !== null && former.reportOwed,
      undo: async () => {
        await this.store.setChatParent(target.id, former.parent)
        await this.store.setChatHidden(target.id, former.hidden)
        if (!former.reportOwed) await this.store.setReportOwed(target.id, false)
        else if (former.reportedThrough === undefined) await this.store.setReportOwed(target.id, true)
        else await this.store.setReportedThrough(target.id, former.reportedThrough)
      },
    }
  }

  /**
   * The chat a sub-chat was adopted away from. A result it was still owed is
   * not coming, so it hears that now, as the report the result would have
   * been (`buildSection` writes the line). Then it is looked at again as a
   * chat that ran out of turns: it may have been waiting on this chat alone,
   * with a report of its own held back.
   */
  private async tellFormerParent(parentChatId: string, chatId: string, owed: boolean) {
    const chat = this.store.getChat(chatId)
    if (owed && chat) {
      await this.deliverInTurn(parentChatId, chatId, this.buildSection(parentChatId, chat)).catch((error) => {
        this.onError(`could not tell chat ${parentChatId} that sub-chat ${chatId} was adopted: ${errorMessage(error)}`)
      })
    }
    this.handleChatSettled(parentChatId)
  }

  /**
   * One chat's agent sending another a message. Returns the queue id when the
   * message is waiting behind a turn, and none when its own turn has started.
   */
  private async send(
    actorChatId: string,
    target: ChatRecord,
    content: string,
    run: ReturnType<ChatOrchestrator["resolveRun"]>,
    options: { report: boolean; steer?: boolean },
  ): Promise<{ queuedMessageId?: string }> {
    const source: MessageSource = { kind: "agent", chatId: actorChatId }
    // Marked before the turn starts: a turn that fails at once still ends, and
    // that end is what sends the report.
    if (options.report) await this.store.setReportOwed(target.id, true)
    try {
      if (options.steer) {
        const { provider, model, modelOptions, effort, planMode, autoPlan } = run
        // A steer either starts the message or throws, so nothing is left queued.
        await this.commands.enqueue(
          { type: "message.enqueue", chatId: target.id, content, provider, model, modelOptions, planMode, autoPlan, steer: true },
          { source, effort },
        )
        return {}
      }
      const sent = await this.commands.send({ type: "chat.send", chatId: target.id, content, ...run }, { source })
      return "queued" in sent.result ? { queuedMessageId: sent.result.queuedMessageId } : {}
    } catch (error) {
      if (options.report) await this.store.setReportOwed(target.id, false).catch(() => {})
      throw new Error(`Chat ${target.id} exists, but its turn did not start: ${errorMessage(error)}`)
    }
  }

  async cancelChat(actorChatId: string, chatId: string) {
    if (chatId === actorChatId) throw new Error("This would stop your own turn. Finish your reply instead.")
    const target = this.requireChat(chatId)
    // Whoever stops a sub-chat of its own already knows it ended, so no report.
    if (this.isParentOf(target.id, actorChatId)) {
      this.forgetLaterTurn(target.id)
      await this.store.setReportOwed(target.id, false)
    }
    await this.commands.cancel(target.id)
    this.push({ sidebar: true, chatIds: [target.id] })
    return this.summarize(this.requireChat(target.id))
  }

  async updateChat(actorChatId: string, input: {
    chatId?: string
    title?: string
    pinned?: boolean
    done?: boolean
    archived?: boolean
  }) {
    const chat = this.requireChat(input.chatId ?? actorChatId)
    if (input.title !== undefined && !input.title.trim()) throw new Error("The title cannot be empty.")
    const changes: Array<ChatChange | null> = []
    if (input.title !== undefined) changes.push((await this.commands.rename(chat.id, input.title)).changed)
    if (input.archived === false && chat.archivedAt) changes.push((await this.commands.unarchive(chat.id)).changed)
    if (input.pinned !== undefined) changes.push((await this.commands.setPinned(chat.id, input.pinned)).changed)
    if (input.done !== undefined) changes.push((await this.commands.setDone(chat.id, input.done)).changed)
    if (input.archived && !chat.archivedAt) changes.push((await this.commands.archive(chat.id)).changed)
    this.push({
      sidebar: true,
      localProjects: changes.some((change) => change?.localProjects),
      chatIds: [chat.id],
    })
    // An empty chat is deleted by archiving, so there may be nothing left to describe.
    const updated = this.store.getChat(chat.id)
    return updated ? this.summarize(updated) : { chatId: chat.id, deleted: true as const }
  }

  async updateQueuedMessage(input: { chatId: string; queuedMessageId: string; action: "remove" | "send_now" }) {
    const chat = this.requireChat(input.chatId)
    if (!this.store.getQueuedMessage(chat.id, input.queuedMessageId)) {
      throw new Error(`No queued message ${input.queuedMessageId} in chat ${chat.id}. read_chat lists its queue.`)
    }
    const outcome = input.action === "remove"
      ? await this.commands.dequeue({ type: "message.dequeue", chatId: chat.id, queuedMessageId: input.queuedMessageId })
      : await this.commands.steer({ type: "message.steer", chatId: chat.id, queuedMessageId: input.queuedMessageId })
    this.push(outcome.changed!)
    return this.summarize(this.requireChat(chat.id))
  }

  // ── Schedules ──────────────────────────────────────────────────────────

  async setSchedule(actorChatId: string, input: RunOptions & {
    scheduleId?: string
    name?: string
    message?: string
    chatId?: string
    newChat?: boolean
    projectId?: string
    inMinutes?: number
    runAt?: string
    everyMinutes?: number
    dailyAt?: string
    weekdays?: number[]
    enabled?: boolean
    maxRuns?: number
  }) {
    const caller = this.requireChat(actorChatId)
    const existing = input.scheduleId ? this.store.getSchedule(input.scheduleId) : null
    if (input.scheduleId && !existing) {
      throw new Error(`Schedule ${input.scheduleId} not found. list_schedules shows the schedules that exist.`)
    }
    const now = this.now()

    const trigger = this.parseTrigger(input, now) ?? existing?.trigger
    if (!trigger) throw new Error("Say when it runs: inMinutes, runAt, everyMinutes or dailyAt.")
    const content = input.message ?? existing?.content
    if (!content?.trim()) throw new Error("A schedule needs a message to send.")

    let target = existing?.target
    if (input.newChat) {
      const projectId = input.projectId ?? caller.projectId
      if (!this.store.getProject(projectId)) throw new Error(`Project ${projectId} not found. get_context lists the projects.`)
      target = { kind: "new_chat", projectId }
    } else if (input.chatId || !target) {
      target = { kind: "chat", chatId: this.requireChat(input.chatId ?? actorChatId).id }
    }

    // The message runs later with nobody to hold it to this chat's mode, so
    // a read-only chat can only schedule read-only work.
    const planning = this.agent.isPlanning(actorChatId)
    if (planning && input.planMode === false) {
      throw new Error("This chat is in plan mode, so what it schedules must run in plan mode too.")
    }
    // A new chat has no history to take its provider from, so it takes the
    // scheduling chat's. A message into an existing chat follows that chat.
    const inherit = !existing && target.kind === "new_chat"
    const provider = input.provider ?? existing?.provider ?? (inherit ? caller.provider ?? undefined : undefined)
    if (provider && !SERVER_PROVIDERS.some((entry) => entry.id === provider)) {
      throw new Error(`Unknown provider "${provider}". get_context lists the providers.`)
    }
    const model = input.model ?? existing?.model ?? (inherit && provider === caller.provider ? caller.lastModel : undefined)
    const planMode = planning ? true : input.planMode ?? existing?.planMode
    const triggerChanged = this.parseTrigger(input, now) !== null
    const enabled = input.enabled ?? existing?.enabled ?? true
    // A sub-chat timing its own next step, in a turn its parent will hear
    // about: the run is more of that work, so its turn is reported as well.
    const ownFollowUp = target.kind === "chat" && target.chatId === actorChatId
    const reportsToParent = ownFollowUp && (existing ? Boolean(existing.reportsToParent) : Boolean(caller.parentChatId && caller.reportOwed))
    const schedule: ChatSchedule = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name?.trim() || existing?.name || clip(content.trim().split("\n")[0]!, 60).text,
      content,
      target,
      trigger,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(input.effort ?? existing?.effort ? { effort: input.effort ?? existing?.effort } : {}),
      ...(planMode !== undefined ? { planMode } : {}),
      enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing ? (existing.createdByChatId ? { createdByChatId: existing.createdByChatId } : {}) : { createdByChatId: actorChatId }),
      ...(reportsToParent ? { reportsToParent: true as const } : {}),
      // Turning one back on, or giving it a new time, starts its clock again.
      nextRunAt: !enabled
        ? existing?.nextRunAt ?? null
        : triggerChanged || !existing || !existing.enabled || existing.nextRunAt == null
          ? computeFirstRun(trigger, now)
          : existing.nextRunAt,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastRunChatId ? { lastRunChatId: existing.lastRunChatId } : {}),
      runCount: existing?.runCount ?? 0,
      ...(input.maxRuns ?? existing?.maxRuns ? { maxRuns: input.maxRuns ?? existing?.maxRuns } : {}),
      ...(existing?.runs ? { runs: existing.runs } : {}),
    }
    if (schedule.enabled && schedule.nextRunAt == null) {
      throw new Error("That time has already passed, so the schedule would never run.")
    }
    await this.store.setSchedule(schedule)
    this.schedules.refresh()
    this.pushSchedule(schedule, existing)
    return this.describeSchedule(schedule)
  }

  private parseTrigger(
    input: { inMinutes?: number; runAt?: string; everyMinutes?: number; dailyAt?: string; weekdays?: number[] },
    now: number,
  ): ScheduleTrigger | null {
    const given = [input.inMinutes, input.runAt, input.everyMinutes, input.dailyAt].filter((value) => value !== undefined)
    if (given.length === 0) return null
    if (given.length > 1) throw new Error("Give one of inMinutes, runAt, everyMinutes or dailyAt, not several.")
    if (input.inMinutes !== undefined) return { kind: "once", at: now + input.inMinutes * 60_000 }
    if (input.runAt !== undefined) {
      const at = Date.parse(input.runAt)
      if (Number.isNaN(at)) throw new Error(`"${input.runAt}" is not a time. Use ISO 8601, such as 2026-01-31T09:00:00-08:00.`)
      return { kind: "once", at }
    }
    if (input.everyMinutes !== undefined) {
      return { kind: "interval", everyMs: Math.max(MIN_SCHEDULE_INTERVAL_MS, input.everyMinutes * 60_000) }
    }
    if (!parseTimeOfDay(input.dailyAt!)) throw new Error(`"${input.dailyAt}" is not a time of day. Use 24-hour HH:MM, such as 09:00.`)
    return { kind: "daily", timeOfDay: input.dailyAt!, ...(input.weekdays?.length ? { weekdays: input.weekdays } : {}) }
  }

  private describeSchedule(schedule: ChatSchedule) {
    return {
      scheduleId: schedule.id,
      name: schedule.name,
      message: schedule.content,
      target: schedule.target,
      trigger: schedule.trigger.kind === "once"
        ? { kind: "once", at: iso(schedule.trigger.at) }
        : schedule.trigger.kind === "interval"
          ? { kind: "interval", everyMinutes: schedule.trigger.everyMs / 60_000 }
          : schedule.trigger,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt == null ? null : iso(schedule.nextRunAt),
      ...(schedule.lastRunAt ? { lastRunAt: iso(schedule.lastRunAt) } : {}),
      ...(schedule.lastRunChatId ? { lastRunChatId: schedule.lastRunChatId } : {}),
      runCount: schedule.runCount,
      ...(schedule.maxRuns ? { maxRuns: schedule.maxRuns } : {}),
      ...(schedule.provider ? { provider: schedule.provider } : {}),
      ...(schedule.model ? { model: schedule.model } : {}),
      ...(schedule.planMode !== undefined ? { planMode: schedule.planMode } : {}),
      ...(schedule.createdByChatId ? { createdByChatId: schedule.createdByChatId } : {}),
    }
  }

  listSchedules(input: { chatId?: string; includeDisabled?: boolean }) {
    return {
      now: iso(this.now()),
      schedules: this.store.listSchedules()
        .filter((schedule) => input.includeDisabled || schedule.enabled)
        .filter((schedule) => !input.chatId || (schedule.target.kind === "chat" && schedule.target.chatId === input.chatId))
        .map((schedule) => this.describeSchedule(schedule)),
    }
  }

  async deleteSchedule(scheduleId: string) {
    const schedule = this.store.getSchedule(scheduleId)
    if (!schedule) {
      throw new Error(`Schedule ${scheduleId} not found. list_schedules shows the schedules that exist.`)
    }
    await this.store.deleteSchedule(scheduleId)
    this.schedules.refresh()
    this.pushSchedule(schedule)
    // The name too: the schedule is gone, and its card has nothing else to call it.
    return { deleted: scheduleId, name: schedule.name }
  }

  /**
   * Push the chats that list a schedule. A chat's snapshot carries the
   * schedules to do with it, so a change to one is a change to those chats.
   */
  private pushSchedule(...schedules: Array<ChatSchedule | null | undefined>) {
    const chatIds = new Set<string>()
    for (const schedule of schedules) {
      if (!schedule) continue
      if (schedule.target.kind === "chat") chatIds.add(schedule.target.chatId)
      if (schedule.createdByChatId) chatIds.add(schedule.createdByChatId)
      if (schedule.lastRunChatId) chatIds.add(schedule.lastRunChatId)
    }
    if (chatIds.size > 0) this.push({ chatIds: [...chatIds] })
  }

  /** Runs whatever is due now. For tests, which have no timers to wait on. */
  async runDueSchedules() {
    await this.schedules.tick()
  }

  private async fireSchedule(schedule: ChatSchedule): Promise<ScheduleFireResult> {
    const source: MessageSource = { kind: "schedule", scheduleId: schedule.id }
    if (schedule.target.kind === "chat") {
      const chat = this.store.getChat(schedule.target.chatId)
      if (!chat) return { outcome: "gone" }
      // The last run's message has not even started. A second copy behind it
      // would only pile up.
      const pending = this.store.getQueuedMessages(chat.id)
        .some((message) => message.source?.kind === "schedule" && message.source.scheduleId === schedule.id)
      if (pending) return { outcome: "skipped" }
      const provider = schedule.provider ?? chat.provider ?? undefined
      // Before the turn starts, like a parent's own message (`send`).
      const arms = Boolean(schedule.reportsToParent && chat.parentChatId && !chat.reportOwed)
      if (arms) await this.store.setReportOwed(chat.id, true)
      try {
        await this.commands.send({
          type: "chat.send",
          chatId: chat.id,
          content: schedule.content,
          provider,
          model: schedule.model ?? (provider === chat.provider ? chat.lastModel : undefined),
          modelOptions: !schedule.model && provider && provider === chat.provider
            ? inheritModelOptions(chat.lastModelOptions, provider, schedule.effort)
            : undefined,
          effort: schedule.effort,
          planMode: schedule.planMode ?? chat.planMode,
          autoPlan: chat.autoPlan,
        }, { source })
      } catch (error) {
        if (arms) await this.store.setReportOwed(chat.id, false).catch(() => {})
        throw error
      }
      return { outcome: "sent", chatId: chat.id }
    }

    if (!this.store.getProject(schedule.target.projectId)) return { outcome: "gone" }
    if (schedule.lastRunChatId && this.isLive(schedule.lastRunChatId)) return { outcome: "skipped" }
    const chatId = (await this.commands.create(schedule.target.projectId)).result.chatId
    await this.commands.rename(chatId, schedule.name)
    await this.commands.send({
      type: "chat.send",
      chatId,
      content: schedule.content,
      provider: schedule.provider,
      model: schedule.model,
      effort: schedule.effort,
      planMode: schedule.planMode,
    }, { source })
    return { outcome: "sent", chatId }
  }

  // ── Coordinator hooks ──────────────────────────────────────────────────

  /** A chat ran out of turns. Reports it, and any ancestor it was holding up. */
  handleChatSettled(chatId: string) {
    // What a reported sub-chat was watched for is over. Its end is not a
    // turn's start: a provider about to answer it has not begun to, so the
    // watch runs on for as long as a closing report would wait.
    if (this.laterTurns.get(chatId) === null && this.agent.getLeftRunning(chatId).length === 0) {
      const timer = setTimeout(() => {
        if (this.laterTurns.get(chatId) === timer) this.laterTurns.delete(chatId)
      }, this.closeOutGraceMs)
      timer.unref?.()
      this.laterTurns.set(chatId, timer)
    }
    const changed: string[] = []
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      void this.maybeReport(current.id)
      if (!current.parentChatId) break
      // The parent's task log lists this chat, so its status there just changed.
      changed.push(current.parentChatId)
      current = this.store.getChat(current.parentChatId)
    }
    if (changed.length > 0) this.push({ sidebar: true, chatIds: changed })
  }

  /**
   * A sub-chat's turn began. Its parent's task log shows that, and every chat
   * above it that was at rest is waiting on it from now. A turn that ended
   * just before it, owed and not yet reported, is reported now
   * (`reportEndedTurn`).
   */
  handleTurnStarted(chatId: string) {
    const endedTurnOwed = this.owedTurns.delete(chatId)
    const chat = this.store.getChat(chatId)
    let owed = Boolean(chat?.reportOwed)
    if (this.laterTurns.has(chatId)) {
      // The turn a sub-chat's shell was watched for, or one someone gave it
      // meanwhile. Either way its parent has not heard what it says.
      this.forgetLaterTurn(chatId)
      if (chat?.parentChatId) {
        owed = true
        void this.store.setReportOwed(chatId, true).catch((error) => {
          this.onError(`could not mark sub-chat ${chatId} as owing a report: ${errorMessage(error)}`)
        })
      }
    }
    if (owed && chat?.parentChatId) this.owedTurns.add(chatId)
    // The turn that ended is the one before this one.
    if (endedTurnOwed) void this.reportEndedTurn(chatId)
    this.pushChatsAbove(chatId)
  }

  /**
   * A task of the provider's began in a chat with no turn running, which puts
   * the chats above it in the same wait a turn starting would.
   */
  handleBackgroundWorkStarted(chatId: string) {
    this.pushChatsAbove(chatId)
  }

  private pushChatsAbove(chatId: string) {
    const above: string[] = []
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current?.parentChatId && !seen.has(current.id)) {
      seen.add(current.id)
      above.push(current.parentChatId)
      current = this.store.getChat(current.parentChatId)
    }
    if (above.length > 0) this.push({ sidebar: true, chatIds: above })
  }

  /**
   * Someone stopped this chat, so the chats it started stop too. They report
   * nothing: the parent that would read the report is the one being stopped.
   * Each cancel fires this again for the next level down.
   */
  handleChatStopped(chatId: string) {
    for (const child of this.childrenOf(chatId)) {
      this.forgetLaterTurn(child.id)
      if (child.adopted) {
        // Not this chat's to stop: its turn may be the user's. It only stops
        // owing a report, for the reason the others report nothing.
        this.owedTurns.delete(child.id)
        void this.store.setReportOwed(child.id, false).catch((error) => {
          this.onError(`could not release adopted chat ${child.id} from its report: ${errorMessage(error)}`)
        })
        continue
      }
      if (!this.isReportDue(child) && !this.isLive(child.id)) continue
      void (async () => {
        await this.store.setReportOwed(child.id, false)
        await this.agent.cancel(child.id)
      })().catch((error) => {
        this.onError(`could not stop sub-chat ${child.id}: ${errorMessage(error)}`)
      })
    }
  }

  /**
   * Sub-chats as rows in their parent's task log, next to the provider's own
   * subagents. Read from the store each time, so a restart loses nothing.
   */
  getChildActivities(chatId: string): SubagentActivity[] {
    const children = this.childrenOf(chatId)
    if (children.length === 0) return []
    const activities = children.map((child): SubagentActivity => {
      const status = this.statusOf(child)
      const running = isStillGoing(status) || status === "needs_input"
      return {
        id: `${SUBCHAT_TASK_PREFIX}${child.id}`,
        type: "chat",
        label: child.title,
        status: running ? "running" : status === "failed" ? "failed" : status === "completed" ? "completed" : "stopped",
        // Its latest turn, so a sub-chat sent a second message times that work
        // and not everything since it was created.
        startedAt: child.lastTurnStartedAt ?? child.createdAt,
        ...(running || child.lastTurnEndedAt == null ? {} : { endedAt: child.lastTurnEndedAt }),
        ...(status === "needs_input" ? { summary: "Waiting for your answer" } : {}),
        ...(running ? { stoppable: true } : {}),
        chatId: child.id,
      }
    })
    const running = activities.filter((activity) => activity.status === "running")
    const finished = activities
      .filter((activity) => activity.status !== "running")
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(0, TASK_LOG_CHATS - running.length))
    return [...running, ...finished]
  }

  /** Stops a sub-chat from its row in the parent's task log. False when the id is not one of ours. */
  async stopChildTask(chatId: string, taskId: string) {
    if (!taskId.startsWith(SUBCHAT_TASK_PREFIX)) return false
    const child = this.store.getChat(taskId.slice(SUBCHAT_TASK_PREFIX.length))
    if (!child || child.parentChatId !== chatId) return false
    await this.commands.cancel(child.id)
    return true
  }

  /**
   * Whether the message that starts this turn is one agent talking to
   * another, with no person there to answer a prompt.
   *
   * A message another chat's agent sent is. A report is not: it arrives in
   * the chat that handed the work out, where the user is. A schedule is when
   * an agent wrote it for another chat, or a sub-chat set it for itself as
   * more of the work its parent hears about (`reportsToParent`). One a chat
   * set for itself otherwise, or the user set, runs for the user.
   */
  isAgentToAgent(chatId: string, source?: MessageSource) {
    if (source?.kind === "agent") return true
    if (source?.kind !== "schedule") return false
    const schedule = this.store.getSchedule(source.scheduleId)
    if (!schedule) return false
    return Boolean(schedule.reportsToParent || (schedule.createdByChatId && schedule.createdByChatId !== chatId))
  }

  /**
   * Wire-only notes for the harness at the start of a turn: who sent the
   * prompt when it was not the user, and which sub-chats are still running.
   */
  buildTurnNotices(chatId: string, source?: MessageSource, turn?: AgentToAgentTurn): string[] {
    const notices: string[] = []
    // No person to answer a prompt in this turn. See `agent-to-agent.ts`.
    const agentNote = turn && this.isAgentToAgent(chatId, source) ? ` ${buildAgentToAgentNote(turn)}` : ""
    if (source?.kind === "agent") {
      const sender = this.store.getChat(source.chatId)
      const chat = this.store.getChat(chatId)
      const parentNote = chat?.parentChatId !== source.chatId
        ? ""
        : ` It ${chat.adopted ? "adopted" : "started"} this chat, and your final reply is sent back to it when you finish.`
      notices.push(`<system-message>This message was sent by the agent in Kanna chat "${sender?.title ?? "unknown"}" (chat id ${source.chatId}), not typed by the user.${parentNote}${agentNote}</system-message>`)
    } else if (source?.kind === "report") {
      notices.push("<system-message>This is Kanna reporting on chats you started, not a message from the user. Carry on with what you were doing for the user.</system-message>")
    } else if (source?.kind === "schedule") {
      const schedule = this.store.getSchedule(source.scheduleId)
      notices.push(`<system-message>This message was sent by the schedule "${schedule?.name ?? "unknown"}" (schedule id ${source.scheduleId}), not typed by the user just now.${agentNote}</system-message>`)
    }
    // An adopted chat is listed only while a result from it is still to come.
    const running = this.childrenOf(chatId).filter((child) => this.isLive(child.id) && (!child.adopted || this.isReportDue(child)))
    if (running.length > 0) {
      notices.push([
        "<system-message>Chats you started that are still running:",
        ...running.map((child) => `${child.title} (chat id ${child.id})`),
        "Each one's result arrives here as a message when it finishes. Stop any you no longer need with cancel_chat.</system-message>",
      ].join("\n"))
    }
    return notices
  }

  // ── Reports ────────────────────────────────────────────────────────────

  /**
   * The message a parent gets about finished sub-chats.
   *
   * Two readers, so two layers. The line saying which chat and how it ended
   * is for the agent: it goes in a `<system-message>` block, which every place
   * that shows a message leaves out (`stripSystemMessages`). What the sub-chat
   * said is for both, and is the only part the user sees. A rule separates
   * one sub-chat's words from the next, and only where both have some.
   *
   * Clients take the message apart again to draw one line per sub-chat
   * (`splitReportSections`). They rely on the block, on `(chat id …)` inside
   * it, and on the rule. They also read the word after `Sub-chat` (the line
   * says "replied", "failed", "needs input", or "still working" for a status
   * that is still going, and `adopted` draws a line of its own) and, for an adoption, the adopter's `(/chat/…)` link
   * followed by `, which adopted it`. A change to any of those is a change
   * there too.
   *
   * One section per report, written when the report is decided on, so it
   * holds the reply of the turn that earned it. A report that finds another
   * still waiting in the parent's queue is added to it (`deliverReport`), and
   * one sub-chat can then have a section for each turn, in order.
   *
   * The reply goes whole, up to `REPORT_TEXT_LIMIT`. `replyReported` is a
   * close-out after an interim report that already carried the same reply.
   */
  private buildSection(parentChatId: string, chat: ChatRecord, options?: { replyReported?: boolean }): ReportSection {
    // Adopted by another chat since this report was owed. The result goes
    // there now, so this parent gets the news instead, in the same shape.
    const adopter = chat.parentChatId && chat.parentChatId !== parentChatId ? this.store.getChat(chat.parentChatId) : null
    if (adopter) {
      return { header: `<system-message>\nSub-chat adopted: [${chat.title}](${chatLink(chat.id)}) (chat id ${chat.id}) now reports to the chat "${adopter.title}" (${chatLink(adopter.id)}), which adopted it. Its result will not arrive here. read_chat still reads it.\n</system-message>` }
    }
    const outcome = this.outcomeOf(chat)
    const lines = [`Sub-chat ${outcome.status}: [${chat.title}](${chatLink(chat.id)}) (chat id ${chat.id})`]
    const interim = this.interimNote(chat, outcome.status)
    if (interim) lines.push(interim)
    // Not waiting on anything, so this is its answer. What it left running
    // may still give it something to add (`laterTurns`).
    else {
      if (options?.replyReported && outcome.finalMessage) {
        lines.push("The work it was waiting on ended without giving it another turn, so the reply already reported here is its result.")
      }
      const left = describeLeftRunning(this.agent.getLeftRunning(chat.id))
      if (left) lines.push(`It left ${left} running in the background, which it is not waiting on. If that gives it another turn, that turn is reported here too.`)
    }
    for (const schedule of this.followUpSchedules(chat.id)) {
      lines.push(`It set itself the schedule "${schedule.name}", which next runs at ${iso(schedule.nextRunAt!)}. The turn each run starts is reported here too.`)
    }
    if (outcome.cut && !options?.replyReported) {
      const { index, textOffset, totalChars } = outcome.cut
      lines.push(`Its reply is ${totalChars.toLocaleString("en-US")} characters, more than a report carries, so only the first ${REPORT_TEXT_LIMIT.toLocaleString("en-US")} are below. read_chat reads the rest: ${JSON.stringify({ chatId: chat.id, after: index - 1, textOffset })}.`)
    }
    const header = `<system-message>\n${lines.join("\n")}\n</system-message>`
    if (!outcome.finalMessage || options?.replyReported) return { header }
    return { header, reply: outcome.finalMessage }
  }

  /**
   * What a report says, past the status, when it is not the sub-chat's last
   * word. The parent's agent reads the reply under it as a result otherwise.
   */
  private interimNote(chat: ChatRecord, status: AgentChatStatus) {
    if (status === "running") return "It went straight on into another turn, so what follows is the whole reply of the turn before. The new turn's report follows when it ends."
    if (!isStillGoing(status)) return null
    const waitingOn = status === "waiting_on_subagent"
      ? "work it handed to agents of its own (a subagent or a workflow)"
      : `chats under it: ${this.childrenOf(chat.id).filter((child) => this.holdsParent(child)).map((child) => `"${child.title}"`).join(", ")}`
    return `Not its last word. Its turn ended, and it is still waiting on ${waitingOn}. What follows is its reply so far. It reports again when its next turn ends.`
  }

  /** Schedules still to run whose turns this chat reports to its parent. See `ChatSchedule.reportsToParent`. */
  private followUpSchedules(chatId: string) {
    return [...this.store.state.schedulesById.values()].filter((schedule) => (
      schedule.reportsToParent
      && schedule.enabled
      && schedule.nextRunAt != null
      && schedule.target.kind === "chat"
      && schedule.target.chatId === chatId
    ))
  }

  /**
   * Sends a sub-chat's result to its parent when a turn of its own has ended
   * and no other is about to start.
   *
   * That is when the sub-chat has something to say, whether or not work it
   * handed off is still going. If it is, the report says so, and the flag
   * stays set: the turn that work wakes ends in a report too, and so on until
   * a turn ends with nothing left under it. `reportedThrough` marks the turn
   * the parent has, so the same reply is not sent twice in between.
   *
   * It travels as an ordinary message: the parent's turn starts if it is
   * idle, and it waits its turn in the queue otherwise. A report already
   * waiting there takes this one in, so five sub-chats finishing do not cost
   * the parent five turns.
   *
   * A turn that another starts straight after never settles the chat, so it
   * is not reported here but by `reportEndedTurn`.
   */
  private async maybeReport(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat?.reportOwed || !chat.parentChatId) {
      this.cancelCloseOut(chatId)
      return
    }
    if (this.reporting.has(chatId)) return
    const status = this.statusOf(chat)
    if (status === "running" || status === "needs_input") {
      this.cancelCloseOut(chatId)
      return
    }
    // A report from one of its own sub-chats is being written. It starts a
    // turn here, whose start reports this one (`reportEndedTurn`).
    if (this.childrenOf(chatId).some((child) => this.reporting.has(child.id))) return
    const waiting = isStillGoing(status)
    const through = chat.lastTurnEndedAt ?? 0
    if (chat.reportedThrough !== through) {
      this.cancelCloseOut(chatId)
    } else {
      // The parent has this reply, and more is coming.
      if (waiting) {
        this.cancelCloseOut(chatId)
        return
      }
      // The work it waited on ended without giving it another turn.
      if (!this.closeOutDue(chatId)) return
      this.cancelCloseOut(chatId)
    }
    const parentChatId = chat.parentChatId
    // Written now, from the turn that earned it, before anything can change.
    const section = this.buildSection(parentChatId, chat, { replyReported: chat.reportedThrough === through })
    // This report covers the turn that ended last. See `owedTurns`.
    this.owedTurns.delete(chatId)
    this.reporting.add(chatId)
    try {
      // Written before the send, so a failure cannot leave it to be sent twice.
      if (waiting) {
        await this.store.setReportedThrough(chatId, through)
      } else {
        await this.store.setReportOwed(chatId, false)
        this.watchForLaterTurn(chatId)
      }
      await this.deliverInTurn(parentChatId, chatId, section)
    } catch (error) {
      this.onError(`could not report sub-chat ${chatId} to its parent: ${errorMessage(error)}`)
    } finally {
      this.reporting.delete(chatId)
      // The parent's own report held back while this one was being written.
      void this.maybeReport(parentChatId)
    }
  }

  /**
   * Reports the turn that just ended when the next one started at once.
   *
   * A message waiting in a sub-chat's queue (most often its parent's
   * follow-up, sent while it was busy) starts the next turn the moment one
   * ends. The chat never settles in between, so `maybeReport` finds it
   * running, and the reply of the turn that ended would be lost: the next
   * report carries only the newer turn. So it goes up now, marked as one the
   * chat has gone on from, and `reportedThrough` keeps it from going twice.
   *
   * Only a turn that was owed when it started (`owedTurns`), so a parent
   * that queued a message behind someone else's turn does not get that
   * turn's reply. A turn that was stopped is not reported: whoever stopped
   * it knows, and a steer's new turn carries the same work on.
   */
  private async reportEndedTurn(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat?.reportOwed || !chat.parentChatId || this.reporting.has(chatId)) return
    if (chat.lastTurnOutcome === "cancelled") return
    const through = chat.lastTurnEndedAt ?? 0
    if (chat.reportedThrough === through) return
    const parentChatId = chat.parentChatId
    const section = this.buildSection(parentChatId, chat)
    this.reporting.add(chatId)
    try {
      await this.store.setReportedThrough(chatId, through)
      await this.deliverInTurn(parentChatId, chatId, section)
    } catch (error) {
      this.onError(`could not report sub-chat ${chatId} to its parent: ${errorMessage(error)}`)
    } finally {
      this.reporting.delete(chatId)
      // A turn end that came while this was being written was held back by it.
      void this.maybeReport(chatId)
      void this.maybeReport(parentChatId)
    }
  }

  /**
   * Whether a sub-chat that has nothing new to say, and nothing left to wait
   * on, has been that way long enough to tell its parent it is finished.
   *
   * Background work ending is not a turn ending. A provider that is about to
   * answer its finished task has not started that turn yet, and a report sent
   * now would close the account one reply early. So the first look starts a
   * clock and the report goes when it runs out with nothing changed. Work
   * that died without a word (a killed task, a restart) ends the same way.
   */
  private closeOutDue(chatId: string) {
    const pending = this.closeOuts.get(chatId)
    if (pending) return pending.ready
    const entry: { ready: boolean; timer?: ReturnType<typeof setTimeout> } = { ready: false }
    entry.timer = setTimeout(() => {
      entry.ready = true
      void this.maybeReport(chatId)
    }, this.closeOutGraceMs)
    entry.timer.unref?.()
    this.closeOuts.set(chatId, entry)
    return false
  }

  /** See `laterTurns`. Only a chat with something of its own still running has a later turn to watch for. */
  private watchForLaterTurn(chatId: string) {
    this.forgetLaterTurn(chatId)
    if (this.agent.getLeftRunning(chatId).length > 0) this.laterTurns.set(chatId, null)
  }

  private forgetLaterTurn(chatId: string) {
    const timer = this.laterTurns.get(chatId)
    if (timer) clearTimeout(timer)
    this.laterTurns.delete(chatId)
  }

  private cancelCloseOut(chatId: string) {
    const pending = this.closeOuts.get(chatId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.closeOuts.delete(chatId)
  }

  /**
   * One delivery at a time per parent: two sub-chats finishing together would
   * each miss the other's report in the queue and send two.
   */
  private deliverInTurn(parentChatId: string, chatId: string, section: ReportSection) {
    const previous = this.deliveries.get(parentChatId) ?? Promise.resolve()
    const delivery = previous.then(() => this.deliverReport(parentChatId, chatId, section))
    const tail = delivery.catch(() => {})
    this.deliveries.set(parentChatId, tail)
    void tail.then(() => {
      if (this.deliveries.get(parentChatId) === tail) this.deliveries.delete(parentChatId)
    })
    return delivery
  }

  private async deliverReport(parentChatId: string, chatId: string, section: ReportSection) {
    const parent = this.store.getChat(parentChatId)
    // A report to a chat the user put away would bring it back uninvited.
    if (!parent || parent.archivedAt) return
    let chatIds = [chatId]
    let before = ""
    const waiting = this.store.getQueuedMessages(parent.id).find((message) => message.source?.kind === "report")
    if (waiting?.source?.kind === "report") {
      // Added to, not rewritten: what it already says is a reply of its own,
      // and a sub-chat that reports again before the parent reads it would
      // otherwise lose the earlier one.
      const merged = [...new Set([...waiting.source.chatIds, chatId])]
      // If it is gone by now the parent's turn ended and took it, and those
      // results are already delivered.
      await this.store.removeQueuedMessage(parent.id, waiting.id).then(() => {
        chatIds = merged
        before = waiting.content
      }, () => {})
    }
    await this.commands.send({
      type: "chat.send",
      chatId: parent.id,
      content: appendReportSection(before, section),
      // The parent carries on as it was running: same model, options and mode.
      provider: parent.provider ?? undefined,
      model: parent.lastModel,
      modelOptions: parent.lastModelOptions,
      planMode: parent.planMode,
      autoPlan: parent.autoPlan,
    }, { source: { kind: "report", chatIds } })
    this.push({ sidebar: true, chatIds: [parent.id] })
  }
}

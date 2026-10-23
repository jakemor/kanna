import { Cause, Context, Deferred, Effect, Exit, type Fiber, FiberSet, Layer, Schema, Scope } from "effect"
import type {
  AgentProvider,
  ChatSchedule,
  MessageSource,
  ScheduleTrigger,
  SubagentActivity,
  TranscriptEntry,
} from "../shared/types"
import { stripSystemMessages } from "../shared/message-preview"
import { buildAgentToAgentNote, type AgentToAgentTurn } from "./agent-to-agent"
import { ChatAgent, type ChatAgentError } from "./chat-agent"
import { ChatCommands, type ChatChange } from "./chat-commands"
import {
  EventStore,
  type EventStoreFileError,
  type EventStoreNotFoundError,
  type EventStoreRejectedError,
} from "./event-store"
import type { ChatRecord } from "./events"
import { renderToolResultContent } from "./handoff"
import { getServerProviderCatalog, SERVER_PROVIDERS } from "./provider-catalog"
import {
  computeFirstRun,
  makeScheduleRunner,
  MIN_SCHEDULE_INTERVAL_MS,
  parseTimeOfDay,
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
 */

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

// ── Errors ───────────────────────────────────────────────────────────────
//
// The message of each is what the agent reads in its tool result, or the user
// in the client, word for word as before.

export class ChatNotFoundError extends Schema.TaggedError<ChatNotFoundError>()(
  "@kanna/server/orchestrator/ChatNotFoundError",
  { chatId: Schema.String },
) {
  override get message() {
    return `Chat ${this.chatId} not found. list_chats shows the chats that exist.`
  }
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "@kanna/server/orchestrator/ProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message() {
    return `Project ${this.projectId} not found. get_context lists the projects.`
  }
}

export class ScheduleNotFoundError extends Schema.TaggedError<ScheduleNotFoundError>()(
  "@kanna/server/orchestrator/ScheduleNotFoundError",
  { scheduleId: Schema.String },
) {
  override get message() {
    return `Schedule ${this.scheduleId} not found. list_schedules shows the schedules that exist.`
  }
}

/**
 * A rule refused the action, or its input does not say enough to act on.
 * `chatId` is the chat whose agent asked. Nothing was changed.
 */
export class ChatActionRefusedError extends Schema.TaggedError<ChatActionRefusedError>()(
  "@kanna/server/orchestrator/ChatActionRefusedError",
  { chatId: Schema.String, message: Schema.String },
) {}

/**
 * The chat a hand-off is for exists (it was created, forked or found), and the
 * message that would start its turn did not go.
 */
export class TurnNotStartedError extends Schema.TaggedError<TurnNotStartedError>()(
  "@kanna/server/orchestrator/TurnNotStartedError",
  {
    chatId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Chat ${this.chatId} exists, but its turn did not start: ${errorMessage(this.cause)}`
  }
}

type StoreError = EventStoreNotFoundError | EventStoreFileError
/** Every way an agent's write can fail. */
export type ChatWriteError =
  | ChatNotFoundError
  | ProjectNotFoundError
  | ScheduleNotFoundError
  | ChatActionRefusedError
  | TurnNotStartedError
  | StoreError
  | EventStoreRejectedError
  | ChatAgentError
/** A read of a chat that may not exist. */
type ChatReadError = ChatNotFoundError

// ── Shapes ───────────────────────────────────────────────────────────────

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

export interface ReadChatInput {
  chatId: string
  after?: number
  before?: number
  textOffset?: number
  lastTurns?: number
  kinds?: ReadChatKind[]
  limit?: number
}

export interface ReadChatResult {
  chat: AgentChatSummary
  subchats: AgentChatSummary[]
  queue: Array<{ queuedMessageId: string; text: string; truncated?: true; from?: MessageSource }>
  entries: ReadChatEntry[]
  transcriptEntries: number
  next?: ReadChatPosition
  earlier?: ReadChatPosition
}

export interface ListChatsInput {
  projectId?: string
  query?: string
  status?: AgentChatStatus
  parentChatId?: string
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export interface OrchestratorContext {
  now: string
  timeZone: string
  chat: AgentChatSummary & { projectPath?: string }
  projects: Array<{ projectId: string; title: string; path: string }>
  providers: Array<{
    provider: AgentProvider
    label: string
    defaultModel: string
    models: string[]
    efforts: string[]
    supportsPlanMode: boolean
  }>
  limits: { maxDepth: number; maxLiveChats: number }
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

export interface RunOptions {
  provider?: AgentProvider
  model?: string
  effort?: string
  planMode?: boolean
}

export type CreateChatInput = RunOptions & {
  message: string
  /** The work it does. Required by the tool; the user's own creations may have none. */
  title?: string
  projectId?: string
  subchat?: boolean
}

export type ForkChatInput = RunOptions & {
  chatId?: string
  message?: string
  /** The new work's. A fork is how a chat's context is reused for new work, so the tool requires one. */
  title?: string
  subchat?: boolean
}

export type SendMessageInput = RunOptions & {
  chatId: string
  message: string
  /**
   * What the chat works on: its title unchanged for a follow-up on its own
   * work, a new one when it is reused for new work. The tool requires it,
   * so keeping it is a choice; none keeps it too. Applied to this chat's
   * own sub-chats only; see `sendMessage`.
   */
  title?: string
  delivery?: "queue" | "steer"
  adopt?: boolean
}

export interface UpdateChatInput {
  chatId?: string
  title?: string
  pinned?: boolean
  done?: boolean
  archived?: boolean
}

export type SetScheduleInput = RunOptions & {
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
}

export type ScheduleDescription = ReturnType<typeof describeSchedule>

// ── Pure helpers ─────────────────────────────────────────────────────────

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

function chatLink(chatId: string) {
  return `/chat/${chatId}`
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

function describeSchedule(schedule: ChatSchedule) {
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

/** Runs `effect`, and logs and drops a failure with `what` ahead of its message: what `.catch(onError)` was. */
const warnOnFailure = (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.tapError((error) => Effect.logWarning(`${what}: ${errorMessage(error)}`)),
    Effect.ignore,
  )

// ── The service ──────────────────────────────────────────────────────────

/**
 * The orchestrator: the agents' side of chat management. Sub-chats and
 * their reports, adoption, delegators, schedules.
 *
 * Reads of memory (`getChatsWaitingOnSubchats`, `getChildActivities`, …)
 * answer synchronously, as the store's do: the coordinator asks them on
 * every push. Everything that can fail is an Effect. The coordinator's hooks
 * (`handle*`) never wait: what they start runs in the background, from the
 * moment they are called up to its first wait, as the old `void` calls did,
 * and is stopped with the layer.
 */
export class Orchestrator extends Context.Service<Orchestrator, {
  /**
   * Arms the schedules and sends any report a restart interrupted: a sub-chat
   * that finished just before the process went down still owes its parent.
   */
  readonly start: Effect.Effect<void>
  /**
   * Stops the schedule timer, the boot sweep and the grace timers, as the old
   * `dispose` did, ahead of the layer's close: shutdown calls it before it
   * interrupts the turns. Reports already being written finish. Closing the
   * layer does this too.
   */
  readonly stop: Effect.Effect<void>

  // Reads
  readonly countSubchatsHolding: (chatId: string) => number
  readonly getChatsWaitingOnSubchats: (unsettled: Iterable<string>) => Set<string>
  readonly getChildActivities: (chatId: string) => SubagentActivity[]
  readonly isAgentToAgent: (chatId: string, source?: MessageSource) => boolean
  readonly buildTurnNotices: (chatId: string, source?: MessageSource, turn?: AgentToAgentTurn) => Effect.Effect<string[]>
  readonly getContext: (actorChatId: string) => Effect.Effect<OrchestratorContext, ChatReadError>
  readonly listChats: (input: ListChatsInput) => Effect.Effect<{ total: number; chats: AgentChatSummary[]; nextOffset?: number }>
  readonly readChat: (input: ReadChatInput) => Effect.Effect<ReadChatResult, ChatReadError>
  readonly listSchedules: (input: { chatId?: string; includeDisabled?: boolean }) => Effect.Effect<{ now: string; schedules: ScheduleDescription[] }>

  // Writes, for an agent
  readonly createChat: (actorChatId: string, input: CreateChatInput) => Effect.Effect<AgentChatSummary, ChatWriteError>
  readonly forkChat: (actorChatId: string, input: ForkChatInput) => Effect.Effect<AgentChatSummary, ChatWriteError>
  /**
   * `titleChanged` says what it did with `title`, so the agent sees whether
   * it kept or changed it; `note` when a title was passed for a chat that is
   * not a sub-chat of the actor, and so left as it was.
   */
  readonly sendMessage: (
    actorChatId: string,
    input: SendMessageInput,
  ) => Effect.Effect<AgentChatSummary & { started: boolean; queuedMessageId?: string; titleChanged: boolean; note?: string }, ChatWriteError>
  readonly cancelChat: (actorChatId: string, chatId: string) => Effect.Effect<AgentChatSummary, ChatWriteError>
  readonly updateChat: (
    actorChatId: string,
    input: UpdateChatInput,
  ) => Effect.Effect<AgentChatSummary | { chatId: string; deleted: true }, ChatWriteError>
  readonly updateQueuedMessage: (
    input: { chatId: string; queuedMessageId: string; action: "remove" | "send_now" },
  ) => Effect.Effect<AgentChatSummary, ChatWriteError>
  readonly setSchedule: (actorChatId: string, input: SetScheduleInput) => Effect.Effect<ScheduleDescription, ChatWriteError>
  readonly deleteSchedule: (scheduleId: string) => Effect.Effect<{ deleted: string; name: string }, ScheduleNotFoundError | StoreError>
  /** Runs whatever is due now. For tests, which have no timers to wait on. */
  readonly runDueSchedules: Effect.Effect<void, EventStoreFileError>

  // The coordinator's hooks. None waits; see the class comment.
  /** A chat ran out of turns. Reports it, and any ancestor it was holding up. */
  readonly handleChatSettled: (chatId: string) => Effect.Effect<void>
  /**
   * A sub-chat's turn began. Its parent's task log shows that, and every chat
   * above it that was at rest is waiting on it from now. A turn that ended
   * just before it, owed and not yet reported, is reported now.
   */
  readonly handleTurnStarted: (chatId: string) => Effect.Effect<void>
  /**
   * A task of the provider's began in a chat with no turn running, which puts
   * the chats above it in the same wait a turn starting would.
   */
  readonly handleBackgroundWorkStarted: (chatId: string) => Effect.Effect<void>
  /**
   * Someone stopped this chat, so the chats it started stop too. They report
   * nothing: the parent that would read the report is the one being stopped.
   * Each cancel fires this again for the next level down.
   */
  readonly handleChatStopped: (chatId: string) => Effect.Effect<void>
  /** Stops a sub-chat from its row in the parent's task log. False when the id is not one of ours. */
  readonly stopChildTask: (chatId: string, taskId: string) => Effect.Effect<boolean, ChatAgentError>
}>()("@kanna/server/Orchestrator") {
  static readonly layer = (options: OrchestratorOptions) => Layer.effect(this, makeOrchestrator(options))
}

export interface OrchestratorOptions {
  /** Push the snapshots an action changed. */
  readonly push: (change: ChatChange) => void
  readonly now?: () => number
  /** Tests shorten it. See `CLOSE_OUT_GRACE_MS`. */
  readonly closeOutGraceMs?: number
}

/** Builds the orchestrator over the store, the coordinator and the chat commands in context. */
const makeOrchestrator = Effect.fn("Orchestrator.make")(function* (options: OrchestratorOptions) {
  const store = yield* EventStore
  const agent = yield* ChatAgent
  const commands = yield* ChatCommands
  const push = options.push
  const now = options.now ?? Date.now
  const closeOutGraceMs = options.closeOutGraceMs ?? CLOSE_OUT_GRACE_MS

  /** What runs on its own: reports, timers. Interrupted when the layer closes. */
  const fibers = yield* FiberSet.make()
  /**
   * Starts `effect` without waiting for it, as `void promise` did: it runs at
   * once up to its first wait. Every one handles its own failures.
   */
  const background = <A, R>(effect: Effect.Effect<A, never, R>) =>
    FiberSet.run(fibers, effect, { startImmediately: true })

  /** Reports being written, so two turn ends in a row send one. */
  const reporting = new Set<string>()
  /** The last report delivery under way per parent, for the next one to follow. */
  const deliveries = new Map<string, Deferred.Deferred<void>>()
  /**
   * Sub-chats whose report is in, with a shell or a monitor of their own still
   * running. Such a chat is not waiting on anything, so it owes nothing and
   * holds nobody. But a shell can give it another turn when it ends, and a
   * monitor each time it fires, and that turn is its parent's to hear of: a
   * turn starting in one of these owes a report again. When that turn's
   * report goes with the monitor still running, the chat is watched again.
   * The value holds the timer that drops the entry, set once nothing is left
   * running (see `handleChatSettled`); null until then.
   *
   * In memory only. A restart ends the provider's session and its tasks with
   * it, so there is no later turn left to watch for.
   */
  const laterTurns = new Map<string, { timer?: Fiber.Fiber<unknown> } | null>()
  /**
   * Sub-chats whose latest turn started while they owed their parent a
   * report, until a report covers it. The turn that starts next looks here to
   * know whether the one before it was the parent's to hear (`reportEndedTurn`).
   *
   * In memory only. A restart resumes a turn, and its start sets this again.
   */
  const owedTurns = new Set<string>()
  /** Sub-chats waiting out `closeOutGraceMs` before their last report. See `closeOutDue`. */
  const closeOuts = new Map<string, { ready: boolean; timer?: Fiber.Fiber<unknown> }>()
  let childIndex: { version: number; byParent: Map<string, ChatRecord[]> } | null = null
  let bootSweep: Fiber.Fiber<unknown> | null = null

  // ── State ──────────────────────────────────────────────────────────────

  function childrenOf(chatId: string): ChatRecord[] {
    const version = store.stateVersion
    if (childIndex?.version !== version) {
      const byParent = new Map<string, ChatRecord[]>()
      for (const chat of store.state.chatsById.values()) {
        if (!chat.parentChatId || chat.deletedAt) continue
        const siblings = byParent.get(chat.parentChatId)
        if (siblings) siblings.push(chat)
        else byParent.set(chat.parentChatId, [chat])
      }
      childIndex = { version, byParent }
    }
    return childIndex.byParent.get(chatId) ?? []
  }

  /** A turn of the chat's own is running, about to run, or still closing its stream. */
  function hasTurnInFlight(chat: ChatRecord) {
    // Cut short by a shutdown and about to be picked back up.
    if (chat.resumePending) return true
    if (agent.isBusy(chat.id) || agent.isDraining(chat.id)) return true
    // A queue normally drains as soon as the turn ends, so messages in it mean
    // a turn is about to start. The exception is a stopped chat, whose queue
    // is parked until someone sends again.
    const queued = store.getQueuedMessages(chat.id).length
    return queued > 0 && chat.lastTurnOutcome !== "cancelled"
  }

  /**
   * The chat itself has nothing running and nothing about to run. Says nothing
   * of its sub-chats. A shell or a monitor it left running does not keep it
   * from this: neither is work the chat is waiting on (`laterTurns` covers
   * what they may wake).
   */
  function isSelfSettled(chat: ChatRecord) {
    return !hasTurnInFlight(chat) && !agent.hasDelegatedWork(chat.id)
  }

  /** A chat this one started is still going, or has a report on its way here. */
  function hasLiveSubchats(chatId: string) {
    return childrenOf(chatId).some((child) => holdsParent(child))
  }

  /**
   * Whether this sub-chat keeps its parent from being finished. One the
   * parent started does for as long as it works. An adopted one has turns its
   * parent never asked for (the user typing in it), so it holds the parent
   * only until the report it owes is in.
   */
  function holdsParent(child: ChatRecord, seen?: Set<string>): boolean {
    if (isReportDue(child)) return true
    return !child.adopted && isLive(child.id, seen)
  }

  /**
   * Work is still going in this chat or under it. A sub-chat that has finished
   * but not yet reported counts: its report is about to start a turn here.
   */
  function isLive(chatId: string, seen = new Set<string>()): boolean {
    if (seen.has(chatId)) return false
    seen.add(chatId)
    const chat = store.getChat(chatId)
    if (!chat) return false
    if (!isSelfSettled(chat)) return true
    return childrenOf(chatId).some((child) => holdsParent(child, seen))
  }

  /**
   * A report from this sub-chat is owed or on its way. "On its way" matters:
   * the flag is cleared before the message is queued, and in between the
   * parent would otherwise look finished to a chat above it.
   */
  function isReportDue(child: ChatRecord) {
    return Boolean(child.reportOwed) || reporting.has(child.id)
  }

  function statusOf(chat: ChatRecord): AgentChatStatus {
    if (agent.getActiveStatuses().get(chat.id) === "waiting_for_user") return "needs_input"
    if (hasTurnInFlight(chat)) return "running"
    if (agent.hasDelegatedWork(chat.id)) return "waiting_on_subagent"
    if (hasLiveSubchats(chat.id)) return "waiting_on_subchats"
    if (chat.lastTurnOutcome === "success") return "completed"
    if (chat.lastTurnOutcome === "failed") return "failed"
    if (chat.lastTurnOutcome === "cancelled") return "cancelled"
    return "idle"
  }

  function summarize(chat: ChatRecord): AgentChatSummary {
    return {
      chatId: chat.id,
      title: chat.title,
      link: chatLink(chat.id),
      projectId: chat.projectId,
      status: statusOf(chat),
      provider: chat.provider,
      ...(chat.lastModel ? { model: chat.lastModel } : {}),
      planMode: chat.planMode,
      ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
      ...(chat.adopted ? { adopted: true as const } : {}),
      ...(chat.delegator ? { delegator: true as const } : {}),
      ...(chat.forkedFromChatId ? { forkedFromChatId: chat.forkedFromChatId } : {}),
      ...(chat.createdByChatId ? { createdByChatId: chat.createdByChatId } : {}),
      ...(chat.lastMessageAt ? { lastMessageAt: iso(chat.lastMessageAt) } : {}),
      turnCount: chat.turnCount ?? 0,
      queuedMessages: store.getQueuedMessages(chat.id).length,
      ...(chat.archivedAt ? { archived: true as const } : {}),
      ...(chat.pinnedAt ? { pinned: true as const } : {}),
      ...(chat.doneAt ? { done: true as const } : {}),
      ...(chat.unread ? { unread: true as const } : {}),
    }
  }

  const requireChat = (chatId: string): Effect.Effect<ChatRecord, ChatNotFoundError> => Effect.suspend(() => {
    const chat = store.getChat(chatId)
    return chat ? Effect.succeed(chat) : Effect.fail(new ChatNotFoundError({ chatId }))
  })

  const refuse = (chatId: string, message: string) => Effect.fail(new ChatActionRefusedError({ chatId, message }))

  /**
   * Keeps a chat's transcript loaded for the reads that follow, until the
   * caller's scope closes. A transcript that can't be read dies, as the
   * synchronous read it replaces threw.
   */
  const holdTranscript = (chatId: string) => store.retainTranscript(chatId).pipe(Effect.orDie)

  /** `f`, run with the chat's transcript loaded. */
  const withTranscript = <A>(chatId: string, f: () => A) =>
    Effect.scoped(holdTranscript(chatId).pipe(Effect.andThen(Effect.sync(f))))

  function tailEntries(chatId: string, count = TAIL_ENTRIES): { entries: TranscriptEntry[]; startIndex: number } {
    const start = Math.max(0, store.getTranscriptLength(chatId) - count)
    const transcript = store.getClientTranscript(chatId, start)
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
  function outcomeOf(chat: ChatRecord): ChatOutcome {
    const status = statusOf(chat)
    const outcome: ChatOutcome = { chatId: chat.id, title: chat.title, link: chatLink(chat.id), status }
    // Its reply is not in yet: the turn is parked on a question.
    if (status === "needs_input") return outcome
    const { entries, startIndex } = tailEntries(chat.id)
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
  function creationChain(chatId: string): ChatRecord[] {
    const chain: ChatRecord[] = []
    const seen = new Set<string>()
    let current = store.getChat(chatId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.push(current)
      current = current.createdByChatId ? store.getChat(current.createdByChatId) : null
    }
    return chain
  }

  /**
   * Refuses a new chat that would nest too deep or run too many at once.
   * Both are counted from the chat the user started, across every chat the
   * agents under it created, so a sub-chat cannot get round a limit by
   * starting chats of its own.
   */
  const checkBudget = (actorChatId: string) => Effect.suspend(() => {
    const chain = creationChain(actorChatId)
    if (chain.length > MAX_CHAT_DEPTH) {
      return refuse(actorChatId, `Chats started by agents can nest ${MAX_CHAT_DEPTH} deep, and this chat is already at that depth. Do the work here instead.`)
    }
    const rootId = chain[chain.length - 1]!.id
    let live = 0
    for (const chat of store.state.chatsById.values()) {
      if (chat.deletedAt || !chat.createdByChatId || chat.id === rootId) continue
      const chatChain = creationChain(chat.id)
      if (chatChain[chatChain.length - 1]!.id === rootId && isLive(chat.id)) live += 1
    }
    if (live >= MAX_LIVE_CHATS) {
      return refuse(actorChatId, `${live} chats started from this conversation are still running, which is the limit. End this turn, and the next one to finish wakes this chat with its report and frees a place. Or stop one with cancel_chat.`)
    }
    return Effect.void
  })

  function isParentOf(chatId: string, ancestorId: string) {
    const seen = new Set<string>()
    let current = store.getChat(chatId)
    while (current?.parentChatId && !seen.has(current.id)) {
      if (current.parentChatId === ancestorId) return true
      seen.add(current.id)
      current = store.getChat(current.parentChatId)
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
  const resolveRun = (
    actorChatId: string,
    requested: RunOptions,
    defaults: { provider: AgentProvider | null; model?: string; planMode: boolean; autoPlan: boolean },
  ) => Effect.suspend(() => {
    const provider = requested.provider ?? defaults.provider ?? "claude"
    if (!SERVER_PROVIDERS.some((entry) => entry.id === provider)) {
      return refuse(actorChatId, `Unknown provider "${provider}". get_context lists the providers.`)
    }
    const catalog = getServerProviderCatalog(provider)
    const sameProvider = provider === defaults.provider
    const planning = agent.isPlanning(actorChatId)
    if (planning && !catalog.supportsPlanMode) {
      return refuse(actorChatId, `This chat is in plan mode, and ${catalog.label} has no read-only mode to match it. Pick a provider with plan mode.`)
    }
    if (planning && requested.planMode === false) {
      return refuse(actorChatId, "This chat is in plan mode, so a chat it starts or messages must be in plan mode too.")
    }
    return Effect.succeed({
      provider,
      // A model belongs to its provider, so a default is not carried across a switch.
      model: requested.model ?? (sameProvider ? defaults.model : undefined),
      effort: requested.effort,
      planMode: catalog.supportsPlanMode && (planning || (requested.planMode ?? defaults.planMode)),
      autoPlan: sameProvider && catalog.supportsAutoPlanMode ? defaults.autoPlan : false,
    })
  })

  type ResolvedRun = Effect.Success<ReturnType<typeof resolveRun>>

  // ── Reads ──────────────────────────────────────────────────────────────

  const getContext = Effect.fn("Orchestrator.getContext")(function* (actorChatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    const chat = yield* requireChat(actorChatId)
    const project = store.getProject(chat.projectId)
    return {
      now: iso(now()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      chat: { ...summarize(chat), projectPath: project?.localPath },
      projects: store.listProjects().map((entry) => ({
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
  })

  const listChats = (input: ListChatsInput) => Effect.sync(() => {
    const query = input.query?.trim().toLowerCase()
    const matches: AgentChatSummary[] = []
    const chats = [...store.state.chatsById.values()]
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
      const summary = summarize(chat)
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
  })

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
  const readChat = Effect.fn("Orchestrator.readChat")(function* (input: ReadChatInput) {
    yield* Effect.annotateCurrentSpan("chatId", input.chatId)
    const chat = yield* requireChat(input.chatId)
    yield* holdTranscript(chat.id)
    const limit = input.limit ?? 40
    const kinds = new Set<ReadChatKind>(input.kinds?.length ? input.kinds : DEFAULT_READ_KINDS)
    const total = store.getTranscriptLength(chat.id)
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
    let rows = readableRows(chat, !forward ? tail : input.lastTurns ? Math.min(lower, tail) : lower)
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
      rows = readableRows(chat, 0)
      selected = select()
    }
    const { candidates } = selected
    const page = forward ? candidates.slice(0, limit) : candidates.slice(-limit)

    // Tool bodies live in the sidecar. One read for the whole page.
    const toolIds = page.filter((row) => row.kind === "tool_call" || row.kind === "tool_result").map((row) => row.entry._id)
    const whole = new Map((yield* store.readEntriesById(chat.id, toolIds).pipe(Effect.orDie)).map((entry) => [entry._id, entry]))
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
      chat: summarize(chat),
      subchats: childrenOf(chat.id).map((child) => summarize(child)),
      queue: store.getQueuedMessages(chat.id).map((message) => {
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
  }, Effect.scoped)

  /**
   * The transcript from `fromIndex` to its end, as rows `read_chat` can
   * return. Always to the end, because whether an `assistant_text` is its
   * turn's reply depends on what follows it.
   */
  function readableRows(chat: ChatRecord, fromIndex: number) {
    const transcript = store.getClientTranscript(chat.id, fromIndex)
    const rows: ReadableRow[] = []
    // Walked from the end: text is final when its turn ended before more text
    // came. At the very end that is only so when no turn is running.
    let closed = !hasTurnInFlight(chat)
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

  const createChat = Effect.fn("Orchestrator.createChat")(function* (actorChatId: string, input: CreateChatInput) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    const caller = yield* requireChat(actorChatId)
    // A delegator's chats are always under it. See the note at the top.
    const subchat = caller.delegator ? true : input.subchat ?? true
    const projectId = input.projectId ?? caller.projectId
    if (!store.getProject(projectId)) return yield* new ProjectNotFoundError({ projectId })
    yield* checkBudget(actorChatId)
    const run = yield* resolveRun(actorChatId, input, {
      provider: caller.provider,
      model: caller.lastModel,
      planMode: false,
      autoPlan: false,
    })

    const created = yield* commands.create(projectId, {
      createdByChatId: actorChatId,
      ...(subchat ? { parentChatId: actorChatId } : {}),
    })
    const chat = yield* requireChat(created.result.chatId)
    if (input.title?.trim()) yield* commands.rename(chat.id, input.title)
    yield* send(actorChatId, chat, input.message, run, { report: subchat })
    push(created.changed!)
    return summarize(yield* requireChat(chat.id))
  })

  const forkChat = Effect.fn("Orchestrator.forkChat")(function* (actorChatId: string, input: ForkChatInput) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    const source = yield* requireChat(input.chatId ?? actorChatId)
    const caller = yield* requireChat(actorChatId)
    // A fork handed work is delegation, so it reports back unless told not to.
    // A delegator's fork is under it either way.
    const subchat = caller.delegator ? true : input.subchat ?? Boolean(input.message)
    yield* checkBudget(actorChatId)
    const forked = yield* commands.fork(source.id, {
      createdByChatId: actorChatId,
      ...(subchat ? { parentChatId: actorChatId } : {}),
    })
    const chat = yield* requireChat(forked.result.chatId)
    if (input.title?.trim()) yield* commands.rename(chat.id, input.title.trim())
    if (input.message) {
      const run = yield* resolveRun(actorChatId, input, {
        provider: chat.provider,
        model: source.lastModel,
        planMode: chat.planMode,
        autoPlan: chat.autoPlan,
      })
      yield* send(actorChatId, chat, input.message, run, { report: subchat })
    }
    push({ ...forked.changed, chatIds: [chat.id] })
    return summarize(yield* requireChat(chat.id))
  })

  const sendMessage = Effect.fn("Orchestrator.sendMessage")(function* (actorChatId: string, input: SendMessageInput) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    yield* Effect.annotateCurrentSpan("targetChatId", input.chatId)
    if (input.chatId === actorChatId) {
      return yield* refuse(actorChatId, "A chat cannot message itself. Use set_schedule to send this chat a message later.")
    }
    const target = yield* requireChat(input.chatId)
    const run = yield* resolveRun(actorChatId, input, {
      provider: target.provider,
      model: target.lastModel,
      planMode: target.planMode,
      autoPlan: target.autoPlan,
    })
    // Before the send: the turn it starts is told who its parent is, and the
    // report it earns is addressed by the link.
    const delegating = Boolean((yield* requireChat(actorChatId)).delegator)
    const adoption = input.adopt || delegating ? yield* adopt(actorChatId, target, { forced: delegating && !input.adopt }) : null
    // Named for the work it is given, before the message lands, so the
    // sidebar says what it is doing from the start. Only a chat of this
    // one's: one it started, or adopts here. A message to anyone else's chat,
    // the user's own among them, leaves its name alone. One adopted is
    // renamed even while the user has it open: the server cannot tell.
    const title = input.title?.trim() || target.title
    const ownChat = (yield* requireChat(target.id)).parentChatId === actorChatId
    const previousTitle = ownChat && title !== target.title ? target.title : null
    if (previousTitle !== null) {
      yield* commands.rename(target.id, title)
      push({ sidebar: true, chatIds: [target.id] })
    }
    const sent = yield* Effect.gen(function* () {
      return yield* send(actorChatId, target, input.message, run, {
        // Only its own parent is owed a sub-chat's result.
        report: (yield* requireChat(target.id)).parentChatId === actorChatId,
        steer: input.delivery === "steer",
      })
    }).pipe(
      // The caller is told the send failed, so nothing of it may remain.
      Effect.tapError(() => Effect.gen(function* () {
        if (previousTitle !== null) yield* Effect.ignore(commands.rename(target.id, previousTitle))
        if (adoption) yield* Effect.ignore(adoption.undo)
      })),
    )
    if (!adoption) {
      push({ sidebar: true, chatIds: [target.id] })
    } else {
      if (adoption.formerParentChatId) {
        yield* tellFormerParent(adoption.formerParentChatId, target.id, adoption.owedFormerParent)
      }
      // Both task logs changed: the new parent's gained a row, the old one's lost it.
      push({
        sidebar: true,
        chatIds: [target.id, actorChatId, ...(adoption.formerParentChatId ? [adoption.formerParentChatId] : [])],
      })
    }
    return {
      ...summarize(yield* requireChat(target.id)),
      started: sent.queuedMessageId === undefined,
      ...(sent.queuedMessageId === undefined ? {} : { queuedMessageId: sent.queuedMessageId }),
      // What it did with the title, so the agent sees whether it kept or changed it.
      titleChanged: previousTitle !== null,
      ...(!ownChat && title !== target.title ? { note: "Not renamed: it is not a sub-chat of this chat. Pass adopt: true to hand it work as yours, and title it." } : {}),
    }
  })

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
  const adopt = Effect.fn("Orchestrator.adopt")(function* (actorChatId: string, target: ChatRecord, options?: { forced?: boolean }) {
    if (target.parentChatId === actorChatId) return null
    if (isParentOf(actorChatId, target.id)) {
      return yield* refuse(actorChatId, `Chat ${target.id} is above this chat in the chain of chats that started it, so adopting it would make a loop. ${options?.forced
        ? "This chat is a delegator, which adopts every chat it messages, so it cannot message that one. What this chat says when its turn ends is reported to it."
        : "Send the message without adopt."}`)
    }
    const former = {
      parent: target.parentChatId ? { parentChatId: target.parentChatId, adopted: Boolean(target.adopted) } : null,
      reportOwed: Boolean(target.reportOwed),
      reportedThrough: target.reportedThrough,
    }
    yield* store.setChatParent(target.id, { parentChatId: actorChatId, adopted: true })
    // What it owed, and what it had already told, were the former parent's.
    // The new one starts with nothing heard, and a turn in flight was not its.
    yield* store.setReportOwed(target.id, false)
    owedTurns.delete(target.id)
    return {
      formerParentChatId: former.parent?.parentChatId,
      /** The former parent was still waiting for a result from this chat. */
      owedFormerParent: former.parent !== null && former.reportOwed,
      undo: Effect.gen(function* () {
        yield* store.setChatParent(target.id, former.parent)
        if (!former.reportOwed) yield* store.setReportOwed(target.id, false)
        else if (former.reportedThrough === undefined) yield* store.setReportOwed(target.id, true)
        else yield* store.setReportedThrough(target.id, former.reportedThrough)
      }),
    }
  })

  /**
   * The chat a sub-chat was adopted away from. A result it was still owed is
   * not coming, so it hears that now, as the report the result would have
   * been (`buildSection` writes the line). Then it is looked at again as a
   * chat that ran out of turns: it may have been waiting on this chat alone,
   * with a report of its own held back.
   */
  const tellFormerParent = Effect.fn("Orchestrator.tellFormerParent")(function* (parentChatId: string, chatId: string, owed: boolean) {
    const chat = store.getChat(chatId)
    if (owed && chat) {
      yield* deliverInTurn(parentChatId, chatId, yield* withTranscript(chatId, () => buildSection(parentChatId, chat))).pipe(
        warnOnFailure(`could not tell chat ${parentChatId} that sub-chat ${chatId} was adopted`),
      )
    }
    yield* handleChatSettled(parentChatId)
  })

  /**
   * One chat's agent sending another a message. Returns the queue id when the
   * message is waiting behind a turn, and none when its own turn has started.
   */
  const send = Effect.fn("Orchestrator.send")(function* (
    actorChatId: string,
    target: ChatRecord,
    content: string,
    run: ResolvedRun,
    options: { report: boolean; steer?: boolean },
  ) {
    const source: MessageSource = { kind: "agent", chatId: actorChatId }
    // Marked before the turn starts: a turn that fails at once still ends, and
    // that end is what sends the report.
    if (options.report) yield* store.setReportOwed(target.id, true)
    const attempt = Effect.gen(function* (): Effect.fn.Return<{ queuedMessageId?: string }, ChatWriteError> {
      if (options.steer) {
        const { provider, model, effort, planMode, autoPlan } = run
        // A steer either starts the message or fails, so nothing is left queued.
        yield* commands.enqueue(
          { type: "message.enqueue", chatId: target.id, content, provider, model, planMode, autoPlan, steer: true },
          { source, effort },
        )
        return {}
      }
      const sent = yield* commands.send({ type: "chat.send", chatId: target.id, content, ...run }, { source })
      return "queued" in sent.result ? { queuedMessageId: sent.result.queuedMessageId } : {}
    })
    return yield* attempt.pipe(
      // Whatever stopped it, the chat is there and its turn is not: that is
      // what the caller is told, in one error, with what was cleaned up.
      Effect.catch((cause) => Effect.gen(function* () {
        if (options.report) yield* Effect.ignore(store.setReportOwed(target.id, false))
        return yield* new TurnNotStartedError({ chatId: target.id, cause })
      })),
    )
  })

  const cancelChat = Effect.fn("Orchestrator.cancelChat")(function* (actorChatId: string, chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    yield* Effect.annotateCurrentSpan("targetChatId", chatId)
    if (chatId === actorChatId) return yield* refuse(actorChatId, "This would stop your own turn. Finish your reply instead.")
    const target = yield* requireChat(chatId)
    // Whoever stops a sub-chat of its own already knows it ended, so no report.
    if (isParentOf(target.id, actorChatId)) {
      forgetLaterTurn(target.id)
      yield* store.setReportOwed(target.id, false)
    }
    yield* commands.cancel(target.id)
    push({ sidebar: true, chatIds: [target.id] })
    return summarize(yield* requireChat(target.id))
  })

  const updateChat = Effect.fn("Orchestrator.updateChat")(function* (actorChatId: string, input: UpdateChatInput) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    const chat = yield* requireChat(input.chatId ?? actorChatId)
    if (input.title !== undefined && !input.title.trim()) return yield* refuse(actorChatId, "The title cannot be empty.")
    const changes: Array<ChatChange | null> = []
    if (input.title !== undefined) changes.push((yield* commands.rename(chat.id, input.title)).changed)
    if (input.archived === false && chat.archivedAt) changes.push((yield* commands.unarchive(chat.id)).changed)
    if (input.pinned !== undefined) changes.push((yield* commands.setPinned(chat.id, input.pinned)).changed)
    if (input.done !== undefined) changes.push((yield* commands.setDone(chat.id, input.done)).changed)
    if (input.archived && !chat.archivedAt) changes.push((yield* commands.archive(chat.id)).changed)
    push({
      sidebar: true,
      localProjects: changes.some((change) => change?.localProjects),
      chatIds: [chat.id],
    })
    // An empty chat is deleted by archiving, so there may be nothing left to describe.
    const updated = store.getChat(chat.id)
    return updated ? summarize(updated) : { chatId: chat.id, deleted: true as const }
  })

  const updateQueuedMessage = Effect.fn("Orchestrator.updateQueuedMessage")(function* (input: { chatId: string; queuedMessageId: string; action: "remove" | "send_now" }) {
    yield* Effect.annotateCurrentSpan("chatId", input.chatId)
    const chat = yield* requireChat(input.chatId)
    if (!store.getQueuedMessage(chat.id, input.queuedMessageId)) {
      return yield* refuse(chat.id, `No queued message ${input.queuedMessageId} in chat ${chat.id}. read_chat lists its queue.`)
    }
    const outcome = input.action === "remove"
      ? yield* commands.dequeue({ type: "message.dequeue", chatId: chat.id, queuedMessageId: input.queuedMessageId })
      : yield* commands.steer({ type: "message.steer", chatId: chat.id, queuedMessageId: input.queuedMessageId })
    push(outcome.changed!)
    return summarize(yield* requireChat(chat.id))
  })

  // ── Schedules ──────────────────────────────────────────────────────────

  const setSchedule = Effect.fn("Orchestrator.setSchedule")(function* (actorChatId: string, input: SetScheduleInput) {
    yield* Effect.annotateCurrentSpan("chatId", actorChatId)
    const caller = yield* requireChat(actorChatId)
    const existing = input.scheduleId ? store.getSchedule(input.scheduleId) : null
    if (input.scheduleId && !existing) return yield* new ScheduleNotFoundError({ scheduleId: input.scheduleId })
    const at = now()

    const parsed = yield* parseTrigger(actorChatId, input, at)
    const trigger = parsed ?? existing?.trigger
    if (!trigger) return yield* refuse(actorChatId, "Say when it runs: inMinutes, runAt, everyMinutes or dailyAt.")
    const content = input.message ?? existing?.content
    if (!content?.trim()) return yield* refuse(actorChatId, "A schedule needs a message to send.")

    let target = existing?.target
    if (input.newChat) {
      const projectId = input.projectId ?? caller.projectId
      if (!store.getProject(projectId)) return yield* new ProjectNotFoundError({ projectId })
      target = { kind: "new_chat", projectId }
    } else if (input.chatId || !target) {
      target = { kind: "chat", chatId: (yield* requireChat(input.chatId ?? actorChatId)).id }
    }

    // The message runs later with nobody to hold it to this chat's mode, so
    // a read-only chat can only schedule read-only work.
    const planning = agent.isPlanning(actorChatId)
    if (planning && input.planMode === false) {
      return yield* refuse(actorChatId, "This chat is in plan mode, so what it schedules must run in plan mode too.")
    }
    // A new chat has no history to take its provider from, so it takes the
    // scheduling chat's. A message into an existing chat follows that chat.
    const inherit = !existing && target.kind === "new_chat"
    const provider = input.provider ?? existing?.provider ?? (inherit ? caller.provider ?? undefined : undefined)
    if (provider && !SERVER_PROVIDERS.some((entry) => entry.id === provider)) {
      return yield* refuse(actorChatId, `Unknown provider "${provider}". get_context lists the providers.`)
    }
    const model = input.model ?? existing?.model ?? (inherit && provider === caller.provider ? caller.lastModel : undefined)
    const planMode = planning ? true : input.planMode ?? existing?.planMode
    const triggerChanged = parsed !== null
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
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(existing ? (existing.createdByChatId ? { createdByChatId: existing.createdByChatId } : {}) : { createdByChatId: actorChatId }),
      ...(reportsToParent ? { reportsToParent: true as const } : {}),
      // Turning one back on, or giving it a new time, starts its clock again.
      nextRunAt: !enabled
        ? existing?.nextRunAt ?? null
        : triggerChanged || !existing || !existing.enabled || existing.nextRunAt == null
          ? computeFirstRun(trigger, at)
          : existing.nextRunAt,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastRunChatId ? { lastRunChatId: existing.lastRunChatId } : {}),
      runCount: existing?.runCount ?? 0,
      ...(input.maxRuns ?? existing?.maxRuns ? { maxRuns: input.maxRuns ?? existing?.maxRuns } : {}),
      ...(existing?.runs ? { runs: existing.runs } : {}),
    }
    if (schedule.enabled && schedule.nextRunAt == null) {
      return yield* refuse(actorChatId, "That time has already passed, so the schedule would never run.")
    }
    yield* store.setSchedule(schedule)
    yield* schedules.refresh
    pushSchedule(schedule, existing)
    return describeSchedule(schedule)
  })

  const parseTrigger = (
    actorChatId: string,
    input: { inMinutes?: number; runAt?: string; everyMinutes?: number; dailyAt?: string; weekdays?: number[] },
    at: number,
  ): Effect.Effect<ScheduleTrigger | null, ChatActionRefusedError> => Effect.suspend((): Effect.Effect<ScheduleTrigger | null, ChatActionRefusedError> => {
    const given = [input.inMinutes, input.runAt, input.everyMinutes, input.dailyAt].filter((value) => value !== undefined)
    if (given.length === 0) return Effect.succeed(null)
    if (given.length > 1) return refuse(actorChatId, "Give one of inMinutes, runAt, everyMinutes or dailyAt, not several.")
    if (input.inMinutes !== undefined) return Effect.succeed({ kind: "once", at: at + input.inMinutes * 60_000 })
    if (input.runAt !== undefined) {
      const runAt = Date.parse(input.runAt)
      if (Number.isNaN(runAt)) return refuse(actorChatId, `"${input.runAt}" is not a time. Use ISO 8601, such as 2026-01-31T09:00:00-08:00.`)
      return Effect.succeed({ kind: "once", at: runAt })
    }
    if (input.everyMinutes !== undefined) {
      return Effect.succeed({ kind: "interval", everyMs: Math.max(MIN_SCHEDULE_INTERVAL_MS, input.everyMinutes * 60_000) })
    }
    if (!parseTimeOfDay(input.dailyAt!)) return refuse(actorChatId, `"${input.dailyAt}" is not a time of day. Use 24-hour HH:MM, such as 09:00.`)
    return Effect.succeed({ kind: "daily", timeOfDay: input.dailyAt!, ...(input.weekdays?.length ? { weekdays: input.weekdays } : {}) })
  })

  const listSchedules = (input: { chatId?: string; includeDisabled?: boolean }) => Effect.sync(() => ({
    now: iso(now()),
    schedules: store.listSchedules()
      .filter((schedule) => input.includeDisabled || schedule.enabled)
      .filter((schedule) => !input.chatId || (schedule.target.kind === "chat" && schedule.target.chatId === input.chatId))
      .map((schedule) => describeSchedule(schedule)),
  }))

  const deleteSchedule = Effect.fn("Orchestrator.deleteSchedule")(function* (scheduleId: string) {
    yield* Effect.annotateCurrentSpan("scheduleId", scheduleId)
    const schedule = store.getSchedule(scheduleId)
    if (!schedule) return yield* new ScheduleNotFoundError({ scheduleId })
    yield* store.deleteSchedule(scheduleId)
    yield* schedules.refresh
    pushSchedule(schedule)
    // The name too: the schedule is gone, and its card has nothing else to call it.
    return { deleted: scheduleId, name: schedule.name }
  })

  /**
   * Push the chats that list a schedule. A chat's snapshot carries the
   * schedules to do with it, so a change to one is a change to those chats.
   */
  function pushSchedule(...changed: Array<ChatSchedule | null | undefined>) {
    const chatIds = new Set<string>()
    for (const schedule of changed) {
      if (!schedule) continue
      if (schedule.target.kind === "chat") chatIds.add(schedule.target.chatId)
      if (schedule.createdByChatId) chatIds.add(schedule.createdByChatId)
      if (schedule.lastRunChatId) chatIds.add(schedule.lastRunChatId)
    }
    if (chatIds.size > 0) push({ chatIds: [...chatIds] })
  }

  const fireSchedule = Effect.fn("Orchestrator.fireSchedule")(function* (schedule: ChatSchedule): Effect.fn.Return<ScheduleFireResult, ChatWriteError> {
    yield* Effect.annotateCurrentSpan("scheduleId", schedule.id)
    const source: MessageSource = { kind: "schedule", scheduleId: schedule.id }
    if (schedule.target.kind === "chat") {
      const chat = store.getChat(schedule.target.chatId)
      if (!chat) return { outcome: "gone" }
      // The last run's message has not even started. A second copy behind it
      // would only pile up.
      const pending = store.getQueuedMessages(chat.id)
        .some((message) => message.source?.kind === "schedule" && message.source.scheduleId === schedule.id)
      if (pending) return { outcome: "skipped" }
      const provider = schedule.provider ?? chat.provider ?? undefined
      // Before the turn starts, like a parent's own message (`send`).
      const arms = Boolean(schedule.reportsToParent && chat.parentChatId && !chat.reportOwed)
      if (arms) yield* store.setReportOwed(chat.id, true)
      yield* commands.send({
        type: "chat.send",
        chatId: chat.id,
        content: schedule.content,
        provider,
        model: schedule.model ?? (provider === chat.provider ? chat.lastModel : undefined),
        effort: schedule.effort,
        planMode: schedule.planMode ?? chat.planMode,
        autoPlan: chat.autoPlan,
      }, { source }).pipe(
        Effect.tapError(() => arms ? Effect.ignore(store.setReportOwed(chat.id, false)) : Effect.void),
      )
      return { outcome: "sent", chatId: chat.id }
    }

    if (!store.getProject(schedule.target.projectId)) return { outcome: "gone" }
    if (schedule.lastRunChatId && isLive(schedule.lastRunChatId)) return { outcome: "skipped" }
    const chatId = (yield* commands.create(schedule.target.projectId)).result.chatId
    yield* commands.rename(chatId, schedule.name)
    yield* commands.send({
      type: "chat.send",
      chatId,
      content: schedule.content,
      provider: schedule.provider,
      model: schedule.model,
      effort: schedule.effort,
      planMode: schedule.planMode,
    }, { source })
    return { outcome: "sent", chatId }
  })

  // Its own scope, so `stop` can end it ahead of the layer's.
  const schedulesScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(schedulesScope, Exit.void))
  const schedules = yield* makeScheduleRunner<EventStoreFileError, ChatWriteError>({
    store: {
      listSchedules: () => store.listSchedules(),
      getSchedule: (scheduleId) => store.getSchedule(scheduleId),
      setSchedule: store.setSchedule,
    },
    fire: (schedule) => fireSchedule(schedule).pipe(
      // What the runner's `onError` was handed: any failure of the run, logged once.
      Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning(`schedule ${schedule.id} (${schedule.name}) failed to run: ${errorMessage(Cause.squash(cause))}`)),
    ),
    onFired: (schedule, result) => {
      // A run can create a chat, which the sidebar and the project list show.
      if (result.outcome === "sent") push({ sidebar: true, localProjects: true, chatIds: [result.chatId] })
      // Every run, skipped ones too, is a new line in the schedule's history.
      pushSchedule(store.getSchedule(schedule.id) ?? schedule)
    },
    now,
  }).pipe(Scope.provide(schedulesScope))

  // ── Coordinator hooks ──────────────────────────────────────────────────

  const handleChatSettled: (chatId: string) => Effect.Effect<void> = Effect.fn("Orchestrator.handleChatSettled")(function* (chatId: string) {
    // What a reported sub-chat was watched for is over. Its end is not a
    // turn's start: a provider about to answer it has not begun to, so the
    // watch runs on for as long as a closing report would wait.
    if (laterTurns.get(chatId) === null && agent.getLeftRunning(chatId).length === 0) {
      const entry: { timer?: Fiber.Fiber<unknown> } = {}
      laterTurns.set(chatId, entry)
      entry.timer = yield* background(Effect.sleep(closeOutGraceMs).pipe(Effect.andThen(Effect.sync(() => {
        if (laterTurns.get(chatId) === entry) laterTurns.delete(chatId)
      }))))
    }
    const changed: string[] = []
    const seen = new Set<string>()
    let current = store.getChat(chatId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      yield* background(maybeReport(current.id))
      if (!current.parentChatId) break
      // The parent's task log lists this chat, so its status there just changed.
      changed.push(current.parentChatId)
      current = store.getChat(current.parentChatId)
    }
    if (changed.length > 0) push({ sidebar: true, chatIds: changed })
  })

  const handleTurnStarted = Effect.fn("Orchestrator.handleTurnStarted")(function* (chatId: string) {
    const endedTurnOwed = owedTurns.delete(chatId)
    const chat = store.getChat(chatId)
    let owed = Boolean(chat?.reportOwed)
    if (laterTurns.has(chatId)) {
      // The turn a sub-chat's shell was watched for, or one someone gave it
      // meanwhile. Either way its parent has not heard what it says.
      forgetLaterTurn(chatId)
      if (chat?.parentChatId) {
        owed = true
        yield* background(store.setReportOwed(chatId, true).pipe(
          warnOnFailure(`could not mark sub-chat ${chatId} as owing a report`),
        ))
      }
    }
    if (owed && chat?.parentChatId) owedTurns.add(chatId)
    // The turn that ended is the one before this one.
    if (endedTurnOwed) yield* background(reportEndedTurn(chatId))
    pushChatsAbove(chatId)
  })

  function pushChatsAbove(chatId: string) {
    const above: string[] = []
    const seen = new Set<string>()
    let current = store.getChat(chatId)
    while (current?.parentChatId && !seen.has(current.id)) {
      seen.add(current.id)
      above.push(current.parentChatId)
      current = store.getChat(current.parentChatId)
    }
    if (above.length > 0) push({ sidebar: true, chatIds: above })
  }

  const handleChatStopped = Effect.fn("Orchestrator.handleChatStopped")(function* (chatId: string) {
    for (const child of childrenOf(chatId)) {
      forgetLaterTurn(child.id)
      if (child.adopted) {
        // Not this chat's to stop: its turn may be the user's. It only stops
        // owing a report, for the reason the others report nothing.
        owedTurns.delete(child.id)
        yield* background(store.setReportOwed(child.id, false).pipe(
          warnOnFailure(`could not release adopted chat ${child.id} from its report`),
        ))
        continue
      }
      if (!isReportDue(child) && !isLive(child.id)) continue
      yield* background(store.setReportOwed(child.id, false).pipe(
        Effect.andThen(agent.cancel(child.id)),
        warnOnFailure(`could not stop sub-chat ${child.id}`),
      ))
    }
  })

  /**
   * Sub-chats as rows in their parent's task log, next to the provider's own
   * subagents. Read from the store each time, so a restart loses nothing.
   */
  function getChildActivities(chatId: string): SubagentActivity[] {
    const children = childrenOf(chatId)
    if (children.length === 0) return []
    const activities = children.map((child): SubagentActivity => {
      const status = statusOf(child)
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

  const stopChildTask = Effect.fn("Orchestrator.stopChildTask")(function* (chatId: string, taskId: string) {
    if (!taskId.startsWith(SUBCHAT_TASK_PREFIX)) return false
    const child = store.getChat(taskId.slice(SUBCHAT_TASK_PREFIX.length))
    if (!child || child.parentChatId !== chatId) return false
    yield* commands.cancel(child.id)
    return true
  })

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
  function isAgentToAgent(chatId: string, source?: MessageSource) {
    if (source?.kind === "agent") return true
    if (source?.kind !== "schedule") return false
    const schedule = store.getSchedule(source.scheduleId)
    if (!schedule) return false
    return Boolean(schedule.reportsToParent || (schedule.createdByChatId && schedule.createdByChatId !== chatId))
  }

  /**
   * Wire-only notes for the harness at the start of a turn: who sent the
   * prompt when it was not the user, and which sub-chats are still running.
   */
  const buildTurnNotices = Effect.fn("Orchestrator.buildTurnNotices")(function* (chatId: string, source?: MessageSource, turn?: AgentToAgentTurn) {
    const notices: string[] = []
    // No person to answer a prompt in this turn. See `agent-to-agent.ts`.
    const agentNote = turn && isAgentToAgent(chatId, source) ? ` ${buildAgentToAgentNote(turn)}` : ""
    if (source?.kind === "agent") {
      const sender = store.getChat(source.chatId)
      const chat = store.getChat(chatId)
      const parentNote = chat?.parentChatId !== source.chatId
        ? ""
        : ` It ${chat.adopted ? "adopted" : "started"} this chat, and your final reply is sent back to it when you finish.`
      notices.push(`<system-message>This message was sent by the agent in Kanna chat "${sender?.title ?? "unknown"}" (chat id ${source.chatId}), not typed by the user.${parentNote}${agentNote}</system-message>`)
    } else if (source?.kind === "report") {
      notices.push("<system-message>This is Kanna reporting on chats you started, not a message from the user. Carry on with what you were doing for the user.</system-message>")
    } else if (source?.kind === "schedule") {
      const schedule = store.getSchedule(source.scheduleId)
      notices.push(`<system-message>This message was sent by the schedule "${schedule?.name ?? "unknown"}" (schedule id ${source.scheduleId}), not typed by the user just now.${agentNote}</system-message>`)
    }
    // An adopted chat is listed only while a result from it is still to come.
    const running = childrenOf(chatId).filter((child) => isLive(child.id) && (!child.adopted || isReportDue(child)))
    if (running.length > 0) {
      notices.push([
        "<system-message>Chats you started that are still running:",
        ...running.map((child) => `${child.title} (chat id ${child.id})`),
        "Each one's result arrives here as a message when it finishes. Stop any you no longer need with cancel_chat.</system-message>",
      ].join("\n"))
    }
    return notices
  })

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
  function buildSection(parentChatId: string, chat: ChatRecord, sectionOptions?: { replyReported?: boolean }): ReportSection {
    // Adopted by another chat since this report was owed. The result goes
    // there now, so this parent gets the news instead, in the same shape.
    const adopter = chat.parentChatId && chat.parentChatId !== parentChatId ? store.getChat(chat.parentChatId) : null
    if (adopter) {
      return { header: `<system-message>\nSub-chat adopted: [${chat.title}](${chatLink(chat.id)}) (chat id ${chat.id}) now reports to the chat "${adopter.title}" (${chatLink(adopter.id)}), which adopted it. Its result will not arrive here. read_chat still reads it.\n</system-message>` }
    }
    const outcome = outcomeOf(chat)
    const lines = [`Sub-chat ${outcome.status}: [${chat.title}](${chatLink(chat.id)}) (chat id ${chat.id})`]
    const interim = interimNote(chat, outcome.status)
    if (interim) lines.push(interim)
    // Not waiting on anything, so this is its answer. What it left running
    // may still give it something to add (`laterTurns`).
    else {
      if (sectionOptions?.replyReported && outcome.finalMessage) {
        lines.push("The work it was waiting on ended without giving it another turn, so the reply already reported here is its result.")
      }
      const left = describeLeftRunning(agent.getLeftRunning(chat.id))
      if (left) lines.push(`It left ${left} running in the background, which it is not waiting on. If that gives it another turn, that turn is reported here too.`)
    }
    for (const schedule of followUpSchedules(chat.id)) {
      lines.push(`It set itself the schedule "${schedule.name}", which next runs at ${iso(schedule.nextRunAt!)}. The turn each run starts is reported here too.`)
    }
    if (outcome.cut && !sectionOptions?.replyReported) {
      const { index, textOffset, totalChars } = outcome.cut
      lines.push(`Its reply is ${totalChars.toLocaleString("en-US")} characters, more than a report carries, so only the first ${REPORT_TEXT_LIMIT.toLocaleString("en-US")} are below. read_chat reads the rest: ${JSON.stringify({ chatId: chat.id, after: index - 1, textOffset })}.`)
    }
    const header = `<system-message>\n${lines.join("\n")}\n</system-message>`
    if (!outcome.finalMessage || sectionOptions?.replyReported) return { header }
    return { header, reply: outcome.finalMessage }
  }

  /**
   * What a report says, past the status, when it is not the sub-chat's last
   * word. The parent's agent reads the reply under it as a result otherwise.
   */
  function interimNote(chat: ChatRecord, status: AgentChatStatus) {
    if (status === "running") return "It went straight on into another turn, so what follows is the whole reply of the turn before. The new turn's report follows when it ends."
    if (!isStillGoing(status)) return null
    const waitingOn = status === "waiting_on_subagent"
      ? "work it handed to agents of its own (a subagent or a workflow)"
      : `chats under it: ${childrenOf(chat.id).filter((child) => holdsParent(child)).map((child) => `"${child.title}"`).join(", ")}`
    return `Not its last word. Its turn ended, and it is still waiting on ${waitingOn}. What follows is its reply so far. It reports again when its next turn ends.`
  }

  /** Schedules still to run whose turns this chat reports to its parent. See `ChatSchedule.reportsToParent`. */
  function followUpSchedules(chatId: string) {
    return [...store.state.schedulesById.values()].filter((schedule) => (
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
  const maybeReport: (chatId: string) => Effect.Effect<void> = Effect.fn("Orchestrator.maybeReport")(function* (chatId: string) {
    const chat = store.getChat(chatId)
    if (!chat?.reportOwed || !chat.parentChatId) {
      cancelCloseOut(chatId)
      return
    }
    if (reporting.has(chatId)) return
    const status = statusOf(chat)
    if (status === "running" || status === "needs_input") {
      cancelCloseOut(chatId)
      return
    }
    // A report from one of its own sub-chats is being written. It starts a
    // turn here, whose start reports this one (`reportEndedTurn`).
    if (childrenOf(chatId).some((child) => reporting.has(child.id))) return
    const waiting = isStillGoing(status)
    const through = chat.lastTurnEndedAt ?? 0
    if (chat.reportedThrough !== through) {
      cancelCloseOut(chatId)
    } else {
      // The parent has this reply, and more is coming.
      if (waiting) {
        cancelCloseOut(chatId)
        return
      }
      // The work it waited on ended without giving it another turn.
      if (!(yield* closeOutDue(chatId))) return
      cancelCloseOut(chatId)
    }
    const parentChatId = chat.parentChatId
    // Written now, from the turn that earned it, before anything can change.
    const section = yield* withTranscript(chatId, () => buildSection(parentChatId, chat, { replyReported: chat.reportedThrough === through }))
    // This report covers the turn that ended last. See `owedTurns`.
    owedTurns.delete(chatId)
    reporting.add(chatId)
    yield* Effect.gen(function* () {
      // Written before the send, so a failure cannot leave it to be sent twice.
      if (waiting) {
        yield* store.setReportedThrough(chatId, through)
      } else {
        yield* store.setReportOwed(chatId, false)
        watchForLaterTurn(chatId)
      }
      yield* deliverInTurn(parentChatId, chatId, section)
    }).pipe(
      warnOnFailure(`could not report sub-chat ${chatId} to its parent`),
      Effect.ensuring(Effect.suspend(() => {
        reporting.delete(chatId)
        // The parent's own report held back while this one was being written.
        return background(maybeReport(parentChatId))
      })),
    )
  })

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
  const reportEndedTurn = Effect.fn("Orchestrator.reportEndedTurn")(function* (chatId: string) {
    const chat = store.getChat(chatId)
    if (!chat?.reportOwed || !chat.parentChatId || reporting.has(chatId)) return
    if (chat.lastTurnOutcome === "cancelled") return
    const through = chat.lastTurnEndedAt ?? 0
    if (chat.reportedThrough === through) return
    const parentChatId = chat.parentChatId
    const section = yield* withTranscript(chatId, () => buildSection(parentChatId, chat))
    reporting.add(chatId)
    yield* Effect.gen(function* () {
      yield* store.setReportedThrough(chatId, through)
      yield* deliverInTurn(parentChatId, chatId, section)
    }).pipe(
      warnOnFailure(`could not report sub-chat ${chatId} to its parent`),
      Effect.ensuring(Effect.suspend(() => {
        reporting.delete(chatId)
        // A turn end that came while this was being written was held back by it.
        return Effect.andThen(background(maybeReport(chatId)), background(maybeReport(parentChatId)))
      })),
    )
  })

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
  const closeOutDue = Effect.fnUntraced(function* (chatId: string) {
    const pending = closeOuts.get(chatId)
    if (pending) return pending.ready
    const entry: { ready: boolean; timer?: Fiber.Fiber<unknown> } = { ready: false }
    closeOuts.set(chatId, entry)
    entry.timer = yield* background(Effect.sleep(closeOutGraceMs).pipe(Effect.andThen(Effect.suspend(() => {
      entry.ready = true
      // Run out: no longer a timer to stop, so the report it starts cannot stop itself.
      entry.timer = undefined
      return maybeReport(chatId)
    }))))
    return false
  })

  /** See `laterTurns`. Only a chat with something of its own still running has a later turn to watch for. */
  function watchForLaterTurn(chatId: string) {
    forgetLaterTurn(chatId)
    if (agent.getLeftRunning(chatId).length > 0) laterTurns.set(chatId, null)
  }

  function forgetLaterTurn(chatId: string) {
    laterTurns.get(chatId)?.timer?.interruptUnsafe()
    laterTurns.delete(chatId)
  }

  function cancelCloseOut(chatId: string) {
    const pending = closeOuts.get(chatId)
    if (!pending) return
    pending.timer?.interruptUnsafe()
    closeOuts.delete(chatId)
  }

  /**
   * One delivery at a time per parent: two sub-chats finishing together would
   * each miss the other's report in the queue and send two. Each waits for
   * the one before it, in the order they were asked for.
   */
  const deliverInTurn = (parentChatId: string, chatId: string, section: ReportSection) => Effect.suspend(() => {
    const previous = deliveries.get(parentChatId)
    const done = Deferred.makeUnsafe<void>()
    deliveries.set(parentChatId, done)
    return (previous ? Deferred.await(previous) : Effect.void).pipe(
      Effect.andThen(deliverReport(parentChatId, chatId, section)),
      Effect.ensuring(Effect.sync(() => {
        Deferred.doneUnsafe(done, Effect.void)
        if (deliveries.get(parentChatId) === done) deliveries.delete(parentChatId)
      })),
    )
  })

  const deliverReport = Effect.fn("Orchestrator.deliverReport")(function* (parentChatId: string, chatId: string, section: ReportSection) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* Effect.annotateCurrentSpan("parentChatId", parentChatId)
    const parent = store.getChat(parentChatId)
    // A report to a chat the user put away would bring it back uninvited.
    if (!parent || parent.archivedAt) return
    let chatIds = [chatId]
    let before = ""
    const waiting = store.getQueuedMessages(parent.id).find((message) => message.source?.kind === "report")
    if (waiting?.source?.kind === "report") {
      // Added to, not rewritten: what it already says is a reply of its own,
      // and a sub-chat that reports again before the parent reads it would
      // otherwise lose the earlier one.
      const merged = [...new Set([...waiting.source.chatIds, chatId])]
      // If it is gone by now the parent's turn ended and took it, and those
      // results are already delivered.
      yield* store.removeQueuedMessage(parent.id, waiting.id).pipe(
        Effect.andThen(Effect.sync(() => {
          chatIds = merged
          before = waiting.content
        })),
        Effect.ignore,
      )
    }
    yield* commands.send({
      type: "chat.send",
      chatId: parent.id,
      content: appendReportSection(before, section),
      // The parent carries on as it was running: same model and mode.
      provider: parent.provider ?? undefined,
      model: parent.lastModel,
      planMode: parent.planMode,
      autoPlan: parent.autoPlan,
    }, { source: { kind: "report", chatIds } })
    push({ sidebar: true, chatIds: [parent.id] })
  })

  // ── Lifetime ───────────────────────────────────────────────────────────

  const sweepReports = Effect.suspend(() => Effect.forEach(
    [...store.state.chatsById.values()].filter((chat) => chat.reportOwed && !chat.deletedAt),
    (chat) => background(maybeReport(chat.id)),
    { discard: true },
  ))

  const stop = Effect.gen(function* () {
    yield* Scope.close(schedulesScope, Exit.void)
    bootSweep?.interruptUnsafe()
    bootSweep = null
    for (const chatId of [...closeOuts.keys()]) cancelCloseOut(chatId)
    for (const chatId of [...laterTurns.keys()]) forgetLaterTurn(chatId)
  })
  yield* Effect.addFinalizer(() => stop)

  return {
    start: Effect.gen(function* () {
      yield* schedules.start
      yield* sweepReports
      // Once more after boot has resumed what it is going to resume. A sub-chat
      // whose resume was skipped has no turn end coming to send its report.
      bootSweep = yield* background(Effect.sleep(BOOT_SWEEP_MS).pipe(Effect.andThen(sweepReports)))
    }).pipe(Effect.withSpan("Orchestrator.start")),
    stop,

    countSubchatsHolding: (chatId) => childrenOf(chatId).filter((child) => holdsParent(child)).length,
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
    getChatsWaitingOnSubchats: (unsettled) => {
      const candidates = new Set(unsettled)
      for (const chatId of reporting) candidates.add(chatId)
      for (const chatId of store.state.queuedMessagesByChatId.keys()) candidates.add(chatId)
      for (const chat of store.state.chatsById.values()) {
        if (chat.parentChatId && (chat.reportOwed || chat.resumePending)) candidates.add(chat.id)
      }
      const waiting = new Set<string>()
      for (const chatId of candidates) {
        let chat = store.getChat(chatId)
        if (!chat?.parentChatId) continue
        if (!isReportDue(chat) && isSelfSettled(chat)) continue
        // A chat with a live sub-chat is live itself, so the wait goes all the
        // way up. A parent already in the set has had its own walked. The walk
        // ends at an adopted chat that owes nothing (`holdsParent`).
        while (chat?.parentChatId && (!chat.adopted || isReportDue(chat)) && !waiting.has(chat.parentChatId)) {
          waiting.add(chat.parentChatId)
          chat = store.getChat(chat.parentChatId)
        }
      }
      return waiting
    },
    getChildActivities,
    isAgentToAgent,
    buildTurnNotices,
    getContext,
    listChats,
    readChat,
    listSchedules,

    createChat,
    forkChat,
    sendMessage,
    cancelChat,
    updateChat,
    updateQueuedMessage,
    setSchedule,
    deleteSchedule,
    runDueSchedules: schedules.tick,

    handleChatSettled,
    handleTurnStarted,
    handleBackgroundWorkStarted: (chatId) => Effect.sync(() => pushChatsAbove(chatId)),
    handleChatStopped,
    stopChildTask,
  } satisfies Orchestrator["Service"]
})

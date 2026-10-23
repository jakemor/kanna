import path from "node:path"
import { Context, Deferred, Effect, FileSystem, Layer, Option, Result, Schema, type Scope } from "effect"
import { getDataDir, LOG_PREFIX } from "../shared/branding"
import { toMessagePreview } from "../shared/message-preview"
import { buildTranscriptOutline, findTranscriptWindowStart } from "../shared/transcript-window"
import type { TranscriptOutlineEntry } from "../shared/types"
import type { AgentProvider, ChatSchedule, QueuedChatMessage, ResolvedChatReadAnchor, TranscriptEntry } from "../shared/types"
import { STORE_VERSION } from "../shared/types"
import {
  type ChatEvent,
  type ChatRecord,
  type ProjectEvent,
  type ProjectRecord,
  type QueuedMessageEvent,
  type ScheduleEvent,
  type SnapshotFile,
  type StoreEvent,
  type StoreState,
  type TouchedFile,
  type TurnEvent,
  cloneTranscriptEntries,
  cloneTranscriptEntriesForClient,
  createEmptyState,
} from "./events"
import { PerformanceLog } from "./performance-log"
import { resolveLocalPath } from "./paths"
// The sidebar's own quantization, imported rather than duplicated so the two
// cannot drift: if the wire resolution changes, this bump condition follows.
import { SIDEBAR_ACTIVITY_RESOLUTION_MS } from "./read-models"
import { slimTranscriptFile } from "./transcript-slim"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import {
  loadTranscriptPayloadIndex,
  mergeTranscriptPayload,
  readTranscriptPayloads,
  readTranscriptPayloadsById,
  serializeTranscriptPayload,
  splitTranscriptEntry,
  TranscriptPayloadIndex,
  type TranscriptPayload,
  type TranscriptPayloadReadError,
} from "./transcript-payloads"
import { INLINE_TOOL_KINDS } from "./events"
import {
  copyTranscriptMedia,
  externalizeEntryImages,
  getTranscriptMediaDir,
  parseTranscriptMediaUrl,
  removeTranscriptMedia,
  retargetEntryMediaUrls,
  type TranscriptMediaError,
} from "./transcript-media"

const COMPACTION_THRESHOLD_BYTES = 2 * 1024 * 1024
const STALE_EMPTY_CHAT_MAX_AGE_MS = 5 * 60 * 1000
/** Chats this much older than the user's latest activity are auto-archived (kept, not deleted). */
const STALE_CHAT_AUTO_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Chats this much older than the user's latest activity are hard-deleted (archived or not). */
const STALE_CHAT_DELETE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const SIDEBAR_PROJECT_ORDER_FILE = "sidebar-order.json"
/** What `crypto.randomUUID` makes, and all a client may name a chat (`createChat`). */
const CLIENT_CHAT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CHAT_MESSAGE_PREVIEW_MAX_LENGTH = 160
/**
 * Ceiling on a chat's remembered touched paths. A long-running chat that
 * rewrites half a repo shouldn't grow an unbounded array in every snapshot;
 * once a chat has touched this many distinct files it is going to intersect
 * whatever is dirty anyway, so the tail adds nothing.
 */
const TOUCHED_PATHS_LIMIT = 500

/**
 * What a `chat_files_touched` event says, in the current shape. Events written
 * before base blobs existed carry bare `paths`; those become entries with no
 * `baseBlob`, i.e. claims that no commit can expire — the behaviour they were
 * recorded under.
 */
function readTouchedFiles(event: { files?: TouchedFile[]; paths?: string[] }): TouchedFile[] {
  if (event.files) return event.files
  return (event.paths ?? []).map((filePath) => ({ path: filePath }))
}

/**
 * Unions touched files: newest base blob wins per path, line counts accumulate.
 *
 * The two halves answer different questions and so merge differently. A base
 * blob is a *position* — the commit this chat's claim stands on — and a path
 * this chat touched, had committed, then touched again must be measured
 * against the newer commit, or the chat would read as settled while it still
 * has live uncommitted work there. Line counts are a *quantity*: each event
 * carries one turn's numstat, so a chat that edits a file across five turns
 * has written the sum of them.
 *
 * The cap only gates *new* paths — updating a path already in the set is free,
 * so a chat at the ceiling keeps its existing claims accurate.
 */
function mergeTouchedFiles(existing: TouchedFile[] | undefined, incoming: TouchedFile[]): TouchedFile[] {
  const merged = new Map((existing ?? []).map((file) => [file.path, file]))
  for (const file of incoming) {
    const previous = merged.get(file.path)
    if (!previous && merged.size >= TOUCHED_PATHS_LIMIT) continue
    merged.set(file.path, {
      ...file,
      ...addCounts("additions", previous, file),
      ...addCounts("deletions", previous, file),
    })
  }
  return [...merged.values()]
}

/**
 * One count, carried forward and added to. Stays absent when neither side has
 * a number, so a binary file (or anything recorded before counts) reads as
 * "unknown" rather than as zero lines changed.
 */
function addCounts(
  key: "additions" | "deletions",
  previous: TouchedFile | undefined,
  incoming: TouchedFile
): Partial<TouchedFile> {
  const total = (previous?.[key] ?? 0) + (incoming[key] ?? 0)
  if (previous?.[key] === undefined && incoming[key] === undefined) return {}
  return { [key]: total }
}
// How much of each transcript tail is scanned at boot to rebuild chat metadata
// (lastMessageAt, previews) that only lives in snapshots between compactions.
const TRANSCRIPT_METADATA_TAIL_BYTES = 256 * 1024
/**
 * A message reduced to the one line the sidebar's hover card shows.
 *
 * The markdown has to come off *here*, not where it's rendered: half of what
 * `toMessagePreview` strips — headings, list markers, quotes, rules — is
 * anchored to the start of a line, and this is the last place the lines still
 * exist. A preview that has already been flattened to one string carries its
 * `##` and `- ` into the middle of the text, where no line-start rule can see
 * them and no client-side pass can recover.
 *
 * Stripping before the truncation also means the 160 characters are spent on
 * words rather than syntax.
 */
function buildChatMessagePreview(text: string) {
  const preview = toMessagePreview(text)
  if (!preview) return undefined
  return preview.length > CHAT_MESSAGE_PREVIEW_MAX_LENGTH
    ? `${preview.slice(0, CHAT_MESSAGE_PREVIEW_MAX_LENGTH)}…`
    : preview
}

/**
 * Entries the agent itself produced, as opposed to the user's prompts or the
 * bookkeeping entries a session emits around them (system_init, account_info,
 * context_window_updated, compaction/handoff boundaries…). Only these advance
 * `lastAgentMessageAt`, so idle session housekeeping can't make a chat look
 * freshly active.
 *
 * `tool_call`/`tool_result` count alongside `assistant_text`: a plan lands as
 * an ExitPlanMode tool call, and a permission prompt may arrive with no text
 * at all, so text alone would miss exactly the mid-turn stops this timestamp
 * exists to catch. `result` counts too — it's the agent's closing entry.
 */
function isAgentAuthoredEntry(entry: TranscriptEntry) {
  return entry.kind === "assistant_text"
    || entry.kind === "tool_call"
    || entry.kind === "tool_result"
    || entry.kind === "result"
}

/**
 * Index just past the last completed turn in a transcript, or 0 when no turn
 * has finished yet. A turn closes with a `result` entry, or with `interrupted`
 * when it was cancelled (Claude emits that instead of a result), so everything
 * after the last of those belongs to a turn still in flight.
 *
 * Used to fork a chat mid-turn: the fork branches from the last settled point
 * rather than inheriting a turn whose tool calls have no results yet.
 */
export function findLastCompletedTurnEnd(entries: TranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const kind = entries[index]!.kind
    if (kind === "result" || kind === "interrupted") return index + 1
  }
  return 0
}

/**
 * Where a fork branches off its source's provider session: the provider's id
 * for the last thing the fork's copied transcript keeps. Null when it has no
 * such id (a provider without one, or turns recorded before they were kept).
 *
 * The fork's transcript stops at the source's last completed turn, but the
 * provider forks its own copy of the session as it stands when the fork
 * first runs. A source that ran more turns by then would hand those to the
 * fork too, unseen in its transcript, unless the fork is cut here.
 *
 * - Claude: the uuid of the last message on the session's main chain, its
 *   assistant text, tool call or tool result (`resumeSessionAt`). Not a
 *   subagent's (their messages live in their own files), and not the turn's
 *   `result`, which the session file does not hold.
 * - Codex: the id of the last completed turn (`lastTurnId`), which its
 *   `result` entry carries.
 */
export function forkPointOf(provider: AgentProvider, entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (!entry.messageId) continue
    if (provider === "claude") {
      if (entry.parentToolUseId) continue
      if (entry.kind === "assistant_text" || entry.kind === "tool_call" || entry.kind === "tool_result") return entry.messageId
    } else if (provider === "codex") {
      if (entry.kind === "result") return entry.messageId
    } else {
      return null
    }
  }
  return null
}

/**
 * Re-derive the sidebar preview fields from a fork's copied transcript. Forks
 * of an idle chat inherit these from the source record instead (it is the same
 * conversation), but a fork taken mid-turn drops the running turn, so the
 * source's fields would advertise a prompt the fork does not contain.
 *
 * Mirrors `applyMessageMetadata`, which derives the same fields on append.
 */
function summarizeForkedTranscript(entries: TranscriptEntry[]) {
  const summary: {
    lastUserMessagePreview?: string
    lastAgentMessagePreview?: string
    lastAgentMessagePreviewAt?: number
    lastAgentMessageAt?: number
  } = {}
  for (const entry of entries) {
    if (entry.kind === "user_prompt" && !entry.hidden) {
      const preview = buildChatMessagePreview(entry.content)
      if (preview) summary.lastUserMessagePreview = preview
    } else if (entry.kind === "assistant_text" && !entry.hidden) {
      const preview = buildChatMessagePreview(entry.text)
      if (preview) {
        summary.lastAgentMessagePreview = preview
        summary.lastAgentMessagePreviewAt = entry.createdAt
      }
    }
    if (isAgentAuthoredEntry(entry)) {
      summary.lastAgentMessageAt = Math.max(summary.lastAgentMessageAt ?? 0, entry.createdAt)
    }
  }
  return summary
}

function normalizeSidebarProjectOrder(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const projectIds: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const projectId = entry.trim()
    if (!projectId || seen.has(projectId)) continue
    seen.add(projectId)
    projectIds.push(projectId)
  }

  return projectIds
}

function getReplayEventPriority(event: StoreEvent) {
  switch (event.type) {
    case "project_opened":
    case "project_pin_set":
    case "project_sidebar_renamed":
    case "project_removed":
      return 0
    case "chat_created":
      return 1
    case "chat_renamed":
    case "chat_provider_set":
    case "chat_plan_mode_set":
    case "chat_auto_plan_set":
      return 2
    case "message_appended":
      return 3
    case "queued_message_enqueued":
    case "queued_message_removed":
      return 4
    case "turn_started":
      return 5
    case "session_token_set":
      return 6
    case "pending_fork_session_token_set":
      return 6
    case "turn_cancelled":
    case "turn_resume_pending_set":
      return 7
    case "turn_finished":
    case "turn_failed":
      return 8
    case "chat_read_state_set":
    case "chat_done_state_set":
    case "chat_read_anchor_set":
    case "chat_files_touched":
    case "chat_last_message_at_set":
    case "chat_report_owed_set":
    case "chat_parent_set":
    case "chat_delegator_set":
      return 9
    case "chat_pin_set":
    case "chat_deleted":
    case "chat_archived":
    case "chat_unarchived":
      return 10
    case "schedule_set":
    case "schedule_deleted":
      return 11
  }
}

/**
 * Bump when the slim sweep learns a new rewrite, so data dirs swept by an
 * older build get the new pass on their next boot.
 */
const SLIM_SWEEP_VERSION = 3

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getForkedChatTitle(title: string) {
  const trimmed = title.trim()
  if (!trimmed) return "Fork: New Chat"
  return trimmed.startsWith("Fork: ") ? trimmed : `Fork: ${trimmed}`
}

const NOT_FOUND_MESSAGES = {
  project: "Project not found",
  chat: "Chat not found",
  schedule: "Schedule not found",
  queued_message: "Queued message not found",
} as const

/** A write named a project, chat, schedule or queued message the store does not have (or has deleted). */
export class EventStoreNotFoundError extends Schema.TaggedError<EventStoreNotFoundError>()(
  "@kanna/server/event-store/EventStoreNotFoundError",
  {
    entity: Schema.Literals(["project", "chat", "schedule", "queued_message"]),
    id: Schema.String,
  },
) {
  override get message() {
    return NOT_FOUND_MESSAGES[this.entity]
  }
}

/**
 * A synchronous transcript read for a chat whose transcript isn't in the
 * cache. A bug, not an expected failure: the caller should have held
 * `retainTranscript` around its reads. Thrown, so it surfaces as a defect.
 */
export class TranscriptNotLoadedError extends Schema.TaggedError<TranscriptNotLoadedError>()(
  "@kanna/server/event-store/TranscriptNotLoadedError",
  { chatId: Schema.String },
) {
  override get message() {
    return `Transcript of chat ${this.chatId} was read before it was loaded (hold retainTranscript around the read)`
  }
}

const REJECTED_MESSAGES = {
  invalid_chat_id: "Invalid chat id",
  chat_exists: "Chat already exists",
  not_forkable: "Chat cannot be forked",
  no_completed_turn: "Chat has no completed turn to fork from yet",
} as const

/** A write the store refuses as asked: a bad client chat id, or a fork with nothing to fork. */
export class EventStoreRejectedError extends Schema.TaggedError<EventStoreRejectedError>()(
  "@kanna/server/event-store/EventStoreRejectedError",
  {
    reason: Schema.Literals(["invalid_chat_id", "chat_exists", "not_forkable", "no_completed_turn"]),
    chatId: Schema.String,
  },
) {
  override get message() {
    return REJECTED_MESSAGES[this.reason]
  }
}

/** A file under the data dir could not be read, written or parsed. */
export class EventStoreFileError extends Schema.TaggedError<EventStoreFileError>()(
  "@kanna/server/event-store/EventStoreFileError",
  {
    operation: Schema.Literals(["read", "parse", "write", "append", "rename", "remove", "list"]),
    filePath: Schema.String,
    chatId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export interface LegacyTranscriptStats {
  hasLegacyData: boolean
  sources: Array<"snapshot" | "messages_log">
  chatCount: number
  entryCount: number
}

export interface SlimTranscriptsStats {
  chats: number
  rewritten: number
  bytesBefore: number
  bytesAfter: number
}

export interface StaleChatSweepOptions {
  now?: number
  maxAgeMs?: number
  activeChatIds?: Iterable<string>
  protectedChatIds?: Iterable<string>
}

export interface ClientTranscript {
  messages: TranscriptEntry[]
  startIndex: number
  readAnchor: ResolvedChatReadAnchor | null
  outline: TranscriptOutlineEntry[]
}

export interface EventStoreResourceCounts {
  transcriptCaches: number
  transcriptCacheEstimatedBytes: number
  transcriptCacheEntries: number
  transcriptLoads: number
  payloadIndexes: number
  storeQueuedWrites: number
}

/**
 * Callbacks the server wires after the store is built (`startKannaServer`).
 *
 * Plain callbacks rather than a `Stream`, on purpose: each fires synchronously
 * right after its event is applied, before the write's caller resumes. File
 * tracking snapshots the worktree on `onTurnStarted`, and that has to happen
 * before the turn's agent can touch a file, which a stream's asynchronous
 * delivery could not promise.
 */
export interface EventStoreHooks {
  /**
   * Fired after a turn reaches a terminal state — the same three events that
   * set `lastTurnEndedAt`. Deliberately distinct from `Agent.onStateChange`,
   * which fires per streamed token.
   */
  onTurnEnded?: (chatId: string) => void
  /**
   * Fired when a turn begins, so file tracking can snapshot the worktree before
   * the agent touches it. Paired with `onTurnEnded`.
   */
  onTurnStarted?: (chatId: string) => void
}

export interface EventStoreOptions {
  /** Defaults to the runtime profile's data dir (`~/.kanna/data`, `~/.kanna-dev/data`). */
  dataDir?: string
}

/** The runtime profile's data dir under `homeDir` (the machine's home, `Machine.homeDirectory`). */
export const defaultEventStoreDataDir = (homeDir: string) => getDataDir(homeDir)

type QueuedMessageInput = Omit<QueuedChatMessage, "id" | "createdAt"> & Partial<Pick<QueuedChatMessage, "id" | "createdAt">>

/**
 * Kanna's projects, chats, queues, schedules and transcripts: six append-only
 * JSONL event logs folded into memory, compacted into `snapshot.json`, plus
 * one transcript (and payload sidecar) per chat. See CLAUDE.md.
 *
 * Reads are synchronous and answer from memory: the router builds a snapshot
 * from many of them within one tick, so no write can land halfway through
 * one. A transcript is read only once it is loaded: `retainTranscript` loads
 * it (asynchronously, on the write chain) and keeps it in the cache until the
 * caller's scope closes. Reading one that isn't loaded is a bug and throws
 * `TranscriptNotLoadedError`; nothing reads the disk synchronously.
 *
 * Writes are Effects. Every write (event appends, transcript appends,
 * transcript loads and rewrites) runs on one FIFO chain, in the order the
 * writes started, and each applies its change in memory only once its bytes
 * are on disk. A failed write fails its caller and the chain carries on.
 */
export class EventStore extends Context.Service<EventStore, {
  readonly dataDir: string
  /** The folded state. Mutated in place by writes; callers must not mutate it. */
  readonly state: StoreState
  /**
   * Bumped on every change that can move a sidebar row: applied events,
   * project order, a reset, and transcript appends — the last only when they
   * moved something the sidebar can actually show. Read models memoize on it,
   * so a broadcast that changed nothing here skips the derive entirely.
   */
  readonly stateVersion: number
  /** Set by the server after construction; see `EventStoreHooks`. */
  readonly hooks: EventStoreHooks

  readonly getProject: (projectId: string) => ProjectRecord | null
  readonly getChat: (chatId: string) => ChatRecord | null
  /** Throws `EventStoreNotFoundError` for a missing or deleted chat. */
  readonly requireChat: (chatId: string) => ChatRecord
  readonly listProjects: () => ProjectRecord[]
  readonly listChatsByProject: (projectId: string) => ChatRecord[]
  readonly getSidebarProjectOrder: () => string[]
  readonly getSchedule: (scheduleId: string) => ChatSchedule | null
  readonly listSchedules: () => ChatSchedule[]
  readonly getQueuedMessages: (chatId: string) => QueuedChatMessage[]
  readonly getQueuedMessage: (chatId: string, queuedMessageId: string) => QueuedChatMessage | null
  /*
   * The transcript reads below answer from the cache and throw
   * `TranscriptNotLoadedError` for a chat whose transcript isn't loaded:
   * hold `retainTranscript` around them.
   */
  readonly getEntryDebugRaw: (chatId: string, entryId: string) => string | null
  readonly getClientTranscript: (chatId: string, fromIndex?: number) => ClientTranscript
  readonly getChatReadAnchor: (chatId: string) => ResolvedChatReadAnchor | null
  readonly getInitialTranscriptWindowStart: (chatId: string, assistantMessages: number) => number
  readonly widenTranscriptWindowStart: (
    chatId: string,
    currentStart: number,
    options: { assistantMessages: number; untilMessageId?: string; all?: boolean },
  ) => number
  readonly getRollingTranscriptWindowStart: (chatId: string, currentStart: number, assistantMessages: number) => number
  readonly getTranscriptLength: (chatId: string) => number
  readonly getEntryIdAt: (chatId: string, index: number) => string | null
  /** Absolute path of a chat's JSONL transcript (may not exist yet for a fresh chat). */
  readonly getTranscriptPath: (chatId: string) => string
  readonly resolveTranscriptMediaPath: (url: string) => string | null
  readonly getResourceCounts: () => EventStoreResourceCounts

  /**
   * Loads a chat's transcript into the cache (on the write chain, so a partial
   * append can't enter it) and keeps it there until the scope closes, so the
   * synchronous reads above can answer. Pinned before the load starts: nothing
   * can evict it between the load and the read.
   */
  readonly retainTranscript: (chatId: string) => Effect.Effect<void, EventStoreFileError, Scope.Scope>
  /**
   * The whole transcript with every tool body merged back in. This reads the
   * payload sidecar end to end, so it is for export, handoff and fork, not for
   * anything that runs per push.
   */
  readonly readMessages: (chatId: string) => Effect.Effect<TranscriptEntry[], EventStoreFileError | TranscriptPayloadReadError>
  /** Entries by id, with their payloads intact. Backs the tool-payload fetch. */
  readonly readEntriesById: (
    chatId: string,
    entryIds: string[],
  ) => Effect.Effect<TranscriptEntry[], EventStoreNotFoundError | EventStoreFileError | TranscriptPayloadReadError>

  readonly openProject: (localPath: string, title?: string) => Effect.Effect<ProjectRecord, EventStoreFileError>
  readonly removeProject: (projectId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly renameProjectSidebarTitle: (projectId: string, title: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setProjectPinned: (projectId: string, pinned: boolean, pinnedAt?: number) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setSidebarProjectOrder: (projectIds: string[]) => Effect.Effect<void, EventStoreFileError>
  readonly createChat: (
    projectId: string,
    lineage?: { parentChatId?: string; createdByChatId?: string },
    options?: { delegator?: boolean; chatId?: string },
  ) => Effect.Effect<ChatRecord, EventStoreNotFoundError | EventStoreRejectedError | EventStoreFileError>
  readonly forkChat: (
    sourceChatId: string,
    options?: { atLastCompletedTurn?: boolean; parentChatId?: string; createdByChatId?: string },
  ) => Effect.Effect<
    ChatRecord,
    EventStoreNotFoundError | EventStoreRejectedError | EventStoreFileError | TranscriptPayloadReadError | TranscriptMediaError
  >
  readonly renameChat: (chatId: string, title: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly deleteChat: (chatId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setChatPinned: (chatId: string, pinned: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly archiveChat: (chatId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly unarchiveChat: (chatId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly pruneStaleEmptyChats: (options?: StaleChatSweepOptions) => Effect.Effect<string[], EventStoreFileError | TranscriptMediaError>
  readonly autoArchiveStaleChats: (options?: StaleChatSweepOptions) => Effect.Effect<string[], EventStoreFileError>
  readonly deleteStaleChats: (options?: StaleChatSweepOptions) => Effect.Effect<string[], EventStoreFileError | TranscriptMediaError>
  readonly setChatProvider: (chatId: string, provider: AgentProvider) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setPlanMode: (chatId: string, planMode: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setAutoPlan: (chatId: string, autoPlan: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setChatReadState: (chatId: string, unread: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setChatDoneState: (chatId: string, done: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setReportOwed: (chatId: string, owed: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setChatDelegator: (chatId: string, delegator: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setReportedThrough: (chatId: string, through: number) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setChatParent: (
    chatId: string,
    parent: { parentChatId: string; adopted: boolean } | null,
  ) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setSchedule: (schedule: ChatSchedule) => Effect.Effect<ChatSchedule, EventStoreFileError>
  readonly deleteSchedule: (scheduleId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setChatReadAnchor: (
    chatId: string,
    messageId: string,
    atEnd: boolean,
    layout?: { transcriptWidth?: number; offsetFromMessage?: number },
  ) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly appendMessage: (
    chatId: string,
    entry: TranscriptEntry,
  ) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError | TranscriptMediaError>
  readonly enqueueMessage: (chatId: string, message: QueuedMessageInput) => Effect.Effect<QueuedChatMessage, EventStoreNotFoundError | EventStoreFileError>
  readonly removeQueuedMessage: (
    chatId: string,
    queuedMessageId: string,
  ) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly recordTurnStarted: (chatId: string, model?: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly recordFilesTouched: (chatId: string, files: TouchedFile[]) => Effect.Effect<void, EventStoreFileError>
  readonly recordTurnFinished: (chatId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly recordTurnFailed: (chatId: string, error: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly recordTurnCancelled: (chatId: string) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setTurnResumePending: (chatId: string, pending: boolean) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  readonly setSessionToken: (chatId: string, sessionToken: string | null) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>
  /** `pendingForkAt` is where the fork branches off that session (`ChatRecord.pendingForkAt`); cleared with the token. */
  readonly setPendingForkSessionToken: (
    chatId: string,
    pendingForkSessionToken: string | null,
    pendingForkAt?: string | null,
  ) => Effect.Effect<void, EventStoreNotFoundError | EventStoreFileError>

  /** Rewrites `snapshot.json` from memory and empties the event logs. Not on the write chain, as before. */
  readonly compact: Effect.Effect<void, EventStoreFileError>
  readonly getLegacyTranscriptStats: Effect.Effect<LegacyTranscriptStats, EventStoreFileError>
  readonly hasLegacyTranscriptData: Effect.Effect<boolean, EventStoreFileError>
  readonly migrateLegacyTranscripts: (onProgress?: (message: string) => void) => Effect.Effect<boolean, EventStoreFileError>
  readonly slimTranscripts: (options?: {
    force?: boolean
    onProgress?: (message: string) => void
  }) => Effect.Effect<SlimTranscriptsStats, EventStoreFileError>
}>()("@kanna/server/EventStore") {
  /**
   * Builds the store: creates the data dir, loads the snapshot, replays the
   * logs, and compacts when they have grown. Records diagnostics into
   * `PerformanceLog` when one is provided.
   */
  static readonly layer = (options: EventStoreOptions = {}) => Layer.effect(this, makeEventStore(options))
  static readonly make = (options: EventStoreOptions = {}) => makeEventStore(options)
}

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeJsonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const SlimMarker = Schema.fromJsonString(Schema.Struct({ version: Schema.optionalKey(Schema.Unknown) }))
const decodeSlimMarker = Schema.decodeUnknownOption(SlimMarker)

/**
 * `value.v`, read the way the old `JSON.parse(line).v` did: a line holding
 * `null` throws there, and counted as a corrupt line rather than a version
 * mismatch. Kept so a log reads exactly as it did.
 */
function readField(value: unknown, field: string): Result.Result<unknown, unknown> {
  return Result.try(() => (value as Record<string, unknown>)[field])
}

/**
 * Lines of a transcript file from `start`, parsed into `entries`, until the
 * text ends or `budgetMs` has passed. Returns where to carry on. A corrupt
 * line throws: a transcript that does not parse is not served half-read.
 *
 * TranscriptEntry has no Schema (shared/types.ts stays plain types); the
 * lines are this store's own, written by `appendMessage`.
 */
function parseTranscriptLines(text: string, start: number, entries: TranscriptEntry[], budgetMs = Infinity) {
  const started = performance.now()
  let offset = start
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(offset, end).trim()
    if (line) {
      const parsed = decodeJsonLine(line)
      if (Option.isNone(parsed)) throw new SyntaxError(`Corrupt transcript line at byte ${offset}`)
      entries.push(parsed.value as TranscriptEntry)
    }
    offset = end + 1
    if (performance.now() - started >= budgetMs) break
  }
  return offset
}

/**
 * The in-memory half of the store: folded state, the transcript and payload
 * caches, and every synchronous read. No Effect here; the IO lives in
 * `makeEventStore`, which owns one of these.
 */
class StoreMemory {
  readonly state: StoreState = createEmptyState()
  stateVersion = 0
  storageReset = false
  transcriptsDirReady = false
  readonly paths: {
    snapshot: string
    projectsLog: string
    chatsLog: string
    messagesLog: string
    queuedMessagesLog: string
    turnsLog: string
    schedulesLog: string
    transcriptsDir: string
    /** Written once `slimTranscripts` has swept this data dir. */
    slimMarker: string
    sidebarProjectOrder: string
  }
  readonly hooks: EventStoreHooks = {}
  legacyMessagesByChatId = new Map<string, TranscriptEntry[]>()
  legacySidebarProjectOrder: string[] = []
  sidebarProjectOrder: string[] = []
  snapshotHasLegacyMessages = false
  // A byte budget avoids eviction on every read when several chats stay open.
  readonly transcriptCache = new Map<string, TranscriptEntry[]>()
  static readonly TRANSCRIPT_CACHE_LIMIT = 256
  static readonly TRANSCRIPT_CACHE_BYTES = 128 * 1024 * 1024
  readonly transcriptBytes = new Map<string, number>()
  readonly transcriptLoads = new Map<string, Deferred.Deferred<void, EventStoreFileError>>()
  /** Readers holding each transcript (`retainTranscript`); a pinned one is never evicted. */
  readonly transcriptPins = new Map<string, number>()
  queuedWrites = 0
  /**
   * Offsets into each chat's payload sidecar (`transcript-payloads.ts`).
   * Built on first payload read, evicted with the transcript cache.
   */
  readonly payloadIndexes = new Map<string, TranscriptPayloadIndex>()
  /**
   * Outline per cached transcript, rebuilt only when a prompt was appended.
   * Keyed by the entries array, which appends grow in place and a reload
   * replaces, so a stale array can never serve a stale outline. Between
   * prompts only the appended tail is scanned.
   */
  private readonly outlineCache = new WeakMap<TranscriptEntry[], { length: number; outline: TranscriptOutlineEntry[] }>()

  constructor(
    readonly dataDir: string,
    readonly record: (name: string, value?: number) => void,
    /** Where `~` in a project path points. */
    readonly machine: Pick<Machine["Service"], "homeDirectory">,
  ) {
    this.paths = {
      snapshot: path.join(dataDir, "snapshot.json"),
      projectsLog: path.join(dataDir, "projects.jsonl"),
      chatsLog: path.join(dataDir, "chats.jsonl"),
      messagesLog: path.join(dataDir, "messages.jsonl"),
      queuedMessagesLog: path.join(dataDir, "queued-messages.jsonl"),
      turnsLog: path.join(dataDir, "turns.jsonl"),
      schedulesLog: path.join(dataDir, "schedules.jsonl"),
      transcriptsDir: path.join(dataDir, "transcripts"),
      slimMarker: path.join(dataDir, "transcripts-slim.json"),
      sidebarProjectOrder: path.join(dataDir, SIDEBAR_PROJECT_ORDER_FILE),
    }
  }

  get eventLogPaths() {
    return [
      this.paths.projectsLog,
      this.paths.chatsLog,
      this.paths.messagesLog,
      this.paths.queuedMessagesLog,
      this.paths.turnsLog,
      this.paths.schedulesLog,
    ]
  }

  applySnapshot(parsed: SnapshotFile) {
    for (const project of parsed.projects) {
      this.state.projectsById.set(project.id, { ...project })
      this.state.projectIdsByPath.set(project.localPath, project.id)
    }
    for (const chat of parsed.chats) {
      const { touchedPaths, ...rest } = chat
      this.state.chatsById.set(chat.id, {
        ...rest,
        unread: chat.unread ?? false,
        readAnchor: chat.readAnchor ?? null,
        pendingForkSessionToken: chat.pendingForkSessionToken ?? null,
        // Snapshots written before base blobs carry bare paths; they keep
        // their old "any dirty match counts" reading rather than being
        // guessed a base that could expire them wrongly.
        ...(chat.touchedFiles ?? touchedPaths
          ? { touchedFiles: mergeTouchedFiles(
              touchedPaths?.map((filePath) => ({ path: filePath })),
              chat.touchedFiles ?? []
            ) }
          : {}),
      })
    }
    this.legacySidebarProjectOrder = normalizeSidebarProjectOrder(parsed.sidebarProjectOrder)
    if (parsed.queuedMessages?.length) {
      for (const queuedSet of parsed.queuedMessages) {
        this.state.queuedMessagesByChatId.set(queuedSet.chatId, queuedSet.entries.map((entry) => ({
          ...entry,
          attachments: [...entry.attachments],
        })))
      }
    }
    for (const schedule of parsed.schedules ?? []) {
      this.state.schedulesById.set(schedule.id, { ...schedule })
    }
    if (parsed.messages?.length) {
      this.snapshotHasLegacyMessages = true
      for (const messageSet of parsed.messages) {
        this.legacyMessagesByChatId.set(messageSet.chatId, cloneTranscriptEntries(messageSet.entries))
      }
    }
  }

  resetState() {
    this.stateVersion += 1
    this.state.projectsById.clear()
    this.state.projectIdsByPath.clear()
    this.state.chatsById.clear()
    this.state.queuedMessagesByChatId.clear()
    this.state.schedulesById.clear()
    this.sidebarProjectOrder = []
    this.legacySidebarProjectOrder = []
    this.transcriptCache.clear()
    this.transcriptBytes.clear()
    this.payloadIndexes.clear()
  }

  pinTranscript(chatId: string) {
    this.transcriptPins.set(chatId, (this.transcriptPins.get(chatId) ?? 0) + 1)
  }

  /**
   * Lets go of a pin. Doesn't trim: eviction happens only on the write chain
   * (a load or an append), where it can't land between another load and the
   * read it was for. The next insertion brings the cache back under budget.
   */
  unpinTranscript(chatId: string) {
    const count = (this.transcriptPins.get(chatId) ?? 0) - 1
    if (count > 0) this.transcriptPins.set(chatId, count)
    else this.transcriptPins.delete(chatId)
  }

  clearLegacyTranscriptState() {
    this.legacyMessagesByChatId.clear()
    this.snapshotHasLegacyMessages = false
  }

  applyEvent(event: StoreEvent) {
    this.stateVersion += 1
    switch (event.type) {
      case "project_opened": {
        const localPath = resolveLocalPath(event.localPath, this.machine.homeDirectory)
        const project = {
          id: event.projectId,
          localPath,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
        this.state.projectsById.set(project.id, project)
        this.state.projectIdsByPath.set(localPath, project.id)
        break
      }
      case "project_removed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        project.deletedAt = event.timestamp
        project.updatedAt = event.timestamp
        this.state.projectIdsByPath.delete(project.localPath)
        break
      }
      case "project_sidebar_renamed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        if (event.title) {
          project.sidebarTitle = event.title
        } else {
          delete project.sidebarTitle
        }
        project.updatedAt = event.timestamp
        break
      }
      case "project_pin_set": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        if (event.pinned) project.pinnedAt = event.pinnedAt ?? event.timestamp
        else delete project.pinnedAt
        project.updatedAt = event.timestamp
        break
      }
      case "chat_created": {
      const chat = {
          id: event.chatId,
          projectId: event.projectId,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          unread: false,
          provider: null,
          planMode: false,
          autoPlan: false,
          sessionToken: null,
          pendingForkSessionToken: null,
          hasMessages: false,
          lastTurnOutcome: null,
          // Forks carry the source's turn-end timestamp on the create event
          // (they have no turn events of their own to replay).
          ...(event.lastTurnEndedAt != null ? { lastTurnEndedAt: event.lastTurnEndedAt } : {}),
          ...(event.parentChatId ? { parentChatId: event.parentChatId } : {}),
          ...(event.forkedFromChatId ? { forkedFromChatId: event.forkedFromChatId } : {}),
          ...(event.createdByChatId ? { createdByChatId: event.createdByChatId } : {}),
          ...(event.delegator ? { delegator: true as const } : {}),
        }
        this.state.chatsById.set(chat.id, chat)
        break
      }
      case "chat_delegator_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        // A setting, not activity: `updatedAt` stays put so the sidebar does not reorder.
        if (event.delegator) chat.delegator = true
        else delete chat.delegator
        break
      }
      case "chat_report_owed_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        // Bookkeeping between two chats, not activity in this one: `updatedAt`
        // stays put so the sidebar does not reorder.
        if (event.owed) {
          chat.reportOwed = true
          if (event.reportedThrough !== undefined) chat.reportedThrough = event.reportedThrough
        } else {
          delete chat.reportOwed
          delete chat.reportedThrough
        }
        break
      }
      case "chat_parent_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        // Like the report flag, a change between two chats: `updatedAt` stays put.
        if (event.parentChatId) chat.parentChatId = event.parentChatId
        else delete chat.parentChatId
        if (event.parentChatId && event.adopted) chat.adopted = true
        else delete chat.adopted
        break
      }
      case "schedule_set": {
        this.state.schedulesById.set(event.schedule.id, { ...event.schedule })
        break
      }
      case "schedule_deleted": {
        this.state.schedulesById.delete(event.scheduleId)
        break
      }
      case "chat_pin_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        if (event.pinned) chat.pinnedAt = event.timestamp
        else delete chat.pinnedAt
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_renamed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.title = event.title
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_deleted": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.deletedAt = event.timestamp
        chat.updatedAt = event.timestamp
        this.state.queuedMessagesByChatId.delete(event.chatId)
        break
      }
      case "chat_archived": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        delete chat.pinnedAt
        chat.archivedAt = event.timestamp
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_unarchived": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        delete chat.archivedAt
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_provider_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.provider = event.provider
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_plan_mode_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.planMode = event.planMode
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_auto_plan_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.autoPlan = event.autoPlan
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_read_state_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.unread = event.unread
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_read_anchor_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.readAnchor = {
          messageId: event.messageId,
          atEnd: event.atEnd,
          updatedAt: event.timestamp,
          ...(event.transcriptWidth != null ? { transcriptWidth: event.transcriptWidth } : {}),
          ...(event.offsetFromMessage != null ? { offsetFromMessage: event.offsetFromMessage } : {}),
        }
        // Intentionally does not bump `updatedAt` — a scroll is not a chat
        // mutation, and bumping it would churn sidebar ordering/signatures.
        break
      }
      case "chat_last_message_at_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        // Exactly what `applyMessageMetadata` does for the prompt this event
        // stands in for, so a restart lands on the same state the live append
        // did — including `updatedAt`, which a user message legitimately moves.
        chat.lastMessageAt = Math.max(chat.lastMessageAt ?? 0, event.at)
        chat.hasMessages = true
        chat.updatedAt = Math.max(chat.updatedAt, event.at)
        break
      }
      case "chat_files_touched": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.touchedFiles = mergeTouchedFiles(chat.touchedFiles, readTouchedFiles(event))
        // Like the read anchor, this is bookkeeping about a chat rather than a
        // change to it — bumping `updatedAt` would churn sidebar ordering.
        break
      }
      case "chat_done_state_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        if (event.done) {
          chat.doneAt = event.timestamp
        } else {
          delete chat.doneAt
        }
        chat.updatedAt = event.timestamp
        break
      }
      case "message_appended": {
        this.applyMessageMetadata(event.chatId, event.entry)
        const existing = this.legacyMessagesByChatId.get(event.chatId) ?? []
        existing.push({ ...event.entry })
        this.legacyMessagesByChatId.set(event.chatId, existing)
        break
      }
      case "queued_message_enqueued": {
        const existing = this.state.queuedMessagesByChatId.get(event.chatId) ?? []
        existing.push({
          ...event.message,
          attachments: [...event.message.attachments],
        })
        this.state.queuedMessagesByChatId.set(event.chatId, existing)
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "queued_message_removed": {
        const existing = this.state.queuedMessagesByChatId.get(event.chatId) ?? []
        const next = existing.filter((entry) => entry.id !== event.queuedMessageId)
        if (next.length > 0) {
          this.state.queuedMessagesByChatId.set(event.chatId, next)
        } else {
          this.state.queuedMessagesByChatId.delete(event.chatId)
        }
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "turn_started": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnStartedAt = event.timestamp
        chat.turnCount = (chat.turnCount ?? 0) + 1
        // Kept from the previous turn when this one didn't name a model, so a
        // resumed background turn doesn't blank what the chat last ran with.
        if (event.model) chat.lastModel = event.model
        // A new turn means the user re-engaged, so the chat is no longer "done".
        delete chat.doneAt
        break
      }
      case "turn_finished": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.unread = true
        chat.lastTurnOutcome = "success"
        chat.lastTurnEndedAt = event.timestamp
        break
      }
      case "turn_failed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.unread = true
        chat.lastTurnOutcome = "failed"
        chat.lastTurnEndedAt = event.timestamp
        break
      }
      case "turn_cancelled": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnOutcome = "cancelled"
        chat.lastTurnEndedAt = event.timestamp
        break
      }
      case "turn_resume_pending_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        if (event.pending) {
          chat.resumePending = true
        } else {
          delete chat.resumePending
        }
        break
      }
      case "session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.sessionToken = event.sessionToken
        chat.updatedAt = event.timestamp
        break
      }
      case "pending_fork_session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.pendingForkSessionToken = event.pendingForkSessionToken
        chat.pendingForkAt = event.pendingForkAt ?? null
        chat.updatedAt = event.timestamp
        break
      }
    }
  }

  /**
   * The part of a chat the sidebar snapshot can actually show.
   *
   * `applyMessageMetadata` touches seven fields, but the sidebar reads only
   * three: `hasMessages` (its archived-chat filter), `lastMessageAt` (sort key,
   * row field, recent/older bucket) and `lastAgentMessageAt` — the last one
   * quantized, so sub-15s movement is invisible on the wire. The previews and
   * `updatedAt` never reach the sidebar at all; the hover card fetches previews
   * through a separate command.
   */
  private sidebarVisibleSignature(chat: ChatRecord) {
    const activityBucket = chat.lastAgentMessageAt == null
      ? ""
      : Math.floor(chat.lastAgentMessageAt / SIDEBAR_ACTIVITY_RESOLUTION_MS)
    return `${chat.hasMessages}|${chat.lastMessageAt ?? ""}|${activityBucket}`
  }

  applyMessageMetadata(chatId: string, entry: TranscriptEntry) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat) {
      // No chat to compare against; keep the unconditional bump.
      this.stateVersion += 1
      return
    }
    // `stateVersion` has exactly one consumer: the sidebar memo key in
    // ws-router. Bumping it per appended entry made a streaming turn re-derive
    // the whole sidebar and stringify the whole snapshot many times a second,
    // only for the signature compare to drop the push as byte-identical.
    const sidebarBefore = this.sidebarVisibleSignature(chat)
    chat.hasMessages = true
    if (entry.kind === "user_prompt") {
      // Monotonic, like `lastAgentMessageAt` below and like the logged stamp
      // this mirrors (`recordLastMessageAt`), which only ever moves forward.
      // Assigning outright let two things walk it backwards: an out-of-order
      // append, and boot re-reading a fork's copied transcript, where the
      // inherited timestamp would lose to the older prompt inside the copy.
      chat.lastMessageAt = Math.max(chat.lastMessageAt ?? 0, entry.createdAt)
      if (!entry.hidden) {
        const preview = buildChatMessagePreview(entry.content)
        if (preview) chat.lastUserMessagePreview = preview
      }
    } else if (entry.kind === "assistant_text" && !entry.hidden && !entry.parentToolUseId) {
      // A subagent's text is not the reply; the main agent's next text is.
      const preview = buildChatMessagePreview(entry.text)
      if (preview) {
        chat.lastAgentMessagePreview = preview
        // Stamped so a reader can tell whether the preview answers the latest
        // prompt or the one before it. `lastAgentMessageAt` can't: it advances
        // on tool calls too, so it moves while the text is still stale.
        chat.lastAgentMessagePreviewAt = entry.createdAt
      }
    }
    if (isAgentAuthoredEntry(entry)) {
      // Hidden entries count: this is "when did the agent last do something",
      // not "what can we show" — same split as lastMessageAt vs its preview.
      chat.lastAgentMessageAt = Math.max(chat.lastAgentMessageAt ?? 0, entry.createdAt)
    }
    chat.updatedAt = Math.max(chat.updatedAt, entry.createdAt)
    if (this.sidebarVisibleSignature(chat) !== sidebarBefore) {
      this.stateVersion += 1
    }
  }

  getResourceCounts(): EventStoreResourceCounts {
    return {
      transcriptCaches: this.transcriptCache.size,
      transcriptCacheEstimatedBytes: [...this.transcriptBytes.values()].reduce((sum, size) => sum + size, 0),
      transcriptCacheEntries: [...this.transcriptCache.values()].reduce((sum, entries) => sum + entries.length, 0),
      transcriptLoads: this.transcriptLoads.size,
      payloadIndexes: this.payloadIndexes.size,
      storeQueuedWrites: this.queuedWrites,
    }
  }

  getRollingTranscriptWindowStart(chatId: string, currentStart: number, assistantMessages: number) {
    const entries = this.getTranscriptEntries(chatId)
    const start = findTranscriptWindowStart(entries, {
      endExclusive: entries.length,
      assistantMessages: assistantMessages * 2,
    })
    return Math.max(currentStart, start)
  }

  getTranscriptLength(chatId: string) {
    return this.getTranscriptEntries(chatId).length
  }

  transcriptPath(chatId: string) {
    return path.join(this.paths.transcriptsDir, `${chatId}.jsonl`)
  }

  payloadSidecarPath(chatId: string) {
    return path.join(this.paths.transcriptsDir, `${chatId}.payloads.jsonl`)
  }

  setPayloadIndex(chatId: string, index: TranscriptPayloadIndex) {
    while (this.payloadIndexes.size >= 16) {
      const oldest = this.payloadIndexes.keys().next().value
      if (oldest === undefined) break
      this.payloadIndexes.delete(oldest)
    }
    this.payloadIndexes.set(chatId, index)
    return index
  }

  /**
   * Whether a result belongs to a tool that renders inline and so keeps its
   * content in the header. The call is almost always the previous entry or
   * close to it, so the backward scan ends fast.
   */
  isInlineResult(chatId: string, toolId: string) {
    return INLINE_TOOL_KINDS.has(this.getToolKind(chatId, toolId) ?? "")
  }

  getToolKind(chatId: string, toolId: string) {
    const entries = this.getTranscriptEntries(chatId)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (entry.kind === "tool_call" && entry.tool.toolId === toolId) {
        return entry.tool.toolKind
      }
    }
    return undefined
  }

  dropTranscriptCaches(chatId: string) {
    this.transcriptCache.delete(chatId)
    this.transcriptBytes.delete(chatId)
    this.payloadIndexes.delete(chatId)
  }

  /**
   * Absolute path of the file behind a transcript media URL, or null when
   * the URL is not one of ours or names a chat this store does not have.
   */
  resolveTranscriptMediaPath(url: string) {
    const parsed = parseTranscriptMediaUrl(url)
    if (!parsed || !this.state.chatsById.has(parsed.chatId)) return null
    return path.join(getTranscriptMediaDir(this.dataDir, parsed.chatId), parsed.name)
  }

  /**
   * Every entry for a chat as the transcript file holds it, which is header
   * form: tool bodies live in the payload sidecar and are merged back only by
   * `readEntriesById` and `readMessages`. Answers from the cache; a transcript
   * that isn't loaded throws `TranscriptNotLoadedError` (see
   * `retainTranscript`). Callers must not mutate.
   */
  getTranscriptEntries(chatId: string): TranscriptEntry[] {
    const cached = this.transcriptCache.get(chatId)
    if (cached) {
      // Refresh LRU recency.
      this.transcriptCache.delete(chatId)
      this.transcriptCache.set(chatId, cached)
      return cached
    }
    // A pre-sidecar snapshot keeps its transcripts in memory already.
    const legacyEntries = this.legacyMessagesByChatId.get(chatId)
    if (!legacyEntries) {
      this.record("transcript_unloaded_reads")
      throw new TranscriptNotLoadedError({ chatId })
    }
    const entries = cloneTranscriptEntries(legacyEntries)
    this.setCachedTranscript(chatId, entries)
    return entries
  }

  setCachedTranscript(chatId: string, entries: TranscriptEntry[], estimatedBytes?: number) {
    this.transcriptCache.delete(chatId)
    this.transcriptCache.set(chatId, entries)
    this.transcriptBytes.set(chatId, estimatedBytes ?? JSON.stringify(entries).length * 2 + entries.length * 512)
    this.trimTranscriptCache(chatId)
  }

  trimTranscriptCache(keepChatId: string) {
    let bytes = [...this.transcriptBytes.values()].reduce((sum, size) => sum + size, 0)
    for (const oldest of this.transcriptCache.keys()) {
      if (this.transcriptCache.size <= StoreMemory.TRANSCRIPT_CACHE_LIMIT && bytes <= StoreMemory.TRANSCRIPT_CACHE_BYTES) break
      // The one just inserted, and any a reader holds, stay.
      if (oldest === keepChatId || this.transcriptPins.has(oldest)) continue
      bytes -= this.transcriptBytes.get(oldest) ?? 0
      this.dropTranscriptCaches(oldest)
      this.record("transcript_cache_evictions")
    }
  }

  getProject(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) return null
    return project
  }

  requireChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) {
      throw new EventStoreNotFoundError({ entity: "chat", id: chatId })
    }
    return chat
  }

  getChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) return null
    return chat
  }

  getSidebarProjectOrder() {
    return [...this.sidebarProjectOrder]
  }

  getSchedule(scheduleId: string) {
    const schedule = this.state.schedulesById.get(scheduleId)
    return schedule ? { ...schedule } : null
  }

  listSchedules() {
    return [...this.state.schedulesById.values()]
      .map((schedule) => ({ ...schedule }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Resolve a chat's stored read anchor against the current transcript.
   * Returns null when nothing is stored or the anchored message no longer
   * exists (deleted, or compacted away), so the client can fall back.
   *
   * `distanceFromEnd` lets the client widen its subscription window in one
   * round trip when the anchor sits outside the default recent page.
   */
  getChatReadAnchor(chatId: string): ResolvedChatReadAnchor | null {
    const chat = this.requireChat(chatId)
    const anchor = chat.readAnchor
    if (!anchor) return null

    const entries = this.getTranscriptEntries(chatId)
    if (!entries.some((entry) => entry._id === anchor.messageId)) return null

    return {
      messageId: anchor.messageId,
      atEnd: anchor.atEnd,
      ...(anchor.transcriptWidth != null ? { transcriptWidth: anchor.transcriptWidth } : {}),
      ...(anchor.offsetFromMessage != null ? { offsetFromMessage: anchor.offsetFromMessage } : {}),
    }
  }

  /**
   * Where a socket's window on this chat should start when it opens: the
   * last `assistantMessages` assistant texts, widened to reach the stored
   * read anchor so restoring a position never lands outside the window.
   */
  getInitialTranscriptWindowStart(chatId: string, assistantMessages: number): number {
    const entries = this.getTranscriptEntries(chatId)
    const anchor = this.getChatReadAnchor(chatId)
    const anchorIndex = anchor && !anchor.atEnd
      ? entries.findIndex((entry) => entry._id === anchor.messageId)
      : -1
    return findTranscriptWindowStart(entries, {
      endExclusive: entries.length,
      assistantMessages,
      ...(anchorIndex >= 0 ? { mustIncludeIndex: anchorIndex } : {}),
    })
  }

  /**
   * A window start further back than `currentStart`: one more window of
   * assistant messages, or far enough to include `untilMessageId`, or 0 for
   * everything. Never moves forward; a target already inside the window
   * leaves it alone.
   */
  widenTranscriptWindowStart(
    chatId: string,
    currentStart: number,
    options: { assistantMessages: number; untilMessageId?: string; all?: boolean }
  ): number {
    if (options.all) return 0
    const entries = this.getTranscriptEntries(chatId)
    const start = Math.max(0, Math.min(currentStart, entries.length))
    if (options.untilMessageId !== undefined) {
      const index = entries.findIndex((entry) => entry._id === options.untilMessageId)
      if (index < 0 || index >= start) return start
      return findTranscriptWindowStart(entries, {
        endExclusive: start,
        assistantMessages: options.assistantMessages,
        mustIncludeIndex: index,
      })
    }
    return findTranscriptWindowStart(entries, { endExclusive: start, assistantMessages: options.assistantMessages })
  }

  /**
   * `_id` of the entry at an absolute index, or null when the index is out of
   * range or sits before the loaded window.
   *
   * Deliberately refuses to widen the window to answer: this exists to check a
   * client's cached position, and a cache that reaches further back than the
   * server is holding is not worth a full transcript read to validate — the
   * caller just sends a full window instead.
   */
  getEntryIdAt(chatId: string, index: number): string | null {
    if (index < 0) return null
    return this.transcriptCache.get(chatId)?.[index]?._id ?? null
  }

  /**
   * The entries `entryIds` names, in transcript order, each merged with what
   * `readPayload` returns for it. Only headers marked `trimmed` have a sidecar
   * line; anything else (an inline kind, or a transcript written before the
   * sidecar) is already whole.
   */
  collectEntriesById(chatId: string, entryIds: string[], readPayload: (entryId: string) => TranscriptPayload | null | undefined) {
    const wanted = new Set(entryIds)
    const found: TranscriptEntry[] = []
    for (const entry of this.getTranscriptEntries(chatId)) {
      if (!wanted.has(entry._id)) continue
      const { debugRaw, ...rest } = entry
      const payload = rest.trimmed ? readPayload(rest._id) : null
      found.push(mergeTranscriptPayload(rest as TranscriptEntry, payload ?? undefined))
      if (found.length === wanted.size) break
    }
    return found
  }

  /**
   * The raw provider payload for one entry, or null if the entry is gone or
   * never carried one. Snapshots strip `debugRaw`; this backs the raw JSON
   * debug view, which is opened rarely enough that a full transcript read is
   * an acceptable cost.
   */
  getEntryDebugRaw(chatId: string, entryId: string): string | null {
    this.requireChat(chatId)
    const entries = this.getTranscriptEntries(chatId)
    return entries.find((entry) => entry._id === entryId)?.debugRaw ?? null
  }

  getQueuedMessages(chatId: string) {
    const entries = this.state.queuedMessagesByChatId.get(chatId) ?? []
    return entries.map((entry) => ({
      ...entry,
      attachments: [...entry.attachments],
    }))
  }

  getQueuedMessage(chatId: string, queuedMessageId: string) {
    return this.getQueuedMessages(chatId).find((entry) => entry.id === queuedMessageId) ?? null
  }

  /**
   * The transcript as a client sees it, from `fromIndex` on.
   *
   * Cloning is per entry, so a push used to clone the whole chat and then
   * throw away everything before the window. Callers pass the earliest index
   * any subscriber holds. `startIndex` records where the clone begins so the
   * router can still slice per socket.
   */
  getClientTranscript(chatId: string, fromIndex = 0): ClientTranscript {
    const entries = this.getTranscriptEntries(chatId)
    const start = Math.max(0, Math.min(fromIndex, entries.length))
    return {
      messages: cloneTranscriptEntriesForClient(
        start === 0 ? entries : entries.slice(start),
        (toolId) => this.getToolKind(chatId, toolId),
      ),
      startIndex: start,
      readAnchor: this.getChatReadAnchor(chatId),
      outline: this.getTranscriptOutline(entries),
    }
  }

  private getTranscriptOutline(entries: TranscriptEntry[]): TranscriptOutlineEntry[] {
    const cached = this.outlineCache.get(entries)
    if (cached && cached.length <= entries.length) {
      let promptAppended = false
      for (let index = cached.length; index < entries.length; index += 1) {
        if (entries[index]!.kind === "user_prompt") {
          promptAppended = true
          break
        }
      }
      if (!promptAppended) {
        cached.length = entries.length
        return cached.outline
      }
    }
    const outline = buildTranscriptOutline(entries)
    this.outlineCache.set(entries, { length: entries.length, outline })
    return outline
  }

  listProjects() {
    return [...this.state.projectsById.values()].filter((project) => !project.deletedAt)
  }

  listChatsByProject(projectId: string) {
    return [...this.state.chatsById.values()]
      .filter((chat) => chat.projectId === projectId && !chat.deletedAt && !chat.archivedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
  }

  /**
   * The most recent activity across all live chats — the reference point the
   * staleness sweeps measure against. Anchoring to the user's own activity
   * (never the wall clock) means an idle month away moves nothing: chats only
   * become "stale" relative to newer work, not relative to time passing.
   */
  latestChatActivityAt(): number | null {
    let latest: number | null = null
    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt) continue
      const at = chat.lastMessageAt ?? chat.createdAt
      if (latest == null || at > latest) latest = at
    }
    return latest
  }

  legacyTranscriptStats(messagesLogSize: number): LegacyTranscriptStats {
    const sources: LegacyTranscriptStats["sources"] = []
    if (this.snapshotHasLegacyMessages) {
      sources.push("snapshot")
    }
    if (messagesLogSize > 0) {
      sources.push("messages_log")
    }

    let entryCount = 0
    for (const entries of this.legacyMessagesByChatId.values()) {
      entryCount += entries.length
    }

    return {
      hasLegacyData: sources.length > 0 || this.legacyMessagesByChatId.size > 0,
      sources,
      chatCount: this.legacyMessagesByChatId.size,
      entryCount,
    }
  }

  createSnapshot(): SnapshotFile {
    return {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      projects: this.listProjects().map((project) => ({ ...project })),
      chats: [...this.state.chatsById.values()]
        .filter((chat) => !chat.deletedAt)
        .map((chat) => ({ ...chat })),
      queuedMessages: [...this.state.queuedMessagesByChatId.entries()]
        .map(([chatId, entries]) => ({
          chatId,
          entries: entries.map((entry) => ({
            ...entry,
            attachments: [...entry.attachments],
          })),
        })),
      schedules: this.listSchedules(),
    }
  }
}

function mergeMessages(entries: TranscriptEntry[], payloads: Map<string, TranscriptPayload>) {
  return entries.map((entry) => entry.trimmed
    ? mergeTranscriptPayload({ ...entry }, payloads.get(entry._id))
    : { ...entry })
}

interface ParsedReplayEvent {
  event: StoreEvent
  sourceIndex: number
  lineIndex: number
}

const makeEventStore = Effect.fn("EventStore.make")(function* (options: EventStoreOptions) {
  const fs = yield* FileSystem.FileSystem
  const extras = yield* FileSystemExtras
  const diagnostics = yield* Effect.serviceOption(PerformanceLog)
  const machine = yield* Machine
  const dataDir = options.dataDir ?? defaultEventStoreDataDir(machine.homeDirectory)
  yield* Effect.annotateCurrentSpan("dataDir", dataDir)

  // Synchronous code (the cache trim on a read) records too, so this runs
  // the record directly: it is an in-memory update with no requirements.
  const record = (name: string, value?: number) => {
    if (Option.isSome(diagnostics)) Effect.runSync(diagnostics.value.record(name, value))
  }
  const memory = new StoreMemory(dataDir, record, machine)
  const { paths } = memory
  const withFs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(FileSystemExtras, extras))

  const fileError = (operation: EventStoreFileError["operation"], filePath: string, chatId?: string) => (cause: unknown) =>
    Effect.fail(new EventStoreFileError({ operation, filePath, cause, ...(chatId === undefined ? {} : { chatId }) }))

  const writeText = (filePath: string, text: string, chatId?: string) =>
    fs.writeFileString(filePath, text).pipe(Effect.catchTag("PlatformError", fileError("write", filePath, chatId)))

  const appendText = (filePath: string, text: string, chatId?: string) =>
    fs.writeFileString(filePath, text, { flag: "a" }).pipe(Effect.catchTag("PlatformError", fileError("append", filePath, chatId)))

  const makeDirectory = (directory: string) =>
    fs.makeDirectory(directory, { recursive: true }).pipe(Effect.catchTag("PlatformError", fileError("write", directory)))

  /** The file's text, or none when it does not exist. */
  const readTextIfExists = (filePath: string, chatId?: string) =>
    fs.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.catchTag("PlatformError", fileError("read", filePath, chatId)),
    )

  /** Size in bytes; a missing file is 0, as `Bun.file(path).size` read it. */
  const fileSize = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0)),
      Effect.catchTag("PlatformError", fileError("read", filePath)),
    )

  const removeFile = (filePath: string, chatId: string) =>
    fs.remove(filePath, { force: true }).pipe(Effect.catchTag("PlatformError", fileError("remove", filePath, chatId)))

  const ensureTranscriptsDir = Effect.suspend(() => {
    if (memory.transcriptsDirReady) return Effect.void
    return makeDirectory(paths.transcriptsDir).pipe(Effect.tap(() => Effect.sync(() => { memory.transcriptsDirReady = true })))
  })

  const ensureFile = (filePath: string) =>
    fs.exists(filePath).pipe(
      Effect.catchTag("PlatformError", fileError("read", filePath)),
      Effect.flatMap((exists) => exists ? Effect.void : writeText(filePath, "")),
    )

  // ---- The write chain --------------------------------------------------
  //
  // Every write runs after the one queued before it has finished, failed or
  // not, in the order the writes started. A FIFO of Deferreds rather than a
  // Semaphore: a semaphore lets a newcomer take a free permit ahead of writers
  // already waiting, and appends must land in the order they were made.
  // Uninterruptible once queued, as the Promise chain it replaces was: an
  // interrupted caller still waits for its write to finish.
  let tail: Effect.Effect<void> = Effect.void
  const enqueueWrite = <A, E>(run: Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.suspend(() => {
    const queuedAt = performance.now()
    memory.queuedWrites += 1
    const previous = tail
    const done = Deferred.makeUnsafe<void>()
    tail = Deferred.await(done)
    return previous.pipe(
      Effect.andThen(Effect.sync(() => record("store_queue_wait_ms", performance.now() - queuedAt))),
      Effect.andThen(run),
      Effect.ensuring(Effect.sync(() => { memory.queuedWrites -= 1 })),
      // The caller receives its error. Later writes still get their own attempt.
      Effect.tapCause(() => Effect.sync(() => record("store_write_errors"))),
      Effect.ensuring(Deferred.succeed(done, undefined)),
      Effect.uninterruptible,
    )
  })

  const appendEvent = (filePath: string, event: StoreEvent) => Effect.suspend(() => {
    const payload = `${JSON.stringify(event)}\n`
    return enqueueWrite(appendText(filePath, payload).pipe(
      Effect.andThen(Effect.sync(() => memory.applyEvent(event))),
    ))
  })

  const requireChat = (chatId: string) => Effect.suspend(() => {
    const chat = memory.state.chatsById.get(chatId)
    return !chat || chat.deletedAt
      ? Effect.fail(new EventStoreNotFoundError({ entity: "chat", id: chatId }))
      : Effect.succeed(chat)
  })

  const requireProject = (projectId: string) => Effect.suspend(() => {
    const project = memory.getProject(projectId)
    return project ? Effect.succeed(project) : Effect.fail(new EventStoreNotFoundError({ entity: "project", id: projectId }))
  })

  // ---- Boot ----------------------------------------------------------------

  const clearStorage = Effect.fn("EventStore.clearStorage")(function* () {
    if (memory.storageReset) return
    memory.storageReset = true
    memory.resetState()
    memory.clearLegacyTranscriptState()
    yield* Effect.forEach([paths.snapshot, ...memory.eventLogPaths], (filePath) => writeText(filePath, ""), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  const loadSnapshot = Effect.fn("EventStore.loadSnapshot")(function* () {
    const text = yield* readTextIfExists(paths.snapshot)
    if (Option.isNone(text) || !text.value.trim()) return
    const parsed = yield* decodeJsonFile(text.value)
    const version = readField(parsed, "v")
    if (Result.isSuccess(version) && version.success !== STORE_VERSION) {
      yield* Effect.logWarning(`Resetting local chat history for store version ${STORE_VERSION}`)
      yield* clearStorage()
      return
    }
    if (Result.isFailure(version)) {
      return yield* fileError("parse", paths.snapshot)(version.failure)
    }
    // SnapshotFile has no Schema: it is this store's own file, and every
    // snapshot an older build wrote has to keep loading. A shape this cannot
    // fold fails the load like a parse error does.
    const applied = Result.try(() => memory.applySnapshot(parsed as SnapshotFile))
    if (Result.isFailure(applied)) return yield* fileError("parse", paths.snapshot)(applied.failure)
  }, (effect) => effect.pipe(
    Effect.catchTags({
      SchemaError: (error) => resetAfterBadSnapshot(error),
      "@kanna/server/event-store/EventStoreFileError": (error) => resetAfterBadSnapshot(error.cause),
    }),
  ))

  const resetAfterBadSnapshot = (error: unknown) =>
    Effect.logWarning("Failed to load snapshot, resetting local history:", error).pipe(Effect.andThen(clearStorage()))

  const loadReplayEvents = Effect.fn("EventStore.loadReplayEvents")(function* (filePath: string, sourceIndex: number) {
    const text = yield* readTextIfExists(filePath)
    if (Option.isNone(text) || !text.value.trim()) return []

    const parsedEvents: ParsedReplayEvent[] = []
    const lines = text.value.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.trim()) {
        lastNonEmpty = index
        break
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim()
      if (!line) continue
      const event = decodeJsonLine(line)
      const version = Option.isSome(event) ? readField(event.value, "v") : Result.fail(new SyntaxError(`Invalid JSON in ${path.basename(filePath)}`))
      if (Result.isFailure(version)) {
        if (index === lastNonEmpty) {
          yield* Effect.logWarning(`Ignoring corrupt trailing line in ${path.basename(filePath)}`)
          return parsedEvents
        }
        yield* Effect.logWarning(`Failed to replay ${path.basename(filePath)}, resetting local history:`, version.failure)
        yield* clearStorage()
        return []
      }
      if (version.success !== STORE_VERSION) {
        yield* Effect.logWarning("Resetting local history from incompatible event log")
        yield* clearStorage()
        return []
      }
      // StoreEvent has no Schema (events.ts is plain types); a line of this
      // log version is taken as written, and `applyEvent` ignores what it
      // cannot place.
      const value = Option.getOrThrow(event) as StoreEvent
      if ((value as { type?: unknown }).type === "sidebar_project_order_set") {
        continue
      }
      parsedEvents.push({ event: value, sourceIndex, lineIndex: index })
    }

    return parsedEvents
  })

  const replayLogs = Effect.fn("EventStore.replayLogs")(function* () {
    if (memory.storageReset) return
    const replayEvents: ParsedReplayEvent[] = []
    for (const [sourceIndex, filePath] of memory.eventLogPaths.entries()) {
      replayEvents.push(...yield* loadReplayEvents(filePath, sourceIndex))
    }
    if (memory.storageReset) return

    replayEvents
      .sort((left, right) => (
        left.event.timestamp - right.event.timestamp
        || getReplayEventPriority(left.event) - getReplayEventPriority(right.event)
        || left.sourceIndex - right.sourceIndex
        || left.lineIndex - right.lineIndex
      ))
      .forEach(({ event }) => {
        memory.applyEvent(event)
      })
  })

  /**
   * Chat metadata derived from transcript entries (lastMessageAt, hasMessages,
   * message previews) is applied in memory on append and only persisted when a
   * snapshot compaction runs. Rebuild it from the transcript files on boot so
   * restarts between compactions don't regress it.
   *
   * Only the tail of each transcript is read, which is enough for the common
   * case and bounded regardless of how large a conversation grows — but a chat
   * whose last prompt sits behind megabytes of tool output has no prompt in
   * that window at all. Those chats used to come back with no `lastMessageAt`
   * and vanish from every recency-driven sidebar section despite having a full
   * conversation; the fallback below dates them by their newest entry instead.
   * Chats messaged from now on carry the real timestamp in the log
   * (`recordLastMessageAt`) and never reach it.
   */
  const hydrateChatMetadataFromTranscripts = Effect.fn("EventStore.hydrateChatMetadata")(function* () {
    // One listing instead of a check per chat: most chats of a long-lived
    // data dir never got a transcript, and there is nothing to read for them.
    const transcripts = new Set(yield* fs.readDirectory(paths.transcriptsDir).pipe(
      Effect.catchTag("PlatformError", () => Effect.succeed([] as string[])),
    ))
    const chats = [...memory.state.chatsById.values()]
      .filter((chat) => !chat.deletedAt && transcripts.has(`${chat.id}.jsonl`))
    // Metadata hydration is best-effort; the transcript itself is untouched.
    yield* Effect.forEach(chats, (chat) => hydrateChatMetadata(chat).pipe(Effect.ignore), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  /** The transcript's last `TRANSCRIPT_METADATA_TAIL_BYTES`, and the offset they start at. */
  const readTranscriptTail = (filePath: string) => Effect.scoped(Effect.gen(function* () {
    const file = yield* fs.open(filePath)
    const size = Number((yield* file.stat).size)
    const start = Math.max(0, size - TRANSCRIPT_METADATA_TAIL_BYTES)
    const bytes = yield* file.readAlloc(size - start, { position: BigInt(start) })
    const text = Option.isSome(bytes)
      ? Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength).toString("utf8")
      : ""
    return { start, text }
  }))

  const hydrateChatMetadata = (chat: ChatRecord) => Effect.gen(function* () {
    const { start, text } = yield* readTranscriptTail(memory.transcriptPath(chat.id))
    const lines = text.split("\n")
    if (start > 0) {
      // The slice may begin mid-line; drop the partial first line.
      lines.shift()
    }
    let newestEntryAt: number | null = null
    for (const line of lines) {
      if (!line.trim()) continue
      // Skip partial or corrupt lines (e.g. an append cut off by a crash).
      const parsed = decodeJsonLine(line)
      if (Option.isNone(parsed)) continue
      const entry = parsed.value as TranscriptEntry
      const applied = Result.try(() => memory.applyMessageMetadata(chat.id, entry))
      if (Result.isFailure(applied)) continue
      if (typeof entry.createdAt === "number") {
        newestEntryAt = Math.max(newestEntryAt ?? 0, entry.createdAt)
      }
    }
    // Approximate, and deliberately last: it dates the chat by the agent's
    // final entry rather than by the user's prompt, which is wrong by a
    // turn's length but right about when the chat was last alive. Only
    // reached when nothing better exists — a prompt in the tail or a
    // logged stamp both leave `lastMessageAt` already set.
    if (chat.lastMessageAt == null && newestEntryAt != null) {
      chat.lastMessageAt = newestEntryAt
    }
  })

  const writeSidebarProjectOrderFile = (projectIds: string[]) =>
    makeDirectory(dataDir).pipe(
      Effect.andThen(writeText(paths.sidebarProjectOrder, `${JSON.stringify(projectIds, null, 2)}\n`)),
    )

  const readLegacySidebarProjectOrderFromProjectsLog = Effect.fn("EventStore.readLegacySidebarProjectOrder")(function* () {
    const text = yield* readTextIfExists(paths.projectsLog)
    if (Option.isNone(text) || !text.value.trim()) return []

    const lines = text.value.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.trim()) {
        lastNonEmpty = index
        break
      }
    }

    let projectIds: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim()
      if (!line) continue
      const event = decodeJsonLine(line)
      const fields = Option.isSome(event)
        ? Result.all({ v: readField(event.value, "v"), type: readField(event.value, "type") })
        : Result.fail(new SyntaxError(`Invalid JSON in ${path.basename(paths.projectsLog)}`))
      if (Result.isFailure(fields)) {
        if (index === lastNonEmpty) {
          yield* Effect.logWarning(`Ignoring corrupt trailing line in ${path.basename(paths.projectsLog)} while migrating sidebar order`)
          return projectIds
        }
        yield* Effect.logWarning(`Failed to migrate sidebar order from ${path.basename(paths.projectsLog)}:`, fields.failure)
        return []
      }
      if (fields.success.v !== STORE_VERSION || fields.success.type !== "sidebar_project_order_set") {
        continue
      }
      projectIds = normalizeSidebarProjectOrder((Option.getOrThrow(event) as { projectIds?: unknown }).projectIds)
    }

    return projectIds
  })

  const loadSidebarProjectOrder = Effect.fn("EventStore.loadSidebarProjectOrder")(function* () {
    const exists = yield* fs.exists(paths.sidebarProjectOrder).pipe(Effect.orElseSucceed(() => false))
    if (exists) {
      memory.sidebarProjectOrder = yield* fs.readFileString(paths.sidebarProjectOrder).pipe(
        Effect.flatMap((text) => text.trim() ? decodeJsonFile(text).pipe(Effect.map(normalizeSidebarProjectOrder)) : Effect.succeed([])),
        Effect.catchTags({
          PlatformError: (error) => ignoreSavedOrder(error),
          SchemaError: (error) => ignoreSavedOrder(error),
        }),
      )
      return
    }

    const fromProjectsLog = yield* readLegacySidebarProjectOrderFromProjectsLog()
    const legacySidebarProjectOrder = fromProjectsLog.length > 0 ? fromProjectsLog : [...memory.legacySidebarProjectOrder]
    memory.sidebarProjectOrder = legacySidebarProjectOrder
    if (legacySidebarProjectOrder.length > 0) {
      yield* writeSidebarProjectOrderFile(legacySidebarProjectOrder)
    }
  })

  const ignoreSavedOrder = (error: unknown) =>
    Effect.logWarning(`Failed to load ${SIDEBAR_PROJECT_ORDER_FILE}, ignoring saved order:`, error).pipe(Effect.as([] as string[]))

  const shouldCompact = Effect.fn("EventStore.shouldCompact")(function* () {
    const sizes = yield* Effect.forEach(memory.eventLogPaths, fileSize, { concurrency: "unbounded" })
    return sizes.reduce((total, size) => total + size, 0) >= COMPACTION_THRESHOLD_BYTES
  })

  const getLegacyTranscriptStats = Effect.fn("EventStore.getLegacyTranscriptStats")(function* () {
    return memory.legacyTranscriptStats(yield* fileSize(paths.messagesLog))
  })

  const hasLegacyTranscriptData = Effect.map(getLegacyTranscriptStats(), (stats) => stats.hasLegacyData)

  const compact = Effect.fn("EventStore.compact")(function* () {
    const snapshot = memory.createSnapshot()
    yield* writeText(paths.snapshot, JSON.stringify(snapshot, null, 2))
    yield* Effect.forEach(memory.eventLogPaths, (filePath) => writeText(filePath, ""), { concurrency: "unbounded", discard: true })
  })

  // ---- Transcripts -----------------------------------------------------

  /** Runs on the write chain, so a partial append cannot enter the cache. */
  const loadTranscriptAsync = Effect.fn("EventStore.loadTranscript")(function* (chatId: string, refresh = false) {
    if (!refresh && memory.transcriptCache.has(chatId)) return
    const started = performance.now()
    const legacy = memory.legacyMessagesByChatId.get(chatId)
    if (legacy) {
      memory.setCachedTranscript(chatId, cloneTranscriptEntries(legacy))
      return
    }
    const transcriptPath = memory.transcriptPath(chatId)
    const text = Option.getOrElse(yield* readTextIfExists(transcriptPath, chatId), () => "")
    const entries: TranscriptEntry[] = []
    let start = 0
    // Parsed in slices of a few milliseconds, yielding between them, so a
    // large transcript does not hold the event loop for its whole parse.
    while (start < text.length) {
      const from = start
      start = yield* Effect.try({
        try: () => parseTranscriptLines(text, from, entries, 4),
        catch: (cause) => new EventStoreFileError({ operation: "parse", filePath: transcriptPath, chatId, cause }),
      })
      if (start < text.length) yield* Effect.yieldNow
    }
    memory.setCachedTranscript(chatId, entries, text.length * 2 + entries.length * 512)
    record("transcript_async_load_ms", performance.now() - started)
    record("transcript_disk_bytes", text.length)
  })

  /** Reads share the write queue so a partial append cannot enter the cache. */
  const prepareTranscript = Effect.fn("EventStore.prepareTranscript")(function* (chatId: string) {
    if (memory.transcriptCache.has(chatId)) return
    const pending = memory.transcriptLoads.get(chatId)
    if (pending) return yield* Deferred.await(pending)
    // Registered and queued in one uninterruptible step, so a load that is
    // waited on always settles and leaves the map.
    yield* Effect.uninterruptible(Effect.suspend(() => {
      const load = Deferred.makeUnsafe<void, EventStoreFileError>()
      memory.transcriptLoads.set(chatId, load)
      return enqueueWrite(loadTranscriptAsync(chatId)).pipe(
        Effect.onExit((exit) => Deferred.done(load, exit).pipe(
          Effect.andThen(Effect.sync(() => { memory.transcriptLoads.delete(chatId) })),
        )),
      )
    }))
  })

  const retainTranscript = Effect.fn("EventStore.retainTranscript")(function* (chatId: string) {
    yield* Effect.acquireRelease(
      Effect.sync(() => memory.pinTranscript(chatId)),
      () => Effect.sync(() => memory.unpinTranscript(chatId)),
    )
    yield* prepareTranscript(chatId)
  })

  /** A transcript's entries straight from disk, without touching the cache. */
  const readTranscriptFile = Effect.fn("EventStore.readTranscriptFile")(function* (chatId: string) {
    const transcriptPath = memory.transcriptPath(chatId)
    const text = yield* readTextIfExists(transcriptPath, chatId)
    const entries: TranscriptEntry[] = []
    if (Option.isNone(text) || !text.value.trim()) return entries
    const started = performance.now()
    yield* Effect.try({
      try: () => parseTranscriptLines(text.value, 0, entries),
      catch: (cause) => new EventStoreFileError({ operation: "parse", filePath: transcriptPath, chatId, cause }),
    })
    record("transcript_file_parse_ms", performance.now() - started)
    return entries
  })

  const readMessages = Effect.fn("EventStore.readMessages")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* retainTranscript(chatId)
    // Copy the entry list before payload IO: later appends belong to the next read.
    const entries = [...memory.getTranscriptEntries(chatId)]
    if (!entries.some((entry) => entry.trimmed)) return cloneTranscriptEntries(entries)
    const payloads = yield* readTranscriptPayloads(memory.payloadSidecarPath(chatId)).pipe(withFs)
    return mergeMessages(entries, payloads)
  }, Effect.scoped)

  const readEntriesById = Effect.fn("EventStore.readEntriesById")(function* (chatId: string, entryIds: string[]) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* requireChat(chatId)
    if (entryIds.length === 0) return []
    yield* retainTranscript(chatId)
    const entries = memory.collectEntriesById(chatId, entryIds, () => null)
    const trimmed = entries.filter((entry) => entry.trimmed).map((entry) => entry._id)
    if (trimmed.length === 0) return entries
    // Built on the write chain: an append between reading the sidecar and
    // storing the index would otherwise go unnoted and shift every later offset.
    const index = memory.payloadIndexes.get(chatId) ?? (yield* enqueueWrite(Effect.suspend(() => {
      const existing = memory.payloadIndexes.get(chatId)
      if (existing) return Effect.succeed(existing)
      return loadTranscriptPayloadIndex(memory.payloadSidecarPath(chatId)).pipe(
        withFs,
        Effect.map((loaded) => memory.setPayloadIndex(chatId, loaded)),
      )
    })))
    const payloads = yield* readTranscriptPayloadsById(index, trimmed).pipe(withFs)
    return entries.map((entry) => entry.trimmed ? mergeTranscriptPayload(entry, payloads.get(entry._id)) : entry)
  }, Effect.scoped)

  /** Transcript, payload sidecar and media of a chat that is gone for good. */
  const removeTranscriptFiles = Effect.fn("EventStore.removeTranscriptFiles")(function* (chatId: string) {
    yield* removeFile(memory.transcriptPath(chatId), chatId)
    yield* removeFile(memory.payloadSidecarPath(chatId), chatId)
    yield* removeTranscriptMedia(dataDir, chatId).pipe(withFs)
    memory.dropTranscriptCaches(chatId)
  })

  // ---- Projects --------------------------------------------------------

  const openProject = Effect.fn("EventStore.openProject")(function* (localPath: string, title?: string) {
    const normalized = resolveLocalPath(localPath, machine.homeDirectory)
    const existingId = memory.state.projectIdsByPath.get(normalized)
    if (existingId) {
      const existing = memory.state.projectsById.get(existingId)
      if (existing && !existing.deletedAt) {
        return existing
      }
    }

    const hiddenProject = [...memory.state.projectsById.values()]
      .find((project) => project.localPath === normalized && project.deletedAt)
    const projectId = hiddenProject?.id ?? crypto.randomUUID()
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_opened",
      timestamp: Date.now(),
      projectId,
      localPath: normalized,
      title: title?.trim() || path.basename(normalized) || normalized,
    }
    yield* appendEvent(paths.projectsLog, event)
    return memory.state.projectsById.get(projectId)!
  })

  const removeProject = Effect.fn("EventStore.removeProject")(function* (projectId: string) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    yield* requireProject(projectId)
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_removed",
      timestamp: Date.now(),
      projectId,
    }
    yield* appendEvent(paths.projectsLog, event)
  })

  const renameProjectSidebarTitle = Effect.fn("EventStore.renameProjectSidebarTitle")(function* (projectId: string, title: string) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    const trimmed = title.trim()
    const project = yield* requireProject(projectId)
    const nextTitle = trimmed || null
    if ((project.sidebarTitle ?? null) === nextTitle) return

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_sidebar_renamed",
      timestamp: Date.now(),
      projectId,
      title: nextTitle,
    }
    yield* appendEvent(paths.projectsLog, event)
  })

  /**
   * Pins a project in the Channels view, or unpins it. `pinnedAt` back-dates
   * the pin, for one carried over from a device that kept its own.
   */
  const setProjectPinned = Effect.fn("EventStore.setProjectPinned")(function* (projectId: string, pinned: boolean, pinnedAt?: number) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    const project = yield* requireProject(projectId)
    if (Boolean(project.pinnedAt) === pinned) return

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_pin_set",
      timestamp: Date.now(),
      projectId,
      pinned,
      ...(pinned && pinnedAt !== undefined ? { pinnedAt } : {}),
    }
    yield* appendEvent(paths.projectsLog, event)
  })

  const setSidebarProjectOrder = Effect.fn("EventStore.setSidebarProjectOrder")(function* (projectIds: string[]) {
    memory.stateVersion += 1
    const validProjectIds = projectIds.filter((projectId) => {
      const project = memory.state.projectsById.get(projectId)
      return Boolean(project && !project.deletedAt)
    })

    const uniqueProjectIds = [...new Set(validProjectIds)]
    const current = memory.sidebarProjectOrder
    if (
      uniqueProjectIds.length === current.length
      && uniqueProjectIds.every((projectId, index) => current[index] === projectId)
    ) {
      return
    }

    yield* enqueueWrite(writeSidebarProjectOrderFile(uniqueProjectIds).pipe(
      Effect.andThen(Effect.sync(() => { memory.sidebarProjectOrder = [...uniqueProjectIds] })),
    ))
  })

  // ---- Chats -----------------------------------------------------------

  const createChat = Effect.fn("EventStore.createChat")(function* (
    projectId: string,
    lineage?: { parentChatId?: string; createdByChatId?: string },
    options?: { delegator?: boolean; chatId?: string },
  ) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    yield* requireProject(projectId)
    // The web client names a chat it starts, so it can be on the chat's page
    // before this answers. The id becomes file names (the transcript, its
    // payloads, its media folder), so nothing but a UUID is taken. A deleted
    // chat still holds its id.
    if (options?.chatId !== undefined) {
      if (!CLIENT_CHAT_ID_PATTERN.test(options.chatId)) {
        return yield* Effect.fail(new EventStoreRejectedError({ reason: "invalid_chat_id", chatId: options.chatId }))
      }
      if (memory.state.chatsById.has(options.chatId)) {
        return yield* Effect.fail(new EventStoreRejectedError({ reason: "chat_exists", chatId: options.chatId }))
      }
    }
    const chatId = options?.chatId ?? crypto.randomUUID()
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: Date.now(),
      chatId,
      projectId,
      title: "New Chat",
      ...(lineage?.parentChatId ? { parentChatId: lineage.parentChatId } : {}),
      ...(lineage?.createdByChatId ? { createdByChatId: lineage.createdByChatId } : {}),
      ...(options?.delegator ? { delegator: true } : {}),
    }
    yield* appendEvent(paths.chatsLog, event)
    return memory.state.chatsById.get(chatId)!
  })

  /**
   * Persists when the user last messaged a chat.
   *
   * Every recency-driven sidebar section keys off `lastMessageAt` — the date
   * buckets, Relevant and the palette's recents all drop a chat that hasn't
   * got one — while the value itself used to live only in memory and in
   * whatever snapshot happened to be written since. Between compactions a
   * restart re-derived it by scanning each transcript's tail, which silently
   * fails for exactly the chats that worked hardest: one long agentic turn can
   * push the last prompt megabytes behind the tail window, and the chat comes
   * back invisible despite having a full conversation in it.
   *
   * Only ever moves forward, and only writes when it actually moves, so
   * replaying a prompt (or a fork inheriting one) adds nothing to the log.
   */
  const recordLastMessageAt = Effect.fn("EventStore.recordLastMessageAt")(function* (chatId: string, at: number | undefined) {
    if (at == null) return
    const chat = memory.state.chatsById.get(chatId)
    if (!chat || (chat.lastMessageAt ?? 0) >= at) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_last_message_at_set",
      timestamp: Date.now(),
      chatId,
      at,
    }
    yield* appendEvent(paths.chatsLog, event)
  })

  /** Records the files one turn changed; replay unions them into `touchedFiles`. */
  const recordFilesTouched = Effect.fn("EventStore.recordFilesTouched")(function* (chatId: string, files: TouchedFile[]) {
    if (files.length === 0) return
    const chat = memory.state.chatsById.get(chatId)
    if (!chat) return
    // Nothing new to learn — skip the append rather than growing the log with
    // a repeat of what we already know. A path whose base blob moved is *not* a
    // repeat: it means the path was committed between the two turns, and
    // recording the newer base is what keeps the claim honest. Neither is one
    // carrying line counts, which accumulate — dropping those would undercount
    // exactly the files a chat works on most.
    const known = new Map((chat.touchedFiles ?? []).map((file) => [file.path, file]))
    if (files.every((file) => {
      const previous = known.get(file.path)
      if (previous == null || previous.baseBlob !== file.baseBlob) return false
      return !file.additions && !file.deletions
    })) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_files_touched",
      timestamp: Date.now(),
      chatId,
      files,
    }
    yield* appendEvent(paths.chatsLog, event)
  })

  /** A chat event for an existing chat, skipped when `unchanged` says the chat already reads that way. */
  const chatSetting = <Event extends ChatEvent | TurnEvent>(
    filePath: string,
    chatId: string,
    unchanged: (chat: ChatRecord) => boolean,
    makeEvent: () => Event,
  ) => requireChat(chatId).pipe(
    Effect.flatMap((chat) => unchanged(chat) ? Effect.void : appendEvent(filePath, makeEvent())),
  )

  const setChatProvider = Effect.fn("EventStore.setChatProvider")(function* (chatId: string, provider: AgentProvider) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => chat.provider === provider, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_provider_set",
      timestamp: Date.now(),
      chatId,
      provider,
    }))
  })

  const setPlanMode = Effect.fn("EventStore.setPlanMode")(function* (chatId: string, planMode: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => chat.planMode === planMode, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_plan_mode_set",
      timestamp: Date.now(),
      chatId,
      planMode,
    }))
  })

  const setAutoPlan = Effect.fn("EventStore.setAutoPlan")(function* (chatId: string, autoPlan: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => chat.autoPlan === autoPlan, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_auto_plan_set",
      timestamp: Date.now(),
      chatId,
      autoPlan,
    }))
  })

  const setPendingForkSessionToken = Effect.fn("EventStore.setPendingForkSessionToken")(function* (
    chatId: string,
    pendingForkSessionToken: string | null,
    pendingForkAt: string | null = null,
  ) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const at = pendingForkSessionToken === null ? null : pendingForkAt
    yield* chatSetting(
      paths.turnsLog,
      chatId,
      (chat) => (chat.pendingForkSessionToken ?? null) === pendingForkSessionToken && (chat.pendingForkAt ?? null) === at,
      (): TurnEvent => ({
        v: STORE_VERSION,
        type: "pending_fork_session_token_set",
        timestamp: Date.now(),
        chatId,
        pendingForkSessionToken,
        ...(at !== null ? { pendingForkAt: at } : {}),
      }),
    )
  })

  /**
   * Copy a chat into a new one that resumes the same native session.
   *
   * `atLastCompletedTurn` trims the copied transcript to the last settled turn.
   * That is how a chat with a turn in flight is forked: the fork starts from a
   * conversation whose tool calls all have their results, and the source keeps
   * running undisturbed.
   */
  const forkChat = Effect.fn("EventStore.forkChat")(function* (
    sourceChatId: string,
    options?: { atLastCompletedTurn?: boolean; parentChatId?: string; createdByChatId?: string },
  ) {
    yield* Effect.annotateCurrentSpan("sourceChatId", sourceChatId)
    const sourceChat = yield* requireChat(sourceChatId)
    const sourceSessionToken = sourceChat.sessionToken ?? sourceChat.pendingForkSessionToken ?? null
    const sourceProvider = sourceChat.provider
    if (!sourceProvider || !sourceSessionToken) {
      return yield* Effect.fail(new EventStoreRejectedError({ reason: "not_forkable", chatId: sourceChatId }))
    }

    // Resolved before anything is written: a mid-turn fork of a chat whose
    // first turn is still running has no settled branch point, and refusing
    // here means it leaves no half-built chat behind.
    const allEntries = yield* readMessages(sourceChatId)
    const branchPoint = options?.atLastCompletedTurn
      ? findLastCompletedTurnEnd(allEntries)
      : allEntries.length
    if (branchPoint === 0 && allEntries.length > 0) {
      return yield* Effect.fail(new EventStoreRejectedError({ reason: "no_completed_turn", chatId: sourceChatId }))
    }
    const droppedRunningTurn = branchPoint < allEntries.length

    // A fork of an idle chat inherits these from the source record — same
    // conversation, so the same counts and previews. A fork taken mid-turn left
    // that turn behind, so its numbers come from the copied transcript instead.
    const inherited = droppedRunningTurn
      ? {
          turnCount: Math.max(0, (sourceChat.turnCount ?? 0) - 1),
          ...summarizeForkedTranscript(allEntries.slice(0, branchPoint)),
        }
      : {
          turnCount: sourceChat.turnCount,
          lastUserMessagePreview: sourceChat.lastUserMessagePreview,
          lastAgentMessagePreview: sourceChat.lastAgentMessagePreview,
          lastAgentMessagePreviewAt: sourceChat.lastAgentMessagePreviewAt,
          lastAgentMessageAt: sourceChat.lastAgentMessageAt,
        }

    const chatId = crypto.randomUUID()
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const createdAt = Date.now()
    const createEvent: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: createdAt,
      chatId,
      projectId: sourceChat.projectId,
      title: getForkedChatTitle(sourceChat.title),
      // A fork inherits the conversation, so it inherits its recency too: with
      // no turn events of its own it would otherwise read as brand new and sort
      // by creation time alone.
      ...(sourceChat.lastTurnEndedAt != null ? { lastTurnEndedAt: sourceChat.lastTurnEndedAt } : {}),
      forkedFromChatId: sourceChatId,
      // A delegator's fork is a delegator: the same conversation under the
      // same system prompt, so the fork's first turn reads the source's cache.
      ...(sourceChat.delegator ? { delegator: true as const } : {}),
      ...(options?.parentChatId ? { parentChatId: options.parentChatId } : {}),
      ...(options?.createdByChatId ? { createdByChatId: options.createdByChatId } : {}),
    }
    yield* appendEvent(paths.chatsLog, createEvent)
    // The fork carries the same conversation, so it carries the same claim on
    // the files that conversation changed — it stays in Relevant alongside its
    // source rather than starting with an empty touched set.
    // Base blobs come along too, so a fork of a chat whose work is already
    // committed inherits a settled claim rather than a live one.
    if (sourceChat.touchedFiles?.length) {
      yield* recordFilesTouched(chatId, sourceChat.touchedFiles)
    }
    yield* setChatProvider(chatId, sourceProvider)
    yield* setPlanMode(chatId, sourceChat.planMode)
    yield* setAutoPlan(chatId, sourceChat.autoPlan)
    yield* setPendingForkSessionToken(chatId, sourceSessionToken, forkPointOf(sourceProvider, allEntries.slice(0, branchPoint)))

    // The fork gets its own copy of any images, and its entries point at
    // that copy, so deleting the source later does not blank its screenshots.
    const sourceEntries = allEntries
      .slice(0, branchPoint)
      .map((entry) => retargetEntryMediaUrls(entry, sourceChatId, chatId))
    if (sourceEntries.length > 0) {
      const transcriptPath = memory.transcriptPath(chatId)
      const payload = sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")
      yield* enqueueWrite(Effect.gen(function* () {
        yield* ensureTranscriptsDir
        yield* copyTranscriptMedia(dataDir, sourceChatId, chatId).pipe(withFs)
        // `readMessages` merged the payloads back in, so the fork's transcript
        // is whole on disk; its first slim sweep or append leaves it that way
        // until a rewrite, and every reader accepts both forms.
        yield* writeText(transcriptPath, `${payload}\n`, chatId)
        const chat = memory.state.chatsById.get(chatId)
        if (chat) {
          chat.hasMessages = true
          chat.updatedAt = Math.max(chat.updatedAt, createdAt)
          // The fork's conversation *is* the source's, so it inherits its turns
          // too — a fork of a twenty-turn chat has twenty turns behind it, and
          // starting the count from zero would read as a fresh chat.
          if (inherited.turnCount) chat.turnCount = inherited.turnCount
          if (inherited.lastUserMessagePreview) chat.lastUserMessagePreview = inherited.lastUserMessagePreview
          if (inherited.lastAgentMessagePreview) {
            chat.lastAgentMessagePreview = inherited.lastAgentMessagePreview
            chat.lastAgentMessagePreviewAt = inherited.lastAgentMessagePreviewAt
          }
          // Same transcript, so the same last-agent-activity timestamp a
          // reload would derive from it.
          if (inherited.lastAgentMessageAt != null) {
            chat.lastAgentMessageAt = Math.max(chat.lastAgentMessageAt ?? 0, inherited.lastAgentMessageAt)
          }
        }
        memory.setCachedTranscript(chatId, cloneTranscriptEntries(sourceEntries))
      }))
      // The fork inherits the copied conversation's recency: without a
      // `lastMessageAt` it reads as an empty draft and stays hidden from every
      // recency-driven sidebar section until its first new message. Set by the
      // event rather than in the block above, so it survives the restart —
      // this transcript is a copy, so rehydrating it hits the same tail limit
      // the source's did, and would otherwise date the fork by whatever prompt
      // happens to sit inside the window.
      yield* recordLastMessageAt(chatId, sourceEntries[sourceEntries.length - 1]?.createdAt)
    }

    return memory.state.chatsById.get(chatId)!
  })

  const renameChat = Effect.fn("EventStore.renameChat")(function* (chatId: string, title: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const trimmed = title.trim()
    if (!trimmed) return
    yield* chatSetting(paths.chatsLog, chatId, (chat) => chat.title === trimmed, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_renamed",
      timestamp: Date.now(),
      chatId,
      title: trimmed,
    }))
  })

  const deleteChat = Effect.fn("EventStore.deleteChat")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, () => false, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_deleted",
      timestamp: Date.now(),
      chatId,
    }))
  })

  const setChatPinned = Effect.fn("EventStore.setChatPinned")(function* (chatId: string, pinned: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(
      paths.chatsLog,
      chatId,
      (chat) => Boolean(chat.deletedAt || chat.archivedAt) || Boolean(chat.pinnedAt) === pinned,
      (): ChatEvent => ({
        v: STORE_VERSION,
        type: "chat_pin_set",
        timestamp: Date.now(),
        chatId,
        pinned,
      }),
    )
  })

  const archiveChat = Effect.fn("EventStore.archiveChat")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, () => false, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_archived",
      timestamp: Date.now(),
      chatId,
    }))
  })

  const unarchiveChat = Effect.fn("EventStore.unarchiveChat")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, () => false, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_unarchived",
      timestamp: Date.now(),
      chatId,
    }))
  })

  const sweepProtectedIds = (options?: StaleChatSweepOptions) => new Set([
    ...(options?.activeChatIds ?? []),
    ...(options?.protectedChatIds ?? []),
  ])

  const pruneStaleEmptyChats = Effect.fn("EventStore.pruneStaleEmptyChats")(function* (options?: StaleChatSweepOptions) {
    const now = options?.now ?? Date.now()
    const maxAgeMs = options?.maxAgeMs ?? STALE_EMPTY_CHAT_MAX_AGE_MS
    const protectedChatIds = sweepProtectedIds(options)
    const prunedChatIds: string[] = []

    for (const chat of memory.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || chat.pinnedAt || protectedChatIds.has(chat.id)) continue
      if (now - chat.createdAt < maxAgeMs) continue
      if (chat.hasMessages) continue
      // Made empty on purpose, to be sent to later.
      if (chat.delegator) continue
      // Peek without inserting into the transcript cache — the prune sweep
      // must not evict actively streaming chats.
      const entries = memory.transcriptCache.get(chat.id)
        ?? memory.legacyMessagesByChatId.get(chat.id)
        ?? (yield* readTranscriptFile(chat.id))
      if (entries.length > 0) {
        chat.hasMessages = true
        continue
      }

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_deleted",
        timestamp: now,
        chatId: chat.id,
      }
      yield* appendEvent(paths.chatsLog, event)

      yield* removeTranscriptFiles(chat.id)

      prunedChatIds.push(chat.id)
    }

    return prunedChatIds
  })

  /**
   * Garbage-collects long-idle chats by archiving (not deleting) them: any
   * chat whose last activity is more than `maxAgeMs` behind the user's latest
   * chat activity and that isn't already archived/deleted, protected, or
   * empty. Empty stale chats are left for pruneStaleEmptyChats to
   * hard-delete. Sending a message unarchives, so this is non-destructive
   * housekeeping.
   */
  const autoArchiveStaleChats = Effect.fn("EventStore.autoArchiveStaleChats")(function* (options?: StaleChatSweepOptions) {
    const now = options?.now ?? Date.now()
    const maxAgeMs = options?.maxAgeMs ?? STALE_CHAT_AUTO_ARCHIVE_MAX_AGE_MS
    // min() guards against clock skew pushing a chat timestamp into the future.
    const reference = Math.min(now, memory.latestChatActivityAt() ?? now)
    const protectedChatIds = sweepProtectedIds(options)
    const archivedChatIds: string[] = []

    for (const chat of memory.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || chat.pinnedAt || protectedChatIds.has(chat.id)) continue
      // Empty chats are the prune sweep's job (hard delete), not ours.
      if (!chat.hasMessages && chat.lastMessageAt == null) continue
      const lastActivityAt = chat.lastMessageAt ?? chat.createdAt
      if (reference - lastActivityAt < maxAgeMs) continue

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_archived",
        timestamp: now,
        chatId: chat.id,
      }
      yield* appendEvent(paths.chatsLog, event)
      archivedChatIds.push(chat.id)
    }

    return archivedChatIds
  })

  /**
   * Hard-deletes long-idle chats — archived or not — whose last activity is
   * more than `maxAgeMs` behind the user's latest chat activity, reclaiming
   * their transcript files. The end of the lifecycle after auto-archive;
   * protected (active/draft) chats are spared.
   */
  const deleteStaleChats = Effect.fn("EventStore.deleteStaleChats")(function* (options?: StaleChatSweepOptions) {
    const now = options?.now ?? Date.now()
    const maxAgeMs = options?.maxAgeMs ?? STALE_CHAT_DELETE_MAX_AGE_MS
    // min() guards against clock skew pushing a chat timestamp into the future.
    const reference = Math.min(now, memory.latestChatActivityAt() ?? now)
    const protectedChatIds = sweepProtectedIds(options)
    const deletedChatIds: string[] = []

    for (const chat of memory.state.chatsById.values()) {
      if (chat.deletedAt || chat.pinnedAt || protectedChatIds.has(chat.id)) continue
      const lastActivityAt = chat.lastMessageAt ?? chat.createdAt
      if (reference - lastActivityAt < maxAgeMs) continue

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_deleted",
        timestamp: now,
        chatId: chat.id,
      }
      yield* appendEvent(paths.chatsLog, event)

      yield* removeTranscriptFiles(chat.id)

      deletedChatIds.push(chat.id)
    }

    return deletedChatIds
  })

  const setChatReadState = Effect.fn("EventStore.setChatReadState")(function* (chatId: string, unread: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => chat.unread === unread, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_read_state_set",
      timestamp: Date.now(),
      chatId,
      unread,
    }))
  })

  const setChatDoneState = Effect.fn("EventStore.setChatDoneState")(function* (chatId: string, done: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => Boolean(chat.doneAt) === done, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_done_state_set",
      timestamp: Date.now(),
      chatId,
      done,
    }))
  })

  /** Marks whether a sub-chat still owes its parent a report. See `ChatRecord.reportOwed`. */
  const setReportOwed = Effect.fn("EventStore.setReportOwed")(function* (chatId: string, owed: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => Boolean(chat.reportOwed) === owed, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_report_owed_set",
      timestamp: Date.now(),
      chatId,
      owed,
    }))
  })

  /** Makes a chat a delegator, or an ordinary chat again. See `ChatRecord.delegator`. */
  const setChatDelegator = Effect.fn("EventStore.setChatDelegator")(function* (chatId: string, delegator: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.chatsLog, chatId, (chat) => Boolean(chat.delegator) === delegator, (): ChatEvent => ({
      v: STORE_VERSION,
      type: "chat_delegator_set",
      timestamp: Date.now(),
      chatId,
      delegator,
    }))
  })

  /**
   * Records that the parent has this sub-chat's reply up to the turn that
   * ended at `through`, and is still owed what comes after. See
   * `ChatRecord.reportedThrough`.
   */
  const setReportedThrough = Effect.fn("EventStore.setReportedThrough")(function* (chatId: string, through: number) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(
      paths.chatsLog,
      chatId,
      (chat) => Boolean(chat.reportOwed) && chat.reportedThrough === through,
      (): ChatEvent => ({
        v: STORE_VERSION,
        type: "chat_report_owed_set",
        timestamp: Date.now(),
        chatId,
        owed: true,
        reportedThrough: through,
      }),
    )
  })

  /**
   * Moves a chat under another parent, or under none. `adopted` says whether
   * the parent took the chat on or started it. See `ChatRecord.adopted`.
   */
  const setChatParent = Effect.fn("EventStore.setChatParent")(function* (
    chatId: string,
    parent: { parentChatId: string; adopted: boolean } | null,
  ) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const adopted = Boolean(parent?.adopted)
    yield* chatSetting(
      paths.chatsLog,
      chatId,
      (chat) => (chat.parentChatId ?? null) === (parent?.parentChatId ?? null) && Boolean(chat.adopted) === adopted,
      (): ChatEvent => ({
        v: STORE_VERSION,
        type: "chat_parent_set",
        timestamp: Date.now(),
        chatId,
        parentChatId: parent?.parentChatId ?? null,
        adopted,
      }),
    )
  })

  /** Creates the schedule, or replaces the one with the same id. */
  const setSchedule = Effect.fn("EventStore.setSchedule")(function* (schedule: ChatSchedule) {
    yield* Effect.annotateCurrentSpan("scheduleId", schedule.id)
    const event: ScheduleEvent = {
      v: STORE_VERSION,
      type: "schedule_set",
      timestamp: Date.now(),
      schedule,
    }
    yield* appendEvent(paths.schedulesLog, event)
    return memory.state.schedulesById.get(schedule.id)!
  })

  const deleteSchedule = Effect.fn("EventStore.deleteSchedule")(function* (scheduleId: string) {
    yield* Effect.annotateCurrentSpan("scheduleId", scheduleId)
    if (!memory.state.schedulesById.has(scheduleId)) {
      return yield* Effect.fail(new EventStoreNotFoundError({ entity: "schedule", id: scheduleId }))
    }
    const event: ScheduleEvent = {
      v: STORE_VERSION,
      type: "schedule_deleted",
      timestamp: Date.now(),
      scheduleId,
    }
    yield* appendEvent(paths.schedulesLog, event)
  })

  /**
   * Persist where the user left off reading. Called on a throttle from the
   * client as it scrolls, so the no-op guard below matters — it is the only
   * write rate-limit in the store.
   */
  const setChatReadAnchor = Effect.fn("EventStore.setChatReadAnchor")(function* (
    chatId: string,
    messageId: string,
    atEnd: boolean,
    layout?: { transcriptWidth?: number; offsetFromMessage?: number },
  ) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    // Scrolling within one message changes only the offset, so that has to
    // count as a change or the position would stick to wherever the message
    // first came into view.
    yield* chatSetting(
      paths.chatsLog,
      chatId,
      (chat) => chat.readAnchor?.messageId === messageId
        && chat.readAnchor.atEnd === atEnd
        && chat.readAnchor.offsetFromMessage === layout?.offsetFromMessage
        && chat.readAnchor.transcriptWidth === layout?.transcriptWidth,
      (): ChatEvent => ({
        v: STORE_VERSION,
        type: "chat_read_anchor_set",
        timestamp: Date.now(),
        chatId,
        messageId,
        atEnd,
        ...(layout?.transcriptWidth != null ? { transcriptWidth: layout.transcriptWidth } : {}),
        ...(layout?.offsetFromMessage != null ? { offsetFromMessage: layout.offsetFromMessage } : {}),
      }),
    )
  })

  const appendMessage = Effect.fn("EventStore.appendMessage")(function* (chatId: string, entry: TranscriptEntry) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* requireChat(chatId)
    // A user prompt is the only entry that moves `lastMessageAt`, so stamping
    // it here costs one log line per prompt rather than one per entry — and it
    // has to be logged, because boot only re-derives this from the transcript's
    // last 256 KB. See `recordLastMessageAt`.
    if (entry.kind === "user_prompt") {
      yield* recordLastMessageAt(chatId, entry.createdAt)
    }
    const transcriptPath = memory.transcriptPath(chatId)
    yield* enqueueWrite(Effect.gen(function* () {
      yield* ensureTranscriptsDir
      // Bytes the header points at go to disk first (image files, then the
      // payload line), so a header on disk never names something missing.
      if (entry.kind === "tool_result" && !entry.trimmed) yield* loadTranscriptAsync(chatId)
      const stored = yield* externalizeEntryImages(entry, { dataDir, chatId }).pipe(withFs)
      const { header, payload } = splitTranscriptEntry(stored, (toolId) => memory.isInlineResult(chatId, toolId))
      if (payload) {
        const line = serializeTranscriptPayload(payload)
        yield* appendText(memory.payloadSidecarPath(chatId), line, chatId)
        memory.payloadIndexes.get(chatId)?.noteAppended(payload._id, Buffer.byteLength(line, "utf8"))
      }
      const headerLine = `${JSON.stringify(header)}\n`
      yield* appendText(transcriptPath, headerLine, chatId)
      memory.applyMessageMetadata(chatId, entry)
      // Deep clone via the already-serialized line: the cached entry is
      // byte-identical to what a cold disk read would produce, and callers
      // that keep mutating their entry can't alias into the cache.
      const cached = memory.transcriptCache.get(chatId)
      if (cached) {
        cached.push(JSON.parse(headerLine) as TranscriptEntry)
        memory.transcriptBytes.set(chatId, (memory.transcriptBytes.get(chatId) ?? 0) + headerLine.length * 2 + 512)
        memory.trimTranscriptCache(chatId)
      }
    }))
  })

  const enqueueMessage = Effect.fn("EventStore.enqueueMessage")(function* (chatId: string, message: QueuedMessageInput) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* requireChat(chatId)
    const queuedMessage: QueuedChatMessage = {
      id: message.id ?? crypto.randomUUID(),
      content: message.content,
      attachments: [...(message.attachments ?? [])],
      createdAt: message.createdAt ?? Date.now(),
      provider: message.provider,
      model: message.model,
      modelOptions: message.modelOptions,
      ...(message.effort ? { effort: message.effort } : {}),
      planMode: message.planMode,
      autoPlan: message.autoPlan,
      ...(message.source ? { source: message.source } : {}),
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_enqueued",
      timestamp: queuedMessage.createdAt,
      chatId,
      message: queuedMessage,
    }
    yield* appendEvent(paths.queuedMessagesLog, event)
    return queuedMessage
  })

  const removeQueuedMessage = Effect.fn("EventStore.removeQueuedMessage")(function* (
    chatId: string,
    queuedMessageId: string,
  ) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* requireChat(chatId)
    const existing = memory.getQueuedMessages(chatId)
    if (!existing.some((entry) => entry.id === queuedMessageId)) {
      return yield* Effect.fail(new EventStoreNotFoundError({ entity: "queued_message", id: queuedMessageId }))
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_removed",
      timestamp: Date.now(),
      chatId,
      queuedMessageId,
    }
    yield* appendEvent(paths.queuedMessagesLog, event)
  })

  /** `model` is what this turn runs with; omitted where the caller has none to name. */
  const recordTurnStarted = Effect.fn("EventStore.recordTurnStarted")(function* (chatId: string, model?: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_started",
      timestamp: Date.now(),
      chatId,
      ...(model ? { model } : {}),
    }
    yield* appendEvent(paths.turnsLog, event)
    memory.hooks.onTurnStarted?.(chatId)
  })

  const recordTurnEnd = (chatId: string, event: TurnEvent) => requireChat(chatId).pipe(
    Effect.andThen(appendEvent(paths.turnsLog, event)),
    Effect.andThen(Effect.sync(() => memory.hooks.onTurnEnded?.(chatId))),
  )

  const recordTurnFinished = Effect.fn("EventStore.recordTurnFinished")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* recordTurnEnd(chatId, { v: STORE_VERSION, type: "turn_finished", timestamp: Date.now(), chatId })
  })

  const recordTurnFailed = Effect.fn("EventStore.recordTurnFailed")(function* (chatId: string, error: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* recordTurnEnd(chatId, { v: STORE_VERSION, type: "turn_failed", timestamp: Date.now(), chatId, error })
  })

  const recordTurnCancelled = Effect.fn("EventStore.recordTurnCancelled")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* recordTurnEnd(chatId, { v: STORE_VERSION, type: "turn_cancelled", timestamp: Date.now(), chatId })
  })

  /**
   * Flag (or clear) a chat whose turn Kanna cut short by shutting down, so the
   * next process can pick it back up. Deliberately does not touch `updatedAt`:
   * it's bookkeeping about the process, not activity in the chat, and bumping
   * it would shuffle the sidebar on every boot.
   */
  const setTurnResumePending = Effect.fn("EventStore.setTurnResumePending")(function* (chatId: string, pending: boolean) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.turnsLog, chatId, (chat) => Boolean(chat.resumePending) === pending, (): TurnEvent => ({
      v: STORE_VERSION,
      type: "turn_resume_pending_set",
      timestamp: Date.now(),
      chatId,
      pending,
    }))
  })

  const setSessionToken = Effect.fn("EventStore.setSessionToken")(function* (chatId: string, sessionToken: string | null) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    yield* chatSetting(paths.turnsLog, chatId, (chat) => chat.sessionToken === sessionToken, (): TurnEvent => ({
      v: STORE_VERSION,
      type: "session_token_set",
      timestamp: Date.now(),
      chatId,
      sessionToken,
    }))
  })

  // ---- Migrations --------------------------------------------------------

  const migrateLegacyTranscripts = Effect.fn("EventStore.migrateLegacyTranscripts")(function* (
    onProgress?: (message: string) => void,
  ) {
    const stats = yield* getLegacyTranscriptStats()
    if (!stats.hasLegacyData) return false

    const sourceSummary = stats.sources.map((source) => source === "messages_log" ? "messages.jsonl" : "snapshot.json").join(", ")
    onProgress?.(`${LOG_PREFIX} transcript migration detected: ${stats.chatCount} chats, ${stats.entryCount} entries from ${sourceSummary}`)

    const messageSets = [...memory.legacyMessagesByChatId.entries()]
    onProgress?.(`${LOG_PREFIX} transcript migration: writing ${messageSets.length} per-chat transcript files`)

    yield* ensureTranscriptsDir
    const logEveryChat = messageSets.length <= 10
    for (let index = 0; index < messageSets.length; index += 1) {
      const [chatId, entries] = messageSets[index]!
      const transcriptPath = memory.transcriptPath(chatId)
      const tempPath = `${transcriptPath}.tmp`
      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n")
      yield* writeText(tempPath, payload ? `${payload}\n` : "", chatId)
      yield* fs.rename(tempPath, transcriptPath).pipe(Effect.catchTag("PlatformError", fileError("rename", transcriptPath, chatId)))
      if (logEveryChat || (index + 1) % 25 === 0 || index === messageSets.length - 1) {
        onProgress?.(`${LOG_PREFIX} transcript migration: ${index + 1}/${messageSets.length} chats`)
      }
    }

    memory.clearLegacyTranscriptState()
    yield* compact()
    memory.transcriptCache.clear()
    memory.transcriptBytes.clear()
    memory.payloadIndexes.clear()
    onProgress?.(`${LOG_PREFIX} transcript migration complete`)
    return true
  })

  const hasSlimMarker = Effect.fn("EventStore.hasSlimMarker")(function* () {
    const text = yield* fs.readFileString(paths.slimMarker).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", () => Effect.succeedNone),
    )
    if (Option.isNone(text)) return false
    const marker = decodeSlimMarker(text.value)
    return Option.isSome(marker) && marker.value.version === SLIM_SWEEP_VERSION
  })

  /**
   * Drop `debugRaw` from tool results and move inline images to disk, in
   * every transcript on disk. See `transcript-slim.ts` and
   * `transcript-media.ts` for what that buys.
   *
   * Runs once per data dir: a marker file records completion, and only
   * `force` repeats the sweep (the `slim-transcripts` CLI command). Each
   * rewrite is queued on the write chain, so an append to the same chat
   * waits for the rename rather than landing in the file being replaced.
   * A rewritten chat is dropped from the transcript cache; the next read
   * parses the slim file, which is the cheap read this exists to make.
   */
  const slimTranscripts = Effect.fn("EventStore.slimTranscripts")(function* (options?: {
    force?: boolean
    onProgress?: (message: string) => void
  }) {
    const stats: SlimTranscriptsStats = { chats: 0, rewritten: 0, bytesBefore: 0, bytesAfter: 0 }
    if (!options?.force && (yield* hasSlimMarker())) return stats

    yield* ensureTranscriptsDir
    const files = (yield* fs.readDirectory(paths.transcriptsDir).pipe(
      Effect.catchTag("PlatformError", fileError("list", paths.transcriptsDir)),
    )).filter((name) => name.endsWith(".jsonl") && !name.endsWith(".payloads.jsonl"))
    for (const name of files) {
      const chatId = name.slice(0, -".jsonl".length)
      const transcriptPath = path.join(paths.transcriptsDir, name)
      stats.chats += 1
      // Calls precede their results in a transcript, so this set is
      // complete by the time a result asks about its tool.
      const inlineToolIds = new Set<string>()
      const sidecarPath = memory.payloadSidecarPath(chatId)
      const skipped = (error: { readonly message: string }) => Effect.sync(() => {
        options?.onProgress?.(`${LOG_PREFIX} transcript slim: skipped ${name}: ${error.message}`)
      })
      yield* enqueueWrite(slimTranscriptFile(transcriptPath, (entry) => {
        if (entry.kind === "tool_call" && INLINE_TOOL_KINDS.has(entry.tool.toolKind)) {
          inlineToolIds.add(entry.tool.toolId)
        }
        return externalizeEntryImages(entry, { dataDir, chatId }).pipe(
          Effect.flatMap((stored) => {
            const { header, payload } = splitTranscriptEntry(stored, (toolId) => inlineToolIds.has(toolId))
            // The payload line lands before the header file is renamed over,
            // same order as a live append.
            if (!payload) return Effect.succeed(header)
            return Effect.as(appendText(sidecarPath, serializeTranscriptPayload(payload), chatId), header)
          }),
        )
      }).pipe(
        withFs,
        Effect.flatMap((result) => Effect.gen(function* () {
          stats.bytesBefore += result.bytesBefore
          stats.bytesAfter += result.bytesAfter
          if (!result.changed) return
          stats.rewritten += 1
          memory.payloadIndexes.delete(chatId)
          // An active lease must stay readable while the rewritten file loads.
          // Replace its entries in one step rather than dropping the cache.
          if (memory.transcriptPins.has(chatId)) yield* loadTranscriptAsync(chatId, true)
          else memory.dropTranscriptCaches(chatId)
          options?.onProgress?.(
            `${LOG_PREFIX} transcript slim: ${name} ${formatMegabytes(result.bytesBefore)} → ${formatMegabytes(result.bytesAfter)}`
          )
        })),
        Effect.catchTags({
          "@kanna/server/transcript-slim/TranscriptSlimError": skipped,
          "@kanna/server/transcript-media/TranscriptMediaError": skipped,
          "@kanna/server/event-store/EventStoreFileError": skipped,
        }),
      ))
    }

    yield* writeText(paths.slimMarker, `${JSON.stringify({ version: SLIM_SWEEP_VERSION, completedAt: Date.now() })}\n`)
    if (stats.rewritten > 0) {
      options?.onProgress?.(
        `${LOG_PREFIX} transcript slim complete: ${stats.rewritten}/${stats.chats} chats rewritten, ${formatMegabytes(stats.bytesBefore)} → ${formatMegabytes(stats.bytesAfter)}`
      )
    }
    return stats
  })

  // ---- Initialize ------------------------------------------------------

  yield* makeDirectory(dataDir)
  yield* ensureTranscriptsDir
  for (const filePath of memory.eventLogPaths) {
    yield* ensureFile(filePath)
  }
  yield* loadSnapshot()
  yield* replayLogs()
  yield* hydrateChatMetadataFromTranscripts()
  yield* loadSidebarProjectOrder()
  if (!(yield* hasLegacyTranscriptData) && (yield* shouldCompact())) {
    yield* compact()
  }

  return {
    dataDir,
    state: memory.state,
    get stateVersion() {
      return memory.stateVersion
    },
    hooks: memory.hooks,

    getProject: (projectId) => memory.getProject(projectId),
    getChat: (chatId) => memory.getChat(chatId),
    requireChat: (chatId) => memory.requireChat(chatId),
    listProjects: () => memory.listProjects(),
    listChatsByProject: (projectId) => memory.listChatsByProject(projectId),
    getSidebarProjectOrder: () => memory.getSidebarProjectOrder(),
    getSchedule: (scheduleId) => memory.getSchedule(scheduleId),
    listSchedules: () => memory.listSchedules(),
    getQueuedMessages: (chatId) => memory.getQueuedMessages(chatId),
    getQueuedMessage: (chatId, queuedMessageId) => memory.getQueuedMessage(chatId, queuedMessageId),
    getEntryDebugRaw: (chatId, entryId) => memory.getEntryDebugRaw(chatId, entryId),
    getClientTranscript: (chatId, fromIndex) => memory.getClientTranscript(chatId, fromIndex),
    getChatReadAnchor: (chatId) => memory.getChatReadAnchor(chatId),
    getInitialTranscriptWindowStart: (chatId, assistantMessages) => memory.getInitialTranscriptWindowStart(chatId, assistantMessages),
    widenTranscriptWindowStart: (chatId, currentStart, widenOptions) =>
      memory.widenTranscriptWindowStart(chatId, currentStart, widenOptions),
    getRollingTranscriptWindowStart: (chatId, currentStart, assistantMessages) =>
      memory.getRollingTranscriptWindowStart(chatId, currentStart, assistantMessages),
    getTranscriptLength: (chatId) => memory.getTranscriptLength(chatId),
    getEntryIdAt: (chatId, index) => memory.getEntryIdAt(chatId, index),
    getTranscriptPath: (chatId) => memory.transcriptPath(chatId),
    resolveTranscriptMediaPath: (url) => memory.resolveTranscriptMediaPath(url),
    getResourceCounts: () => memory.getResourceCounts(),

    retainTranscript,
    readMessages,
    readEntriesById,
    openProject,
    removeProject,
    renameProjectSidebarTitle,
    setProjectPinned,
    setSidebarProjectOrder,
    createChat,
    forkChat,
    renameChat,
    deleteChat,
    setChatPinned,
    archiveChat,
    unarchiveChat,
    pruneStaleEmptyChats,
    autoArchiveStaleChats,
    deleteStaleChats,
    setChatProvider,
    setPlanMode,
    setAutoPlan,
    setChatReadState,
    setChatDoneState,
    setReportOwed,
    setChatDelegator,
    setReportedThrough,
    setChatParent,
    setSchedule,
    deleteSchedule,
    setChatReadAnchor,
    appendMessage,
    enqueueMessage,
    removeQueuedMessage,
    recordTurnStarted,
    recordFilesTouched,
    recordTurnFinished,
    recordTurnFailed,
    recordTurnCancelled,
    setTurnResumePending,
    setSessionToken,
    setPendingForkSessionToken,
    compact: compact(),
    getLegacyTranscriptStats: getLegacyTranscriptStats(),
    hasLegacyTranscriptData,
    migrateLegacyTranscripts,
    slimTranscripts,
  } satisfies EventStore["Service"]
})

import { appendFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync as readFileSyncImmediate } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir, LOG_PREFIX } from "../shared/branding"
import { toMessagePreview } from "../shared/message-preview"
import { buildTranscriptOutline, findTranscriptWindowStart } from "../shared/transcript-window"
import type { TranscriptOutlineEntry } from "../shared/types"
import type { AgentProvider, QueuedChatMessage, ResolvedChatReadAnchor, TranscriptEntry } from "../shared/types"
import { STORE_VERSION } from "../shared/types"
import {
  type ChatEvent,
  type ProjectEvent,
  type QueuedMessageEvent,
  type SnapshotFile,
  type StoreEvent,
  type StoreState,
  type TouchedFile,
  type TurnEvent,
  cloneTranscriptEntries,
  cloneTranscriptEntriesForClient,
  createEmptyState,
} from "./events"
import { resolveLocalPath } from "./paths"
import { slimTranscriptFile } from "./transcript-slim"
import {
  mergeTranscriptPayload,
  readAllTranscriptPayloads,
  serializeTranscriptPayload,
  splitTranscriptEntry,
  TranscriptPayloadIndex,
} from "./transcript-payloads"
import { INLINE_TOOL_KINDS } from "./events"
import {
  copyTranscriptMedia,
  externalizeEntryImages,
  getTranscriptMediaDir,
  parseTranscriptMediaUrl,
  removeTranscriptMedia,
  retargetEntryMediaUrls,
} from "./transcript-media"

const COMPACTION_THRESHOLD_BYTES = 2 * 1024 * 1024
const STALE_EMPTY_CHAT_MAX_AGE_MS = 5 * 60 * 1000
/** Chats this much older than the user's latest activity are auto-archived (kept, not deleted). */
const STALE_CHAT_AUTO_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Chats this much older than the user's latest activity are hard-deleted (archived or not). */
const STALE_CHAT_DELETE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const SIDEBAR_PROJECT_ORDER_FILE = "sidebar-order.json"
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



interface LegacyTranscriptStats {
  hasLegacyData: boolean
  sources: Array<"snapshot" | "messages_log">
  chatCount: number
  entryCount: number
}

interface ParsedReplayEvent {
  event: StoreEvent
  sourceIndex: number
  lineIndex: number
}

function getReplayEventPriority(event: StoreEvent) {
  switch (event.type) {
    case "project_opened":
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
      return 7
    case "turn_finished":
    case "turn_failed":
      return 8
    case "chat_read_state_set":
    case "chat_done_state_set":
    case "chat_read_anchor_set":
    case "chat_files_touched":
    case "chat_last_message_at_set":
      return 9
    case "chat_deleted":
    case "chat_archived":
    case "chat_unarchived":
      return 10
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

export class EventStore {
  readonly dataDir: string
  readonly state: StoreState = createEmptyState()
  private writeChain = Promise.resolve()
  private storageReset = false
  private readonly snapshotPath: string
  private readonly projectsLogPath: string
  private readonly chatsLogPath: string
  private readonly messagesLogPath: string
  private readonly queuedMessagesLogPath: string
  private readonly turnsLogPath: string
  private readonly transcriptsDir: string
  /** Written once `slimTranscripts` has swept this data dir. */
  private readonly slimMarkerPath: string
  private readonly sidebarProjectOrderPath: string
  private legacyMessagesByChatId = new Map<string, TranscriptEntry[]>()
  private legacySidebarProjectOrder: string[] = []
  private sidebarProjectOrder: string[] = []
  private snapshotHasLegacyMessages = false
  // Small LRU of hot transcripts. One slot used to thrash badly: any read of
  // another chat (board view, prune sweep) evicted the actively streaming
  // chat, forcing a synchronous full-file re-read on its next event.
  private readonly transcriptCache = new Map<string, TranscriptEntry[]>()
  private static readonly TRANSCRIPT_CACHE_LIMIT = 8
  /**
   * Offsets into each chat's payload sidecar (`transcript-payloads.ts`).
   * Built on first payload read, evicted with the transcript cache.
   */
  private readonly payloadIndexes = new Map<string, TranscriptPayloadIndex>()
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

  constructor(dataDir = getDataDir(homedir())) {
    this.dataDir = dataDir
    this.snapshotPath = path.join(this.dataDir, "snapshot.json")
    this.projectsLogPath = path.join(this.dataDir, "projects.jsonl")
    this.chatsLogPath = path.join(this.dataDir, "chats.jsonl")
    this.messagesLogPath = path.join(this.dataDir, "messages.jsonl")
    this.queuedMessagesLogPath = path.join(this.dataDir, "queued-messages.jsonl")
    this.turnsLogPath = path.join(this.dataDir, "turns.jsonl")
    this.transcriptsDir = path.join(this.dataDir, "transcripts")
    this.slimMarkerPath = path.join(this.dataDir, "transcripts-slim.json")
    this.sidebarProjectOrderPath = path.join(this.dataDir, SIDEBAR_PROJECT_ORDER_FILE)
  }

  private transcriptsDirReady = false

  private async ensureTranscriptsDir() {
    if (this.transcriptsDirReady) return
    await mkdir(this.transcriptsDir, { recursive: true })
    this.transcriptsDirReady = true
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.ensureTranscriptsDir()
    await this.ensureFile(this.projectsLogPath)
    await this.ensureFile(this.chatsLogPath)
    await this.ensureFile(this.messagesLogPath)
    await this.ensureFile(this.queuedMessagesLogPath)
    await this.ensureFile(this.turnsLogPath)
    await this.loadSnapshot()
    await this.replayLogs()
    await this.hydrateChatMetadataFromTranscripts()
    await this.loadSidebarProjectOrder()
    if (!(await this.hasLegacyTranscriptData()) && await this.shouldCompact()) {
      await this.compact()
    }
  }

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
  private async hydrateChatMetadataFromTranscripts() {
    const chats = [...this.state.chatsById.values()].filter((chat) => !chat.deletedAt)
    await Promise.all(chats.map(async (chat) => {
      try {
        const file = Bun.file(this.transcriptPath(chat.id))
        if (!(await file.exists())) return
        const start = Math.max(0, file.size - TRANSCRIPT_METADATA_TAIL_BYTES)
        const text = await file.slice(start).text()
        const lines = text.split("\n")
        if (start > 0) {
          // The slice may begin mid-line; drop the partial first line.
          lines.shift()
        }
        let newestEntryAt: number | null = null
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as TranscriptEntry
            this.applyMessageMetadata(chat.id, entry)
            if (typeof entry.createdAt === "number") {
              newestEntryAt = Math.max(newestEntryAt ?? 0, entry.createdAt)
            }
          } catch {
            // Skip partial or corrupt lines (e.g. an append cut off by a crash).
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
      } catch {
        // Metadata hydration is best-effort; the transcript itself is untouched.
      }
    }))
  }

  private async ensureFile(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      await Bun.write(filePath, "")
    }
  }

  private async clearStorage() {
    if (this.storageReset) return
    this.storageReset = true
    this.resetState()
    this.clearLegacyTranscriptState()
    await Promise.all([
      Bun.write(this.snapshotPath, ""),
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.queuedMessagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  private async loadSnapshot() {
    const file = Bun.file(this.snapshotPath)
    if (!(await file.exists())) return

    try {
      const text = await file.text()
      if (!text.trim()) return
      const parsed = JSON.parse(text) as SnapshotFile
      if (parsed.v !== STORE_VERSION) {
        console.warn(`${LOG_PREFIX} Resetting local chat history for store version ${STORE_VERSION}`)
        await this.clearStorage()
        return
      }
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
      if (parsed.messages?.length) {
        this.snapshotHasLegacyMessages = true
        for (const messageSet of parsed.messages) {
          this.legacyMessagesByChatId.set(messageSet.chatId, cloneTranscriptEntries(messageSet.entries))
        }
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load snapshot, resetting local history:`, error)
      await this.clearStorage()
    }
  }

  private resetState() {
    this.stateVersion += 1
    this.state.projectsById.clear()
    this.state.projectIdsByPath.clear()
    this.state.chatsById.clear()
    this.state.queuedMessagesByChatId.clear()
    this.sidebarProjectOrder = []
    this.legacySidebarProjectOrder = []
    this.transcriptCache.clear()
    this.payloadIndexes.clear()
  }

  private clearLegacyTranscriptState() {
    this.legacyMessagesByChatId.clear()
    this.snapshotHasLegacyMessages = false
  }

  private async loadSidebarProjectOrder() {
    const file = Bun.file(this.sidebarProjectOrderPath)
    if (await file.exists()) {
      try {
        const text = await file.text()
        if (!text.trim()) {
          this.sidebarProjectOrder = []
          return
        }
        this.sidebarProjectOrder = normalizeSidebarProjectOrder(JSON.parse(text))
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to load ${SIDEBAR_PROJECT_ORDER_FILE}, ignoring saved order:`, error)
        this.sidebarProjectOrder = []
      }
      return
    }

    const legacySidebarProjectOrder = await this.loadLegacySidebarProjectOrder()
    this.sidebarProjectOrder = legacySidebarProjectOrder
    if (legacySidebarProjectOrder.length > 0) {
      await this.writeSidebarProjectOrderFile(legacySidebarProjectOrder)
    }
  }

  private async loadLegacySidebarProjectOrder() {
    const fromProjectsLog = await this.readLegacySidebarProjectOrderFromProjectsLog()
    if (fromProjectsLog.length > 0) {
      return fromProjectsLog
    }
    return [...this.legacySidebarProjectOrder]
  }

  private async readLegacySidebarProjectOrderFromProjectsLog() {
    const file = Bun.file(this.projectsLogPath)
    if (!(await file.exists())) return []

    const text = await file.text()
    if (!text.trim()) return []

    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    let projectIds: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as {
          v?: number
          type?: string
          projectIds?: unknown
        }
        if (event.v !== STORE_VERSION || event.type !== "sidebar_project_order_set") {
          continue
        }
        projectIds = normalizeSidebarProjectOrder(event.projectIds)
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(this.projectsLogPath)} while migrating sidebar order`)
          return projectIds
        }
        console.warn(`${LOG_PREFIX} Failed to migrate sidebar order from ${path.basename(this.projectsLogPath)}:`, error)
        return []
      }
    }

    return projectIds
  }

  private async writeSidebarProjectOrderFile(projectIds: string[]) {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.sidebarProjectOrderPath, `${JSON.stringify(projectIds, null, 2)}\n`, "utf8")
  }

  private async replayLogs() {
    if (this.storageReset) return
    const replayEvents = [
      ...await this.loadReplayEvents(this.projectsLogPath, 0),
      ...await this.loadReplayEvents(this.chatsLogPath, 1),
      ...await this.loadReplayEvents(this.messagesLogPath, 2),
      ...await this.loadReplayEvents(this.queuedMessagesLogPath, 3),
      ...await this.loadReplayEvents(this.turnsLogPath, 4),
    ]
    if (this.storageReset) return

    replayEvents
      .sort((left, right) => (
        left.event.timestamp - right.event.timestamp
        || getReplayEventPriority(left.event) - getReplayEventPriority(right.event)
        || left.sourceIndex - right.sourceIndex
        || left.lineIndex - right.lineIndex
      ))
      .forEach(({ event }) => {
        this.applyEvent(event)
      })
  }

  private async loadReplayEvents(filePath: string, sourceIndex: number): Promise<ParsedReplayEvent[]> {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return []
    const text = await file.text()
    if (!text.trim()) return []

    const parsedEvents: ParsedReplayEvent[] = []
    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as Partial<StoreEvent>
        if (event.v !== STORE_VERSION) {
          console.warn(`${LOG_PREFIX} Resetting local history from incompatible event log`)
          await this.clearStorage()
          return []
        }
        if ((event as { type?: unknown }).type === "sidebar_project_order_set") {
          continue
        }
        parsedEvents.push({
          event: event as StoreEvent,
          sourceIndex,
          lineIndex: index,
        })
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(filePath)}`)
          return parsedEvents
        }
        console.warn(`${LOG_PREFIX} Failed to replay ${path.basename(filePath)}, resetting local history:`, error)
        await this.clearStorage()
        return []
      }
    }

    return parsedEvents
  }

  /**
   * Bumped on every change that can move a sidebar row: applied events,
   * transcript metadata, project order, a reset. Read models memoize on it,
   * so a broadcast that changed nothing here skips the derive entirely.
   */
  stateVersion = 0

  private applyEvent(event: StoreEvent) {
    this.stateVersion += 1
    switch (event.type) {
      case "project_opened": {
        const localPath = resolveLocalPath(event.localPath)
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
        }
        this.state.chatsById.set(chat.id, chat)
        break
      }
      case "chat_renamed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.title = event.title
        // A rename with no source is a person typing, and it takes the title
        // out of automation's hands for good.
        if (event.source) {
          chat.titleSource = event.source
        } else {
          delete chat.titleSource
        }
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
        chat.updatedAt = event.timestamp
        break
      }
    }
  }

  private applyMessageMetadata(chatId: string, entry: TranscriptEntry) {
    this.stateVersion += 1
    const chat = this.state.chatsById.get(chatId)
    if (!chat) return
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
    } else if (entry.kind === "assistant_text" && !entry.hidden) {
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
  }

  private append<TEvent extends StoreEvent>(filePath: string, event: TEvent) {
    const payload = `${JSON.stringify(event)}\n`
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(filePath, payload, "utf8")
      this.applyEvent(event)
    })
    return this.writeChain
  }

  private transcriptPath(chatId: string) {
    return path.join(this.transcriptsDir, `${chatId}.jsonl`)
  }

  private payloadSidecarPath(chatId: string) {
    return path.join(this.transcriptsDir, `${chatId}.payloads.jsonl`)
  }

  private getPayloadIndex(chatId: string) {
    const cached = this.payloadIndexes.get(chatId)
    if (cached) return cached
    while (this.payloadIndexes.size >= EventStore.TRANSCRIPT_CACHE_LIMIT) {
      const oldest = this.payloadIndexes.keys().next().value
      if (oldest === undefined) break
      this.payloadIndexes.delete(oldest)
    }
    const index = new TranscriptPayloadIndex(this.payloadSidecarPath(chatId))
    this.payloadIndexes.set(chatId, index)
    return index
  }

  /**
   * Whether a result belongs to a tool that renders inline and so keeps its
   * content in the header. The call is almost always the previous entry or
   * close to it, so the backward scan ends fast.
   */
  private isInlineResult(chatId: string, toolId: string) {
    const entries = this.getTranscriptEntries(chatId)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (entry.kind === "tool_call" && entry.tool.toolId === toolId) {
        return INLINE_TOOL_KINDS.has(entry.tool.toolKind)
      }
    }
    return false
  }

  private dropTranscriptCaches(chatId: string) {
    this.transcriptCache.delete(chatId)
    this.payloadIndexes.delete(chatId)
  }

  /** Transcript, payload sidecar and media of a chat that is gone for good. */
  private async removeTranscriptFiles(chatId: string) {
    await rm(this.transcriptPath(chatId), { force: true })
    await rm(this.payloadSidecarPath(chatId), { force: true })
    await removeTranscriptMedia(this.dataDir, chatId)
    this.dropTranscriptCaches(chatId)
  }

  /** Absolute path of a chat's JSONL transcript (may not exist yet for a fresh chat). */
  getTranscriptPath(chatId: string) {
    return this.transcriptPath(chatId)
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

  private hasSlimMarker() {
    if (!existsSync(this.slimMarkerPath)) return false
    try {
      const marker = JSON.parse(readFileSyncImmediate(this.slimMarkerPath, "utf8")) as { version?: number }
      return marker.version === SLIM_SWEEP_VERSION
    } catch {
      return false
    }
  }

  /**
   * Every entry for a chat as the transcript file holds it, which is header
   * form: tool bodies live in the payload sidecar and are merged back only by
   * `getEntriesById` and `getMessages`. Loads from disk on miss. Callers must
   * not mutate.
   */
  private getTranscriptEntries(chatId: string): TranscriptEntry[] {
    const cached = this.transcriptCache.get(chatId)
    if (cached) {
      // Refresh LRU recency.
      this.transcriptCache.delete(chatId)
      this.transcriptCache.set(chatId, cached)
      return cached
    }

    const legacyEntries = this.legacyMessagesByChatId.get(chatId)
    const entries = legacyEntries ? cloneTranscriptEntries(legacyEntries) : this.loadTranscriptFromDisk(chatId)
    this.setCachedTranscript(chatId, entries)
    return entries
  }

  private setCachedTranscript(chatId: string, entries: TranscriptEntry[]) {
    this.transcriptCache.delete(chatId)
    while (this.transcriptCache.size >= EventStore.TRANSCRIPT_CACHE_LIMIT) {
      const oldest = this.transcriptCache.keys().next().value
      if (oldest === undefined) break
      this.transcriptCache.delete(oldest)
    }
    this.transcriptCache.set(chatId, entries)
  }

  private loadTranscriptFromDisk(chatId: string) {
    const transcriptPath = this.transcriptPath(chatId)
    if (!existsSync(transcriptPath)) {
      return []
    }

    const text = readFileSyncImmediate(transcriptPath, "utf8")
    if (!text.trim()) return []

    const entries: TranscriptEntry[] = []
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      entries.push(JSON.parse(line) as TranscriptEntry)
    }
    return entries
  }

  async openProject(localPath: string, title?: string) {
    const normalized = resolveLocalPath(localPath)
    const existingId = this.state.projectIdsByPath.get(normalized)
    if (existingId) {
      const existing = this.state.projectsById.get(existingId)
      if (existing && !existing.deletedAt) {
        return existing
      }
    }

    const hiddenProject = [...this.state.projectsById.values()]
      .find((project) => project.localPath === normalized && project.deletedAt)
    const projectId = hiddenProject?.id ?? crypto.randomUUID()
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_opened",
      timestamp: Date.now(),
      projectId,
      localPath: normalized,
      title: title?.trim() || path.basename(normalized) || normalized,
    }
    await this.append(this.projectsLogPath, event)
    return this.state.projectsById.get(projectId)!
  }

  async removeProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_removed",
      timestamp: Date.now(),
      projectId,
    }
    await this.append(this.projectsLogPath, event)
  }

  async renameProjectSidebarTitle(projectId: string, title: string) {
    const trimmed = title.trim()
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    const nextTitle = trimmed || null
    if ((project.sidebarTitle ?? null) === nextTitle) return

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_sidebar_renamed",
      timestamp: Date.now(),
      projectId,
      title: nextTitle,
    }
    await this.append(this.projectsLogPath, event)
  }

  async setSidebarProjectOrder(projectIds: string[]) {
    this.stateVersion += 1
    const validProjectIds = projectIds.filter((projectId) => {
      const project = this.state.projectsById.get(projectId)
      return Boolean(project && !project.deletedAt)
    })

    const uniqueProjectIds = [...new Set(validProjectIds)]
    const current = this.sidebarProjectOrder
    if (
      uniqueProjectIds.length === current.length
      && uniqueProjectIds.every((projectId, index) => current[index] === projectId)
    ) {
      return
    }

    this.writeChain = this.writeChain.then(async () => {
      await this.writeSidebarProjectOrderFile(uniqueProjectIds)
      this.sidebarProjectOrder = [...uniqueProjectIds]
    })
    return this.writeChain
  }

  async createChat(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) {
      throw new Error("Project not found")
    }
    const chatId = crypto.randomUUID()
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: Date.now(),
      chatId,
      projectId,
      title: "New Chat",
    }
    await this.append(this.chatsLogPath, event)
    return this.state.chatsById.get(chatId)!
  }

  async forkChat(sourceChatId: string) {
    const sourceChat = this.requireChat(sourceChatId)
    const sourceSessionToken = sourceChat.sessionToken ?? sourceChat.pendingForkSessionToken ?? null
    if (!sourceChat.provider || !sourceSessionToken) {
      throw new Error("Chat cannot be forked")
    }

    const chatId = crypto.randomUUID()
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
    }
    await this.append(this.chatsLogPath, createEvent)
    // The fork carries the same conversation, so it carries the same claim on
    // the files that conversation changed — it stays in Relevant alongside its
    // source rather than starting with an empty touched set.
    // Base blobs come along too, so a fork of a chat whose work is already
    // committed inherits a settled claim rather than a live one.
    if (sourceChat.touchedFiles?.length) {
      await this.recordFilesTouched(chatId, sourceChat.touchedFiles)
    }
    await this.setChatProvider(chatId, sourceChat.provider)
    await this.setPlanMode(chatId, sourceChat.planMode)
    await this.setAutoPlan(chatId, sourceChat.autoPlan)
    await this.setPendingForkSessionToken(chatId, sourceSessionToken)

    // The fork gets its own copy of any images, and its entries point at
    // that copy, so deleting the source later does not blank its screenshots.
    const sourceEntries = this.getMessages(sourceChatId)
      .map((entry) => retargetEntryMediaUrls(entry, sourceChatId, chatId))
    if (sourceEntries.length > 0) {
      const transcriptPath = this.transcriptPath(chatId)
      const payload = sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")
      this.writeChain = this.writeChain.then(async () => {
        await this.ensureTranscriptsDir()
        await copyTranscriptMedia(this.dataDir, sourceChatId, chatId)
        // `getMessages` merged the payloads back in, so the fork's transcript
        // is whole on disk; its first slim sweep or append leaves it that way
        // until a rewrite, and every reader accepts both forms.
        await writeFile(transcriptPath, `${payload}\n`, "utf8")
        const chat = this.state.chatsById.get(chatId)
        if (chat) {
          chat.hasMessages = true
          chat.updatedAt = Math.max(chat.updatedAt, createdAt)
          // The fork's conversation *is* the source's, so it inherits its turns
          // too — a fork of a twenty-turn chat has twenty turns behind it, and
          // starting the count from zero would read as a fresh chat.
          if (sourceChat.turnCount) chat.turnCount = sourceChat.turnCount
          if (sourceChat.lastUserMessagePreview) chat.lastUserMessagePreview = sourceChat.lastUserMessagePreview
          if (sourceChat.lastAgentMessagePreview) {
            chat.lastAgentMessagePreview = sourceChat.lastAgentMessagePreview
            chat.lastAgentMessagePreviewAt = sourceChat.lastAgentMessagePreviewAt
          }
          // Same transcript, so the same last-agent-activity timestamp a
          // reload would derive from it.
          if (sourceChat.lastAgentMessageAt != null) {
            chat.lastAgentMessageAt = Math.max(chat.lastAgentMessageAt ?? 0, sourceChat.lastAgentMessageAt)
          }
        }
        this.setCachedTranscript(chatId, cloneTranscriptEntries(sourceEntries))
      })
      await this.writeChain
      // The fork inherits the copied conversation's recency: without a
      // `lastMessageAt` it reads as an empty draft and stays hidden from every
      // recency-driven sidebar section until its first new message. Set by the
      // event rather than in the block above, so it survives the restart —
      // this transcript is a copy, so rehydrating it hits the same tail limit
      // the source's did, and would otherwise date the fork by whatever prompt
      // happens to sit inside the window.
      await this.recordLastMessageAt(chatId, sourceEntries[sourceEntries.length - 1]?.createdAt)
    }

    return this.state.chatsById.get(chatId)!
  }

  /**
   * `source` records who named the chat: omit it for a user rename, which is
   * final, or pass "auto"/"refined" for a generated one, which the post-turn
   * refiner is still allowed to revisit.
   */
  async renameChat(chatId: string, title: string, options?: { source?: "auto" | "refined" }) {
    const trimmed = title.trim()
    if (!trimmed) return
    const chat = this.requireChat(chatId)
    if (chat.title === trimmed && chat.titleSource === options?.source) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_renamed",
      timestamp: Date.now(),
      chatId,
      title: trimmed,
      ...(options?.source ? { source: options.source } : {}),
    }
    await this.append(this.chatsLogPath, event)
  }

  async deleteChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_deleted",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async archiveChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_archived",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async unarchiveChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_unarchived",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async pruneStaleEmptyChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_EMPTY_CHAT_MAX_AGE_MS
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const prunedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || protectedChatIds.has(chat.id)) continue
      if (now - chat.createdAt < maxAgeMs) continue
      if (chat.hasMessages) continue
      // Peek without inserting into the transcript cache — the prune sweep
      // must not evict actively streaming chats.
      const entries = this.transcriptCache.get(chat.id)
        ?? this.legacyMessagesByChatId.get(chat.id)
        ?? this.loadTranscriptFromDisk(chat.id)
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
      await this.append(this.chatsLogPath, event)

      await this.removeTranscriptFiles(chat.id)

      prunedChatIds.push(chat.id)
    }

    return prunedChatIds
  }

  /**
   * The most recent activity across all live chats — the reference point the
   * staleness sweeps measure against. Anchoring to the user's own activity
   * (never the wall clock) means an idle month away moves nothing: chats only
   * become "stale" relative to newer work, not relative to time passing.
   */
  private latestChatActivityAt(): number | null {
    let latest: number | null = null
    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt) continue
      const at = chat.lastMessageAt ?? chat.createdAt
      if (latest == null || at > latest) latest = at
    }
    return latest
  }

  /**
   * Garbage-collects long-idle chats by archiving (not deleting) them: any
   * chat whose last activity is more than `maxAgeMs` behind the user's latest
   * chat activity and that isn't already archived/deleted, protected, or
   * empty. Empty stale chats are left for pruneStaleEmptyChats to
   * hard-delete. Sending a message unarchives, so this is non-destructive
   * housekeeping.
   */
  async autoArchiveStaleChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_CHAT_AUTO_ARCHIVE_MAX_AGE_MS
    // min() guards against clock skew pushing a chat timestamp into the future.
    const reference = Math.min(now, this.latestChatActivityAt() ?? now)
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const archivedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || protectedChatIds.has(chat.id)) continue
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
      await this.append(this.chatsLogPath, event)
      archivedChatIds.push(chat.id)
    }

    return archivedChatIds
  }

  /**
   * Hard-deletes long-idle chats — archived or not — whose last activity is
   * more than `maxAgeMs` behind the user's latest chat activity, reclaiming
   * their transcript files. The end of the lifecycle after auto-archive;
   * protected (active/draft) chats are spared.
   */
  async deleteStaleChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_CHAT_DELETE_MAX_AGE_MS
    // min() guards against clock skew pushing a chat timestamp into the future.
    const reference = Math.min(now, this.latestChatActivityAt() ?? now)
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const deletedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || protectedChatIds.has(chat.id)) continue
      const lastActivityAt = chat.lastMessageAt ?? chat.createdAt
      if (reference - lastActivityAt < maxAgeMs) continue

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_deleted",
        timestamp: now,
        chatId: chat.id,
      }
      await this.append(this.chatsLogPath, event)

      await this.removeTranscriptFiles(chat.id)

      deletedChatIds.push(chat.id)
    }

    return deletedChatIds
  }

  async setChatProvider(chatId: string, provider: AgentProvider) {
    const chat = this.requireChat(chatId)
    if (chat.provider === provider) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_provider_set",
      timestamp: Date.now(),
      chatId,
      provider,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setPlanMode(chatId: string, planMode: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.planMode === planMode) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_plan_mode_set",
      timestamp: Date.now(),
      chatId,
      planMode,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setAutoPlan(chatId: string, autoPlan: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.autoPlan === autoPlan) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_auto_plan_set",
      timestamp: Date.now(),
      chatId,
      autoPlan,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setChatReadState(chatId: string, unread: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.unread === unread) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_read_state_set",
      timestamp: Date.now(),
      chatId,
      unread,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setChatDoneState(chatId: string, done: boolean) {
    const chat = this.requireChat(chatId)
    if (Boolean(chat.doneAt) === done) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_done_state_set",
      timestamp: Date.now(),
      chatId,
      done,
    }
    await this.append(this.chatsLogPath, event)
  }

  /**
   * Persist where the user left off reading. Called on a throttle from the
   * client as it scrolls, so the no-op guard below matters — it is the only
   * write rate-limit in the store.
   */
  async setChatReadAnchor(
    chatId: string,
    messageId: string,
    atEnd: boolean,
    layout?: { transcriptWidth?: number; offsetFromMessage?: number }
  ) {
    const chat = this.requireChat(chatId)
    // Scrolling within one message changes only the offset, so that has to
    // count as a change or the position would stick to wherever the message
    // first came into view.
    if (
      chat.readAnchor?.messageId === messageId
      && chat.readAnchor.atEnd === atEnd
      && chat.readAnchor.offsetFromMessage === layout?.offsetFromMessage
      && chat.readAnchor.transcriptWidth === layout?.transcriptWidth
    ) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_read_anchor_set",
      timestamp: Date.now(),
      chatId,
      messageId,
      atEnd,
      ...(layout?.transcriptWidth != null ? { transcriptWidth: layout.transcriptWidth } : {}),
      ...(layout?.offsetFromMessage != null ? { offsetFromMessage: layout.offsetFromMessage } : {}),
    }
    await this.append(this.chatsLogPath, event)
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
   * Entries by id, with their payloads intact.
   *
   * Backs the tool-payload fetch: snapshots ship tool calls and results without
   * their unbounded fields, and a row that gets opened asks for the real thing.
   * Batched because expanding a tool group asks for every member at once.
   * `debugRaw` is stripped as everywhere else on the wire — the raw JSON view
   * has its own request for that.
   *
   * Ids that no longer exist are simply absent from the result.
   */
  getEntriesById(chatId: string, entryIds: string[]): TranscriptEntry[] {
    this.requireChat(chatId)
    if (entryIds.length === 0) return []
    const wanted = new Set(entryIds)
    const found: TranscriptEntry[] = []
    let index: TranscriptPayloadIndex | null = null
    for (const entry of this.getTranscriptEntries(chatId)) {
      if (!wanted.has(entry._id)) continue
      const { debugRaw, ...rest } = entry
      // Only headers marked `trimmed` have a sidecar line; anything else
      // (an inline kind, or a transcript written before the sidecar) is
      // already whole.
      const payload = rest.trimmed ? (index ??= this.getPayloadIndex(chatId)).read(rest._id) : null
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

  async appendMessage(chatId: string, entry: TranscriptEntry) {
    this.requireChat(chatId)
    // A user prompt is the only entry that moves `lastMessageAt`, so stamping
    // it here costs one log line per prompt rather than one per entry — and it
    // has to be logged, because boot only re-derives this from the transcript's
    // last 256 KB. See `recordLastMessageAt`.
    if (entry.kind === "user_prompt") {
      await this.recordLastMessageAt(chatId, entry.createdAt)
    }
    const transcriptPath = this.transcriptPath(chatId)
    this.writeChain = this.writeChain.then(async () => {
      await this.ensureTranscriptsDir()
      // Bytes the header points at go to disk first (image files, then the
      // payload line), so a header on disk never names something missing.
      const stored = await externalizeEntryImages(entry, { dataDir: this.dataDir, chatId })
      const { header, payload } = splitTranscriptEntry(stored, (toolId) => this.isInlineResult(chatId, toolId))
      if (payload) {
        const line = serializeTranscriptPayload(payload)
        await appendFile(this.payloadSidecarPath(chatId), line, "utf8")
        this.payloadIndexes.get(chatId)?.noteAppended(payload._id, Buffer.byteLength(line, "utf8"))
      }
      const headerLine = `${JSON.stringify(header)}\n`
      await appendFile(transcriptPath, headerLine, "utf8")
      this.applyMessageMetadata(chatId, entry)
      // Deep clone via the already-serialized line: the cached entry is
      // byte-identical to what a cold disk read would produce, and callers
      // that keep mutating their entry can't alias into the cache.
      this.transcriptCache.get(chatId)?.push(JSON.parse(headerLine) as TranscriptEntry)
    })
    return this.writeChain
  }

  async enqueueMessage(chatId: string, message: Omit<QueuedChatMessage, "id" | "createdAt"> & Partial<Pick<QueuedChatMessage, "id" | "createdAt">>) {
    this.requireChat(chatId)
    const queuedMessage: QueuedChatMessage = {
      id: message.id ?? crypto.randomUUID(),
      content: message.content,
      attachments: [...(message.attachments ?? [])],
      createdAt: message.createdAt ?? Date.now(),
      provider: message.provider,
      model: message.model,
      modelOptions: message.modelOptions,
      planMode: message.planMode,
      autoPlan: message.autoPlan,
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_enqueued",
      timestamp: queuedMessage.createdAt,
      chatId,
      message: queuedMessage,
    }
    await this.append(this.queuedMessagesLogPath, event)
    return queuedMessage
  }

  async removeQueuedMessage(chatId: string, queuedMessageId: string) {
    this.requireChat(chatId)
    const existing = this.getQueuedMessages(chatId)
    if (!existing.some((entry) => entry.id === queuedMessageId)) {
      throw new Error("Queued message not found")
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_removed",
      timestamp: Date.now(),
      chatId,
      queuedMessageId,
    }
    await this.append(this.queuedMessagesLogPath, event)
  }

  /** `model` is what this turn runs with; omitted where the caller has none to name. */
  async recordTurnStarted(chatId: string, model?: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_started",
      timestamp: Date.now(),
      chatId,
      ...(model ? { model } : {}),
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnStarted?.(chatId)
  }

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
  private async recordLastMessageAt(chatId: string, at: number | undefined) {
    if (at == null) return
    const chat = this.state.chatsById.get(chatId)
    if (!chat || (chat.lastMessageAt ?? 0) >= at) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_last_message_at_set",
      timestamp: Date.now(),
      chatId,
      at,
    }
    await this.append(this.chatsLogPath, event)
  }

  /** Records the files one turn changed; replay unions them into `touchedFiles`. */
  async recordFilesTouched(chatId: string, files: TouchedFile[]) {
    if (files.length === 0) return
    const chat = this.state.chatsById.get(chatId)
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
    await this.append(this.chatsLogPath, event)
  }

  async recordTurnFinished(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_finished",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnEnded?.(chatId)
  }

  async recordTurnFailed(chatId: string, error: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_failed",
      timestamp: Date.now(),
      chatId,
      error,
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnEnded?.(chatId)
  }

  async recordTurnCancelled(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_cancelled",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
    this.onTurnEnded?.(chatId)
  }

  async setSessionToken(chatId: string, sessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if (chat.sessionToken === sessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "session_token_set",
      timestamp: Date.now(),
      chatId,
      sessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  async setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if ((chat.pendingForkSessionToken ?? null) === pendingForkSessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "pending_fork_session_token_set",
      timestamp: Date.now(),
      chatId,
      pendingForkSessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  getProject(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) return null
    return project
  }

  requireChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) {
      throw new Error("Chat not found")
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

  /**
   * The whole transcript with every tool body merged back in. This reads
   * the payload sidecar end to end, so it is for export, handoff and fork,
   * not for anything that runs per push.
   */
  getMessages(chatId: string) {
    const entries = this.getTranscriptEntries(chatId)
    if (!entries.some((entry) => entry.trimmed)) return cloneTranscriptEntries(entries)
    const payloads = readAllTranscriptPayloads(this.payloadSidecarPath(chatId))
    return entries.map((entry) => entry.trimmed
      ? mergeTranscriptPayload({ ...entry }, payloads.get(entry._id))
      : { ...entry })
  }

  /**
   * The transcript in header form — tool bodies left in the sidecar. For
   * readers that only need to know *what* happened (titles, summaries), not
   * what the tools returned.
   */
  getTranscriptHeaders(chatId: string) {
    return cloneTranscriptEntries(this.getTranscriptEntries(chatId))
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
   * The whole transcript, reduced for the wire, plus the resolved read anchor.
   *
   * There is no window. Once consecutive tool calls collapse into single rows a
   * chat is a few hundred rows — the largest here is 1,096 — and with the tool
   * payloads trimmed the entire thing is smaller than one page of untrimmed
   * history used to be. Sending all of it means the client can render, search
   * and map the whole conversation without ever asking for more.
   *
   * The transcript file is already in header form, so the clone below only
   * has work to do on entries written before the payload sidecar existed.
   *
   * `startIndex` is always 0. It stays on the shape because streamed appends
   * are sent as slices positioned against it.
   */
  /**
   * The transcript as a client sees it, from `fromIndex` on.
   *
   * Cloning is per entry, so a push used to clone the whole chat and then
   * throw away everything before the window. Callers pass the earliest index
   * any subscriber holds. `startIndex` records where the clone begins so the
   * router can still slice per socket.
   */
  getClientTranscript(chatId: string, fromIndex = 0) {
    const entries = this.getTranscriptEntries(chatId)
    const start = Math.max(0, Math.min(fromIndex, entries.length))
    return {
      messages: cloneTranscriptEntriesForClient(start === 0 ? entries : entries.slice(start)),
      startIndex: start,
      readAnchor: this.getChatReadAnchor(chatId),
      outline: this.getTranscriptOutline(chatId, entries),
    }
  }

  /**
   * Outline per cached transcript, rebuilt only when a prompt was appended.
   * Keyed by the entries array, which appends grow in place and a reload
   * replaces, so a stale array can never serve a stale outline. Between
   * prompts only the appended tail is scanned.
   */
  private readonly outlineCache = new WeakMap<TranscriptEntry[], { length: number; outline: TranscriptOutlineEntry[] }>()

  private getTranscriptOutline(chatId: string, entries: TranscriptEntry[]): TranscriptOutlineEntry[] {
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

  async getLegacyTranscriptStats(): Promise<LegacyTranscriptStats> {
    const messagesLogSize = await Bun.file(this.messagesLogPath).size
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

  async hasLegacyTranscriptData() {
    return (await this.getLegacyTranscriptStats()).hasLegacyData
  }

  private createSnapshot(): SnapshotFile {
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
    }
  }

  async compact() {
    const snapshot = this.createSnapshot()
    await Bun.write(this.snapshotPath, JSON.stringify(snapshot, null, 2))
    await Promise.all([
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.queuedMessagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  async migrateLegacyTranscripts(onProgress?: (message: string) => void) {
    const stats = await this.getLegacyTranscriptStats()
    if (!stats.hasLegacyData) return false

    const sourceSummary = stats.sources.map((source) => source === "messages_log" ? "messages.jsonl" : "snapshot.json").join(", ")
    onProgress?.(`${LOG_PREFIX} transcript migration detected: ${stats.chatCount} chats, ${stats.entryCount} entries from ${sourceSummary}`)

    const messageSets = [...this.legacyMessagesByChatId.entries()]
    onProgress?.(`${LOG_PREFIX} transcript migration: writing ${messageSets.length} per-chat transcript files`)

    await this.ensureTranscriptsDir()
    const logEveryChat = messageSets.length <= 10
    for (let index = 0; index < messageSets.length; index += 1) {
      const [chatId, entries] = messageSets[index]
      const transcriptPath = this.transcriptPath(chatId)
      const tempPath = `${transcriptPath}.tmp`
      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n")
      await writeFile(tempPath, payload ? `${payload}\n` : "", "utf8")
      await rename(tempPath, transcriptPath)
      if (logEveryChat || (index + 1) % 25 === 0 || index === messageSets.length - 1) {
        onProgress?.(`${LOG_PREFIX} transcript migration: ${index + 1}/${messageSets.length} chats`)
      }
    }

    this.clearLegacyTranscriptState()
    await this.compact()
    this.transcriptCache.clear()
    this.payloadIndexes.clear()
    onProgress?.(`${LOG_PREFIX} transcript migration complete`)
    return true
  }

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
  async slimTranscripts(options?: { force?: boolean; onProgress?: (message: string) => void }) {
    const stats = { chats: 0, rewritten: 0, bytesBefore: 0, bytesAfter: 0 }
    if (!options?.force && this.hasSlimMarker()) return stats

    await this.ensureTranscriptsDir()
    const files = (await readdir(this.transcriptsDir))
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".payloads.jsonl"))
    for (const name of files) {
      const chatId = name.slice(0, -".jsonl".length)
      const transcriptPath = path.join(this.transcriptsDir, name)
      stats.chats += 1
      this.writeChain = this.writeChain.then(async () => {
        let result: Awaited<ReturnType<typeof slimTranscriptFile>>
        // Calls precede their results in a transcript, so this set is
        // complete by the time a result asks about its tool.
        const inlineToolIds = new Set<string>()
        const sidecarPath = this.payloadSidecarPath(chatId)
        try {
          result = await slimTranscriptFile(transcriptPath, async (entry) => {
            if (entry.kind === "tool_call" && INLINE_TOOL_KINDS.has(entry.tool.toolKind)) {
              inlineToolIds.add(entry.tool.toolId)
            }
            const stored = await externalizeEntryImages(entry, { dataDir: this.dataDir, chatId })
            const { header, payload } = splitTranscriptEntry(stored, (toolId) => inlineToolIds.has(toolId))
            // The payload line lands before the header file is renamed over,
            // same order as a live append.
            if (payload) await appendFile(sidecarPath, serializeTranscriptPayload(payload), "utf8")
            return header
          })
        } catch (error) {
          options?.onProgress?.(`${LOG_PREFIX} transcript slim: skipped ${name}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        stats.bytesBefore += result.bytesBefore
        stats.bytesAfter += result.bytesAfter
        if (!result.changed) return
        stats.rewritten += 1
        this.dropTranscriptCaches(chatId)
        options?.onProgress?.(
          `${LOG_PREFIX} transcript slim: ${name} ${formatMegabytes(result.bytesBefore)} → ${formatMegabytes(result.bytesAfter)}`
        )
      })
      await this.writeChain
    }

    await writeFile(this.slimMarkerPath, `${JSON.stringify({ version: SLIM_SWEEP_VERSION, completedAt: Date.now() })}\n`, "utf8")
    if (stats.rewritten > 0) {
      options?.onProgress?.(
        `${LOG_PREFIX} transcript slim complete: ${stats.rewritten}/${stats.chats} chats rewritten, ${formatMegabytes(stats.bytesBefore)} → ${formatMegabytes(stats.bytesAfter)}`
      )
    }
    return stats
  }

  private async shouldCompact() {
    const sizes = await Promise.all([
      Bun.file(this.projectsLogPath).size,
      Bun.file(this.chatsLogPath).size,
      Bun.file(this.messagesLogPath).size,
      Bun.file(this.queuedMessagesLogPath).size,
      Bun.file(this.turnsLogPath).size,
    ])
    return sizes.reduce((total, size) => total + size, 0) >= COMPACTION_THRESHOLD_BYTES
  }
}

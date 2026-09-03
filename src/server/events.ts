import type { AgentProvider, ProjectSummary, QueuedChatMessage, TranscriptEntry } from "../shared/types"

export interface ProjectRecord extends ProjectSummary {
  sidebarTitle?: string
  deletedAt?: number
}

export interface ChatReadAnchor {
  messageId: string
  atEnd: boolean
  updatedAt: number
  /**
   * Width of the transcript column when this was recorded.
   *
   * `offsetFromMessage` is only meaningful at the same width — a narrower
   * column rewraps text, so the same scroll position sits at a different
   * distance into the message. Absent on anchors written before this existed.
   */
  transcriptWidth?: number
  /**
   * How far below the anchored message's own top the reader was, in pixels.
   *
   * Deliberately relative rather than an absolute scroll position: rows that
   * have never been on screen stand in at an estimated height, so the absolute
   * coordinate space shifts as they render and an absolute offset restores to
   * the wrong place. A distance from the message survives that, and carries the
   * within-message position that pinning the message alone would lose.
   */
  offsetFromMessage?: number
}

export interface ChatRecord {
  id: string
  projectId: string
  title: string
  /**
   * Where the current title came from. "auto" — generated from the opening
   * message before any work happened, so the post-turn refiner is allowed to
   * replace it. "refined" — the refiner has already had its look. Absent means
   * a person named it (or a fork inherited it), and nothing renames it again.
   */
  titleSource?: "auto" | "refined"
  createdAt: number
  updatedAt: number
  deletedAt?: number
  archivedAt?: number
  /** Set when the user marks the chat done (e.g. drags it to the board's Done column). Cleared when a new turn starts. */
  doneAt?: number
  unread: boolean
  /**
   * Where the user last left off reading, anchored to a transcript entry `_id`
   * so it survives history paging and re-renders. `atEnd` means they were
   * parked at the bottom following the stream — restore should keep following
   * rather than pin to a message.
   */
  readAnchor?: ChatReadAnchor | null
  provider: AgentProvider | null
  planMode: boolean
  /** "Auto Plan": the harness keeps its EnterPlanMode tool. Claude only. */
  autoPlan: boolean
  sessionToken: string | null
  pendingForkSessionToken?: string | null
  hasMessages?: boolean
  lastMessageAt?: number
  /**
   * When the most recent turn *started*. With `lastTurnEndedAt` this is how
   * long the last turn took; while a turn is running it's how long it has been
   * going. Absent on chats whose turns all predate the field.
   */
  lastTurnStartedAt?: number
  /**
   * Model id the most recent turn ran with (e.g. "opus", "gpt-5.3-codex").
   * Recorded per turn rather than per chat because the model is picked at send
   * time and can differ turn to turn — this is the one that actually ran, not
   * whatever the composer happens to be set to now.
   */
  lastModel?: string
  /** When the last turn ended (finished/failed/cancelled) — i.e. when the last agent response was received. */
  lastTurnEndedAt?: number
  /**
   * How many turns this chat has run, counted from `turn_started`.
   *
   * A running total rather than something derived on demand: the sidebar
   * snapshot is built from `StoreState` alone and never opens a transcript, and
   * counting prompts per chat per broadcast would mean reading every one.
   *
   * Safe to accumulate here precisely because these are *store* events —
   * compaction writes the total into the snapshot and truncates the log, so
   * replay only re-applies what came after it. The same counter kept in
   * `applyMessageMetadata` would double-count, since boot re-runs that over
   * each transcript's tail on top of an already-loaded snapshot.
   *
   * Absent on chats whose turns all predate the field — the card says nothing
   * rather than claiming zero.
   */
  turnCount?: number
  /**
   * When the agent last wrote to the transcript (assistant text, tool call, or
   * tool result). Advances mid-turn, unlike `lastTurnEndedAt` — the timestamp
   * a chat waiting on a plan or a permission prompt sorts by.
   */
  lastAgentMessageAt?: number
  lastUserMessagePreview?: string
  lastAgentMessagePreview?: string
  /**
   * When `lastAgentMessagePreview`'s entry was written — i.e. how old the
   * agent's last *words* are, as opposed to `lastAgentMessageAt`, which any
   * tool call advances. Compared against `lastMessageAt` to tell a reply to the
   * current prompt from one left over from the previous turn.
   */
  lastAgentMessagePreviewAt?: number
  lastTurnOutcome: "success" | "failed" | "cancelled" | null
  /**
   * Files this chat has changed, unioned across its turns and measured by
   * diffing worktree snapshots at each turn boundary (see `TurnFileTracker`).
   * Intersected with the currently-dirty paths to decide whether a chat is
   * relevant to your uncommitted work.
   *
   * Last write wins per path: a later turn's base blob replaces an earlier
   * one's, so a chat that edits a file, has it committed, then edits it again
   * is measured against the newer commit rather than the one it started from.
   */
  touchedFiles?: TouchedFile[]
  /**
   * Legacy shape — paths with no base blob, written before commits could expire
   * a claim. Normalized into `touchedFiles` when an old snapshot loads and
   * never written again.
   */
  touchedPaths?: string[]
}

/** One file a chat changed, and the committed content it changed it from. */
export interface TouchedFile {
  /** Repo-root-relative. */
  path: string
  /**
   * Blob sha this path held in `HEAD` when the touching turn started, or `null`
   * when it wasn't committed at all. The chat's claim on the path lives exactly
   * as long as `HEAD` still holds this blob: committing the path — by anyone,
   * including the chat itself — replaces it and retires the claim, so a chat
   * whose work has landed can't be dragged back into Relevant by someone else
   * dirtying the same file later.
   *
   * Absent means *unknown* (recorded before base blobs, or the lookup failed),
   * which keeps the old behaviour of flagging on a dirty-path match alone.
   */
  baseBlob?: string | null
  /**
   * Lines this chat wrote to this path, summed over every turn that changed it
   * — how much of the file is the chat's doing, not what the file currently
   * differs from `HEAD` by. A chat that added ten lines and then deleted them
   * reads as `+10 -10` rather than as nothing, which is the honest answer to
   * "what did this chat do here".
   *
   * Absent for binary files (numstat has no count for them) and for anything
   * recorded before turn-level counts existed.
   */
  additions?: number
  deletions?: number
}

export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByPath: Map<string, string>
  chatsById: Map<string, ChatRecord>
  queuedMessagesByChatId: Map<string, QueuedChatMessage[]>
}

export interface SnapshotFile {
  v: 2
  generatedAt: number
  projects: ProjectRecord[]
  chats: ChatRecord[]
  sidebarProjectOrder?: string[]
  queuedMessages?: Array<{ chatId: string; entries: QueuedChatMessage[] }>
  messages?: Array<{ chatId: string; entries: TranscriptEntry[] }>
}

export type ProjectEvent = {
  v: 2
  type: "project_opened"
  timestamp: number
  projectId: string
  localPath: string
  title: string
} | {
  v: 2
  type: "project_sidebar_renamed"
  timestamp: number
  projectId: string
  title: string | null
} | {
  v: 2
  type: "project_removed"
  timestamp: number
  projectId: string
}

export type ChatEvent =
  | {
      v: 2
      type: "chat_created"
      timestamp: number
      chatId: string
      projectId: string
      title: string
      /**
       * Forks only: the source chat's `lastTurnEndedAt`, carried over so the
       * fork inherits the conversation's recency in the sidebar. A fork has no
       * turn events of its own, so without this it would sort by creation time
       * as though the copied conversation never happened. Optional — absent on
       * every plain chat_created, including old logs.
       */
      lastTurnEndedAt?: number
    }
  | {
      v: 2
      type: "chat_renamed"
      timestamp: number
      chatId: string
      title: string
      /**
       * Who named it. Absent means the user did, which is the only answer old
       * logs can give and the one that keeps automation off a hand-typed name.
       * See `ChatRecord.titleSource`.
       */
      source?: "auto" | "refined"
    }
  | {
      v: 2
      type: "chat_deleted"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_archived"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_unarchived"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_provider_set"
      timestamp: number
      chatId: string
      provider: AgentProvider
    }
  | {
      v: 2
      type: "chat_plan_mode_set"
      timestamp: number
      chatId: string
      planMode: boolean
    }
  | {
      v: 2
      type: "chat_auto_plan_set"
      timestamp: number
      chatId: string
      autoPlan: boolean
    }
  | {
      v: 2
      type: "chat_read_state_set"
      timestamp: number
      chatId: string
      unread: boolean
    }
  | {
      v: 2
      type: "chat_done_state_set"
      timestamp: number
      chatId: string
      done: boolean
    }
  | {
      v: 2
      type: "chat_read_anchor_set"
      timestamp: number
      chatId: string
      messageId: string
      atEnd: boolean
      /** See `ChatReadAnchor`. Optional — absent on pre-existing log lines. */
      transcriptWidth?: number
      offsetFromMessage?: number
    }
  | {
      v: 2
      type: "chat_last_message_at_set"
      timestamp: number
      chatId: string
      /**
       * When the user's newest message landed — `ChatRecord.lastMessageAt`.
       *
       * Logged rather than left to be re-derived from the transcript on boot:
       * the rehydration only reads each transcript's tail, so a chat whose last
       * prompt sits behind megabytes of tool output came back with no
       * timestamp at all and fell out of every recency-driven sidebar section.
       * One line per prompt, not per entry.
       */
      at: number
    }
  | {
      v: 2
      type: "chat_files_touched"
      timestamp: number
      chatId: string
      /** Files one turn changed; replay unions them into `ChatRecord.touchedFiles`. */
      files?: TouchedFile[]
      /** Legacy shape: paths with no base blob. Read on replay, never written. */
      paths?: string[]
    }

export type MessageEvent = {
  v: 2
  type: "message_appended"
  timestamp: number
  chatId: string
  entry: TranscriptEntry
}

export type QueuedMessageEvent =
  | {
      v: 2
      type: "queued_message_enqueued"
      timestamp: number
      chatId: string
      message: QueuedChatMessage
    }
  | {
      v: 2
      type: "queued_message_removed"
      timestamp: number
      chatId: string
      queuedMessageId: string
    }

export type TurnEvent =
  | {
      v: 2
      type: "turn_started"
      timestamp: number
      chatId: string
      /** Model this turn runs with. Optional — absent on every pre-existing log line. */
      model?: string
    }
  | {
      v: 2
      type: "turn_finished"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_failed"
      timestamp: number
      chatId: string
      error: string
    }
  | {
      v: 2
      type: "turn_cancelled"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "session_token_set"
      timestamp: number
      chatId: string
      sessionToken: string | null
    }
  | {
      v: 2
      type: "pending_fork_session_token_set"
      timestamp: number
      chatId: string
      pendingForkSessionToken: string | null
    }

export type StoreEvent = ProjectEvent | ChatEvent | MessageEvent | QueuedMessageEvent | TurnEvent

export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(),
    queuedMessagesByChatId: new Map(),
  }
}

export function cloneTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/** Tool kinds whose rendered result comes from `tool_use_result`, not `content`. */
export const STRUCTURED_RESULT_TOOL_KINDS: ReadonlySet<string> = new Set(["ask_user_question", "exit_plan_mode"])

/**
 * Tool kinds that render inline and interactively, so their payloads have to
 * travel with the transcript rather than being fetched when a row is opened —
 * there is no row to open. Superset of the structured-result kinds.
 */
export const INLINE_TOOL_KINDS: ReadonlySet<string> = new Set([...STRUCTURED_RESULT_TOOL_KINDS, "todo_write"])

/**
 * Tool call input fields that can grow without bound, by kind. The other
 * kinds are already header-sized (a path, a pattern, a query) and travel
 * whole.
 */
export const UNBOUNDED_TOOL_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write_file: ["content"],
  delete_file: ["content"],
  edit_file: ["oldString", "newString"],
  mcp_generic: ["payload"],
  unknown_tool: ["payload"],
}

/** Strip the raw provider payload; it duplicates `content` and dwarfs it. */
function withoutDebugRaw<TEntry extends TranscriptEntry>(entry: TEntry) {
  const { debugRaw, ...rest } = entry
  return rest as TEntry
}

/**
 * Drop a tool call's unbounded input fields, keeping everything a collapsed
 * row draws. Returns the entry unchanged when there was nothing to drop, so
 * the `trimmed` marker always means "fetching will reveal more".
 */
export function trimToolCallEntry(entry: Extract<TranscriptEntry, { kind: "tool_call" }>) {
  const { rawInput, ...tool } = entry.tool
  let input = tool.input as Record<string, unknown>
  let dropped = rawInput !== undefined

  for (const field of UNBOUNDED_TOOL_INPUT_FIELDS[tool.toolKind] ?? []) {
    if (input[field] === undefined) continue
    if (!dropped || input === tool.input) input = { ...input }
    delete input[field]
    dropped = true
  }

  if (!dropped) return entry
  return { ...entry, tool: { ...tool, input }, trimmed: true } as TranscriptEntry
}

/**
 * Clone entries for the wire, leaving the bulky parts on the server.
 *
 * A transcript is mostly tool traffic, and a collapsed tool row draws none of
 * it — a group of a dozen calls renders as one line reading "3 reads, 1
 * command". Sending the payloads anyway is how a 6,000-entry chat became 24MB
 * on the wire to paint a few hundred headers. Dropped here, the same chat is
 * under 2MB, and the payloads are fetched by id if a row is actually opened.
 *
 * Two things are deliberately never dropped:
 *
 * - `ask_user_question` / `exit_plan_mode` / `todo_write` render inline, so
 *   there is no expansion to fetch on. The first two additionally get
 *   `tool_use_result` lifted out of `debugRaw` into `structuredResult`.
 * - `isError` and the entry ids, which is everything a collapsed row and its
 *   group label need to describe a finished call.
 *
 * This is the only place the reduction happens. Full-fidelity consumers —
 * export, handoff, fork — read through `getMessages` and never pass here.
 */
export function cloneTranscriptEntriesForClient(entries: TranscriptEntry[]): TranscriptEntry[] {
  const structuredToolIds = new Set<string>()
  const inlineToolIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== "tool_call") continue
    if (STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) {
      structuredToolIds.add(entry.tool.toolId)
    }
    if (INLINE_TOOL_KINDS.has(entry.tool.toolKind)) {
      inlineToolIds.add(entry.tool.toolId)
    }
  }

  return entries.map((entry) => {
    if (entry.kind === "tool_call") {
      const stripped = withoutDebugRaw(entry)
      return INLINE_TOOL_KINDS.has(stripped.tool.toolKind) ? stripped : trimToolCallEntry(stripped)
    }

    if (entry.kind === "tool_result") {
      const structured = structuredToolIds.has(entry.toolId)
        ? entry.structuredResult ?? readStructuredResult(entry.debugRaw)
        : undefined
      const stripped = withoutDebugRaw(entry)
      if (inlineToolIds.has(stripped.toolId)) {
        return structured === undefined ? stripped : { ...stripped, structuredResult: structured }
      }
      // An orphan result — no call in this transcript — is trimmed too: the
      // client only renders results attached to a call it saw.
      const { content, ...rest } = stripped
      return { ...rest, trimmed: true } as TranscriptEntry
    }

    return withoutDebugRaw(entry)
  })
}

/**
 * `tool_use_result` from a raw provider message. Only transcripts written
 * before `structuredResult` was persisted still need this; new tool results
 * carry the field directly and no `debugRaw` at all.
 */
export function readStructuredResult(debugRaw: string | undefined): unknown {
  if (debugRaw === undefined) return undefined
  try {
    return (JSON.parse(debugRaw) as { tool_use_result?: unknown }).tool_use_result
  } catch {
    // Corrupt debugRaw is not worth failing a transcript render over.
    return undefined
  }
}

import type {
  AppSettingsSnapshot,
  AppSettingsPatch,
  AgentProvider,
  AuthServiceId,
  ProviderAuthSnapshot,
  ChatAttachment,
  ChatDiffSnapshot,
  ChatSnapshot,
  DiffCommitMode,
  KeybindingsSnapshot,
  LlmProviderSnapshot,
  LocalProjectsSnapshot,
  ModelOptions,
  SelectedBranch,
  SidebarData,
  StandaloneTranscriptAttachmentMode,
  StandaloneTranscriptExportResult,
  UpdateSnapshot,
  UsageLimitsSnapshot,
  EditorPreset,
} from "./types"

export type { EditorPreset }

export interface EditorOpenSettings {
  preset: EditorPreset
  commandTemplate: string
}

export interface LocalHttpServerInfo {
  title: string
  address: string
  port: number
  status: number
  ownerPath?: string
  processName?: string
  sameProject?: boolean
}

export interface ProjectQuickAction {
  id: string
  label: string
  command: string
}

export type SubscriptionTopic =
  | { type: "sidebar" }
  | { type: "local-projects" }
  | { type: "update" }
  | { type: "keybindings" }
  | { type: "app-settings" }
  | { type: "usage-limits" }
  | { type: "provider-auth" }
  | {
    type: "chat"
    chatId: string
    /**
     * The absolute transcript span the client already holds from its local
     * cache, so the first push can be incremental instead of a full window.
     * Omitted when the client has nothing cached.
     *
     * `endEntryId` is the `_id` of the entry at `end - 1`. The server only
     * honours the span when that entry still matches, which keeps a cache
     * belonging to a different machine — or one written before a transcript
     * was rewritten — from being spliced onto unrelated history.
     */
    cachedSpan?: { start: number; end: number; endEntryId: string }
  }
  | { type: "project-git"; projectId: string }
  | { type: "terminal"; terminalId: string }

export interface TerminalSnapshot {
  terminalId: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  scrollback: number
  serializedState: string
  status: "running" | "exited"
  exitCode: number | null
  signal?: number
  /**
   * Count of output characters the server has seen so far. `serializedState`
   * reflects exactly this much output, so a client that replays it can then
   * ask `terminal.tail` for everything after it.
   */
  outputVersion?: number
}

export type TerminalEvent =
  /** `version` is the output count after `data`; `data` starts at `version - data.length`. */
  | { type: "terminal.output"; terminalId: string; data: string; version?: number }
  | { type: "terminal.exit"; terminalId: string; exitCode: number; signal?: number }

/**
 * Answer to `terminal.tail`. `tail` holds output since the requested version
 * when the server still has it; otherwise `snapshot` carries a full state to
 * replay from scratch.
 */
export interface TerminalTailResult {
  terminalId: string
  tail: { data: string; version: number } | null
  snapshot: TerminalSnapshot | null
}

export type ClientCommand =
  | { type: "project.open"; localPath: string }
  | { type: "project.create"; localPath: string; title?: string }
  | { type: "project.rename"; projectId: string; title: string }
  | { type: "project.clone"; cloneUrl: string; localPath: string; fallbackPath?: string; title: string }
  | { type: "github.listRecentRepos" }
  | { type: "project.remove"; projectId: string }
  | { type: "sidebar.reorderProjectGroups"; projectIds: string[] }
  | { type: "project.readDiffPatch"; projectId: string; path: string }
  // Committing is addressed by project, not by chat: the diff panel's file
  // selection belongs to the project it is rendering, and the active chat can
  // move to another project mid-flow (notably across the "generate a message"
  // round-trip) — which would otherwise aim the commit at the wrong repo.
  | { type: "project.generateCommitMessage"; projectId: string; paths: string[] }
  | { type: "project.commitDiffs"; projectId: string; paths: string[]; summary: string; description?: string; mode: DiffCommitMode }
  | { type: "system.ping" }
  | { type: "fs.list"; path?: string; nearest?: boolean }
  | { type: "fs.mkdir"; path: string }
  | { type: "browser.listLocalHttpServers"; projectId?: string }
  | { type: "browser.killLocalHttpServer"; port: number }
  | { type: "project.readQuickActions"; projectId: string }
  | { type: "project.writeQuickActions"; projectId: string; quickActions: ProjectQuickAction[] }
  | { type: "update.check"; force?: boolean }
  | { type: "update.install" }
  | { type: "update.installNightly" }
  | { type: "update.installStable" }
  | { type: "settings.readKeybindings" }
  | { type: "settings.writeKeybindings"; bindings: KeybindingsSnapshot["bindings"] }
  | { type: "settings.readAppSettings" }
  | { type: "settings.writeAppSettings"; analyticsEnabled: boolean }
  | { type: "settings.writeAppSettingsPatch"; patch: AppSettingsPatch }
  | { type: "settings.readLlmProvider" }
  | { type: "usage.refresh"; force?: boolean }
  | { type: "auth.refresh"; force?: boolean }
  /** Install (or update to the latest version of) a service's CLI. */
  | { type: "auth.install"; service: AuthServiceId }
  | { type: "auth.login.start"; service: AuthServiceId }
  /** claude only: the code the user pasted back from the OAuth page. */
  | { type: "auth.login.submitCode"; service: AuthServiceId; code: string }
  | { type: "auth.login.cancel"; service: AuthServiceId }
  /** Ack result: `{ authUrl: string }` — open in a popup. */
  | { type: "auth.openrouter.start"; callbackUrl: string }
  /** Ack result: LlmProviderSnapshot with the exchanged key saved. */
  | { type: "auth.openrouter.exchange"; code: string }
  | { type: "chat.listSkills"; provider: AgentProvider; chatId?: string; projectId?: string }
  | { type: "skills.search"; query: string; limit?: number }
  | { type: "skills.install"; source: string; skillId: string }
  | { type: "skills.uninstall"; skillId: string }
  | { type: "skills.listInstalled" }
  | { type: "skills.listGlobal" }
  | {
      type: "settings.writeLlmProvider"
      provider: LlmProviderSnapshot["provider"]
      apiKey: string
      model: string
      baseUrl: string
      faveModels?: LlmProviderSnapshot["faveModels"]
    }
  | {
      type: "settings.validateLlmProvider"
      provider: LlmProviderSnapshot["provider"]
      apiKey: string
      model: string
      baseUrl: string
    }
  | {
      type: "system.openExternal"
      localPath: string
      action: "open_finder" | "open_terminal" | "open_editor" | "open_preview" | "open_default"
      line?: number
      column?: number
      editor?: EditorOpenSettings
    }
  | { type: "chat.create"; projectId: string }
  | { type: "chat.fork"; chatId: string }
  | { type: "chat.rename"; chatId: string; title: string }
  | { type: "chat.archive"; chatId: string }
  | { type: "chat.unarchive"; chatId: string }
  | { type: "chat.delete"; chatId: string }
  | { type: "chat.setDraftProtection"; chatIds: string[] }
  /**
   * The files a chat changed, for its sidebar hover card. Ack-only and read
   * on demand: the list is too big per chat to ride along on every sidebar
   * snapshot, and it's only ever wanted for the one row under the pointer.
   */
  | { type: "chat.touchedFiles"; chatId: string }
  | { type: "chat.markRead"; chatId: string }
  | { type: "chat.setDone"; chatId: string; done: boolean }
  /**
   * Persist where the user left off reading. Sent on a throttle while
   * scrolling. Deliberately ack-only: the anchor is not part of any snapshot,
   * so a scroll never triggers a sidebar or chat re-push to other sockets.
   */
  | {
    type: "chat.setReadAnchor"
    chatId: string
    messageId: string
    atEnd: boolean
    /** Transcript column width and the position's distance into the message. */
    transcriptWidth?: number
    offsetFromMessage?: number
  }
  /** Read back the stored anchor when opening a chat. Result: ResolvedChatReadAnchor | null. */
  | { type: "chat.getReadAnchor"; chatId: string }
  /** The hover card's prompt and reply text; see `ChatPreview`. */
  | { type: "chat.getPreview"; chatId: string }
  /**
   * Fetch one entry's raw provider payload. Snapshots omit `debugRaw` because
   * it duplicates `content` and dominates the transcript payload, so the raw
   * JSON debug view pulls it on demand when opened.
   */
  | { type: "chat.getEntryDebugRaw"; chatId: string; entryId: string }
  /**
   * Fetch tool entries with their payloads intact. Snapshots ship tool calls
   * and results without their unbounded fields — a collapsed row draws none of
   * them — so opening a row asks for the real thing. Batched: expanding a tool
   * group wants every member at once. Result: TranscriptEntry[].
   */
  | { type: "chat.getToolEntries"; chatId: string; entryIds: string[] }
  /**
   * Widen this socket's window on a chat toward the start of the transcript.
   * By one more window of assistant messages by default; far enough to
   * include `untilMessageId` when jumping to a turn that is not loaded; the
   * whole transcript with `all`. The widened slice arrives as an incremental
   * push that lands before what the client holds. Result: `{ startIndex }`.
   */
  | { type: "chat.loadOlder"; chatId: string; untilMessageId?: string; all?: boolean }
  | {
      type: "chat.send"
      chatId?: string
      projectId?: string
      provider?: AgentProvider
      content: string
      attachments?: ChatAttachment[]
      model?: string
      modelOptions?: ModelOptions
      effort?: string
      planMode?: boolean
      autoPlan?: boolean
    }
  | { type: "chat.refreshDiffs"; chatId: string }
  | { type: "chat.initGit"; chatId: string }
  | { type: "chat.getGitHubPublishInfo"; chatId: string }
  | { type: "chat.checkGitHubRepoAvailability"; chatId: string; owner: string; name: string }
  | {
      type: "chat.publishToGitHub"
      chatId: string
      owner: string
      name: string
      visibility: "public" | "private"
      description?: string
    }
  | { type: "chat.listBranches"; chatId: string }
  | {
      type: "chat.previewMergeBranch"
      chatId: string
      branch: SelectedBranch
    }
  | {
      type: "chat.mergeBranch"
      chatId: string
      branch: SelectedBranch
    }
  | { type: "chat.syncBranch"; chatId: string; action: "fetch" | "pull" | "push" | "publish" }
  | {
      type: "chat.checkoutBranch"
      chatId: string
      branch: SelectedBranch
      bringChanges?: boolean
    }
  | { type: "chat.createBranch"; chatId: string; name: string; baseBranchName?: string }
  | { type: "chat.discardDiffFile"; chatId: string; path: string }
  | { type: "chat.ignoreDiffFile"; chatId: string; path: string }
  | { type: "chat.cancel"; chatId: string }
  | { type: "chat.stopDraining"; chatId: string }
  | {
      type: "chat.exportStandalone"
      chatId: string
      theme: "light" | "dark"
      attachmentMode: StandaloneTranscriptAttachmentMode
    }
  | { type: "chat.respondTool"; chatId: string; toolUseId: string; result: unknown }
  | {
      type: "message.enqueue"
      chatId: string
      content: string
      attachments?: ChatAttachment[]
      provider?: AgentProvider
      model?: string
      modelOptions?: ModelOptions
      planMode?: boolean
      autoPlan?: boolean
      /**
       * Interrupt the running turn and deliver this message now, instead of
       * leaving it queued — the same as "Send now" on a queued message, folded
       * into one command so the coordinator can absorb the turn ending in
       * between (in which case the message has already started).
       */
      steer?: boolean
    }
  | {
      type: "message.steer"
      chatId: string
      queuedMessageId: string
    }
  | {
      type: "message.dequeue"
      chatId: string
      queuedMessageId: string
    }
  /** projectId null → a home-directory terminal (dev-box full-screen Terminal page). */
  | { type: "terminal.create"; projectId: string | null; terminalId: string; cols: number; rows: number; scrollback: number }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  /** sinceVersion null → the client has no usable buffer; answer with a snapshot. */
  | { type: "terminal.tail"; terminalId: string; sinceVersion: number | null }

export type OpenExternalAction = Extract<ClientCommand, { type: "system.openExternal" }>["action"]

export type ClientEnvelope =
  | { v: 1; type: "subscribe"; id: string; topic: SubscriptionTopic }
  | { v: 1; type: "unsubscribe"; id: string }
  | { v: 1; type: "command"; id: string; command: ClientCommand }

export type ServerSnapshot =
  | { type: "sidebar"; data: SidebarData }
  | { type: "local-projects"; data: LocalProjectsSnapshot }
  | { type: "update"; data: UpdateSnapshot }
  | { type: "keybindings"; data: KeybindingsSnapshot }
  | { type: "app-settings"; data: AppSettingsSnapshot }
  | { type: "usage-limits"; data: UsageLimitsSnapshot }
  | { type: "provider-auth"; data: ProviderAuthSnapshot }
  | { type: "llm-provider"; data: LlmProviderSnapshot }
  | { type: "chat"; data: ChatSnapshot | null }
  | { type: "project-git"; data: ChatDiffSnapshot | null }
  | { type: "terminal"; data: TerminalSnapshot | null }

export type ServerEnvelope =
  | { v: 1; type: "snapshot"; id: string; snapshot: ServerSnapshot }
  | { v: 1; type: "event"; id: string; event: TerminalEvent }
  | { v: 1; type: "ack"; id: string; result?: unknown | StandaloneTranscriptExportResult }
  | { v: 1; type: "error"; id?: string; message: string }

export function isClientEnvelope(value: unknown): value is ClientEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ClientEnvelope>
  return candidate.v === 1 && typeof candidate.type === "string"
}

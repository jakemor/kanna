export const STORE_VERSION = 3 as const
export const PROTOCOL_VERSION = 1 as const

export type AgentProvider = "claude" | "codex"
export type LlmProviderKind = "openai" | "openrouter" | "custom"
export const DEFAULT_OPENAI_SDK_MODEL = "gpt-5.4-mini"
export const DEFAULT_OPENROUTER_SDK_MODEL = "moonshotai/kimi-k2.5:nitro"

export type AttachmentKind = "image" | "file" | "mention"

export interface ChatAttachment {
  id: string
  kind: AttachmentKind
  displayName: string
  absolutePath: string
  relativePath: string
  contentUrl: string
  mimeType: string
  size: number
}

export interface QueuedChatMessage {
  id: string
  content: string
  attachments: ChatAttachment[]
  createdAt: number
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
  autoContinue?: { scheduleId: string }
}

export interface InternalUserAttachmentsData {
  userText: string
  attachments: ChatAttachment[]
  llmHintText: string
}

export interface ProviderModelOption {
  id: string
  label: string
  supportsEffort: boolean
  contextWindowOptions?: readonly ProviderContextWindowOption[]
}

export interface ProviderEffortOption {
  id: string
  label: string
}

export interface ProviderContextWindowOption {
  id: ClaudeContextWindow
  label: string
}

export const CLAUDE_REASONING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const satisfies readonly ProviderEffortOption[]

export const CODEX_REASONING_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
] as const satisfies readonly ProviderEffortOption[]

export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_OPTIONS)[number]["id"]
export type CodexReasoningEffort = (typeof CODEX_REASONING_OPTIONS)[number]["id"]
export type ClaudeContextWindow = "200k" | "1m"
export type ServiceTier = "fast"

export interface ClaudeModelOptions {
  reasoningEffort: ClaudeReasoningEffort
  contextWindow: ClaudeContextWindow
}

export interface CodexModelOptions {
  reasoningEffort: CodexReasoningEffort
  fastMode: boolean
}

export interface ProviderModelOptionsByProvider {
  claude: ClaudeModelOptions
  codex: CodexModelOptions
}

export type ModelOptions = Partial<{
  [K in AgentProvider]: Partial<ProviderModelOptionsByProvider[K]>
}>

export const DEFAULT_CLAUDE_MODEL_OPTIONS = {
  reasoningEffort: "high",
  contextWindow: "200k",
} as const satisfies ClaudeModelOptions

export const DEFAULT_CODEX_MODEL_OPTIONS = {
  reasoningEffort: "high",
  fastMode: false,
} as const satisfies CodexModelOptions

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return CLAUDE_REASONING_OPTIONS.some((option) => option.id === value)
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return CODEX_REASONING_OPTIONS.some((option) => option.id === value)
}

export const CLAUDE_CONTEXT_WINDOW_OPTIONS = [
  { id: "200k", label: "200k" },
  { id: "1m", label: "1M" },
] as const satisfies readonly ProviderContextWindowOption[]

export function isClaudeContextWindow(value: unknown): value is ClaudeContextWindow {
  return CLAUDE_CONTEXT_WINDOW_OPTIONS.some((option) => option.id === value)
}

export function normalizeClaudeModelId(modelId?: string): string {
  switch (modelId) {
    case "opus":
    case "claude-opus-4-7":
      return "claude-opus-4-7"
    case "sonnet":
    case "claude-sonnet-4-6":
      return "claude-sonnet-4-6"
    case "haiku":
    case "claude-haiku-4-5-20251001":
      return "claude-haiku-4-5-20251001"
    default:
      return modelId ?? "claude-opus-4-7"
  }
}

export function isClaudeOpusModelId(modelId: string): boolean {
  return normalizeClaudeModelId(modelId).startsWith("claude-opus-")
}

export interface ProviderCatalogEntry {
  id: AgentProvider
  label: string
  defaultModel: string
  defaultEffort?: string
  supportsPlanMode: boolean
  models: ProviderModelOption[]
  efforts: ProviderEffortOption[]
}

export const PROVIDERS: ProviderCatalogEntry[] = [
  {
    id: "claude",
    label: "Claude",
    defaultModel: "claude-sonnet-4-6",
    defaultEffort: "high",
    supportsPlanMode: true,
    models: [
      { id: "claude-opus-4-7", label: "Opus 4.7", supportsEffort: true, contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS] },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS] },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", supportsEffort: true },
    ],
    efforts: [...CLAUDE_REASONING_OPTIONS],
  },
  {
    id: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4",
    supportsPlanMode: true,
    models: [
      { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportsEffort: false },
    ],
    efforts: [],
  },
]

export function getProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

export function getClaudeModelOption(modelId: string): ProviderModelOption | undefined {
  return getProviderCatalog("claude").models.find((candidate) => candidate.id === modelId)
}

export function getClaudeContextWindowOptions(modelId: string): readonly ProviderContextWindowOption[] {
  return getClaudeModelOption(modelId)?.contextWindowOptions ?? []
}

export function normalizeClaudeContextWindow(modelId: string, contextWindow?: unknown): ClaudeContextWindow {
  const options = getClaudeContextWindowOptions(modelId)
  if (options.length === 0) return DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow
  return options.some((option) => option.id === contextWindow)
    ? contextWindow as ClaudeContextWindow
    : DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow
}

export function resolveClaudeApiModelId(modelId: string, contextWindow?: ClaudeContextWindow): string {
  return contextWindow === "1m" ? `${modelId}[1m]` : modelId
}

export function resolveClaudeContextWindowTokens(contextWindow: ClaudeContextWindow): number {
  switch (contextWindow) {
    case "1m":
      return 1_000_000
    case "200k":
    default:
      return 200_000
  }
}

export type KannaStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_user"
  | "failed"

export interface ProjectSummary {
  id: string
  localPath: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface SidebarChatRow {
  _id: string
  _creationTime: number
  chatId: string
  title: string
  status: KannaStatus
  unread: boolean
  localPath: string
  provider: AgentProvider | null
  lastMessageAt?: number
  hasAutomation: boolean
}

export interface SidebarProjectGroup {
  groupKey: string
  localPath: string
  chats: SidebarChatRow[]
  previewChats: SidebarChatRow[]
  olderChats: SidebarChatRow[]
  defaultCollapsed: boolean
}

export interface SidebarData {
  projectGroups: SidebarProjectGroup[]
}

export interface LocalProjectSummary {
  localPath: string
  title: string
  source: "saved" | "discovered"
  lastOpenedAt?: number
  chatCount: number
}

export interface LocalProjectsSnapshot {
  machine: {
    id: "local"
    displayName: string
  }
  projects: LocalProjectSummary[]
}

export interface LlmProviderFile {
  provider?: LlmProviderKind
  apiKey?: string
  model?: string
  baseUrl?: string | null
}

export interface LlmProviderSnapshot {
  provider: LlmProviderKind
  apiKey: string
  model: string
  baseUrl: string
  resolvedBaseUrl: string
  enabled: boolean
  warning: string | null
  filePathDisplay: string
}

export interface LlmProviderValidationResult {
  ok: boolean
  error: unknown | null
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "updating"
  | "restart_pending"
  | "error"

export interface UpdateSnapshot {
  currentVersion: string
  latestVersion: string | null
  status: UpdateStatus
  updateAvailable: boolean
  lastCheckedAt: number | null
  error: string | null
  installAction: "restart" | "reload"
  reloadRequestedAt: number | null
}

export type UpdateInstallErrorCode =
  | "version_not_live_yet"
  | "install_failed"
  | "command_missing"

export interface UpdateInstallResult {
  ok: boolean
  action: "restart" | "reload"
  errorCode: UpdateInstallErrorCode | null
  userTitle: string | null
  userMessage: string | null
}

export type KeybindingAction =
  | "toggleEmbeddedTerminal"
  | "toggleRightSidebar"
  | "openInFinder"
  | "openInEditor"
  | "addSplitTerminal"
  | "jumpToSidebarChat"
  | "createChatInCurrentProject"
  | "openAddProject"

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string[]> = {
  toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
  toggleRightSidebar: ["cmd+b", "ctrl+b"],
  openInFinder: ["cmd+alt+f", "ctrl+alt+f"],
  openInEditor: ["cmd+shift+o", "ctrl+shift+o"],
  addSplitTerminal: ["cmd+/", "ctrl+/"],
  jumpToSidebarChat: ["cmd+alt"],
  createChatInCurrentProject: ["cmd+alt+n"],
  openAddProject: ["cmd+alt+o"],
}

export interface KeybindingsSnapshot {
  bindings: Record<KeybindingAction, string[]>
  warning: string | null
  filePathDisplay: string
}

export interface McpServerInfo {
  name: string
  status: string
  error?: string
}

export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
}

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id?: string
  question: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export type AskUserQuestionAnswerMap = Record<string, string[]>

export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm: string
}

interface TranscriptEntryBase {
  _id: string
  messageId?: string
  createdAt: number
  hidden?: boolean
  debugRaw?: string
}

interface ToolCallBase<TKind extends string, TInput> {
  kind: "tool"
  toolKind: TKind
  toolName: string
  toolId: string
  input: TInput
  rawInput?: Record<string, unknown>
}

export interface AskUserQuestionToolCall
  extends ToolCallBase<"ask_user_question", { questions: AskUserQuestionItem[] }> { }

export interface ExitPlanModeToolCall
  extends ToolCallBase<"exit_plan_mode", { plan?: string; summary?: string }> { }

export interface TodoWriteToolCall
  extends ToolCallBase<"todo_write", { todos: TodoItem[] }> { }

export interface SkillToolCall
  extends ToolCallBase<"skill", { skill: string }> { }

export interface GlobToolCall
  extends ToolCallBase<"glob", { pattern: string }> { }

export interface GrepToolCall
  extends ToolCallBase<"grep", { pattern: string; outputMode?: string }> { }

export interface BashToolCall
  extends ToolCallBase<"bash", { command: string; description?: string; timeoutMs?: number; runInBackground?: boolean }> { }

export interface WebSearchToolCall
  extends ToolCallBase<"web_search", { query: string }> { }

export interface ReadFileToolCall
  extends ToolCallBase<"read_file", { filePath: string }> { }

export interface WriteFileToolCall
  extends ToolCallBase<"write_file", { filePath: string; content: string }> { }

export interface EditFileToolCall
  extends ToolCallBase<"edit_file", { filePath: string; oldString: string; newString: string }> { }

export interface DeleteFileToolCall
  extends ToolCallBase<"delete_file", { filePath: string; content: string }> { }

export interface SubagentTaskToolCall
  extends ToolCallBase<"subagent_task", { subagentType?: string }> { }

export interface McpGenericToolCall
  extends ToolCallBase<"mcp_generic", { server: string; tool: string; payload: Record<string, unknown> }> { }

export interface UnknownToolCall
  extends ToolCallBase<"unknown_tool", { payload: Record<string, unknown> }> { }

export type NormalizedToolCall =
  | AskUserQuestionToolCall
  | ExitPlanModeToolCall
  | TodoWriteToolCall
  | SkillToolCall
  | GlobToolCall
  | GrepToolCall
  | BashToolCall
  | WebSearchToolCall
  | ReadFileToolCall
  | WriteFileToolCall
  | EditFileToolCall
  | DeleteFileToolCall
  | SubagentTaskToolCall
  | McpGenericToolCall
  | UnknownToolCall

export interface ToolResultEntry extends TranscriptEntryBase {
  kind: "tool_result"
  toolId: string
  content: unknown
  isError?: boolean
}

export interface UserPromptEntry extends TranscriptEntryBase {
  kind: "user_prompt"
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  autoContinue?: { scheduleId: string }
}

export interface SystemInitEntry extends TranscriptEntryBase {
  kind: "system_init"
  provider: AgentProvider
  model: string
  tools: string[]
  agents: string[]
  slashCommands: string[]
  mcpServers: McpServerInfo[]
}

export interface AccountInfoEntry extends TranscriptEntryBase {
  kind: "account_info"
  accountInfo: AccountInfo
}

export interface AssistantTextEntry extends TranscriptEntryBase {
  kind: "assistant_text"
  text: string
}

export interface ToolCallEntry extends TranscriptEntryBase {
  kind: "tool_call"
  tool: NormalizedToolCall
}

export interface ResultEntry extends TranscriptEntryBase {
  kind: "result"
  subtype: "success" | "error" | "cancelled"
  isError: boolean
  durationMs: number
  result: string
  costUsd?: number
}

export interface StatusEntry extends TranscriptEntryBase {
  kind: "status"
  status: string
}

export interface ContextWindowUsageSnapshot {
  usedTokens: number
  totalProcessedTokens?: number
  maxTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  lastUsedTokens?: number
  lastInputTokens?: number
  lastCachedInputTokens?: number
  lastOutputTokens?: number
  lastReasoningOutputTokens?: number
  toolUses?: number
  durationMs?: number
  compactsAutomatically: boolean
}

export interface ChatDiffFile {
  path: string
  changeType: "added" | "deleted" | "modified" | "renamed"
  isUntracked: boolean
  additions: number
  deletions: number
  patchDigest: string
  mimeType?: string
  size?: number
}

export interface ChatBranchHistoryEntry {
  sha: string
  summary: string
  description: string
  authorName?: string
  authoredAt: string
  tags: string[]
  githubUrl?: string
}

export interface ChatBranchHistorySnapshot {
  entries: ChatBranchHistoryEntry[]
}

export type ChatBranchListEntryKind = "local" | "remote" | "pull_request"

export interface ChatBranchListEntry {
  id: string
  kind: ChatBranchListEntryKind
  name: string
  displayName: string
  updatedAt?: string
  description?: string
  remoteRef?: string
  prNumber?: number
  prTitle?: string
  headRefName?: string
  headLabel?: string
  headRepoCloneUrl?: string
  isCrossRepository?: boolean
}

export interface ChatBranchListResult {
  currentBranchName?: string
  defaultBranchName?: string
  recent: ChatBranchListEntry[]
  local: ChatBranchListEntry[]
  remote: ChatBranchListEntry[]
  pullRequests: ChatBranchListEntry[]
  pullRequestsStatus: "available" | "unavailable" | "error"
  pullRequestsError?: string
}

export interface GitHubPublishInfo {
  ghInstalled: boolean
  authenticated: boolean
  activeAccountLogin?: string
  owners: string[]
  suggestedRepoName: string
}

export interface GitHubRepoAvailabilityResult {
  available: boolean
  message: string
}

export interface BranchMetadata {
  branchName?: string
  defaultBranchName?: string
  hasOriginRemote?: boolean
  originRepoSlug?: string
  hasUpstream?: boolean
}

export interface UpstreamStatus {
  aheadCount?: number
  behindCount?: number
  lastFetchedAt?: string
}

export interface ChatDiffSnapshot extends BranchMetadata, UpstreamStatus {
  status: "unknown" | "ready" | "no_repo"
  files: ChatDiffFile[]
  branchHistory?: ChatBranchHistorySnapshot
}

export interface BranchActionSuccess {
  ok: true
  branchName?: string
  snapshotChanged: boolean
}

export interface BranchActionFailure {
  ok: false
  title: string
  message: string
  detail?: string
  cancelled?: boolean
  snapshotChanged?: boolean
}

export type ChatSyncSuccess = BranchActionSuccess & {
  action: "fetch" | "pull" | "push" | "publish"
  aheadCount?: number
  behindCount?: number
}

export type ChatSyncFailure = BranchActionFailure & {
  action: "fetch" | "pull" | "push" | "publish"
}

export type ChatSyncResult = ChatSyncSuccess | ChatSyncFailure

export type DiffCommitMode = "commit_and_push" | "commit_only"

export type ChatCheckoutBranchSuccess = BranchActionSuccess
export type ChatCheckoutBranchFailure = BranchActionFailure
export type ChatCheckoutBranchResult = ChatCheckoutBranchSuccess | ChatCheckoutBranchFailure

export type ChatCreateBranchSuccess = BranchActionSuccess & { branchName: string }
export type ChatCreateBranchFailure = BranchActionFailure
export type ChatCreateBranchResult = ChatCreateBranchSuccess | ChatCreateBranchFailure

export type ChatMergePreviewStatus = "up_to_date" | "mergeable" | "conflicts" | "error"

export interface ChatMergePreviewResult {
  currentBranchName?: string
  targetBranchName: string
  targetDisplayName: string
  status: ChatMergePreviewStatus
  commitCount: number
  hasConflicts: boolean
  message: string
  detail?: string
}

export type ChatMergeBranchSuccess = BranchActionSuccess
export type ChatMergeBranchFailure = BranchActionFailure
export type ChatMergeBranchResult = ChatMergeBranchSuccess | ChatMergeBranchFailure

export type DiffCommitSuccess = BranchActionSuccess & {
  mode: DiffCommitMode
  pushed: boolean
}

export type DiffCommitFailure = BranchActionFailure & {
  mode: DiffCommitMode
  phase: "commit" | "push"
  localCommitCreated?: boolean
}

export type DiffCommitResult = DiffCommitSuccess | DiffCommitFailure

export interface ContextWindowUpdatedEntry extends TranscriptEntryBase {
  kind: "context_window_updated"
  usage: ContextWindowUsageSnapshot
}

export interface CompactBoundaryEntry extends TranscriptEntryBase {
  kind: "compact_boundary"
}

export interface CompactSummaryEntry extends TranscriptEntryBase {
  kind: "compact_summary"
  summary: string
}

export interface ContextClearedEntry extends TranscriptEntryBase {
  kind: "context_cleared"
}

export interface InterruptedEntry extends TranscriptEntryBase {
  kind: "interrupted"
}

export type TranscriptEntry =
  | UserPromptEntry
  | SystemInitEntry
  | AccountInfoEntry
  | AssistantTextEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry
  | StatusEntry
  | ContextWindowUpdatedEntry
  | CompactBoundaryEntry
  | CompactSummaryEntry
  | ContextClearedEntry
  | InterruptedEntry
  | AutoContinuePromptEntry

export interface HydratedToolCallBase<TKind extends string, TInput, TResult> {
  id: string
  messageId?: string
  hidden?: boolean
  kind: "tool"
  toolKind: TKind
  toolName: string
  toolId: string
  input: TInput
  result?: TResult
  rawResult?: unknown
  isError?: boolean
  timestamp: string
}

export interface AskUserQuestionToolResult {
  answers: AskUserQuestionAnswerMap
  discarded?: boolean
}

export interface ExitPlanModeToolResult {
  confirmed?: boolean
  clearContext?: boolean
  message?: string
  discarded?: boolean
}

export type HydratedAskUserQuestionToolCall =
  HydratedToolCallBase<"ask_user_question", AskUserQuestionToolCall["input"], AskUserQuestionToolResult>

export type HydratedExitPlanModeToolCall =
  HydratedToolCallBase<"exit_plan_mode", ExitPlanModeToolCall["input"], ExitPlanModeToolResult>

export type HydratedTodoWriteToolCall =
  HydratedToolCallBase<"todo_write", TodoWriteToolCall["input"], unknown>

export type HydratedSkillToolCall =
  HydratedToolCallBase<"skill", SkillToolCall["input"], unknown>

export type HydratedGlobToolCall =
  HydratedToolCallBase<"glob", GlobToolCall["input"], unknown>

export type HydratedGrepToolCall =
  HydratedToolCallBase<"grep", GrepToolCall["input"], unknown>

export type HydratedBashToolCall =
  HydratedToolCallBase<"bash", BashToolCall["input"], unknown>

export type HydratedWebSearchToolCall =
  HydratedToolCallBase<"web_search", WebSearchToolCall["input"], unknown>

export interface ReadFileTextBlock {
  type: "text"
  text: string
}

export interface ReadFileImageBlock {
  type: "image"
  data: string
  mimeType?: string
}

export interface ReadFileToolResult {
  content: string
  blocks?: Array<ReadFileTextBlock | ReadFileImageBlock>
}

export type HydratedReadFileToolCall =
  HydratedToolCallBase<"read_file", ReadFileToolCall["input"], ReadFileToolResult | string>

export type HydratedWriteFileToolCall =
  HydratedToolCallBase<"write_file", WriteFileToolCall["input"], unknown>

export type HydratedEditFileToolCall =
  HydratedToolCallBase<"edit_file", EditFileToolCall["input"], unknown>

export type HydratedDeleteFileToolCall =
  HydratedToolCallBase<"delete_file", DeleteFileToolCall["input"], unknown>

export type HydratedSubagentTaskToolCall =
  HydratedToolCallBase<"subagent_task", SubagentTaskToolCall["input"], unknown>

export type HydratedMcpGenericToolCall =
  HydratedToolCallBase<"mcp_generic", McpGenericToolCall["input"], unknown>

export type HydratedUnknownToolCall =
  HydratedToolCallBase<"unknown_tool", UnknownToolCall["input"], unknown>

export type HydratedToolCall =
  | HydratedAskUserQuestionToolCall
  | HydratedExitPlanModeToolCall
  | HydratedTodoWriteToolCall
  | HydratedSkillToolCall
  | HydratedGlobToolCall
  | HydratedGrepToolCall
  | HydratedBashToolCall
  | HydratedWebSearchToolCall
  | HydratedReadFileToolCall
  | HydratedWriteFileToolCall
  | HydratedEditFileToolCall
  | HydratedDeleteFileToolCall
  | HydratedSubagentTaskToolCall
  | HydratedMcpGenericToolCall
  | HydratedUnknownToolCall

export type HydratedTranscriptMessage =
  | ({ kind: "user_prompt"; content: string; attachments?: ChatAttachment[]; steered?: boolean; autoContinue?: { scheduleId: string }; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "system_init"; model: string; tools: string[]; agents: string[]; slashCommands: string[]; mcpServers: McpServerInfo[]; provider: AgentProvider; id: string; messageId?: string; timestamp: string; hidden?: boolean; debugRaw?: string })
  | ({ kind: "account_info"; accountInfo: AccountInfo; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "assistant_text"; text: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "result"; success: boolean; cancelled?: boolean; result: string; durationMs: number; costUsd?: number; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "status"; status: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_window_updated"; usage: ContextWindowUsageSnapshot; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_boundary"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_summary"; summary: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_cleared"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "interrupted"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "unknown"; json: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "auto_continue_prompt"; scheduleId: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ id: string; messageId?: string; hidden?: boolean } & HydratedToolCall)

export interface ChatRuntime {
  chatId: string
  projectId: string
  localPath: string
  title: string
  status: KannaStatus
  isDraining: boolean
  provider: AgentProvider | null
  planMode: boolean
  sessionToken: string | null
}

export interface ChatHistorySnapshot {
  hasOlder: boolean
  olderCursor: string | null
  recentLimit: number
}

export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
}

export interface ChatSnapshot {
  runtime: ChatRuntime
  queuedMessages: QueuedChatMessage[]
  messages: TranscriptEntry[]
  history: ChatHistorySnapshot
  availableProviders: ProviderCatalogEntry[]
  slashCommands: SlashCommand[]
  slashCommandsLoading: boolean
  schedules: Record<string, AutoContinueSchedule>
  liveScheduleId: string | null
}

export interface ChatHistoryPage {
  messages: TranscriptEntry[]
  hasOlder: boolean
  olderCursor: string | null
}

export interface KannaSnapshot {
  sidebar: SidebarData
  chat?: ChatSnapshot | null
}

export interface PendingToolSnapshot {
  toolUseId: string
  toolKind: "ask_user_question" | "exit_plan_mode"
}

export type AutoContinueScheduleState = "proposed" | "scheduled" | "fired" | "cancelled"

export interface AutoContinueSchedule {
  scheduleId: string
  state: AutoContinueScheduleState
  scheduledAt: number | null
  tz: string
  resetAt: number
  detectedAt: number
}

export interface AutoContinuePromptEntry extends TranscriptEntryBase {
  kind: "auto_continue_prompt"
  scheduleId: string
}

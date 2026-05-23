import type { ChatPermissionPolicyOverride, ToolRequestDecision, ToolRequestStatus } from "./permission-policy"

export const STORE_VERSION = 3 as const
export const PROTOCOL_VERSION = 1 as const

export type AgentProvider = "claude" | "codex"
export type LlmProviderKind = "openai" | "openrouter" | "custom"
export type AppThemePreference = "light" | "dark" | "system"
export type ChatSoundPreference = "never" | "unfocused" | "always"
export type ChatSoundId = "blow" | "bottle" | "frog" | "funk" | "glass" | "ping" | "pop" | "purr" | "tink"
export type DefaultProviderPreference = "last_used" | AgentProvider
export type EditorPreset = "cursor" | "vscode" | "xcode" | "windsurf" | "custom"
export const DEFAULT_OPENAI_SDK_MODEL = "gpt-5.4-mini"
export const DEFAULT_OPENROUTER_SDK_MODEL = "moonshotai/kimi-k2.5:nitro"

export type AttachmentKind = "image" | "file" | "mention"
export type StandaloneTranscriptAttachmentMode = "metadata" | "bundle"
export type StandaloneTranscriptTheme = "light" | "dark"

export interface SkillSearchResult {
  id: string
  skillId: string
  name: string
  installs: number
  source: string
}

export interface SkillSearchSnapshot {
  query: string
  searchType: string
  skills: SkillSearchResult[]
  count: number
  duration_ms: number
}

export interface SkillInstallResult {
  source: string
  skillId: string
  command: string[]
  cwd: string
  stdout: string
  stderr: string
}

export interface SkillUninstallResult {
  skillId: string
  command: string[]
  cwd: string
  stdout: string
  stderr: string
}

export interface InstalledSkillSummary {
  name: string
  source: string
  sourceType: string
  sourceUrl: string
  skillPath?: string
  installedAt: string
  updatedAt: string
  pluginName?: string
}

export interface InstalledSkillsSnapshot {
  lockFilePath: string
  skills: InstalledSkillSummary[]
}

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

export interface StandaloneTranscriptBundle {
  version: 1
  chatId: string
  title: string
  localPath: string
  exportedAt: string
  viewerVersion: string
  theme: StandaloneTranscriptTheme
  attachmentMode: StandaloneTranscriptAttachmentMode
  messages: TranscriptEntry[]
}

export interface StandaloneTranscriptExportResult {
  ok: true
  outputDir: string
  indexHtmlPath: string
  transcriptJsonPath: string
  attachmentMode: StandaloneTranscriptAttachmentMode
  totalAttachmentCount: number
  bundledAttachmentCount: number
  shareSlug: string
  shareUrl: string
  uploadedFileCount: number
}

export interface StandaloneTranscriptExportFailureResult {
  ok: false
  error: string
  outputDir: string
  transcriptJsonPath: string
  transcriptFileName: string
  transcriptJson: string
  shareSlug: string
  shareUrl: string
}

export type StandaloneTranscriptExportCommandResult =
  | StandaloneTranscriptExportResult
  | StandaloneTranscriptExportFailureResult

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
  aliases?: readonly string[]
  contextWindowOptions?: readonly ProviderContextWindowOption[]
  supportsMaxReasoningEffort?: boolean
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

export interface ProviderPreference<TModelOptions> {
  model: string
  modelOptions: TModelOptions
  planMode: boolean
}

export type ChatProviderPreferences = {
  claude: ProviderPreference<ClaudeModelOptions>
  codex: ProviderPreference<CodexModelOptions>
}

export type SubagentContextScope = "previous-assistant-reply" | "full-transcript"

export interface Subagent {
  id: string
  name: string
  description?: string
  provider: AgentProvider
  model: string
  modelOptions: ClaudeModelOptions | CodexModelOptions
  systemPrompt: string
  contextScope: SubagentContextScope
  createdAt: number
  updatedAt: number
}

export interface SubagentInput {
  name: string
  description?: string
  provider: AgentProvider
  model: string
  modelOptions: ClaudeModelOptions | CodexModelOptions
  systemPrompt: string
  contextScope: SubagentContextScope
}

export interface SubagentPatch {
  name?: string
  description?: string | null
  provider?: AgentProvider
  model?: string
  modelOptions?: Partial<ClaudeModelOptions> | Partial<CodexModelOptions>
  systemPrompt?: string
  contextScope?: SubagentContextScope
}

export type SubagentValidationErrorCode =
  | "EMPTY_NAME"
  | "INVALID_CHAR"
  | "RESERVED_NAME"
  | "DUPLICATE_NAME"
  | "TOO_LONG"
  | "NOT_FOUND"

export interface SubagentValidationError {
  code: SubagentValidationErrorCode
  message: string
}

export type McpServerTransport = "stdio" | "http" | "sse" | "ws"

export type McpServerTestResult =
  | { status: "untested" }
  | { status: "pending"; startedAt: string }
  | { status: "ok"; testedAt: string; toolCount: number }
  | { status: "error"; testedAt: string; message: string }

interface McpServerBase {
  id: string
  name: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastTest: McpServerTestResult
}

export interface McpServerStdioFields {
  transport: "stdio"
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export interface McpServerNetworkFields {
  transport: "http" | "sse" | "ws"
  url: string
  headers: Record<string, string>
}

export type McpServerConfig =
  | (McpServerBase & McpServerStdioFields)
  | (McpServerBase & McpServerNetworkFields)

export type McpServerInput =
  | (McpServerStdioFields & { name: string; enabled?: boolean })
  | (McpServerNetworkFields & { name: string; enabled?: boolean })

export type McpServerPatch = Partial<{
  name: string
  enabled: boolean
  transport: McpServerTransport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string | undefined
  url: string
  headers: Record<string, string>
}>

export interface McpValidationError {
  code:
    | "INVALID_NAME"
    | "DUPLICATE_NAME"
    | "RESERVED_NAME"
    | "INVALID_TRANSPORT"
    | "MISSING_COMMAND"
    | "INVALID_URL"
    | "INVALID_HEADER_KEY"
    | "INVALID_ENV_KEY"
    | "NOT_FOUND"
  field?: string
  message: string
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
      {
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        supportsEffort: true,
        aliases: ["opus"],
        contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS],
        supportsMaxReasoningEffort: true,
      },
      {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        supportsEffort: true,
        aliases: ["sonnet"],
        contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS],
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Haiku 4.5",
        supportsEffort: true,
        aliases: ["haiku"],
      },
    ],
    efforts: [...CLAUDE_REASONING_OPTIONS],
  },
  {
    id: "codex",
    label: "Codex",
    defaultModel: "gpt-5.5",
    supportsPlanMode: true,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: false },
      { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false, aliases: ["gpt-5-codex"] },
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

function getProviderModelMatch(provider: AgentProvider, modelId?: string): ProviderModelOption | undefined {
  if (!modelId) return undefined

  return getProviderCatalog(provider).models.find((candidate) =>
    candidate.id === modelId || candidate.aliases?.includes(modelId)
  )
}

export function normalizeProviderModelId(
  provider: AgentProvider,
  modelId?: string,
  fallbackModelId?: string
): string {
  return getProviderModelMatch(provider, modelId)?.id
    ?? fallbackModelId
    ?? getProviderCatalog(provider).defaultModel
}

export function normalizeClaudeModelId(modelId?: string, fallbackModelId = "claude-opus-4-7"): string {
  return normalizeProviderModelId("claude", modelId, fallbackModelId)
}

export function normalizeCodexModelId(modelId?: string, fallbackModelId = "gpt-5.5"): string {
  return normalizeProviderModelId("codex", modelId, fallbackModelId)
}

export function getProviderModelOption(provider: AgentProvider, modelId: string): ProviderModelOption | undefined {
  const normalizedModelId = normalizeProviderModelId(provider, modelId)
  return getProviderCatalog(provider).models.find((candidate) => candidate.id === normalizedModelId)
}

export function getClaudeModelOption(modelId: string): ProviderModelOption | undefined {
  return getProviderModelOption("claude", modelId)
}

export function supportsClaudeMaxReasoningEffort(modelId: string): boolean {
  return Boolean(getClaudeModelOption(modelId)?.supportsMaxReasoningEffort)
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

export type PushTransitionKind = "waiting_for_user" | "failed" | "completed"

export interface PushSubscriptionRecord {
  id: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  label: string
  userAgent: string
  createdAt: number
  lastSeenAt: number
}

export interface PushPayload {
  v: 1
  kind: PushTransitionKind
  projectLocalPath: string
  projectTitle: string
  chatId: string
  chatTitle: string
  chatUrl: string
  ts: number
}

export interface PushPreferences {
  globalEnabled: boolean
  mutedProjectPaths: string[]
}

export interface PushDeviceSummary {
  id: string
  label: string
  userAgent: string
  createdAt: number
  lastSeenAt: number
  isCurrentDevice: boolean
}

export interface PushConfigSnapshot {
  vapidPublicKey: string
  preferences: PushPreferences
  devices: PushDeviceSummary[]
}

export interface PushSubscribeRequestPayload {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface ProjectSummary {
  id: string
  localPath: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface Stack {
  id: string
  title: string
  projectIds: string[]   // insertion order; drives sidebar order within the stack
  createdAt: number
  updatedAt: number
}

export interface StackSummary {
  id: string
  title: string
  projectIds: string[]
  memberCount: number
  createdAt: number
  updatedAt: number
}

export interface StackBinding {
  projectId: string
  worktreePath: string                          // absolute, matches agent SDK cwd input
  role: "primary" | "additional"
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
  canFork?: boolean
  stateEnteredAt?: number
  stackId?: string
  /** Live Claude PTY session lifecycle state for the sidebar badge. Missing implies "cold". */
  sessionState?: ClaudeSessionLifecycleStatus
  /** True when the chat has a non-null policyOverride. Missing implies false. */
  hasPolicyOverride?: boolean
}

export interface SidebarProjectGroup {
  groupKey: string
  localPath: string
  chats: SidebarChatRow[]
  previewChats: SidebarChatRow[]
  olderChats: SidebarChatRow[]
  archivedChats?: SidebarChatRow[]
  defaultCollapsed: boolean
  starredAt?: number
}

export interface SidebarData {
  starredProjectGroups: SidebarProjectGroup[]
  projectGroups: SidebarProjectGroup[]
  stacks: StackSummary[]
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
    platform: NodeJS.Platform
  }
  projects: LocalProjectSummary[]
}

export interface AuthSettings {
  sessionMaxAgeDays: number
}

export const AUTH_DEFAULTS: AuthSettings = {
  sessionMaxAgeDays: 30,
}

export const AUTH_SESSION_MAX_AGE_DAYS_MIN = 1
export const AUTH_SESSION_MAX_AGE_DAYS_MAX = 365

export type OAuthTokenStatus = "active" | "limited" | "error" | "disabled"

export interface OAuthTokenEntry {
  id: string
  label: string
  token: string
  status: OAuthTokenStatus
  limitedUntil: number | null
  lastUsedAt: number | null
  lastErrorAt: number | null
  lastErrorMessage: string | null
  addedAt: number
  // Per-token concurrent-chat cap. When omitted, the pool falls back to
  // ClaudeAuthSettings.concurrencyDefault. Default 1 preserves the
  // historical 1-token-per-chat invariant. Range
  // [OAUTH_TOKEN_MAX_CONCURRENT_MIN, OAUTH_TOKEN_MAX_CONCURRENT_MAX].
  maxConcurrent?: number
}

export interface ClaudeAuthSettings {
  tokens: OAuthTokenEntry[]
  // Pool-wide default applied to tokens whose maxConcurrent is omitted.
  concurrencyDefault: number
}

export const OAUTH_TOKEN_MAX_CONCURRENT_MIN = 1
export const OAUTH_TOKEN_MAX_CONCURRENT_MAX = 5
export const OAUTH_TOKEN_CONCURRENCY_DEFAULT = 1

export const CLAUDE_AUTH_DEFAULTS: ClaudeAuthSettings = {
  tokens: [],
  concurrencyDefault: OAUTH_TOKEN_CONCURRENCY_DEFAULT,
}

export const OAUTH_TOKEN_LABEL_MAX = 64
export const OAUTH_TOKEN_VALUE_MAX = 1024

export interface UploadSettings {
  maxFileSizeMb: number
}

export const UPLOAD_DEFAULTS: UploadSettings = {
  maxFileSizeMb: 100,
}

export const UPLOAD_MAX_FILE_SIZE_MB_MIN = 1
export const UPLOAD_MAX_FILE_SIZE_MB_MAX = 2048

export const GLOBAL_PROMPT_APPEND_MAX_CHARS = 8_000

export type ClaudeDriverPreference = "sdk" | "pty"

export const CLAUDE_DRIVER_VALUES: readonly ClaudeDriverPreference[] = ["sdk", "pty"]

export function isClaudeDriverPreference(value: unknown): value is ClaudeDriverPreference {
  return value === "sdk" || value === "pty"
}

export interface ClaudePtyLifecycleSettings {
  idleTimeoutMs: number
  maxConcurrent: number
}

export const CLAUDE_PTY_LIFECYCLE_DEFAULTS: ClaudePtyLifecycleSettings = {
  idleTimeoutMs: 600_000,
  maxConcurrent: 4,
}

export const CLAUDE_PTY_IDLE_TIMEOUT_MS_MIN = 60_000
export const CLAUDE_PTY_IDLE_TIMEOUT_MS_MAX = 3_600_000
export const CLAUDE_PTY_MAX_CONCURRENT_MIN = 1
export const CLAUDE_PTY_MAX_CONCURRENT_MAX = 16

export interface ClaudeDriverSettings {
  preference: ClaudeDriverPreference
  lifecycle: ClaudePtyLifecycleSettings
}

export const CLAUDE_DRIVER_DEFAULTS: ClaudeDriverSettings = {
  preference: "sdk",
  lifecycle: { ...CLAUDE_PTY_LIFECYCLE_DEFAULTS },
}

export type ClaudeSessionLifecycleStatus = "cold" | "warming" | "active" | "idle" | "cooling"

export interface ChatSessionStateSnapshot {
  chatId: string
  state: ClaudeSessionLifecycleStatus
  updatedAt: number
}

export interface AppSettingsSnapshot {
  analyticsEnabled: boolean
  browserSettingsMigrated: boolean
  theme: AppThemePreference
  chatSoundPreference: ChatSoundPreference
  chatSoundId: ChatSoundId
  terminal: {
    scrollbackLines: number
    minColumnWidth: number
  }
  editor: {
    preset: EditorPreset
    commandTemplate: string
  }
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  warning: string | null
  filePathDisplay: string
  cloudflareTunnel: CloudflareTunnelSettings
  auth: AuthSettings
  claudeAuth: ClaudeAuthSettings
  uploads: UploadSettings
  subagents: Subagent[]
  customMcpServers: McpServerConfig[]
  claudeDriver: ClaudeDriverSettings
  globalPromptAppend: string
}

export interface AppSettingsPatch {
  analyticsEnabled?: boolean
  browserSettingsMigrated?: boolean
  theme?: AppThemePreference
  chatSoundPreference?: ChatSoundPreference
  chatSoundId?: ChatSoundId
  terminal?: Partial<AppSettingsSnapshot["terminal"]>
  editor?: Partial<AppSettingsSnapshot["editor"]>
  defaultProvider?: DefaultProviderPreference
  providerDefaults?: {
    claude?: Partial<ProviderPreference<ClaudeModelOptions>>
    codex?: Partial<ProviderPreference<CodexModelOptions>>
  }
  cloudflareTunnel?: Partial<CloudflareTunnelSettings>
  auth?: Partial<AuthSettings>
  claudeAuth?: Partial<ClaudeAuthSettings>
  uploads?: Partial<UploadSettings>
  subagents?: {
    create?: SubagentInput
    update?: { id: string; patch: SubagentPatch }
    delete?: { id: string }
  }
  customMcpServers?: {
    create?: McpServerInput
    update?: { id: string; patch: McpServerPatch }
    delete?: { id: string }
    setEnabled?: { id: string; enabled: boolean }
    setTestResult?: { id: string; result: McpServerTestResult }
  }
  claudeDriver?: {
    preference?: ClaudeDriverPreference
    lifecycle?: Partial<ClaudePtyLifecycleSettings>
  }
  globalPromptAppend?: string
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
  | "newStack"
  | "newStackChat"
  | "jumpToStacks"

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string[]> = {
  toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
  toggleRightSidebar: ["cmd+b", "ctrl+b"],
  openInFinder: ["cmd+alt+f", "ctrl+alt+f"],
  openInEditor: ["cmd+shift+o", "ctrl+shift+o"],
  addSplitTerminal: ["cmd+/", "ctrl+/"],
  jumpToSidebarChat: ["cmd+alt"],
  createChatInCurrentProject: ["cmd+alt+n"],
  openAddProject: ["cmd+alt+o"],
  newStack: ["cmd+alt+w"],
  newStackChat: ["cmd+alt+shift+n"],
  jumpToStacks: ["g s"],
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
  oauthKeyMasked?: string
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

export interface OfferDownloadToolCall
  extends ToolCallBase<"offer_download", { path: string; label?: string }> { }

export interface OfferDownloadToolResult {
  contentUrl: string
  relativePath: string
  fileName: string
  displayName: string
  size: number
  mimeType?: string
}

export type ImageGenerationStatus = "in_progress" | "completed" | "failed"

export interface ImageGenerationToolCall
  extends ToolCallBase<"image_generation", { revisedPrompt: string | null; status: ImageGenerationStatus }> { }

export interface ImageGenerationToolResult {
  contentUrl: string
  relativePath: string
  fileName: string
}

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
  | OfferDownloadToolCall
  | ImageGenerationToolCall
  | UnknownToolCall

export interface ToolResultEntry extends TranscriptEntryBase {
  kind: "tool_result"
  toolId: string
  content: unknown
  isError?: boolean
  /**
   * Set when the original content exceeded the subagent payload cap
   * (50 KB) and the full content was written to disk. `content` then
   * carries only a 2 KB preview wrapped in <persisted-output> tags.
   */
  persisted?: {
    filePath: string
    originalSize: number
    isJson: boolean
    truncated: true
  }
}

export interface UserPromptEntry extends TranscriptEntryBase {
  kind: "user_prompt"
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  autoContinue?: { scheduleId: string }
  subagentMentions?: Array<{ subagentId: string; raw: string }>
  unknownSubagentMentions?: Array<{ name: string; raw: string }>
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

export interface ApiErrorEntry extends TranscriptEntryBase {
  kind: "api_error"
  status: number
  text: string
  requestId?: string
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
  usage?: ProviderUsage
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
  | ApiErrorEntry
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
  | PendingToolRequestEntry
  | ToolRequestResolvedEntry

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
  /**
   * Set when the underlying tool_result entry was persisted to disk
   * via the subagent payload cap. Mirrored from
   * ToolResultEntry.persisted during hydration.
   */
  persisted?: {
    filePath: string
    originalSize: number
    isJson: boolean
    truncated: true
  }
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

export type HydratedOfferDownloadToolCall =
  HydratedToolCallBase<"offer_download", OfferDownloadToolCall["input"], OfferDownloadToolResult>

export type HydratedImageGenerationToolCall =
  HydratedToolCallBase<"image_generation", ImageGenerationToolCall["input"], ImageGenerationToolResult>

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
  | HydratedOfferDownloadToolCall
  | HydratedImageGenerationToolCall
  | HydratedUnknownToolCall

export type HydratedTranscriptMessage =
  | ({ kind: "user_prompt"; content: string; attachments?: ChatAttachment[]; steered?: boolean; autoContinue?: { scheduleId: string }; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "system_init"; model: string; tools: string[]; agents: string[]; slashCommands: string[]; mcpServers: McpServerInfo[]; provider: AgentProvider; id: string; messageId?: string; timestamp: string; hidden?: boolean; debugRaw?: string })
  | ({ kind: "account_info"; accountInfo: AccountInfo; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "assistant_text"; text: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "api_error"; status: number; text: string; requestId?: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "result"; success: boolean; cancelled?: boolean; result: string; durationMs: number; costUsd?: number; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "status"; status: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_window_updated"; usage: ContextWindowUsageSnapshot; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_boundary"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_summary"; summary: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_cleared"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "interrupted"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "unknown"; json: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "auto_continue_prompt"; scheduleId: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "pending_tool_request"; toolRequestId: string; toolName: string; arguments: Record<string, unknown>; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ id: string; messageId?: string; hidden?: boolean } & HydratedToolCall)

export interface ChatTimingCumulativeMs {
  idle: number
  starting: number
  running: number
  waiting_for_user: number
  failed: number
}

export interface ChatStateTimings {
  activeSessionStartedAt: number
  chatCreatedAt: number
  stateEnteredAt: number
  lastTurnDurationMs: number | null
  derivedAtMs: number
  cumulativeMs: ChatTimingCumulativeMs
}

export interface ChatRuntime {
  chatId: string
  projectId: string
  localPath: string
  title: string
  status: KannaStatus
  isDraining: boolean
  provider: AgentProvider | null
  planMode: boolean
  sessionTokensByProvider: Partial<Record<AgentProvider, string | null>>
  timings: ChatStateTimings
  /** Per-chat permission policy overlay. Null means "use global defaults". */
  policyOverride: ChatPermissionPolicyOverride | null
  /** Current claude PTY session lifecycle state for this chat. `cold` when no live session. */
  sessionState: ClaudeSessionLifecycleStatus
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

export interface ResolvedStackBinding {
  projectId: string
  projectTitle: string
  worktreePath: string
  role: "primary" | "additional"
  projectStatus: "active" | "missing"
}

export type SubagentErrorCode =
  | "AUTH_REQUIRED"
  | "UNKNOWN_SUBAGENT"
  | "LOOP_DETECTED"
  | "DEPTH_EXCEEDED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INTERRUPTED"
  | "USER_CANCELLED"

export type SubagentRunStatus = "running" | "completed" | "failed" | "cancelled"

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  costUsd?: number
}

export interface SubagentPendingTool {
  toolUseId: string
  toolKind: "ask_user_question" | "exit_plan_mode"
  input: unknown
  requestedAt: number
}

export interface SubagentRunSnapshot {
  runId: string
  chatId: string
  subagentId: string | null
  subagentName: string
  provider: AgentProvider
  model: string
  status: SubagentRunStatus
  parentUserMessageId: string
  parentRunId: string | null
  depth: number
  startedAt: number
  finishedAt: number | null
  finalText: string | null
  error: { code: SubagentErrorCode; message: string } | null
  usage: ProviderUsage | null
  /**
   * Every TranscriptEntry the subagent produced, in arrival order. Includes
   * tool_call, tool_result, system_init, account_info, result. assistant_text
   * entries also live here in addition to being concatenated into finalText
   * via subagent_message_delta — clients should prefer entries[] for rich
   * rendering, finalText only as a quick text-only summary.
   */
  entries: TranscriptEntry[]
  /**
   * Set while the subagent is awaiting a user response to an
   * interactive tool call (AskUserQuestion / ExitPlanMode). Null
   * otherwise. The orchestrator's wall-clock timeout is paused while
   * this is non-null.
   */
  pendingTool: SubagentPendingTool | null
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
  tunnels: Record<string, CloudflareTunnelRecord>
  liveTunnelId: string | null
  resolvedBindings?: ResolvedStackBinding[]
  subagentRuns: Record<string, SubagentRunSnapshot>
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

export interface PendingToolRequestEntry extends TranscriptEntryBase {
  kind: "pending_tool_request"
  toolRequestId: string
  toolName: string
  arguments: Record<string, unknown>
}

export interface ToolRequestResolvedEntry extends TranscriptEntryBase {
  kind: "tool_request_resolved"
  toolRequestId: string
  status: ToolRequestStatus
  decision?: ToolRequestDecision
}

export type CloudflareTunnelMode = "always-ask" | "auto-expose"

export interface CloudflareTunnelSettings {
  enabled: boolean
  cloudflaredPath: string
  mode: CloudflareTunnelMode
}

export const CLOUDFLARE_TUNNEL_DEFAULTS: CloudflareTunnelSettings = {
  enabled: false,
  cloudflaredPath: "cloudflared",
  mode: "always-ask",
}

export type CloudflareTunnelState = "proposed" | "active" | "stopped" | "failed"

export interface CloudflareTunnelRecord {
  tunnelId: string
  chatId: string
  port: number
  state: CloudflareTunnelState
  url: string | null
  error: string | null
  proposedAt: number
  activatedAt: number | null
  stoppedAt: number | null
}

export interface GitWorktree {
  path: string                 // absolute
  branch: string               // e.g. "main", "feat/x", "(detached)"
  sha: string                  // HEAD commit sha
  isPrimary: boolean
  isLocked: boolean            // git has flagged this worktree as locked (pruning inhibited)
}

export const STORE_VERSION = 3 as const
export const PROTOCOL_VERSION = 1 as const

export type AgentProvider = "claude" | "codex" | "gemini" | "cursor"

export interface ProviderModelOption {
  id: string
  label: string
  supportsEffort: boolean
}

export interface ProviderEffortOption {
  id: string
  label: string
}

export interface GeminiThinkingOption {
  id: "off" | "standard" | "high"
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
export type ServiceTier = "fast"

export const GEMINI_THINKING_OPTIONS = [
  { id: "off", label: "Off" },
  { id: "standard", label: "Standard" },
  { id: "high", label: "High" },
] as const satisfies readonly GeminiThinkingOption[]

export type GeminiThinkingMode = (typeof GEMINI_THINKING_OPTIONS)[number]["id"]

export interface ClaudeModelOptions {
  reasoningEffort: ClaudeReasoningEffort
}

export interface CodexModelOptions {
  reasoningEffort: CodexReasoningEffort
  fastMode: boolean
}

export interface GeminiModelOptions {
  thinkingMode: GeminiThinkingMode
}

export interface CursorModelOptions {}

export type CursorModelSpeed = "fast" | "standard"

export const DEFAULT_CURSOR_MODEL = "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]" as const

export const CURSOR_MODELS = [
  { id: "composer-2[fast=true]", label: "Composer 2", supportsEffort: false },
  { id: "composer-1.5[]", label: "Composer 1.5", supportsEffort: false },
  { id: "gpt-5.3-codex[reasoning=medium,fast=false]", label: "Codex 5.3", supportsEffort: false },
  { id: "gpt-5.4[reasoning=medium,context=272k,fast=false]", label: "GPT-5.4", supportsEffort: false },
  { id: "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]", label: "Sonnet 4.6", supportsEffort: false },
  { id: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]", label: "Opus 4.6", supportsEffort: false },
  { id: "claude-opus-4-5[thinking=true]", label: "Opus 4.5", supportsEffort: false },
  { id: "gpt-5.2[reasoning=medium,fast=false]", label: "GPT-5.2", supportsEffort: false },
  { id: "gemini-3.1-pro[]", label: "Gemini 3.1 Pro", supportsEffort: false },
  { id: "gpt-5.4-mini[reasoning=medium]", label: "GPT-5.4 Mini", supportsEffort: false },
  { id: "gpt-5.4-nano[reasoning=medium]", label: "GPT-5.4 Nano", supportsEffort: false },
  { id: "claude-haiku-4-5[thinking=true]", label: "Haiku 4.5", supportsEffort: false },
  { id: "gpt-5.3-codex-spark[reasoning=medium]", label: "Codex 5.3 Spark", supportsEffort: false },
  { id: "grok-4-20[thinking=true]", label: "Grok 4.20", supportsEffort: false },
  { id: "claude-sonnet-4-5[thinking=true,context=200k]", label: "Sonnet 4.5", supportsEffort: false },
  { id: "gpt-5.2-codex[reasoning=medium,fast=false]", label: "Codex 5.2", supportsEffort: false },
  { id: "gemini-3-flash[]", label: "Gemini 3 Flash", supportsEffort: false },
  { id: "claude-sonnet-4[thinking=false,context=200k]", label: "Sonnet 4", supportsEffort: false },
  { id: "kimi-k2.5[]", label: "Kimi K2.5", supportsEffort: false },
] as const satisfies readonly ProviderModelOption[]

export const CURSOR_MODEL_ALIASES: Record<string, string> = {
  "composer-2-fast": "composer-2[fast=true]",
  "composer-1.5": "composer-1.5[]",
  "gpt-5.3-codex": "gpt-5.3-codex[reasoning=medium,fast=false]",
  "gpt-5.4": "gpt-5.4[reasoning=medium,context=272k,fast=false]",
  "gpt-5.4-medium": "gpt-5.4[reasoning=medium,context=272k,fast=false]",
  "claude-4.6-sonnet-medium-thinking": "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]",
  "claude-4.6-opus-high-thinking": "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
  "claude-4.5-opus-high-thinking": "claude-opus-4-5[thinking=true]",
  "gpt-5.2": "gpt-5.2[reasoning=medium,fast=false]",
  "gemini-3.1-pro": "gemini-3.1-pro[]",
  "gpt-5.4-mini": "gpt-5.4-mini[reasoning=medium]",
  "gpt-5.4-mini-medium": "gpt-5.4-mini[reasoning=medium]",
  "gpt-5.4-nano": "gpt-5.4-nano[reasoning=medium]",
  "gpt-5.4-nano-medium": "gpt-5.4-nano[reasoning=medium]",
  "claude-haiku-4.5": "claude-haiku-4-5[thinking=true]",
  "gpt-5.3-codex-spark-preview": "gpt-5.3-codex-spark[reasoning=medium]",
  "grok-4-20": "grok-4-20[thinking=true]",
  "grok-4-20-thinking": "grok-4-20[thinking=true]",
  "claude-4.5-sonnet-thinking": "claude-sonnet-4-5[thinking=true,context=200k]",
  "gpt-5.2-codex": "gpt-5.2-codex[reasoning=medium,fast=false]",
  "gemini-3-flash": "gemini-3-flash[]",
  "claude-4-sonnet": "claude-sonnet-4[thinking=false,context=200k]",
  "kimi-k2.5": "kimi-k2.5[]",
}

export function normalizeCursorModelId(model?: string): string {
  if (!model) return DEFAULT_CURSOR_MODEL
  if (CURSOR_MODELS.some((candidate) => candidate.id === model)) return model
  return CURSOR_MODEL_ALIASES[model] ?? DEFAULT_CURSOR_MODEL
}

export function getCursorModelBaseId(modelId: string): string {
  const bracketIndex = modelId.indexOf("[")
  return bracketIndex >= 0 ? modelId.slice(0, bracketIndex) : modelId
}

export function getCursorModelSpeed(modelId: string): CursorModelSpeed | null {
  const fastMatch = modelId.match(/\bfast=(true|false)\b/)
  if (!fastMatch) return null
  return fastMatch[1] === "true" ? "fast" : "standard"
}

export interface ProviderModelOptionsByProvider {
  claude: ClaudeModelOptions
  codex: CodexModelOptions
  gemini: GeminiModelOptions
  cursor: CursorModelOptions
}

export type ModelOptions = Partial<{
  [K in AgentProvider]: Partial<ProviderModelOptionsByProvider[K]>
}>

export const DEFAULT_CLAUDE_MODEL_OPTIONS = {
  reasoningEffort: "high",
} as const satisfies ClaudeModelOptions

export const DEFAULT_CODEX_MODEL_OPTIONS = {
  reasoningEffort: "high",
  fastMode: false,
} as const satisfies CodexModelOptions

export const DEFAULT_GEMINI_MODEL_OPTIONS = {
  thinkingMode: "standard",
} as const satisfies GeminiModelOptions

export const DEFAULT_CURSOR_MODEL_OPTIONS = {
} as const satisfies CursorModelOptions

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return CLAUDE_REASONING_OPTIONS.some((option) => option.id === value)
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return CODEX_REASONING_OPTIONS.some((option) => option.id === value)
}

export function isGeminiThinkingMode(value: unknown): value is GeminiThinkingMode {
  return GEMINI_THINKING_OPTIONS.some((option) => option.id === value)
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
    defaultModel: "sonnet",
    defaultEffort: "high",
    supportsPlanMode: true,
    models: [
      { id: "opus", label: "Opus", supportsEffort: true },
      { id: "sonnet", label: "Sonnet", supportsEffort: true },
      { id: "haiku", label: "Haiku", supportsEffort: true },
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
  {
    id: "gemini",
    label: "Gemini",
    defaultModel: "auto-gemini-2.5",
    supportsPlanMode: true,
    models: [
      { id: "auto-gemini-3", label: "Auto (Gemini 3)", supportsEffort: false },
      { id: "auto-gemini-2.5", label: "Auto (Gemini 2.5)", supportsEffort: false },
      { id: "gemini-3.1-pro-preview", label: "3.1 Pro Preview", supportsEffort: false },
      { id: "gemini-3-pro-preview", label: "3 Pro Preview", supportsEffort: false },
      { id: "gemini-3-flash-preview", label: "3 Flash Preview", supportsEffort: false },
      { id: "gemini-2.5-pro", label: "2.5 Pro", supportsEffort: false },
      { id: "gemini-2.5-flash", label: "2.5 Flash", supportsEffort: false },
      { id: "gemini-2.5-flash-lite", label: "2.5 Flash Lite", supportsEffort: false },
    ],
    efforts: [],
  },
  {
    id: "cursor",
    label: "Cursor",
    defaultModel: DEFAULT_CURSOR_MODEL,
    supportsPlanMode: true,
    models: [...CURSOR_MODELS],
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

export type KannaStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_user"
  | "failed"

export const FEATURE_STAGES = ["idea", "todo", "progress", "testing", "done"] as const
export type FeatureStage = (typeof FEATURE_STAGES)[number]
export const FEATURE_BROWSER_STATES = ["OPEN", "CLOSED"] as const
export type FeatureBrowserState = (typeof FEATURE_BROWSER_STATES)[number]

export const FEATURE_STAGE_LABELS: Record<FeatureStage, string> = {
  idea: "IDEA",
  todo: "TODO",
  progress: "PROGRESS",
  testing: "TESTING",
  done: "DONE",
}

export interface ProjectSummary {
  id: string
  repoKey: string
  localPath: string
  worktreePaths: string[]
  title: string
  browserState: FeatureBrowserState
  generalChatsBrowserState: FeatureBrowserState
  createdAt: number
  updatedAt: number
}

export interface FeatureSummary {
  id: string
  projectId: string
  title: string
  description: string
  browserState: FeatureBrowserState
  stage: FeatureStage
  sortOrder: number
  directoryRelativePath: string
  overviewRelativePath: string
  createdAt: number
  updatedAt: number
}

export interface SidebarChatRow {
  _id: string
  _creationTime: number
  chatId: string
  title: string
  status: KannaStatus
  localPath: string
  provider: AgentProvider | null
  lastMessageAt?: number
  hasAutomation: boolean
  featureId?: string | null
}

export interface SidebarFeatureRow {
  featureId: string
  title: string
  description: string
  browserState: FeatureBrowserState
  stage: FeatureStage
  sortOrder: number
  directoryRelativePath: string
  overviewRelativePath: string
  updatedAt: number
  chats: SidebarChatRow[]
}

export interface SidebarProjectGroup {
  groupKey: string
  title: string
  localPath: string
  browserState: FeatureBrowserState
  generalChatsBrowserState: FeatureBrowserState
  features: SidebarFeatureRow[]
  generalChats: SidebarChatRow[]
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

export interface DirectoryBrowserEntry {
  name: string
  localPath: string
}

export interface DirectoryBrowserSnapshot {
  currentPath: string
  parentPath: string | null
  roots: DirectoryBrowserEntry[]
  entries: DirectoryBrowserEntry[]
}

export interface SuggestedProjectFolder {
  label: string
  localPath: string
}

export interface LocalProjectsSnapshot {
  machine: {
    id: "local"
    displayName: string
  }
  projects: LocalProjectSummary[]
  suggestedFolders: SuggestedProjectFolder[]
  rootDirectory: DirectoryBrowserSnapshot | null
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
  | "submitChatMessage"
  | "toggleProjectsSidebar"
  | "toggleEmbeddedTerminal"
  | "toggleRightSidebar"
  | "openInFinder"
  | "openInEditor"
  | "addSplitTerminal"

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string[]> = {
  submitChatMessage: ["enter"],
  toggleProjectsSidebar: ["ctrl+a"],
  toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
  toggleRightSidebar: ["cmd+b", "ctrl+b"],
  openInFinder: ["cmd+alt+f", "ctrl+alt+f"],
  openInEditor: ["cmd+shift+o", "ctrl+shift+o"],
  addSplitTerminal: ["cmd+/", "ctrl+/"],
}

export interface KeybindingsSnapshot {
  bindings: Record<KeybindingAction, string[]>
  warning: string | null
  filePathDisplay: string
}

export type ThemePreference = "light" | "dark" | "system" | "custom"
export type ColorTheme = "default" | "tokyo-night" | "catppuccin" | "dracula" | "nord" | "everforest" | "rose-pine"
export type CustomAppearance = "light" | "dark" | "system"

export interface ThemeSettingsSnapshot {
  settings: {
    themePreference: ThemePreference
    colorTheme: ColorTheme
    customAppearance: CustomAppearance
    backgroundImage: string | null
    backgroundOpacity: number
    backgroundBlur: number
  }
  warning: string | null
  filePathDisplay: string
}

export const DEFAULT_THEME_SETTINGS: ThemeSettingsSnapshot["settings"] = {
  themePreference: "system",
  colorTheme: "default",
  customAppearance: "system",
  backgroundImage: null,
  backgroundOpacity: 1,
  backgroundBlur: 0,
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

export const MAX_CHAT_ATTACHMENTS = 8
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
export const SUPPORTED_CHAT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const

export interface ChatImageAttachment {
  type: "image"
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  relativePath: string
}

export interface ChatImageAttachmentUpload {
  type: "image"
  name: string
  mimeType: string
  sizeBytes: number
  dataUrl: string
}

export type ChatAttachment = ChatImageAttachment
export type ChatAttachmentUpload = ChatImageAttachmentUpload

export interface ChatUserMessage {
  text: string
  attachments?: ChatAttachmentUpload[]
}

export interface HydratedChatImageAttachment extends ChatImageAttachment {
  previewUrl: string
}

export type HydratedChatAttachment = HydratedChatImageAttachment

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

export interface AssistantThoughtEntry extends TranscriptEntryBase {
  kind: "assistant_thought"
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
  | AssistantThoughtEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry
  | StatusEntry
  | CompactBoundaryEntry
  | CompactSummaryEntry
  | ContextClearedEntry
  | InterruptedEntry

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

export interface ReadFileToolResult {
  content: string
}

export type HydratedReadFileToolCall =
  HydratedToolCallBase<"read_file", ReadFileToolCall["input"], ReadFileToolResult | string>

export type HydratedWriteFileToolCall =
  HydratedToolCallBase<"write_file", WriteFileToolCall["input"], unknown>

export type HydratedEditFileToolCall =
  HydratedToolCallBase<"edit_file", EditFileToolCall["input"], unknown>

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
  | HydratedSubagentTaskToolCall
  | HydratedMcpGenericToolCall
  | HydratedUnknownToolCall

export type HydratedTranscriptMessage =
  | ({ kind: "user_prompt"; content: string; attachments?: HydratedChatAttachment[]; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "system_init"; model: string; tools: string[]; agents: string[]; slashCommands: string[]; mcpServers: McpServerInfo[]; provider: AgentProvider; id: string; messageId?: string; timestamp: string; hidden?: boolean; debugRaw?: string })
  | ({ kind: "account_info"; accountInfo: AccountInfo; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "assistant_text"; text: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "assistant_thought"; text: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "result"; success: boolean; cancelled?: boolean; result: string; durationMs: number; costUsd?: number; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "status"; status: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_boundary"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_summary"; summary: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_cleared"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "interrupted"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "unknown"; json: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ id: string; messageId?: string; hidden?: boolean } & HydratedToolCall)

export interface ChatRuntime {
  chatId: string
  projectId: string
  localPath: string
  title: string
  status: KannaStatus
  provider: AgentProvider | null
  model: string | null
  planMode: boolean
  sessionToken: string | null
  pendingTool?: ChatPendingToolSnapshot | null
}

export type ChatUsageWarning =
  | "context_warning"
  | "context_critical"
  | "rate_warning"
  | "rate_critical"
  | "stale"

export interface ChatUsageSnapshot {
  provider: AgentProvider
  threadTokens: number | null
  contextWindowTokens: number | null
  contextUsedPercent: number | null
  lastTurnTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens?: number | null
  sessionLimitUsedPercent: number | null
  rateLimitResetAt: number | null
  source: "live" | "reconstructed" | "unavailable"
  updatedAt: number | null
  warnings: ChatUsageWarning[]
}

export interface ChatSnapshot {
  runtime: ChatRuntime
  messages: TranscriptEntry[]
  usage?: ChatUsageSnapshot | null
  availableProviders: ProviderCatalogEntry[]
}

export interface KannaSnapshot {
  sidebar: SidebarData
  chat?: ChatSnapshot | null
}

export interface PendingToolSnapshot {
  toolUseId: string
  toolKind: "ask_user_question" | "exit_plan_mode"
}

export interface ChatPendingToolSnapshot extends PendingToolSnapshot {
  source?: "active" | "recovered"
}

export const STORE_VERSION = 2 as const
export const PROTOCOL_VERSION = 1 as const

export type AgentProvider = "claude" | "codex" | "cursor" | "pi"
export type LlmProviderKind = "openai" | "openrouter" | "custom"
export type AppThemePreference = "light" | "dark" | "system"
export type ChatSoundPreference = "never" | "unfocused" | "always"
export type ChatSoundId = "blow" | "bottle" | "frog" | "funk" | "glass" | "ping" | "pop" | "purr" | "tink"
export type DefaultProviderPreference = "last_used" | AgentProvider
export type EditorPreset = "cursor" | "vscode" | "xcode" | "windsurf" | "custom"
export const DEFAULT_OPENAI_SDK_MODEL = "gpt-5.4-mini"
export const DEFAULT_OPENROUTER_SDK_MODEL = "moonshotai/kimi-k2.5:nitro"

export type AttachmentKind = "image" | "file"
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
  supportedReasoningEfforts?: readonly CodexReasoningEffortOption[]
  defaultReasoningEffort?: CodexReasoningEffort
  supportsFastMode?: boolean
  contextWindowOptions?: readonly ProviderContextWindowOption[]
  supportsMaxReasoningEffort?: boolean
}

export interface ProviderEffortOption {
  id: string
  label: string
  description?: string
}

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

export interface CodexReasoningEffortOption extends ProviderEffortOption {
  id: CodexReasoningEffort
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
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  {
    id: "ultra",
    label: "Ultra",
    description: "Delegates to subagents more",
  },
] as const satisfies readonly CodexReasoningEffortOption[]

// Pi's standardized thinking levels (mapped by pi-ai to each provider's native
// reasoning parameter — for OpenRouter that's `reasoning: { effort }`).
export const PI_REASONING_OPTIONS = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
] as const satisfies readonly ProviderEffortOption[]

export type PiReasoningEffort = (typeof PI_REASONING_OPTIONS)[number]["id"]

export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_OPTIONS)[number]["id"]
export type ClaudeContextWindow = "200k" | "1m"
export type ServiceTier = "fast"

export interface ClaudeModelOptions {
  reasoningEffort: ClaudeReasoningEffort
  contextWindow: ClaudeContextWindow
  fastMode: boolean
}

export interface CodexModelOptions {
  reasoningEffort: CodexReasoningEffort
  fastMode: boolean
}

export interface CursorModelOptions {
  fastMode: boolean
}

export interface PiModelOptions {
  reasoningEffort: PiReasoningEffort
}

export interface ProviderModelOptionsByProvider {
  claude: ClaudeModelOptions
  codex: CodexModelOptions
  cursor: CursorModelOptions
  pi: PiModelOptions
}

export interface ProviderPreference<TModelOptions> {
  model: string
  modelOptions: TModelOptions
  planMode: boolean
}

export type ChatProviderPreferences = {
  claude: ProviderPreference<ClaudeModelOptions>
  codex: ProviderPreference<CodexModelOptions>
  cursor: ProviderPreference<CursorModelOptions>
  pi: ProviderPreference<PiModelOptions>
}

export type ModelOptions = Partial<{
  [K in AgentProvider]: Partial<ProviderModelOptionsByProvider[K]>
}>

export const DEFAULT_CLAUDE_MODEL_OPTIONS = {
  reasoningEffort: "high",
  contextWindow: "1m",
  fastMode: false,
} as const satisfies ClaudeModelOptions

export const DEFAULT_CODEX_MODEL_OPTIONS = {
  reasoningEffort: "medium",
  fastMode: false,
} as const satisfies CodexModelOptions

export const DEFAULT_CURSOR_MODEL_OPTIONS = {
  fastMode: false,
} as const satisfies CursorModelOptions

export const DEFAULT_PI_MODEL = "moonshotai/kimi-k2.6"

export const DEFAULT_PI_MODEL_OPTIONS = {
  reasoningEffort: "medium",
} as const satisfies PiModelOptions

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return CLAUDE_REASONING_OPTIONS.some((option) => option.id === value)
}

export function isPiReasoningEffort(value: unknown): value is PiReasoningEffort {
  return PI_REASONING_OPTIONS.some((option) => option.id === value)
}

export function normalizePiReasoningEffort(effort?: unknown): PiReasoningEffort {
  return isPiReasoningEffort(effort) ? effort : DEFAULT_PI_MODEL_OPTIONS.reasoningEffort
}

// Pi accepts any OpenRouter model id verbatim — unlike the other providers there
// is no catalog clamp, the catalog entries are just suggestions.
export function normalizePiModelId(modelId?: unknown, fallbackModelId = DEFAULT_PI_MODEL): string {
  const trimmed = typeof modelId === "string" ? modelId.trim() : ""
  return trimmed || fallbackModelId
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return value === "minimal" || CODEX_REASONING_OPTIONS.some((option) => option.id === value)
}

const LEGACY_CODEX_REASONING_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  ...CODEX_REASONING_OPTIONS.filter((option) => option.id !== "max" && option.id !== "ultra"),
] as const satisfies readonly ProviderEffortOption[]

const GPT_5_6_REASONING_OPTIONS = [...CODEX_REASONING_OPTIONS]
const GPT_5_6_LUNA_REASONING_OPTIONS = CODEX_REASONING_OPTIONS.filter((option) => option.id !== "ultra")

export const CLAUDE_CONTEXT_WINDOW_OPTIONS = [
  { id: "1m", label: "1M" },
  { id: "200k", label: "200k" },
] as const satisfies readonly ProviderContextWindowOption[]

export function isClaudeContextWindow(value: unknown): value is ClaudeContextWindow {
  return CLAUDE_CONTEXT_WINDOW_OPTIONS.some((option) => option.id === value)
}

function titleCaseWord(value: string) {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`
}

export function deriveClaudeModelLabel(modelId: string): string {
  const parts = modelId.replace(/^claude-/, "").split("-").filter(Boolean)
  if (parts.length === 0) return modelId
  return titleCaseWord(parts[0] ?? modelId)
}

// Well-known acronyms kept fully uppercase when deriving labels from model ids.
const MODEL_LABEL_ACRONYMS = new Set(["gpt", "glm"])

/**
 * Derive a display label from a bare model id when no catalog or fave record
 * names it: strip the vendor prefix and any `:variant` suffix, then title-case
 * the dash-separated words.
 *
 *   lab/kimi-k2.5:nitro → Kimi K2.5
 *   gpt-5.6-sol         → GPT 5.6 Sol
 *   openai/gpt-5.6      → GPT 5.6
 */
export function deriveModelLabel(modelId: string): string {
  const base = modelId.split("/").pop() ?? modelId
  const withoutVariant = base.split(":")[0] ?? base
  const words = withoutVariant.split("-").filter(Boolean)
  if (words.length === 0) return modelId
  return words
    .map((word) => (MODEL_LABEL_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : titleCaseWord(word)))
    .join(" ")
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
        id: "fable",
        label: deriveClaudeModelLabel("fable"),
        supportsEffort: true,
      },
      {
        id: "claude-opus-4-8",
        label: deriveClaudeModelLabel("claude-opus-4-8"),
        supportsEffort: true,
        aliases: ["opus"],
        contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS],
        supportsMaxReasoningEffort: true,
        // Fast mode is available on Opus 4.6/4.7/4.8 — Opus is the only
        // catalog model in that family. The SDK confirms this at runtime via
        // supportedModels() (see applyClaudeSdkModels).
        supportsFastMode: true,
      },
      {
        id: "claude-sonnet-4-6",
        label: deriveClaudeModelLabel("claude-sonnet-4-6"),
        supportsEffort: true,
        aliases: ["sonnet"],
        contextWindowOptions: [...CLAUDE_CONTEXT_WINDOW_OPTIONS],
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: deriveClaudeModelLabel("claude-haiku-4-5-20251001"),
        supportsEffort: true,
        aliases: ["haiku"],
      },
    ],
    efforts: [...CLAUDE_REASONING_OPTIONS],
  },
  {
    id: "codex",
    label: "Codex",
    defaultModel: "gpt-5.6-sol",
    defaultEffort: "medium",
    supportsPlanMode: true,
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        supportsEffort: true,
        aliases: ["gpt-5.6"],
        supportedReasoningEfforts: GPT_5_6_REASONING_OPTIONS,
        defaultReasoningEffort: "medium",
        supportsFastMode: true,
      },
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        supportsEffort: true,
        supportedReasoningEfforts: GPT_5_6_REASONING_OPTIONS,
        defaultReasoningEffort: "medium",
        supportsFastMode: true,
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        supportsEffort: true,
        supportedReasoningEfforts: GPT_5_6_LUNA_REASONING_OPTIONS,
        defaultReasoningEffort: "medium",
        supportsFastMode: true,
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        supportsEffort: true,
        supportedReasoningEfforts: LEGACY_CODEX_REASONING_OPTIONS,
        defaultReasoningEffort: "medium",
        supportsFastMode: true,
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        supportsEffort: true,
        supportedReasoningEfforts: LEGACY_CODEX_REASONING_OPTIONS,
        defaultReasoningEffort: "medium",
        supportsFastMode: true,
      },
      {
        id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        supportsEffort: true,
        aliases: ["gpt-5-codex"],
        supportedReasoningEfforts: LEGACY_CODEX_REASONING_OPTIONS,
        defaultReasoningEffort: "high",
        // Fast mode supports GPT-5.6/5.5/5.4 only (docs: /codex/speed).
        supportsFastMode: false,
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        supportsEffort: true,
        supportedReasoningEfforts: LEGACY_CODEX_REASONING_OPTIONS,
        defaultReasoningEffort: "high",
        supportsFastMode: false,
      },
    ],
    efforts: [...CODEX_REASONING_OPTIONS],
  },
  {
    id: "cursor",
    label: "Cursor",
    defaultModel: "composer-2.5",
    supportsPlanMode: false,
    models: [
      { id: "composer-2.5", label: "Composer 2.5", supportsEffort: false },
    ],
    efforts: [],
  },
  {
    // Pi (badlogic's pi-coding-agent) runs in-process against OpenRouter. The
    // model list is a curated starting point — any OpenRouter model id can be
    // typed in via the custom model input (see normalizePiModelId).
    id: "pi",
    label: "Pi",
    defaultModel: DEFAULT_PI_MODEL,
    defaultEffort: "medium",
    supportsPlanMode: false,
    models: [
      { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", supportsEffort: true },
      { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", supportsEffort: true },
      { id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7", supportsEffort: true },
      { id: "openai/gpt-5.5", label: "GPT-5.5", supportsEffort: true },
      { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: true },
      { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", supportsEffort: true },
      { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast", supportsEffort: true },
      { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", supportsEffort: true },
      { id: "minimax/minimax-m2.7", label: "MiniMax M2.7", supportsEffort: true },
      { id: "qwen/qwen3-coder-plus", label: "Qwen3 Coder Plus", supportsEffort: false },
    ],
    efforts: [...PI_REASONING_OPTIONS],
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
  if (provider === "pi") {
    return normalizePiModelId(modelId, fallbackModelId ?? getProviderCatalog(provider).defaultModel)
  }
  return getProviderModelMatch(provider, modelId)?.id
    ?? fallbackModelId
    ?? getProviderCatalog(provider).defaultModel
}

export function normalizeClaudeModelId(modelId?: string, fallbackModelId = "claude-opus-4-8"): string {
  return normalizeProviderModelId("claude", modelId, fallbackModelId)
}

export function normalizeCodexModelId(modelId?: string, fallbackModelId = "gpt-5.6-sol"): string {
  return normalizeProviderModelId("codex", modelId, fallbackModelId)
}

export function normalizeCursorModelId(modelId?: string, fallbackModelId = "composer-2.5"): string {
  return normalizeProviderModelId("cursor", modelId, fallbackModelId)
}

export function getProviderModelOption(provider: AgentProvider, modelId: string): ProviderModelOption | undefined {
  const normalizedModelId = normalizeProviderModelId(provider, modelId)
  return getProviderCatalog(provider).models.find((candidate) => candidate.id === normalizedModelId)
}

export function getClaudeModelOption(modelId: string): ProviderModelOption | undefined {
  return getProviderModelOption("claude", modelId)
}

export function getCodexModelOption(modelId: string): ProviderModelOption | undefined {
  return getProviderModelOption("codex", modelId)
}

export function getCodexReasoningOptions(modelId: string): readonly CodexReasoningEffortOption[] {
  return getCodexModelOption(modelId)?.supportedReasoningEfforts ?? CODEX_REASONING_OPTIONS
}

export function normalizeCodexReasoningEffort(
  modelId: string,
  effort?: unknown,
): CodexReasoningEffort {
  const normalizedModel = normalizeCodexModelId(modelId)
  const model = getCodexModelOption(normalizedModel)
  const supported = model?.supportedReasoningEfforts ?? CODEX_REASONING_OPTIONS

  if (effort === "minimal" && normalizedModel.startsWith("gpt-5.6-")) {
    return "low"
  }
  if (effort === "ultra" && normalizedModel === "gpt-5.6-luna") {
    return "max"
  }
  if (isCodexReasoningEffort(effort) && supported.some((option) => option.id === effort)) {
    return effort
  }

  return model?.defaultReasoningEffort ?? DEFAULT_CODEX_MODEL_OPTIONS.reasoningEffort
}

export function supportsClaudeMaxReasoningEffort(modelId: string): boolean {
  return Boolean(getClaudeModelOption(modelId)?.supportsMaxReasoningEffort)
}

export function supportsProviderFastMode(provider: AgentProvider, modelId: string): boolean {
  return Boolean(getProviderModelOption(provider, modelId)?.supportsFastMode)
}

export function supportsClaudeFastMode(modelId: string): boolean {
  return supportsProviderFastMode("claude", modelId)
}

export function normalizeClaudeFastMode(modelId: string, fastMode?: unknown): boolean {
  return supportsClaudeFastMode(modelId) && fastMode === true
}

export function getClaudeContextWindowOptions(modelId: string): readonly ProviderContextWindowOption[] {
  return getClaudeModelOption(modelId)?.contextWindowOptions ?? []
}

// Preference normalization: models without a context window selector keep the
// default *preference* instead of a clamped value, so switching to a model
// that does support selection starts from the default rather than a stale
// clamp. The effective window is resolved at usage time below.
export function normalizeClaudeContextWindow(modelId: string, contextWindow?: unknown): ClaudeContextWindow {
  const options = getClaudeContextWindowOptions(modelId)
  if (options.length === 0) return DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow
  return options.some((option) => option.id === contextWindow)
    ? contextWindow as ClaudeContextWindow
    : DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow
}

// Usage-time resolution: models without a 1m option always run at the
// standard window regardless of the stored preference.
export function resolveClaudeContextWindow(modelId: string, contextWindow?: unknown): ClaudeContextWindow {
  const options = getClaudeContextWindowOptions(modelId)
  if (!options.some((option) => option.id === "1m")) return "200k"
  return normalizeClaudeContextWindow(modelId, contextWindow)
}

export function resolveClaudeApiModelId(modelId: string, contextWindow?: ClaudeContextWindow): string {
  return resolveClaudeContextWindow(modelId, contextWindow) === "1m" ? `${modelId}[1m]` : modelId
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
  /** User marked the chat done (board Done column). Cleared when a new turn starts. */
  done?: boolean
  localPath: string
  provider: AgentProvider | null
  lastMessageAt?: number
  /** One-line preview of the latest user prompt. */
  lastUserMessagePreview?: string
  /** One-line preview of the latest agent text message. */
  lastAgentMessagePreview?: string
  /** Tool kind the chat is waiting on when status is waiting_for_user (e.g. "ask_user_question"). */
  pendingToolKind?: string
  hasAutomation: boolean
  canFork?: boolean
}

export interface SidebarProjectGroup {
  groupKey: string
  title: string
  realTitle: string
  sidebarTitle?: string
  localPath: string
  chats: SidebarChatRow[]
  previewChats: SidebarChatRow[]
  olderChats: SidebarChatRow[]
  archivedChats?: SidebarChatRow[]
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
  folderModifiedAt?: number
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
  /** Return to the board when a chat opened from it starts running. Off by default. */
  boardAutoReturn: boolean
  warning: string | null
  filePathDisplay: string
}

export interface AppSettingsPatch {
  analyticsEnabled?: boolean
  browserSettingsMigrated?: boolean
  theme?: AppThemePreference
  chatSoundPreference?: ChatSoundPreference
  chatSoundId?: ChatSoundId
  boardAutoReturn?: boolean
  terminal?: Partial<AppSettingsSnapshot["terminal"]>
  editor?: Partial<AppSettingsSnapshot["editor"]>
  defaultProvider?: DefaultProviderPreference
  providerDefaults?: {
    claude?: Partial<Omit<ProviderPreference<ClaudeModelOptions>, "modelOptions">> & {
      modelOptions?: Partial<ClaudeModelOptions>
    }
    codex?: Partial<Omit<ProviderPreference<CodexModelOptions>, "modelOptions">> & {
      modelOptions?: Partial<CodexModelOptions>
    }
    cursor?: Partial<ProviderPreference<CursorModelOptions>>
    pi?: Partial<Omit<ProviderPreference<PiModelOptions>, "modelOptions">> & {
      modelOptions?: Partial<PiModelOptions>
    }
  }
}

/** A user-curated model shortcut shown in Pi's model picker. */
export interface FaveModel {
  label: string
  id: string
}

// The Model Registry: one OpenAI-compatible connection (OpenRouter, OpenAI, or
// a custom base URL) used by Pi and for background quick responses (chat
// naming, commit messages). Kept as "LlmProvider" internally / on disk for
// backwards compatibility with existing ~/.kanna/llm-provider.json files.
export interface LlmProviderFile {
  provider?: LlmProviderKind
  apiKey?: string
  model?: string
  baseUrl?: string | null
  faveModels?: FaveModel[]
}

export interface LlmProviderSnapshot {
  provider: LlmProviderKind
  apiKey: string
  model: string
  baseUrl: string
  resolvedBaseUrl: string
  faveModels: FaveModel[]
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
  /** Set when the checked-out branch is a pull request checked out through Kanna. */
  checkedOutPrNumber?: number
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
  | ({ kind: "user_prompt"; content: string; attachments?: ChatAttachment[]; steered?: boolean; id: string; messageId?: string; timestamp: string; hidden?: boolean })
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

export interface ChatSnapshot {
  runtime: ChatRuntime
  queuedMessages: QueuedChatMessage[]
  messages: TranscriptEntry[]
  history: ChatHistorySnapshot
  availableProviders: ProviderCatalogEntry[]
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

import { Effect, Schema, Struct } from "effect"
import { isClientEnvelope, type ClientEnvelope } from "./protocol"

/**
 * Schemas for what a client sends the server: the `ClientEnvelope` and
 * `ClientCommand` types of `protocol.ts`, as values a frame can be decoded
 * with. `protocol.ts` keeps the types (the client imports them); these are
 * checked against them in `protocol-schema.test.ts`, both ways, so a change
 * to one that is not made to the other fails the build.
 *
 * The strict schemas describe the declared protocol types. The WebSocket
 * boundary uses `CompatibleClientEnvelopeSchema` below to preserve the
 * router's permissive dispatch and leave nested normalization to handlers.
 */

const AgentProvider = Schema.Literals(["claude", "codex", "cursor", "grok", "pi"])
const AuthServiceId = Schema.Literals(["claude", "codex", "cursor", "grok", "gh", "openrouter"])
const EditorPreset = Schema.Literals(["cursor", "vscode", "zed", "xcode", "windsurf", "custom"])
const TerminalPreset = Schema.Literals(["terminal", "iterm", "ghostty", "warp", "wezterm", "kitty", "alacritty", "hyper"])
const LlmProviderKind = Schema.Literals(["openai", "openrouter", "custom"])
const DiffCommitMode = Schema.Literals(["commit_and_push", "commit_only"])
const StandaloneTranscriptAttachmentMode = Schema.Literals(["metadata", "bundle"])
const ChatSoundPreference = Schema.Literals(["never", "unfocused", "always"])
const PaneVisibilityScope = Schema.Literals(["chat", "project"])

const ChatAttachment = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  displayName: Schema.String,
  absolutePath: Schema.String,
  relativePath: Schema.String,
  contentUrl: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
})

const SelectedBranch = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("remote"), name: Schema.String, remoteRef: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    name: Schema.String,
    prNumber: Schema.Number,
    headRefName: Schema.String,
    headRepoCloneUrl: Schema.optionalKey(Schema.String),
    isCrossRepository: Schema.optionalKey(Schema.Boolean),
    remoteRef: Schema.optionalKey(Schema.String),
  }),
])

const ClaudeReasoningEffort = Schema.Literals(["low", "medium", "high", "max"])
/** Any string: the real set per model comes from the codex app-server at runtime. */
const CodexReasoningEffort = Schema.String
const PiReasoningEffort = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh"])
const GrokReasoningEffort = Schema.Literals(["low", "medium", "high"])

const ClaudeModelOptionsFields = {
  reasoningEffort: ClaudeReasoningEffort,
  contextWindow: Schema.Literals(["200k", "1m"]),
  fastMode: Schema.Boolean,
}
const CodexModelOptionsFields = { reasoningEffort: CodexReasoningEffort, fastMode: Schema.Boolean }
const CursorModelOptionsFields = { fastMode: Schema.Boolean }
const PiModelOptionsFields = { reasoningEffort: PiReasoningEffort }
const GrokModelOptionsFields = { reasoningEffort: GrokReasoningEffort }

/** Every field of `fields`, optional: `Partial<T>` as a schema. */
const partialStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.optionalKey))

const ModelOptions = partialStruct({
  claude: partialStruct(ClaudeModelOptionsFields),
  codex: partialStruct(CodexModelOptionsFields),
  cursor: partialStruct(CursorModelOptionsFields),
  grok: partialStruct(GrokModelOptionsFields),
  pi: partialStruct(PiModelOptionsFields),
})

/** `Partial<Omit<ProviderPreference<O>, "modelOptions">> & { modelOptions?: Partial<O> }` */
const ProviderDefaultsPatch = <const Fields extends Schema.Struct.Fields>(modelOptions: Fields) =>
  partialStruct({
    model: Schema.String,
    modelOptions: partialStruct(modelOptions),
    planMode: Schema.Boolean,
    autoPlan: Schema.Boolean,
  })

const AppSettingsPatch = partialStruct({
  analyticsEnabled: Schema.Boolean,
  browserSettingsMigrated: Schema.Boolean,
  theme: Schema.Literals(["light", "dark", "system"]),
  chatSoundPreference: ChatSoundPreference,
  chatSoundId: Schema.Literals(["blow", "bottle", "frog", "funk", "glass", "ping", "pop", "purr", "tink"]),
  chatBrowserNotificationPreference: ChatSoundPreference,
  submitWhileRunning: Schema.Literals(["queue", "steer"]),
  newSidebarEnabled: Schema.Boolean,
  projectIconsInChats: Schema.Boolean,
  chatTabsEnabled: Schema.Boolean,
  widgetsPeekEnabled: Schema.Boolean,
  newProjectsDirectory: Schema.String,
  setupShown: Schema.Boolean,
  setupCompleted: Schema.Boolean,
  setupDismissed: Schema.Boolean,
  terminal: partialStruct({ scrollbackLines: Schema.Number, minColumnWidth: Schema.Number, webglRenderer: Schema.Boolean }),
  editor: partialStruct({ preset: EditorPreset, commandTemplate: Schema.String }),
  transcript: partialStruct({ windowAssistantMessages: Schema.Number }),
  paneVisibility: partialStruct({ widgets: PaneVisibilityScope, terminal: PaneVisibilityScope }),
  defaultProvider: Schema.Union([Schema.Literal("last_used"), AgentProvider]),
  providerDefaults: partialStruct({
    claude: ProviderDefaultsPatch(ClaudeModelOptionsFields),
    codex: ProviderDefaultsPatch(CodexModelOptionsFields),
    // `Partial<ProviderPreference<CursorModelOptions>>`: its options are whole.
    cursor: partialStruct({
      model: Schema.String,
      modelOptions: Schema.Struct(CursorModelOptionsFields),
      planMode: Schema.Boolean,
      autoPlan: Schema.Boolean,
    }),
    grok: ProviderDefaultsPatch(GrokModelOptionsFields),
    pi: ProviderDefaultsPatch(PiModelOptionsFields),
  }),
})

const KeybindingAction = [
  "toggleEmbeddedTerminal",
  "toggleRightSidebar",
  "openInFinder",
  "openInEditor",
  "addSplitTerminal",
  "jumpToSidebarChat",
  "createChatInCurrentProject",
  "openAddProject",
  "openCommandPalette",
  "toggleFocusMode",
] as const
/** Every action, each with its shortcuts: `Record<KeybindingAction, string[]>`. */
const KeybindingBindings = Schema.Record(Schema.Literals(KeybindingAction), Schema.Array(Schema.String))

const FaveModel = Schema.Struct({ label: Schema.String, id: Schema.String })

const ProjectQuickAction = Schema.Struct({ id: Schema.String, label: Schema.String, command: Schema.String })

const EditorOpenSettings = Schema.Struct({ preset: EditorPreset, commandTemplate: Schema.String })

/** The settings a send carries from the composer, shared by chat.send and message.enqueue. */
const ComposerFields = {
  attachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
  provider: Schema.optionalKey(AgentProvider),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(ModelOptions),
  planMode: Schema.optionalKey(Schema.Boolean),
  autoPlan: Schema.optionalKey(Schema.Boolean),
}

const command = <const Type extends string, const Fields extends Schema.Struct.Fields = {}>(type: Type, fields?: Fields) =>
  Schema.Struct({ type: Schema.Literal(type), ...(fields ?? ({} as Fields)) })

const optionalString = Schema.optionalKey(Schema.String)
const optionalBoolean = Schema.optionalKey(Schema.Boolean)
const optionalNumber = Schema.optionalKey(Schema.Number)

export const ClientCommandSchema = Schema.Union([
  command("project.open", { localPath: Schema.String }),
  command("project.create", { localPath: Schema.String, title: optionalString }),
  command("project.rename", { projectId: Schema.String, title: Schema.String }),
  command("project.rename", { localPath: Schema.String, title: Schema.String }),
  command("project.setPinned", { projectId: Schema.String, pinned: Schema.Boolean, pinnedAt: optionalNumber }),
  command("project.clone", { cloneUrl: Schema.String, localPath: Schema.String, fallbackPath: optionalString, title: Schema.String }),
  command("github.listRecentRepos"),
  command("project.remove", { projectId: Schema.String }),
  command("project.remove", { localPath: Schema.String }),
  command("sidebar.reorderProjectGroups", { projectIds: Schema.Array(Schema.String) }),
  command("project.readDiffPatch", { projectId: Schema.String, path: Schema.String, fullContext: optionalBoolean }),
  command("project.readCommit", { projectId: Schema.String, sha: Schema.String }),
  command("project.readBranch", { projectId: Schema.String, branch: SelectedBranch }),
  command("project.generateCommitMessage", { projectId: Schema.String, paths: Schema.Array(Schema.String) }),
  command("project.commitDiffs", {
    projectId: Schema.String,
    paths: Schema.Array(Schema.String),
    summary: Schema.String,
    description: optionalString,
    mode: DiffCommitMode,
  }),
  command("system.ping"),
  command("fs.list", { path: optionalString, nearest: optionalBoolean }),
  command("fs.mkdir", { path: Schema.String }),
  command("browser.listLocalHttpServers", { projectId: optionalString }),
  command("browser.killLocalHttpServer", { port: Schema.Number }),
  command("browser.exposeLocalHttpServer", { port: Schema.Number }),
  command("browser.unexposeLocalHttpServer", { port: Schema.Number }),
  command("project.readQuickActions", { projectId: Schema.String }),
  command("project.writeQuickActions", { projectId: Schema.String, quickActions: Schema.Array(ProjectQuickAction) }),
  command("update.check", { force: optionalBoolean }),
  command("update.install"),
  command("update.installNightly"),
  command("update.installStable"),
  command("settings.readKeybindings"),
  command("settings.writeKeybindings", { bindings: KeybindingBindings }),
  command("settings.readAppSettings"),
  command("settings.writeAppSettings", { analyticsEnabled: Schema.Boolean }),
  command("settings.writeAppSettingsPatch", { patch: AppSettingsPatch }),
  command("settings.readLlmProvider"),
  command("usage.refresh", { force: optionalBoolean }),
  command("auth.refresh", { force: optionalBoolean }),
  command("auth.install", { service: AuthServiceId }),
  command("auth.login.start", { service: AuthServiceId }),
  command("auth.login.submitCode", { service: AuthServiceId, code: Schema.String }),
  command("auth.login.cancel", { service: AuthServiceId }),
  command("auth.openrouter.start", { callbackUrl: Schema.String }),
  command("auth.openrouter.exchange", { code: Schema.String }),
  command("chat.listSkills", { provider: AgentProvider, chatId: optionalString, projectId: optionalString }),
  command("skills.search", { query: Schema.String, limit: optionalNumber }),
  command("skills.install", { source: Schema.String, skillId: Schema.String }),
  command("skills.uninstall", { skillId: Schema.String }),
  command("skills.listInstalled"),
  command("skills.listGlobal"),
  command("settings.writeLlmProvider", {
    provider: LlmProviderKind,
    apiKey: Schema.String,
    model: Schema.String,
    baseUrl: Schema.String,
    faveModels: Schema.optionalKey(Schema.Array(FaveModel)),
  }),
  command("settings.validateLlmProvider", {
    provider: LlmProviderKind,
    apiKey: Schema.String,
    model: Schema.String,
    baseUrl: Schema.String,
  }),
  command("system.openExternal", {
    localPath: Schema.String,
    action: Schema.Literals(["open_finder", "open_terminal", "open_editor", "open_preview", "open_default"]),
    line: optionalNumber,
    column: optionalNumber,
    editor: Schema.optionalKey(EditorOpenSettings),
    terminal: Schema.optionalKey(TerminalPreset),
  }),
  command("chat.create", { projectId: Schema.String, delegator: optionalBoolean, chatId: optionalString }),
  command("chat.setDelegator", { chatId: Schema.String, delegator: Schema.Boolean }),
  command("chat.fork", { chatId: Schema.String }),
  command("chat.rename", { chatId: Schema.String, title: Schema.String }),
  command("chat.setPinned", { chatId: Schema.String, pinned: Schema.Boolean }),
  command("chat.archive", { chatId: Schema.String }),
  command("chat.unarchive", { chatId: Schema.String }),
  command("chat.delete", { chatId: Schema.String }),
  command("chat.setDraftProtection", { chatIds: Schema.Array(Schema.String) }),
  command("chat.touchedFiles", { chatId: Schema.String }),
  command("chat.markRead", { chatId: Schema.String }),
  command("chat.setDone", { chatId: Schema.String, done: Schema.Boolean }),
  command("chat.setReadAnchor", {
    chatId: Schema.String,
    messageId: Schema.String,
    atEnd: Schema.Boolean,
    transcriptWidth: optionalNumber,
    offsetFromMessage: optionalNumber,
  }),
  command("chat.getReadAnchor", { chatId: Schema.String }),
  command("chat.getPreview", { chatId: Schema.String }),
  command("chat.getEntryDebugRaw", { chatId: Schema.String, entryId: Schema.String }),
  command("chat.getToolEntries", { chatId: Schema.String, entryIds: Schema.Array(Schema.String) }),
  command("chat.loadOlder", { chatId: Schema.String, untilMessageId: optionalString, all: optionalBoolean }),
  command("chat.send", {
    chatId: optionalString,
    projectId: optionalString,
    content: Schema.String,
    effort: optionalString,
    delegator: optionalBoolean,
    ...ComposerFields,
  }),
  command("chat.refreshDiffs", { chatId: Schema.String }),
  command("chat.initGit", { chatId: Schema.String }),
  command("chat.getGitHubPublishInfo", { chatId: Schema.String }),
  command("chat.checkGitHubRepoAvailability", { chatId: Schema.String, owner: Schema.String, name: Schema.String }),
  command("chat.publishToGitHub", {
    chatId: Schema.String,
    owner: Schema.String,
    name: Schema.String,
    visibility: Schema.Literals(["public", "private"]),
    description: optionalString,
  }),
  command("chat.listBranches", { chatId: Schema.String }),
  command("chat.previewMergeBranch", { chatId: Schema.String, branch: SelectedBranch }),
  command("chat.mergeBranch", { chatId: Schema.String, branch: SelectedBranch }),
  command("chat.syncBranch", { chatId: Schema.String, action: Schema.Literals(["fetch", "pull", "push", "publish"]) }),
  command("chat.checkoutBranch", { chatId: Schema.String, branch: SelectedBranch, bringChanges: optionalBoolean }),
  command("chat.createBranch", { chatId: Schema.String, name: Schema.String, baseBranchName: optionalString }),
  command("chat.discardDiffFile", { chatId: Schema.String, path: Schema.String }),
  command("chat.ignoreDiffFile", { chatId: Schema.String, path: Schema.String }),
  command("chat.cancel", { chatId: Schema.String }),
  command("chat.stopDraining", { chatId: Schema.String }),
  command("chat.stopTask", { chatId: Schema.String, taskId: Schema.String }),
  command("chat.exportStandalone", {
    sourceOrigin: optionalString,
    chatId: Schema.String,
    theme: Schema.Literals(["light", "dark"]),
    attachmentMode: StandaloneTranscriptAttachmentMode,
  }),
  command("chat.respondTool", {
    chatId: Schema.String,
    toolUseId: Schema.String,
    // `unknown` admits undefined, which JSON drops: an absent key is that.
    result: Schema.Unknown.pipe(Schema.withDecodingDefaultKey(Effect.succeed(undefined))),
  }),
  command("message.enqueue", { chatId: Schema.String, content: Schema.String, steer: optionalBoolean, ...ComposerFields }),
  command("message.steer", { chatId: Schema.String, queuedMessageId: Schema.String }),
  command("message.dequeue", { chatId: Schema.String, queuedMessageId: Schema.String }),
  command("terminal.create", {
    projectId: Schema.NullOr(Schema.String),
    terminalId: Schema.String,
    cols: Schema.Number,
    rows: Schema.Number,
    scrollback: Schema.Number,
  }),
  command("terminal.input", { terminalId: Schema.String, data: Schema.String }),
  command("terminal.resize", { terminalId: Schema.String, cols: Schema.Number, rows: Schema.Number }),
  command("terminal.close", { terminalId: Schema.String }),
  command("terminal.tail", { terminalId: Schema.String, sinceVersion: Schema.NullOr(Schema.Number) }),
])

export const SubscriptionTopicSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sidebar"), patches: optionalBoolean }),
  Schema.Struct({ type: Schema.Literal("local-projects") }),
  Schema.Struct({ type: Schema.Literal("update") }),
  Schema.Struct({ type: Schema.Literal("keybindings") }),
  Schema.Struct({ type: Schema.Literal("app-settings") }),
  Schema.Struct({ type: Schema.Literal("usage-limits") }),
  Schema.Struct({ type: Schema.Literal("provider-auth") }),
  Schema.Struct({
    type: Schema.Literal("chat"),
    chatId: Schema.String,
    cachedSpan: Schema.optionalKey(Schema.Struct({ start: Schema.Number, end: Schema.Number, endEntryId: Schema.String })),
    background: optionalBoolean,
  }),
  Schema.Struct({ type: Schema.Literal("project-git"), projectId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("terminal"), terminalId: Schema.String }),
])

export const ClientEnvelopeSchema = Schema.Union([
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("subscribe"), id: Schema.String, topic: SubscriptionTopicSchema }),
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("unsubscribe"), id: Schema.String }),
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("command"), id: Schema.String, command: ClientCommandSchema }),
])

/** A WebSocket text frame: JSON holding a `ClientEnvelope`. */
export const ClientEnvelopeFromJson = Schema.fromJsonString(ClientEnvelopeSchema)

/**
 * The router historically accepts any JSON object with version 1 and a string
 * type. Keep that exact boundary while letting Schema decode the untrusted
 * value. In particular, do not strip extra fields or validate nested payloads
 * here: handlers may normalize them or return their own command errors.
 */
export const CompatibleClientEnvelopeSchema = Schema.declare(
  (input: unknown): input is ClientEnvelope => isClientEnvelope(input),
)

/** Parse JSON separately so the router can retain its distinct error messages. */
export const ClientFrameJsonSchema = Schema.fromJsonString(Schema.Unknown)

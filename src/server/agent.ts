import {
  query,
  type BackgroundTaskSummary,
  type CanUseTool,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentProvider,
  AccountInfo,
  AskUserQuestionItem,
  ChatAttachment,
  ChatSkillsSnapshot,
  CodexReasoningEffort,
  ContextWindowUsageSnapshot,
  HarnessSkill,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  KannaStatus,
  QueuedChatMessage,
  SubagentActivity,
  MessageSource,
  TranscriptEntry,
  WaitingOn,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { resolveClaudeExecutable } from "./claude-executable"
import { KannaToolRuntime, KannaToolEventFilter, type KannaToolHost } from "./kanna-tools"
import type { Orchestrator } from "./orchestrator"
import { createClaudeKannaTools } from "./kanna-tool-adapters"
import type { EventStore } from "./event-store"
import { STRUCTURED_RESULT_TOOL_KINDS } from "./events"
import { NoopAnalytics, type Analytics } from "./analytics"
import { runKannaSync } from "./effect/bridge"
import { type CodexAppServer, createCodexAppServer } from "./codex-app-server"
import { makeCursorCli, type CursorCli } from "./cursor-cli"
import { makeGrokCli, type GrokCli } from "./grok-cli"
import { openHarnessTurn } from "./harness-bridge"
import { PiAgentManager, piDataDir, resolvePiConnection } from "./pi-agent"
import { Machine, type MachineEnv } from "./platform/machine"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import { QuickResponse, withSharedQuickResponse } from "./quick-response"
import type { ClaudeRateLimitInfoRaw, ClaudeUsageRaw } from "./usage-limits"
import type { HarnessEvent, HarnessToolRequest, ManagedHarnessTurn } from "./harness-types"
import {
  appendSystemMessageBlock,
  buildSkillSystemMessage,
  findSkillMentions,
  resolveSkillMentions,
  scanClaudeSkills,
  scanCodexSkills,
  scanCursorSkills,
  scanGrokSkills,
  type SkillReference,
} from "./harness-skills"
import {
  buildKannaAgentCorrection,
  buildKannaAgentId,
} from "./attribution"
import { buildKannaSystemInstructions, buildKannaSystemMessage } from "./harness-instructions"
import {
  applyClaudeSdkModels,
  applyCodexModels,
  applyCursorModels,
  applyGrokModels,
  type ClaudeSdkModelInfo,
  cursorModelIdForOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeGrokModelOptions,
  normalizePiModelOptions,
  normalizeServerModel,
  serviceTierFromModelOptions,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import { asRecord } from "../shared/json"
import { maxClaudeContextWindowFromModelUsage, normalizeClaudeContextUsage, normalizeClaudeUsageSnapshot } from "./claude-usage"
import { buildHandoffContext, buildHandoffMessageContent } from "./handoff"
import { checkSessionArtifact, type SessionArtifactStatus } from "./session-artifacts"
import { Cause, Context, Effect, Exit, Fiber, Queue, Schema, Stream } from "effect"
import { runKanna } from "./effect/bridge"
import type { PlatformServices } from "./platform"
import { timestamped } from "./transcript"
import {
  findWorkflowOf,
  finishActivity,
  isDelegatedTask,
  linkWorkflowAgents,
  normalizeClaudeTaskMessage,
  pruneTaskLog,
  type SubagentActivityUpdate,
  type TaskStart,
} from "./background-tasks"

export type { SubagentActivityUpdate } from "./background-tasks"
export { maxClaudeContextWindowFromModelUsage, normalizeClaudeContextUsage, normalizeClaudeUsageSnapshot } from "./claude-usage"

/** Existing agent tests inject Promise stores; production passes EventStore's Effect service. */
function runStoreWrite<A, E>(operation: Effect.Effect<A, E>): Promise<A> {
  return runKanna(storeWriteEffect(operation))
}

/** Older agent fixtures return Promises from store writes. Production uses Effects. */
function storeWriteEffect<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E | Error> {
  return Effect.isEffect(operation)
    ? operation
    : Effect.tryPromise({
      try: () => operation as unknown as Promise<A>,
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    })
}

/**
 * Tools every Claude session gets. `EnterPlanMode` is deliberately absent — it
 * is added only in "Auto Plan" (see {@link claudeToolset}); without it Claude
 * cannot put itself into plan mode unprompted.
 *
 * `ExitPlanMode` stays in the base set even in Full Access: the user can flip a
 * live session into plan mode via `setPermissionMode` without a restart, and
 * without the exit tool they would be stranded there.
 */
const CLAUDE_BASE_TOOLSET = [
  "Skill",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "TodoWrite",
  "KillShell",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "Monitor",
  "PushNotification",
  "AskUserQuestion",
  "ExitPlanMode",
] as const

/**
 * The SDK's `tools` allowlist is fixed at `query()` time (there is no runtime
 * tool-swap), so a change to `autoPlan` forces a session restart — see the
 * restart condition in {@link AgentCoordinator.startClaudeTurn}.
 */
export function claudeToolset(autoPlan: boolean): string[] {
  return autoPlan ? [...CLAUDE_BASE_TOOLSET, "EnterPlanMode"] : [...CLAUDE_BASE_TOOLSET]
}

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
  resolve: (result: unknown) => void
  resultOwner?: "tool"
  validateResult?: (result: unknown) => void
}

function normalizePreviewText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * One line of what the chat is waiting on, for the sidebar row and the system
 * notification that quotes it: the questions asked, or the plan's summary.
 */
function getToolRequestPreview(tool: PendingToolRequest["tool"]) {
  if (tool.toolKind === "ask_user_question") {
    const questions = tool.input.questions
      .map((question) => normalizePreviewText(question.question))
      .filter(Boolean)
    if (questions.length > 0) return questions.join(" ")
  }

  if (tool.toolKind === "exit_plan_mode") {
    const summary = normalizePreviewText(tool.input.summary ?? "")
    if (summary) return summary
    const plan = normalizePreviewText(tool.input.plan ?? "")
    if (plan) return plan
  }

  return "Waiting for your response."
}

interface ActiveTurn {
  customTools?: KannaToolRuntime
  chatId: string
  provider: AgentProvider
  turn: ManagedHarnessTurn<unknown, unknown, unknown>
  claudePromptSeq?: number
  /** The Claude session this turn runs in (`ClaudeSessionState.id`). See `runClaudeSession`'s cleanup. */
  claudeSessionId?: string
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  status: KannaStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean
  /** The user approved this turn's plan, so it is no longer read-only whatever `planMode` says. */
  planExited?: boolean
}

interface ClaudeSessionHandle {
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  getUsage?: () => Promise<ClaudeUsageRaw | null>
  interrupt: () => Promise<void>
  /** Stops one background task; the CLI then reports it ended as `stopped`. */
  stopTask?: (taskId: string) => Promise<void>
  close: () => void
  /** `promptId` rides on the message and comes back on the result that answers it. */
  sendPrompt: (content: string, promptId?: string) => Promise<void>
  /** Whether results are known to echo prompt ids before any has arrived. */
  echoesPromptIds?: boolean
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  setFastMode?: (fastMode: boolean) => Promise<void>
  supportedModels?: () => Promise<ClaudeSdkModelInfo[]>
  supportedCommands?: () => Promise<SlashCommand[]>
}

export class ClaudeSessionError extends Schema.TaggedError<ClaudeSessionError>()(
  "@kanna/server/agent/ClaudeSessionError",
  {
    chatId: Schema.String,
    operation: Schema.Literals([
      "events", "accountInfo", "usage", "interrupt", "stopTask", "sendPrompt",
      "setModel", "setPermissionMode", "setFastMode", "supportedModels", "supportedCommands",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export class AgentCancelError extends Schema.TaggedError<AgentCancelError>()(
  "@kanna/server/agent/AgentCancelError",
  { chatId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export class AgentEventError extends Schema.TaggedError<AgentEventError>()(
  "@kanna/server/agent/AgentEventError",
  { chatId: Schema.String, provider: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

interface ClaudeSessionEffect {
  readonly events: Stream.Stream<HarnessEvent, ClaudeSessionError>
  readonly accountInfo?: Effect.Effect<AccountInfo | null, ClaudeSessionError>
  readonly usage?: Effect.Effect<ClaudeUsageRaw | null, ClaudeSessionError>
  readonly interrupt: Effect.Effect<void, ClaudeSessionError>
  readonly stopTask?: (taskId: string) => Effect.Effect<void, ClaudeSessionError>
  readonly close: Effect.Effect<void>
  readonly sendPrompt: (content: string, promptId?: string) => Effect.Effect<void, ClaudeSessionError>
  readonly setModel: (model: string) => Effect.Effect<void, ClaudeSessionError>
  readonly setPermissionMode: (planMode: boolean) => Effect.Effect<void, ClaudeSessionError>
  readonly setFastMode?: (fastMode: boolean) => Effect.Effect<void, ClaudeSessionError>
  readonly supportedCommands?: Effect.Effect<SlashCommand[], ClaudeSessionError>
}

/** The SDK and injected test sessions are Promise based; adapt them once. */
function effectClaudeSession(chatId: string, handle: ClaudeSessionHandle): ClaudeSessionEffect {
  const attempt = <A>(operation: ClaudeSessionError["operation"], run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new ClaudeSessionError({ chatId, operation, cause }),
    })
  return {
    events: Stream.fromAsyncIterable(handle.stream, (cause) => new ClaudeSessionError({ chatId, operation: "events", cause })),
    ...(handle.getAccountInfo ? { accountInfo: attempt("accountInfo", handle.getAccountInfo) } : {}),
    ...(handle.getUsage ? { usage: attempt("usage", handle.getUsage) } : {}),
    interrupt: attempt("interrupt", handle.interrupt),
    ...(handle.stopTask ? { stopTask: (taskId: string) => attempt("stopTask", () => handle.stopTask!(taskId)) } : {}),
    close: Effect.sync(() => handle.close()),
    sendPrompt: (content, promptId) => attempt("sendPrompt", () => handle.sendPrompt(content, promptId)),
    setModel: (model) => attempt("setModel", () => handle.setModel(model)),
    setPermissionMode: (planMode) => attempt("setPermissionMode", () => handle.setPermissionMode(planMode)),
    ...(handle.setFastMode ? { setFastMode: (fastMode: boolean) => attempt("setFastMode", () => handle.setFastMode!(fastMode)) } : {}),
    ...(handle.supportedCommands ? { supportedCommands: attempt("supportedCommands", handle.supportedCommands) } : {}),
  }
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionEffect
  localPath: string
  model: string
  /**
   * The agent id baked into this session's system-prompt append. Frozen at
   * query() time — unlike `model`, which setModel() updates in place — so a
   * mismatch against the turn's model is exactly the drift the per-turn
   * correction exists to cover.
   */
  promptAgentId: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  /** Baked into the system-prompt append, like `promptAgentId`. */
  delegator: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  /** Prompts sent and not yet answered, oldest first. */
  pendingPrompts: Array<{ seq: number; id: string }>
  /** Results carry the ids of the prompts they answer (see takeAnsweredClaudePrompts). */
  echoesPromptIds: boolean
  /**
   * Set while a cancel is settling so in-flight stream entries (emitted
   * between cancel() and the interrupt landing) don't re-register an
   * active turn via resumeBackgroundTurn. Cleared on the next result or
   * interrupted entry, and whenever a new prompt is sent.
   */
  suppressResume: boolean
  /**
   * Prompt seqs whose turn was cancelled by the user (escape or steer).
   * The SDK reports an interrupt as an error result (subtype
   * error_during_execution, usually no text); results attributed to these
   * seqs are dropped instead of persisted, since cancel already appended an
   * "interrupted" entry. Unlike suppressResume, this survives a new prompt
   * being sent immediately after the cancel (the steer path).
   */
  cancelledPromptSeqs: Set<number>
}

interface AgentCoordinatorArgs {
  /** The native service; a `{ service }` wrapper remains accepted for older test fixtures. */
  store: EventStore["Service"] | { readonly service: EventStore["Service"] }
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  analytics?: Analytics["Service"]
  codexManager?: CodexAppServer["Service"]
  quickResponse?: QuickResponse["Service"]
  cursorManager?: CursorCli["Service"]
  grokManager?: GrokCli["Service"]
  piManager?: PiAgentManager
  /**
   * The platform the agents run on: processes, files, the machine's facts.
   * The server passes the one its runtime was built with.
   */
  platform: Context.Context<PlatformServices>
  /** The machine the agents run on (default: the platform's). */
  machine?: Machine["Service"]
  resolvePiConnection?: () => Promise<import("./pi-agent").PiConnection | null>
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  startClaudeSession?: (args: {
    platform: Context.Context<PlatformServices>
    localPath: string
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    autoPlan: boolean
    delegator?: boolean
    sessionToken: string | null
    forkSession: boolean
    resumeSessionAt?: string
    customTools?: KannaToolHost
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
    onSubagentActivity?: (update: SubagentActivityUpdate) => void
    signal?: AbortSignal
  }) => Promise<ClaudeSessionHandle>
  /**
   * Probe whether a provider's native session artifact still exists on disk.
   * Injectable so tests can force a "missing" session without touching the
   * filesystem. Defaults to the real {@link checkSessionArtifact}.
   */
  checkSessionArtifact?: (
    provider: AgentProvider,
    query: { cwd: string; sessionToken: string | null | undefined }
  ) => SessionArtifactStatus | Promise<SessionArtifactStatus>
}


/**
 * Whether a provider's subagents are known only from its transcript. See
 * `AgentCoordinator.trackSubagentFromEntry`.
 */
function tracksSubagentsFromTranscript(provider: AgentProvider) {
  return provider !== "claude" && provider !== "codex"
}

function isClaudeSteerLoggingEnabled(env: MachineEnv) {
  return env.get("KANNA_LOG_CLAUDE_STEER") === "1"
}

function logClaudeSteer(env: MachineEnv, stage: string, details?: Record<string, unknown>) {
  if (!isClaudeSteerLoggingEnabled(env)) return
  console.log("[kanna/claude-steer]", JSON.stringify({
    stage,
    ...details,
  }))
}

const STEERED_MESSAGE_PREFIX = `<system-message>
The user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.
</system-message>`

/**
 * Wire-only prompt that restarts a turn Kanna killed by shutting down (see
 * `AgentCoordinator.resumeInterruptedTurn`). The harness session carries the
 * original prompt and the work already done, so this only has to say what
 * happened and warn that the last thing it was doing may be half-finished —
 * the process died mid-tool-call as often as not.
 */
export const RESUME_AFTER_RESTART_MESSAGE = `<system-message>
Kanna restarted while you were working on this, so your process was stopped mid-task and is now back up. Continue the task you were on from where it left off.
Whatever you were doing last may not have completed — re-check the state of any file you were editing and any command you had running before assuming it finished.
</system-message>`

interface StartTurnArgs {
  chatId: string
  provider: AgentProvider
  content: string
  attachments: ChatAttachment[]
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  appendUserPrompt: boolean
  steered?: boolean
  /** Who sent the prompt, when not the user. Stamped on the transcript entry. */
  source?: MessageSource
}

interface SendMessageOptions {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  effort?: string
  planMode?: boolean
  autoPlan?: boolean
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function buildSteeredMessageContent(content: string) {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return STEERED_MESSAGE_PREFIX
  }
  // Slash invocations must stay at the very start of the message — claude
  // checks trim().startsWith("/") and pi checks startsWith("/") before
  // expanding — so the steer block trails instead of leading for them.
  if (trimmed.startsWith("/")) {
    return `${content}\n\n${STEERED_MESSAGE_PREFIX}`
  }
  return `${STEERED_MESSAGE_PREFIX}\n\n${content}`
}

export interface ConcurrentProjectChat {
  title: string
  transcriptPath: string
}

/**
 * Wire-only notice (never stored in the transcript — same pattern as the
 * codex/cursor skill failsafe) appended to the harness-bound prompt when
 * other chats have active turns in the same project directory.
 */
export function buildConcurrentAgentsNotice(chats: ConcurrentProjectChat[]): string | null {
  if (chats.length === 0) return null
  const lines = chats.map((chat) => `${chat.title}: ${chat.transcriptPath}`)
  return [
    "<system-message>there are other agents working in the current directory. Don't overwrite their work if builds fail, don't fix broken tests (as they may be stale while the other agent works) and expect changes between reads.",
    "",
    "Active chats & their transcripts can be found here:",
    ...lines,
    "</system-message>",
  ].join("\n")
}

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}




export function buildAttachmentHintText(attachments: ChatAttachment[]) {
  if (attachments.length === 0) return ""

  const lines = attachments.map((attachment) => (
    `<attachment kind="${escapeXmlAttribute(attachment.kind)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}" path="${escapeXmlAttribute(attachment.absolutePath)}" project_path="${escapeXmlAttribute(attachment.relativePath)}" size_bytes="${attachment.size}" display_name="${escapeXmlAttribute(attachment.displayName)}" />`
  ))

  return [
    "<kanna-attachments>",
    ...lines,
    "</kanna-attachments>",
  ].join("\n")
}

export function buildPromptText(content: string, attachments: ChatAttachment[]) {
  const attachmentHint = buildAttachmentHintText(attachments)
  if (!attachmentHint) {
    return content.trim()
  }

  const trimmed = content.trim()
  return [
    trimmed || "Please inspect the attached files.",
    attachmentHint,
  ].join("\n\n").trim()
}

/**
 * The user's answers to an AskUserQuestion, as the prompt of a follow-up
 * turn for harnesses that cannot take the answer mid-turn. Answers are keyed
 * by question id when the question has one, else by its text.
 */
export function formatQuestionAnswersFollowUp(questions: AskUserQuestionItem[], result: unknown) {
  const answers = asRecord(asRecord(result)?.answers) ?? {}
  const lines = questions.map((question) => {
    const raw = (question.id ? answers[question.id] : undefined) ?? answers[question.question]
    const picked = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String).filter(Boolean)
    return `- ${question.question}\n  ${picked.length > 0 ? picked.join(", ") : "(no answer)"}`
  })
  return `Here are my answers to your questions:\n\n${lines.join("\n")}`
}

function discardedToolResult(
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
) {
  if (tool.toolKind === "ask_user_question") {
    return {
      discarded: true,
      answers: {},
    }
  }

  return {
    discarded: true,
  }
}

function getClaudeAssistantMessageUsageId(message: any): string | null {
  if (typeof message?.message?.id === "string" && message.message.id) {
    return message.message.id
  }
  if (typeof message?.uuid === "string" && message.uuid) {
    return message.uuid
  }
  return null
}

export function normalizeClaudeStreamMessage(
  message: any,
  options?: {
    /**
     * Ids of earlier tool calls whose kind renders `tool_use_result`
     * (`STRUCTURED_RESULT_TOOL_KINDS`). Only their results keep that field;
     * for every other tool it duplicates `content`.
     */
    structuredToolIds?: ReadonlySet<string>
  }
): TranscriptEntry[] {
  const entries = normalizeClaudeStreamMessageEntries(message, options)
  // Subagent (sidechain) messages arrive on the same iterator as the main
  // thread, told apart only by this id. Stamp it on everything the message
  // produced so readers can fold the subagent's work under its Agent row.
  const parentToolUseId = typeof message?.parent_tool_use_id === "string" && message.parent_tool_use_id
    ? message.parent_tool_use_id
    : undefined
  if (!parentToolUseId) return entries
  return entries.map((entry) => ({ ...entry, parentToolUseId }))
}

function normalizeClaudeStreamMessageEntries(
  message: any,
  options?: { structuredToolIds?: ReadonlySet<string> }
): TranscriptEntry[] {
  // Raw SDK JSON is kept only on system_init, for the raw JSON view. Tool
  // results used to carry it too, so `tool_use_result` could be lifted out
  // later; that copy held every screenshot twice and grew chats past 100 MB
  // on disk. Now the one field is stored on its own, and only where read.
  const messageId = typeof message.uuid === "string" ? message.uuid : undefined

  if (message.type === "system" && message.subtype === "init") {
    return [
      timestamped({
        kind: "system_init",
        messageId,
        provider: "claude",
        model: typeof message.model === "string" ? message.model : "unknown",
        tools: Array.isArray(message.tools) ? message.tools : [],
        agents: Array.isArray(message.agents) ? message.agents : [],
        slashCommands: Array.isArray(message.slash_commands)
          ? message.slash_commands.filter((entry: string) => !entry.startsWith("._"))
          : [],
        mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
        debugRaw: JSON.stringify(message),
      }),
    ]
  }

  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "text" && typeof content.text === "string") {
        entries.push(timestamped({
          kind: "assistant_text",
          messageId,
          text: content.text,
        }))
      }
      if (content.type === "tool_use" && typeof content.name === "string" && typeof content.id === "string") {
        entries.push(timestamped({
          kind: "tool_call",
          messageId,
          tool: normalizeToolCall({
            toolName: content.name,
            toolId: content.id,
            input: (content.input ?? {}) as Record<string, unknown>,
          }),
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        const structured = options?.structuredToolIds?.has(content.tool_use_id)
          ? message.tool_use_result
          : undefined
        entries.push(timestamped({
          kind: "tool_result",
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
          ...(structured !== undefined ? { structuredResult: structured } : {}),
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId })]
    }
    return [
      timestamped({
        kind: "result",
        messageId,
        subtype: message.is_error ? "error" : "success",
        isError: Boolean(message.is_error),
        durationMs: typeof message.duration_ms === "number" ? message.duration_ms : 0,
        result: typeof message.result === "string" ? message.result : stringFromUnknown(message.result),
        costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content })]
  }

  return []
}

function claudeResultPromptIds(message: any): string[] | undefined {
  if (Array.isArray(message.user_message_uuids)) {
    const ids = message.user_message_uuids.filter((id: unknown): id is string => typeof id === "string")
    if (ids.length > 0) return ids
  }
  return typeof message.user_message_uuid === "string" && message.user_message_uuid
    ? [message.user_message_uuid]
    : undefined
}

async function* createClaudeHarnessStream(
  q: Query,
  hooks?: {
    onCommandsChanged?: (commands: SlashCommand[]) => void
    onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
    /** A background task started, reported progress, or ended. */
    onTaskActivity?: (update: SubagentActivityUpdate) => void
  }
): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined
  // The call always streams before its result, so by the time the result
  // arrives this says whether its `tool_use_result` is worth keeping.
  const structuredToolIds = new Set<string>()

  for await (const sdkMessage of q as AsyncIterable<any>) {
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken }
    }

    // Mid-session command/skill list changes are pushed by the SDK; per its
    // docs the payload must REPLACE any cached list (a supportedCommands()
    // re-fetch would return the stale initialize-time list).
    if (sdkMessage?.type === "system" && sdkMessage.subtype === "commands_changed" && Array.isArray(sdkMessage.commands)) {
      hooks?.onCommandsChanged?.(sdkMessage.commands as SlashCommand[])
    }

    // Subscription rate-limit utilization pushed on turns (claude.ai plans).
    if (sdkMessage?.type === "rate_limit_event" && sdkMessage.rate_limit_info) {
      hooks?.onRateLimitEvent?.(sdkMessage.rate_limit_info as ClaudeRateLimitInfoRaw)
    }

    // Task reports are live state, not conversation: they go to the chat's
    // task registry and never into the transcript. A workflow reports every
    // few seconds for as long as it runs.
    if (hooks?.onTaskActivity) {
      const task = normalizeClaudeTaskMessage(sdkMessage)
      if (task) hooks.onTaskActivity(task)
    }

    // Per-step usage lives on the nested API message (`sdkMessage.message.usage`);
    // SDKAssistantMessage has no top-level `usage`. Skip sidechain/subagent
    // messages (`parent_tool_use_id` set) — their usage reflects the subagent's
    // own context window, not the main thread's.
    if (sdkMessage?.type === "assistant" && sdkMessage.parent_tool_use_id == null) {
      const usageId = getClaudeAssistantMessageUsageId(sdkMessage)
      const usageSnapshot = normalizeClaudeUsageSnapshot(
        sdkMessage.message?.usage ?? sdkMessage.usage,
        lastKnownContextWindow,
      )
      if (usageId && usageSnapshot && !seenAssistantUsageIds.has(usageId)) {
        seenAssistantUsageIds.add(usageId)
        latestUsageSnapshot = usageSnapshot
        yield {
          type: "transcript",
          entry: timestamped({
            kind: "context_window_updated",
            usage: usageSnapshot,
          }),
        }
      }
    }

    if (sdkMessage?.type === "result") {
      const resultContextWindow = maxClaudeContextWindowFromModelUsage(sdkMessage.modelUsage)
      if (resultContextWindow !== undefined) {
        lastKnownContextWindow = resultContextWindow
      }

      // The result message's `usage` is *cumulative* across every step of the
      // query() call (each step re-counts the whole cached context), so it is
      // never the current context length. Only surface it as
      // `totalProcessedTokens`.
      const accumulatedUsage = normalizeClaudeUsageSnapshot(
        sdkMessage.usage,
        resultContextWindow ?? lastKnownContextWindow,
      )

      // Exact /context parity: ask the CLI for the authoritative breakdown of
      // the current context window. Falls back to the last main-thread
      // per-step snapshot when the control request is unavailable (old CLI,
      // closed transport, timeout).
      const contextUsage = normalizeClaudeContextUsage(
        await Promise.race([
          q.getContextUsage().catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]),
      )

      const baseUsage: ContextWindowUsageSnapshot | null = contextUsage
        ? {
            ...(latestUsageSnapshot ?? { compactsAutomatically: false }),
            usedTokens: contextUsage.usedTokens,
            ...(contextUsage.maxTokens !== undefined ? { maxTokens: contextUsage.maxTokens } : {}),
          }
        : latestUsageSnapshot

      const finalUsage = baseUsage
        ? {
            ...baseUsage,
            ...(baseUsage.maxTokens === undefined
              && typeof (resultContextWindow ?? lastKnownContextWindow) === "number"
              ? { maxTokens: resultContextWindow ?? lastKnownContextWindow }
              : {}),
            ...(accumulatedUsage && accumulatedUsage.usedTokens > baseUsage.usedTokens
              ? { totalProcessedTokens: accumulatedUsage.usedTokens }
              : {}),
          }
        : null

      if (finalUsage) {
        yield {
          type: "transcript",
          entry: timestamped({
            kind: "context_window_updated",
            usage: finalUsage,
          }),
        }
      }

      seenAssistantUsageIds = new Set<string>()
      latestUsageSnapshot = null
    }

    const promptIds = sdkMessage?.type === "result" ? claudeResultPromptIds(sdkMessage) : undefined
    for (const entry of normalizeClaudeStreamMessage(sdkMessage, { structuredToolIds })) {
      if (entry.kind === "tool_call" && STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) {
        structuredToolIds.add(entry.tool.toolId)
      }
      yield promptIds ? { type: "transcript", entry, promptIds } : { type: "transcript", entry }
    }
  }
}

/**
 * SDK hooks that back up the task stream (see background-tasks.ts).
 *
 * The stream announces every task as it starts and ends. The hooks are the
 * safety net for an end that never lands. `SubagentStop` closes a Task
 * subagent. `Stop` fires when the main agent stops and carries
 * `background_tasks`, the work still registered on the session. That is the
 * sweep: whatever it doesn't name has ended, however it ended.
 *
 * There is no `SubagentStart`: `task_started` announces the same agent under
 * the same id, with its tool call. The hook also fires for every agent a
 * workflow runs, which belong on the workflow's card, not as rows of their own.
 *
 * Every hook returns `{}`: these observe, they never block or steer the model.
 */
function subagentHooks(
  onActivity: (update: SubagentActivityUpdate) => void
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const one = (hook: HookCallback): HookCallbackMatcher[] => [{ hooks: [hook] }]

  const sweep = (input: { background_tasks?: BackgroundTaskSummary[] }) => {
    onActivity({
      kind: "inFlight",
      ids: (input.background_tasks ?? []).map((task) => ({
        id: task.id,
        type: task.type,
        label: task.agent_type || task.name || task.command || task.description || task.type,
      })),
    })
  }

  return {
    SubagentStop: one(async (input) => {
      if (input.hook_event_name !== "SubagentStop") return {}
      onActivity({ kind: "stopped", id: input.agent_id, failed: false })
      return {}
    }),
    Stop: one(async (input) => {
      if (input.hook_event_name !== "Stop") return {}
      sweep(input)
      return {}
    }),
  }
}

async function startClaudeSession(args: {
  /** The platform to resolve `claude` and read the environment through. */
  platform: Context.Context<PlatformServices>
  localPath: string
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  /** The chat is a delegator, which its system prompt says. See `ChatRecord.delegator`. */
  delegator?: boolean
  sessionToken: string | null
  forkSession: boolean
  /**
   * With `forkSession`: the source session's last message the fork keeps
   * (`ChatRecord.pendingForkAt`). Without it the SDK copies the whole session
   * as it is now, turns the source ran since the fork was made included.
   */
  resumeSessionAt?: string
  customTools?: KannaToolHost
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
  /**
   * Delegated work starting, progressing, finishing, or — on Stop — the
   * authoritative list of what is still in flight. Driven by the task stream
   * (background-tasks.ts) and SDK hooks (`subagentHooks`).
   */
  onSubagentActivity?: (update: SubagentActivityUpdate) => void
  signal?: AbortSignal
}): Promise<ClaudeSessionHandle> {
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      return {
        behavior: "allow",
        updatedInput: input,
      }
    }

    const tool = normalizeToolCall({
      toolName,
      toolId: options.toolUseID,
      input: (input ?? {}) as Record<string, unknown>,
    })

    if (tool.toolKind !== "ask_user_question" && tool.toolKind !== "exit_plan_mode") {
      return {
        behavior: "deny",
        message: "Unsupported tool request",
      }
    }

    const result = await args.onToolRequest({ tool })

    if (tool.toolKind === "ask_user_question") {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          questions: record.questions ?? tool.input.questions,
          answers: record.answers ?? result,
        },
      } satisfies PermissionResult
    }

    const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const confirmed = Boolean(record.confirmed)
    if (confirmed) {
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          ...record,
        },
      } satisfies PermissionResult
    }

    return {
      behavior: "deny",
      message: typeof record.message === "string"
        ? `User wants to suggest edits to the plan: ${record.message}`
        : "User wants to suggest edits to the plan before approving.",
    } satisfies PermissionResult
  }

  // The user's own `claude`, never the SDK's pinned copy (claude-executable.ts).
  const claudeExecutable = await runKanna(resolveClaudeExecutable().pipe(Effect.provide(args.platform)))
  const machine = Context.get(args.platform, Machine)
  if (args.signal?.aborted) throw new Error("Claude session startup was interrupted")
  if (!claudeExecutable.ok) throw new Error(claudeExecutable.message)
  const promptQueue = runKannaSync(Queue.unbounded<SDKUserMessage, Cause.Done>())
  let promptQueueClosed = false

  const q = query({
    prompt: Stream.toAsyncIterable(Stream.fromQueue(promptQueue)),
    options: {
      cwd: args.localPath,
      model: args.model,
      effort: args.effort as "low" | "medium" | "high" | "max" | undefined,
      resume: args.sessionToken ?? undefined,
      forkSession: args.forkSession,
      ...(args.forkSession && args.resumeSessionAt ? { resumeSessionAt: args.resumeSessionAt } : {}),
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,
      ...(args.customTools ? {
        mcpServers: { kanna: createClaudeKannaTools(args.customTools) },
      } : {}),
      tools: claudeToolset(args.autoPlan),
      ...(args.onSubagentActivity ? { hooks: subagentHooks(args.onSubagentActivity) } : {}),
      // By default the SDK forwards only a subagent's tool calls. Its text
      // (what it is doing, and its final report) completes the nested view
      // under the Agent row; the normalizer stamps it with parent_tool_use_id
      // like the rest.
      forwardSubagentText: true,
      settingSources: ["user", "project", "local"],
      // Append-only: the claude_code preset stays intact, Kanna's session
      // instructions ride on the end of it (see harness-instructions.ts).
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildKannaSystemInstructions(buildKannaAgentId("claude", args.model), { delegator: args.delegator }),
      },
      // fastMode must go through the flag-settings layer: the CLI only allows
      // fast mode in Agent SDK sessions when flagSettings.fastMode is true,
      // and an explicit false keeps a user-level settings.json from silently
      // enabling it while the UI shows "Standard".
      settings: { enableWorkflows: true, fastMode: args.serviceTier === "fast" },
      pathToClaudeCodeExecutable: claudeExecutable.path,
      env: (() => { const { CLAUDECODE: _, ...env } = machine.env.snapshot(); return env })(),
      // The SDK spawns `claude` itself, on this computer. A binding whose
      // machine is elsewhere would hand it `spawnClaudeCodeProcess`, backed by
      // that machine's `ProcessSpawner`.
    },
  })
  if (args.signal?.aborted) {
    q.close()
    throw new Error("Claude session startup was interrupted")
  }

  // Latest command list pushed via system/commands_changed; null until the
  // first push. supportedCommands() below prefers this over a q re-fetch.
  const commandsRef: { current: SlashCommand[] | null } = { current: null }

  return {
    provider: "claude",
    // A readable version passed the minimum-version gate, and every CLI from
    // that version on echoes prompt ids. An override wrapper reports none.
    echoesPromptIds: claudeExecutable.version !== null,
    stream: createClaudeHarnessStream(q, {
      onCommandsChanged: (commands) => {
        commandsRef.current = commands
      },
      onRateLimitEvent: args.onRateLimitEvent,
      onTaskActivity: args.onSubagentActivity,
    }),
    getAccountInfo: async () => {
      try {
        return await q.accountInfo()
      } catch {
        return null
      }
    },
    getUsage: async () => {
      try {
        const anyQ = q as unknown as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<ClaudeUsageRaw>
        }
        if (typeof anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") {
          return null
        }
        return await Promise.race([
          anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
        ])
      } catch {
        return null
      }
    },
    interrupt: async () => {
      await q.interrupt()
    },
    stopTask: async (taskId: string) => {
      await q.stopTask(taskId)
    },
    sendPrompt: async (content: string, promptId?: string) => {
      if (promptQueueClosed) {
        throw new Error("Cannot push to a closed queue")
      }
      Queue.offerUnsafe(promptQueue, {
        type: "user",
        message: {
          role: "user",
          content,
        },
        parent_tool_use_id: null,
        session_id: args.sessionToken ?? "",
        ...(promptId ? { uuid: promptId as SDKUserMessage["uuid"] } : {}),
      })
    },
    setModel: async (model: string) => {
      await q.setModel(model)
    },
    setPermissionMode: async (planMode: boolean) => {
      await q.setPermissionMode(planMode ? "plan" : "acceptEdits")
    },
    setFastMode: async (fastMode: boolean) => {
      await q.applyFlagSettings({ fastMode })
    },
    supportedModels: async () => await q.supportedModels(),
    supportedCommands: async () => commandsRef.current ?? await q.supportedCommands(),
    close: () => {
      promptQueueClosed = true
      Queue.endUnsafe(promptQueue)
      q.close()
    },
  }
}

export class AgentCoordinator {
  private readonly store: EventStore["Service"]
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly analytics: Analytics["Service"]
  private readonly codexManager: CodexAppServer["Service"]
  private readonly cursorManager: CursorCli["Service"]
  private readonly grokManager: GrokCli["Service"]
  private readonly piManager: PiAgentManager
  private readonly platform: Context.Context<PlatformServices>
  private readonly machine: Machine["Service"]
  private readonly ownsPiManager: boolean
  private readonly resolvePiConnectionEffect: () => Effect.Effect<import("./pi-agent").PiConnection | null, Error>
  private readonly generateTitleEffect: (messageContent: string, cwd: string) => Effect.Effect<GenerateChatTitleResult, Error>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly checkSessionArtifactEffect: (
    provider: AgentProvider,
    query: { cwd: string; sessionToken: string | null | undefined },
  ) => Effect.Effect<SessionArtifactStatus, Error>
  private reportBackgroundError: ((message: string) => void) | null = null
  private onClaudeRateLimit: ((info: ClaudeRateLimitInfoRaw) => void) | null = null
  private cursorModelCatalogApplied = false
  private grokModelCatalogApplied = false
  private codexModelCatalogRefresh: { fiber: Fiber.Fiber<void, never> | null } | null = null
  private readonly backgroundTasks = new Set<{ fiber: Fiber.Fiber<unknown, unknown> | null }>()
  readonly activeTurns = new Map<string, ActiveTurn>()
  readonly drainingStreams = new Map<string, { turn: ManagedHarnessTurn<unknown, unknown, unknown> }>()
  /**
   * Delegated work per chat, keyed by the provider's agent id: a log that
   * runs across turns. Finished entries stay, so the widgets can say what ran
   * whether its turn is going or over, until newer ones push them out
   * (`pruneTaskLog`). In memory only: a restart starts it empty.
   */
  private readonly subagents = new Map<string, Map<string, SubagentActivity>>()
  /**
   * Tasks the CLI called housekeeping when they started, per chat. The Stop
   * sweep lists them with everything else and can't say which they are, so
   * without this it would surface them as work.
   */
  private readonly ambientTaskIds = new Map<string, Set<string>>()
  /**
   * Foreground shells per chat, held back from the log with the time they
   * started, so one moved to the background gets its row from its real start.
   * Each leaves at its end, or at the Stop sweep, when no foreground step can
   * still be running.
   */
  private readonly foregroundTasks = new Map<string, Map<string, { task: TaskStart; startedAt: number }>>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()
  /**
   * Chats with a turn on its way: a start in progress, a queue drain, a steer
   * between its cancel and its new turn. `activeTurns` has a gap at each of
   * those, and a chat read as idle inside one would be reported finished.
   */
  private readonly startingTurns = new Map<string, number>()
  private shuttingDown = false
  /**
   * Chats, schedules and the links between them. Set after construction,
   * because the orchestrator is built on top of this coordinator.
   */
  private orchestrationService: Orchestrator["Service"] | null = null

  get orchestration(): Orchestrator["Service"] | null {
    return this.orchestrationService
  }

  /** Native service in server composition; old test fixtures expose it as `.service`. */
  set orchestration(value: Orchestrator["Service"] | { readonly service: Orchestrator["Service"] } | null) {
    this.orchestrationService = value && "service" in value ? value.service : value
  }

  /**
   * Fired when a chat has no turn left to run: its turn ended and nothing
   * queued started another. Not fired for a steer or a shutdown, where the
   * turn that ended is about to be replaced.
   */
  onChatSettled?: (chatId: string) => void
  /** Fired when someone stops a chat on purpose, as against a steer or a shutdown. */
  onChatStopped?: (chatId: string) => void

  constructor(args: AgentCoordinatorArgs) {
    this.store = "service" in args.store ? args.store.service : args.store
    this.onStateChange = args.onStateChange
    this.analytics = args.analytics ?? NoopAnalytics
    this.platform = args.platform
    this.codexManager = args.codexManager ?? createCodexAppServer(args.platform)
    this.codexManager.setTaskActivityListener((chatId, update) => this.applySubagentActivity(chatId, update))
    this.cursorManager = args.cursorManager ?? runKannaSync(makeCursorCli().pipe(Effect.provide(args.platform)))
    this.grokManager = args.grokManager ?? runKannaSync(makeGrokCli().pipe(Effect.provide(args.platform)))
    this.ownsPiManager = args.piManager === undefined
    this.machine = args.machine ?? Context.get(args.platform, Machine)
    this.piManager = args.piManager ?? new PiAgentManager({ dataDir: piDataDir(this.machine.homeDirectory) })
    this.resolvePiConnectionEffect = args.resolvePiConnection
      ? () => Effect.tryPromise({
        try: () => args.resolvePiConnection!(),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      })
      : () => resolvePiConnection().pipe(Effect.provide(args.platform))
    const quickResponse = args.quickResponse
    this.generateTitleEffect = args.generateTitle
      ? (messageContent, cwd) => Effect.tryPromise({
        try: () => args.generateTitle!(messageContent, cwd),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      })
      : (quickResponse
        ? (messageContent, cwd) => generateTitleForChatDetailed(messageContent, cwd).pipe(
          Effect.provideService(QuickResponse, quickResponse),
        )
        : (messageContent, cwd) => withSharedQuickResponse(args.platform, generateTitleForChatDetailed(messageContent, cwd)))
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.checkSessionArtifactEffect = args.checkSessionArtifact
      ? (provider, query) => Effect.tryPromise({
        try: () => Promise.resolve(args.checkSessionArtifact!(provider, query)),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      })
      : (provider, query) => checkSessionArtifact(provider, query).pipe(Effect.provide(args.platform))
  }

  private forkBackground<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
    const task: { fiber: Fiber.Fiber<unknown, unknown> | null } = { fiber: null }
    this.backgroundTasks.add(task)
    task.fiber = Effect.runFork(effect.pipe(
      Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("agent background task failed", { cause })),
      Effect.ensuring(Effect.sync(() => { this.backgroundTasks.delete(task) })),
    ))
    return task.fiber as Fiber.Fiber<A, E>
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }

  /** Register a sink for pushed Claude rate-limit events (usage page). */
  setClaudeRateLimitListener(listener: ((info: ClaudeRateLimitInfoRaw) => void) | null) {
    this.onClaudeRateLimit = listener
  }

  /**
   * Read Claude subscription usage on demand. Reuses a live session's query
   * when one exists; otherwise spawns a short-lived probe. Returns null when
   * unavailable (no method / timeout / not a subscription session).
   */
  async fetchClaudeUsage(): Promise<ClaudeUsageRaw | null> {
    for (const state of this.claudeSessions.values()) {
      if (state.session.usage) {
        const usage = await runKanna(state.session.usage)
        if (usage) return usage
      }
    }
    let probe: ClaudeSessionHandle | null = null
    try {
      probe = await this.startClaudeSessionFn({
        platform: this.platform,
        localPath: this.machine.homeDirectory,
        // Model choice is irrelevant for the usage read; use the catalog default.
        model: "sonnet",
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        forkSession: false,
        onToolRequest: async () => ({}),
      })
      return (await probe.getUsage?.()) ?? null
    } catch {
      return null
    } finally {
      probe?.close()
    }
  }

  /** Read Codex account rate limits on demand (reuses a live app-server or probes). */
  fetchCodexRateLimitsEffect = Effect.fn("Agent.fetchCodexRateLimits")(() =>
    this.codexManager.readAccountRateLimits(this.machine.homeDirectory))

  /** Compatibility for callers that have not moved to Effect yet. */
  fetchCodexRateLimits() {
    return runKanna(this.fetchCodexRateLimitsEffect())
  }

  refreshGrokModelCatalogEffect = Effect.fn("Agent.refreshGrokModelCatalog")(() => {
    const self = this
    return Effect.gen(function* () {
      if (self.grokModelCatalogApplied) return
      const result = yield* Effect.exit(Effect.suspend(() => self.grokManager.listModels()))
      if (Exit.isFailure(result)) return // Grok missing or signed out; keep the static catalog.
      self.grokModelCatalogApplied = true
      if (applyGrokModels(result.value)) self.emitStateChange(undefined, { immediate: true })
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  refreshGrokModelCatalog(): Promise<void> {
    return runKanna(this.refreshGrokModelCatalogEffect())
  }

  getCodexManager() {
    return this.codexManager
  }

  getResourceCountsEffect = Effect.fn("Agent.getResourceCounts")(() =>
    this.codexManager.resourceCounts.pipe(Effect.map((codex) => ({
      activeTurns: this.activeTurns.size,
      drainingStreams: this.drainingStreams.size,
      claudeSessions: this.claudeSessions.size,
      ...codex,
      ...this.piManager.getResourceCounts(),
    }))))

  /** Compatibility for synchronous diagnostics callers. */
  getResourceCounts() {
    return runKannaSync(this.getResourceCountsEffect())
  }

  disposeEffect = Effect.fn("Agent.dispose")(() => {
    const self = this
    return Effect.gen(function* () {
      yield* Effect.forEach([...self.backgroundTasks], (task) =>
        task.fiber ? Fiber.interrupt(task.fiber) : Effect.void, { discard: true })
      const sessions = [...self.claudeSessions.values()]
      const streams = [...self.drainingStreams.values()]
      self.claudeSessions.clear()
      self.drainingStreams.clear()
      if (self.ownsPiManager) self.piManager.dispose()
      yield* Effect.forEach(sessions, (session) => session.session.close, { discard: true })
      yield* Effect.forEach(streams, (stream) => stream.turn.close, { discard: true })
      yield* self.codexManager.stopAll
    })
  })

  /** Compatibility for synchronous server teardown and older tests. */
  /** Closes every session; the Promise settles once they are closed. */
  dispose(): Promise<void> {
    return runKanna(this.disposeEffect())
  }

  getActiveStatuses() {
    const statuses = new Map<string, KannaStatus>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  /**
   * What the sidebar and the chat page show: the turns in flight, plus every
   * chat whose own turn has ended while work it handed off is still going.
   *
   * Read off the task log, but not every running row there counts: a chat is
   * waiting on work it gave another agent (`hasDelegatedWork`), not on a
   * shell or a monitor it left running, which the Tasks widget still lists.
   */
  getChatStatuses() {
    const statuses = this.getActiveStatuses()
    for (const [chatId, byId] of this.subagents) {
      if (statuses.has(chatId)) continue
      for (const activity of byId.values()) {
        if (activity.status !== "running" || !isDelegatedTask(activity.type)) continue
        statuses.set(chatId, "waiting_on_subagent")
        break
      }
    }
    // What only the coordinator knows to be going. The orchestrator adds the
    // rest (queues, reports on their way) and finds the chats above them.
    const unsettled = new Set([...this.activeTurns.keys(), ...this.startingTurns.keys(), ...this.drainingStreams.keys()])
    for (const chatId of this.subagents.keys()) {
      if (this.hasDelegatedWork(chatId)) unsettled.add(chatId)
    }
    for (const chatId of this.orchestration?.getChatsWaitingOnSubchats(unsettled) ?? []) {
      if (!statuses.has(chatId)) statuses.set(chatId, "waiting_on_subagent")
    }
    return statuses
  }

  /**
   * What a chat that reads `waiting_on_subagent` is waiting on, by the two
   * checks `getChatStatuses` makes. Meaningful only for such a chat.
   *
   * An agent running inside a workflow that is itself running is that
   * workflow's, and is not counted beside it: the Tasks widget gives it no
   * row of its own either.
   */
  getWaitingOn(chatId: string): WaitingOn {
    const byId = this.subagents.get(chatId)
    let agents = 0
    for (const activity of byId?.values() ?? []) {
      if (activity.status !== "running" || !isDelegatedTask(activity.type)) continue
      if (activity.workflowId && byId?.get(activity.workflowId)?.status === "running") continue
      agents += 1
    }
    return { chats: this.orchestration?.countSubchatsHolding(chatId) ?? 0, agents }
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return {
      toolUseId: pending.toolUseId,
      toolKind: pending.tool.toolKind,
      preview: getToolRequestPreview(pending.tool),
    }
  }

  getDrainingChatIds(): Set<string> {
    return new Set(this.drainingStreams.keys())
  }

  /** Delegated work for a chat, oldest first. Empty when it has spawned none. */
  getSubagents(chatId: string): SubagentActivity[] {
    const native = [...(this.subagents.get(chatId)?.values() ?? [])]
    // Sub-chats are derived from the store on each read rather than kept in
    // the registry: its sweeps close anything the provider does not name, and
    // a sub-chat outlives the turn that started it.
    const chats = this.orchestration?.getChildActivities(chatId) ?? []
    return [...native, ...chats].sort((a, b) => a.startedAt - b.startedAt)
  }

  /** A turn is running or about to. See `startingTurns`. */
  isBusy(chatId: string) {
    return this.activeTurns.has(chatId) || this.startingTurns.has(chatId)
  }

  /** A turn gave its result and its stream is still open. */
  isDraining(chatId: string) {
    return this.drainingStreams.has(chatId)
  }

  /**
   * Work the chat handed to another agent of its provider's is still going: a
   * subagent, a workflow, a Codex agent. This is what the chat is waiting on
   * once its own turn is over (`isDelegatedTask`).
   */
  hasDelegatedWork(chatId: string) {
    for (const activity of this.subagents.get(chatId)?.values() ?? []) {
      if (activity.status === "running" && isDelegatedTask(activity.type)) return true
    }
    return false
  }

  /**
   * The kinds of task still running here that the chat is not waiting on: a
   * shell, a monitor. The other half of the task log from `hasDelegatedWork`,
   * and for a different question. A chat with only these is at rest, but any
   * of them can start another turn in it (a shell by ending, a monitor each
   * time it fires), and that turn is still one its parent is owed.
   */
  getLeftRunning(chatId: string) {
    const types = new Set<string>()
    for (const activity of this.subagents.get(chatId)?.values() ?? []) {
      if (activity.status === "running" && !isDelegatedTask(activity.type)) types.add(activity.type)
    }
    return [...types]
  }

  /** Whether the chat is read-only right now. */
  isPlanning(chatId: string) {
    const active = this.activeTurns.get(chatId)
    if (active) return active.planMode && !active.planExited
    return Boolean(this.store.getChat(chatId)?.planMode)
  }

  private markStarting(chatId: string) {
    this.startingTurns.set(chatId, (this.startingTurns.get(chatId) ?? 0) + 1)
  }

  private unmarkStarting(chatId: string) {
    const count = (this.startingTurns.get(chatId) ?? 1) - 1
    if (count > 0) this.startingTurns.set(chatId, count)
    else this.startingTurns.delete(chatId)
  }

  private notifySettled(chatId: string) {
    if (this.shuttingDown || this.isBusy(chatId)) return
    this.onChatSettled?.(chatId)
  }

  /**
   * Fold one hook report into the registry.
   *
   * `inFlight` is a sweep, not an increment: anything running that the sweep
   * does not name has ended without its stop hook landing, so it is closed
   * here. That is what keeps a crashed or killed agent from pinning the chat
   * in "waiting" forever.
   */
  applySubagentActivity(chatId: string, update: SubagentActivityUpdate, now = Date.now()) {
    if (update.kind === "ambient") {
      let ambient = this.ambientTaskIds.get(chatId)
      if (!ambient) {
        ambient = new Set()
        this.ambientTaskIds.set(chatId, ambient)
      }
      ambient.add(update.id)
      return
    }
    if (update.kind === "foreground") {
      let held = this.foregroundTasks.get(chatId)
      if (!held) {
        held = new Map()
        this.foregroundTasks.set(chatId, held)
      }
      held.set(update.task.id, { task: update.task, startedAt: now })
      return
    }
    if (update.kind === "backgrounded") {
      const held = this.foregroundTasks.get(chatId)?.get(update.id)
      if (!held) return
      this.foregroundTasks.get(chatId)?.delete(update.id)
      this.applySubagentActivity(chatId, { kind: "started", ...held.task }, held.startedAt)
      return
    }
    if (update.kind === "stopped") this.foregroundTasks.get(chatId)?.delete(update.id)
    if (update.kind === "inFlight") this.foregroundTasks.delete(chatId)

    let byId = this.subagents.get(chatId)
    if (!byId) {
      byId = new Map()
      this.subagents.set(chatId, byId)
    }

    if (update.kind === "started") {
      const existing = byId.get(update.id)
      const next: SubagentActivity = {
        id: update.id,
        type: update.type,
        label: update.label,
        status: "running",
        // The Stop sweep can list a task before its start event lands, and
        // it started when the sweep first saw it, not now.
        startedAt: existing?.status === "running" ? existing.startedAt : now,
        ...(update.toolUseId ? { toolUseId: update.toolUseId } : {}),
        ...(update.description ? { description: update.description } : {}),
        ...(update.stoppable ? { stoppable: true } : {}),
        ...(update.type === "workflow"
          ? { workflow: { ...(update.workflowName ? { name: update.workflowName } : {}), phases: [], agents: [] } }
          : {}),
      }
      const workflowId = findWorkflowOf(byId, update.id)
      if (workflowId) next.workflowId = workflowId
      byId.set(update.id, next)
    } else if (update.kind === "progress") {
      let existing = byId.get(update.id)
      // A workflow already running when the session (re)attached reports
      // progress with no start before it. Its progress says what it is.
      if (!existing && update.workflow) {
        existing = { id: update.id, type: "workflow", label: "Workflow", status: "running", startedAt: now, stoppable: true }
      }
      if (!existing || existing.status !== "running") return
      const next: SubagentActivity = { ...existing }
      if (update.usage) next.usage = update.usage
      if (update.summary) next.summary = update.summary
      if (update.workflow) {
        next.workflow = { ...(existing.workflow?.name ? { name: existing.workflow.name } : {}), ...update.workflow }
        linkWorkflowAgents(byId, update.id, update.workflow.agents)
      }
      byId.set(update.id, next)
    } else if (update.kind === "stopped") {
      const existing = byId.get(update.id)
      if (!existing) return
      const reported = {
        ...(update.usage ? { usage: update.usage } : {}),
        ...(update.summary ? { summary: update.summary } : {}),
      }
      if (existing.status !== "running") {
        // Two reports can end one task (task_updated, then the notification
        // with its totals), or the sweep can close it first. The outcome and
        // time already stand; the totals are still worth having.
        if (!update.usage && !update.summary) return
        byId.set(update.id, { ...existing, ...reported })
      } else {
        const status = update.stopped ? "stopped" : update.failed ? "failed" : "completed"
        byId.set(update.id, finishActivity({ ...existing, ...reported }, status, now))
      }
    } else {
      const named = new Set(update.ids.map((task) => task.id))
      const ambient = this.ambientTaskIds.get(chatId)
      for (const task of update.ids) {
        if (ambient?.has(task.id)) continue
        const existing = byId.get(task.id)
        // The sweep also *discovers* work whose start event never reached
        // us, so Stop is the first we hear of it.
        if (!existing) {
          byId.set(task.id, { id: task.id, type: task.type, label: task.label, status: "running", startedAt: now })
        } else if (existing.status !== "running") {
          byId.set(task.id, { ...existing, status: "running", endedAt: undefined })
        }
      }
      for (const [id, activity] of byId) {
        if (activity.status === "running" && !named.has(id)) {
          byId.set(id, finishActivity(activity, "completed", now))
        }
      }
    }

    pruneTaskLog(byId)
    this.emitStateChange(chatId)
    // Outside a turn there is no turn start to tell the chats above this one
    // that it is back at work.
    if (update.kind === "started" && !this.isBusy(chatId) && this.orchestration) {
      runKannaSync(this.orchestration.handleBackgroundWorkStarted(chatId))
    }
    // A chat whose turn ended with background work still going is finished
    // only now, and no turn end is coming to say so.
    if (update.kind === "stopped" || update.kind === "inFlight") this.notifySettled(chatId)
  }

  /**
   * Stops one background task without cancelling the turn: the Stop in a
   * Tasks row's menu, or on a workflow's card. The CLI answers with the
   * task's end, reported as `stopped`, which is what updates the row.
   */
  stopBackgroundTaskEffect(chatId: string, taskId: string) {
    const self = this
    return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const orchestration = self.orchestration
    if (orchestration && (yield* orchestration.stopChildTask(chatId, taskId))) return
    const task = self.subagents.get(chatId)?.get(taskId)
    if (!task || task.status !== "running") return
    if (task.stoppable && self.store.getChat(chatId)?.provider === "codex") {
      // Codex does not tell a turn that the agent it is waiting on was
      // stopped: its wait runs out after two minutes and it waits again. So
      // an agent is stopped on its own only once the chat's turn is over.
      if (self.isBusy(chatId)) {
        return yield* Effect.fail(new Error("This chat's turn is still using this agent. Stop the chat to end both."))
      }
      // A Codex agent is a thread with a turn of its own to interrupt.
      if (yield* self.codexManager.stopAgent(chatId, taskId)) return
    }
    const stopTask = self.claudeSessions.get(chatId)?.session.stopTask
    if (!task.stoppable || !stopTask) {
      return yield* Effect.fail(new Error("This task can't be stopped on its own. Stop the chat to end it."))
    }
    yield* stopTask(taskId)
    }).pipe(Effect.withSpan("Agent.stopBackgroundTask"))
  }

  /** Compatibility for callers that have not moved to Effect yet. */
  stopBackgroundTask(chatId: string, taskId: string): Promise<void> {
    return runKanna(this.stopBackgroundTaskEffect(chatId, taskId))
  }

  /**
   * Derive delegated work from the transcript, for providers that report it
   * nowhere else (Grok, which normalizes its spawn call to `subagent_task`).
   * Weaker than a task stream: a subagent is "running" from its tool call
   * until its tool result, which is all such a provider reports.
   *
   * Claude and Codex are deliberately excluded. Each reports its tasks itself
   * (Claude's hooks and task stream, Codex's agent threads) under ids that are
   * not the tool call's, so running both would list every agent twice. And a
   * Codex `wait` or `closeAgent` is a `subagent_task` call that is no agent.
   */
  private trackSubagentFromEntry(chatId: string, provider: AgentProvider, entry: TranscriptEntry) {
    if (!tracksSubagentsFromTranscript(provider)) return
    if (entry.kind === "tool_call" && entry.tool.toolKind === "subagent_task") {
      const input = entry.tool.input as { subagentType?: unknown; description?: unknown }
      const label = typeof input.subagentType === "string" && input.subagentType
        ? input.subagentType
        : typeof input.description === "string" && input.description
          ? input.description
          : "Agent"
      this.applySubagentActivity(chatId, { kind: "started", id: entry.tool.toolId, type: "subagent", label })
      return
    }
    if (entry.kind === "tool_result" && this.subagents.get(chatId)?.has(entry.toolId)) {
      this.applySubagentActivity(chatId, { kind: "stopped", id: entry.toolId, failed: Boolean(entry.isError) })
    }
  }

  /**
   * Close everything still marked running, as failed: it was cut off, not
   * finished. For when the turn ends without the Stop hook's sweep — an
   * interrupt, or a Claude session that died — which would otherwise leave
   * the chat showing agents running forever.
   */
  private closeRunningSubagents(chatId: string, now = Date.now()) {
    const byId = this.subagents.get(chatId)
    if (!byId) return
    let changed = false
    for (const [id, activity] of byId) {
      if (activity.status !== "running") continue
      byId.set(id, finishActivity(activity, "failed", now))
      changed = true
    }
    if (changed) this.emitStateChange(chatId)
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  private refreshClaudeModelCatalog(session: ClaudeSessionHandle) {
    if (!session.supportedModels) return
    void session.supportedModels()
      .then((models) => {
        if (applyClaudeSdkModels(models)) {
          this.emitStateChange(undefined, { immediate: true })
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.reportBackgroundError?.(`[claude-models] failed to refresh Claude model catalog: ${message}`)
      })
  }

  /**
   * Overlay the account's live Cursor model list (`cursor-agent --list-models`)
   * on the catalog — the Cursor analog of refreshClaudeModelCatalog. Runs at
   * server startup and retries on cursor turns until one fetch succeeds (e.g.
   * the user logs in to cursor-agent while the server is running). Failure is
   * expected — cursor-agent missing or logged out — so it stays quiet and the
   * static catalog remains in place.
   */
  refreshCursorModelCatalogEffect = Effect.fn("Agent.refreshCursorModelCatalog")(() => {
    const self = this
    return Effect.gen(function* () {
      if (self.cursorModelCatalogApplied) return
      const result = yield* Effect.exit(Effect.suspend(() => self.cursorManager.listModels()))
      if (Exit.isFailure(result)) return // Keep the static catalog; the next cursor turn retries.
      self.cursorModelCatalogApplied = true
      if (applyCursorModels(result.value)) self.emitStateChange(undefined, { immediate: true })
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  refreshCursorModelCatalog(): Promise<void> {
    return runKanna(this.refreshCursorModelCatalogEffect())
  }

  /**
   * Overlay the account's live Codex model list (app-server `model/list`) on
   * the catalog — the Codex analog of refreshCursorModelCatalog. Unlike the
   * Cursor one this runs on every codex turn, not once: OpenAI adds models to
   * an account without a codex upgrade, and the turn's own app-server process
   * answers the request, so the repeat costs no extra spawn. Startup and
   * sign-in go through a short-lived probe. Failure is expected — codex
   * missing, signed out, or too old for model/list — so it stays quiet and
   * the static catalog remains in place. Concurrent callers share one fetch.
   */
  refreshCodexModelCatalogEffect = Effect.fn("Agent.refreshCodexModelCatalog")(() => {
    const self = this
    return Effect.gen(function* () {
      let refresh = self.codexModelCatalogRefresh
      if (!refresh) {
        refresh = { fiber: null }
        self.codexModelCatalogRefresh = refresh
        const current = refresh
        refresh.fiber = self.forkBackground(Effect.gen(function* () {
          const result = yield* Effect.exit(self.codexManager.listModels(self.machine.homeDirectory))
          if (Exit.isSuccess(result) && result.value && applyCodexModels(result.value)) {
            self.emitStateChange(undefined, { immediate: true })
          }
          // A missing or signed-out Codex CLI leaves the static catalog in place.
        }).pipe(Effect.ensuring(Effect.sync(() => {
          if (self.codexModelCatalogRefresh === current) self.codexModelCatalogRefresh = null
        }))))
      }
      if (refresh.fiber) yield* Fiber.await(refresh.fiber)
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  refreshCodexModelCatalog(): Promise<void> {
    return runKanna(this.refreshCodexModelCatalogEffect())
  }


  stopDrainingEffect(chatId: string) {
    const self = this
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      const draining = self.drainingStreams.get(chatId)
      if (!draining) return
      yield* draining.turn.close
      self.drainingStreams.delete(chatId)
      self.emitStateChange(chatId)
    }).pipe(Effect.withSpan("Agent.stopDraining"))
  }

  /** Compatibility for callers that have not moved to Effect yet. */
  stopDraining(chatId: string): Promise<void> {
    return runKanna(this.stopDrainingEffect(chatId))
  }

  closeChatEffect(chatId: string) {
    const self = this
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* self.stopDrainingEffect(chatId)
      const claudeSession = self.claudeSessions.get(chatId)
      if (claudeSession) {
        yield* claudeSession.session.close
        self.claudeSessions.delete(chatId)
      }
      self.forkBackground(self.codexManager.stopSession(chatId))
      self.piManager.closeChat(chatId)
      self.emitStateChange(chatId)
    }).pipe(Effect.withSpan("Agent.closeChat"))
  }

  /** Compatibility for callers that have not moved to Effect yet. */
  closeChat(chatId: string): Promise<void> {
    return runKanna(this.closeChatEffect(chatId))
  }

  /**
   * An explicit provider on the message wins — sending with a different
   * provider than the chat's current one performs a mid-conversation harness
   * switch (fresh session + handoff context, see prepareProviderHandoff).
   */
  private resolveProvider(options: SendMessageOptions, currentProvider: AgentProvider | null) {
    return options.provider ?? currentProvider ?? "claude"
  }

  private getProviderSettings(provider: AgentProvider, options: SendMessageOptions) {
    const catalog = getServerProviderCatalog(provider)
    if (provider === "claude") {
      const model = normalizeServerModel(provider, options.model)
      const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
      return {
        model: resolveClaudeApiModelId(model, modelOptions.contextWindow),
        effort: modelOptions.reasoningEffort,
        serviceTier: serviceTierFromModelOptions(modelOptions),
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
        autoPlan: catalog.supportsAutoPlanMode ? Boolean(options.autoPlan) : false,
      }
    }

    if (provider === "cursor") {
      const modelOptions = normalizeCursorModelOptions(options.modelOptions)
      return {
        model: cursorModelIdForOptions(normalizeServerModel(provider, options.model), modelOptions),
        effort: undefined,
        serviceTier: undefined,
        planMode: false,
        autoPlan: false,
      }
    }

    if (provider === "grok") {
      const modelOptions = normalizeGrokModelOptions(options.modelOptions, options.effort)
      return {
        model: normalizeServerModel(provider, options.model),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
        autoPlan: false,
      }
    }

    if (provider === "pi") {
      const modelOptions = normalizePiModelOptions(options.modelOptions, options.effort)
      return {
        model: normalizeServerModel(provider, options.model),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: false,
        autoPlan: false,
      }
    }

    const model = normalizeServerModel(provider, options.model)
    const modelOptions = normalizeCodexModelOptions(model, options.modelOptions, options.effort)
    return {
      model,
      effort: modelOptions.reasoningEffort,
      serviceTier: serviceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
      autoPlan: catalog.supportsAutoPlanMode ? Boolean(options.autoPlan) : false,
    }
  }

  private enqueueMessageEffect = Effect.fn("Agent.enqueueMessage")((
    chatId: string,
    content: string,
    attachments: ChatAttachment[],
    options?: SendMessageOptions & { source?: MessageSource },
  ) => {
    const queued = this.store.enqueueMessage(chatId, {
      content,
      attachments,
      provider: options?.provider,
      model: options?.model,
      modelOptions: options?.modelOptions,
      effort: options?.effort,
      planMode: options?.planMode,
      autoPlan: options?.autoPlan,
      source: options?.source,
    })
    return storeWriteEffect(queued).pipe(
      Effect.tap(() => Effect.sync(() => this.emitStateChange(chatId))),
    )
  })

  private dequeueAndStartQueuedMessageEffect = Effect.fn("Agent.dequeueAndStartQueuedMessage")((
    chatId: string, queuedMessage: QueuedChatMessage, options?: { steered?: boolean },
  ) => {
    const self = this
    return Effect.gen(function* () {
    yield* storeWriteEffect(self.store.removeQueuedMessage(chatId, queuedMessage.id))
    const chat = self.store.requireChat(chatId)
    const provider = self.resolveProvider(queuedMessage, chat.provider)
    const settings = self.getProviderSettings(provider, queuedMessage)
    yield* self.startTurnForChatEffect({
      chatId,
      provider,
      content: queuedMessage.content,
      attachments: queuedMessage.attachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      autoPlan: settings.autoPlan,
      appendUserPrompt: true,
      steered: options?.steered,
      source: queuedMessage.source,
    })
    })
  })

  private maybeStartNextQueuedMessageEffect = Effect.fn("Agent.maybeStartNextQueuedMessage")((chatId: string) => {
    const self = this
    return Effect.gen(function* () {
      if (self.isBusy(chatId)) return false
      const nextQueuedMessage = typeof self.store.getQueuedMessages === "function"
        ? self.store.getQueuedMessages(chatId)[0]
        : undefined
      if (!nextQueuedMessage) return false
      // Marked before the first wait: two callers that both saw the chat idle
      // would otherwise both take the head of the queue.
      self.markStarting(chatId)
      yield* self.dequeueAndStartQueuedMessageEffect(chatId, nextQueuedMessage).pipe(
        Effect.ensuring(Effect.sync(() => self.unmarkStarting(chatId))),
      )
      return true
    })
  })

  /**
   * Other chats with an active turn in the same project directory as
   * `localPath` (matched by path, not project id, so two Kanna projects
   * pointing at the same directory still see each other). Draining streams
   * are excluded — those turns are winding down, not doing new work.
   */
  private collectConcurrentProjectChats(chatId: string, localPath: string): ConcurrentProjectChat[] {
    const chats: ConcurrentProjectChat[] = []
    for (const activeChatId of this.activeTurns.keys()) {
      if (activeChatId === chatId) continue
      const chat = this.store.getChat(activeChatId)
      if (!chat) continue
      const project = this.store.getProject(chat.projectId)
      if (!project || project.localPath !== localPath) continue
      chats.push({ title: chat.title, transcriptPath: this.store.getTranscriptPath(activeChatId) })
    }
    return chats
  }

  /**
   * Mid-conversation harness switch. Closes the outgoing provider's session
   * plumbing, clears the chat's session tokens (fresh native session on the
   * new harness — stale old sessions are never resumed, even when switching
   * back), and appends a handoff_boundary entry. Returns the wire-only
   * handoff context to prepend to this turn's prompt, or null when the
   * transcript has nothing worth handing off (the switch still happens).
   */
  private prepareProviderHandoffEffect = Effect.fn("Agent.prepareProviderHandoff")((
    chatId: string,
    fromProvider: AgentProvider,
    toProvider: AgentProvider,
    entries: TranscriptEntry[],
  ) => {
    const self = this
    return Effect.gen(function* () {
    const claudeSession = self.claudeSessions.get(chatId)
    if (claudeSession) {
      yield* claudeSession.session.close
      self.claudeSessions.delete(chatId)
    }
    // Codex keeps a warm per-chat app-server session that would silently
    // resume the old thread on switch-back; kill it so the cleared session
    // token actually takes effect. Cursor spawns per turn — nothing to close.
    self.forkBackground(self.codexManager.stopSession(chatId))
    self.piManager.closeChat(chatId)
    yield* storeWriteEffect(self.store.setSessionToken(chatId, null))
    yield* storeWriteEffect(self.store.setPendingForkSessionToken(chatId, null))

    const handoff = buildHandoffContext({
      entries,
      fromProvider,
      toProvider,
      transcriptPath: self.store.getTranscriptPath(chatId),
    })
    yield* storeWriteEffect(self.store.appendMessage(chatId, timestamped({
      kind: "handoff_boundary",
      fromProvider,
      toProvider,
      ...(handoff ? { stats: handoff.stats } : {}),
    })))
    return handoff
    })
  })

  /**
   * Decide whether this chat's native provider session is gone and should be
   * rebuilt from the transcript. Only called when the provider is unchanged
   * (a switch already rebuilds context via the handoff path).
   *
   * - claude/cursor: the session artifact is deterministic on disk, so we
   *   probe it directly. A session minted this process lifetime is still warm
   *   (in `claudeSessions`) and can't have been GC'd — skip the check.
   * - codex: the app-server reports a recoverable resume failure by falling
   *   back to a fresh thread, so we preflight `startSession` (which the turn's
   *   own call then reuses via its warm-session early return) and read the
   *   flag. Errors are swallowed so the turn's own startSession surfaces them
   *   with today's ordering.
   * - pi: out of scope.
   */
  private detectLostProviderSessionEffect = Effect.fn("Agent.detectLostProviderSession")((args: {
    chatId: string
    provider: AgentProvider
    cwd: string
    model: string
    serviceTier?: "fast"
    sessionToken: string | null | undefined
    pendingForkSessionToken: string | null | undefined
  }) => {
    const self = this
    return Effect.gen(function* () {
    switch (args.provider) {
      case "claude": {
        if (self.claudeSessions.has(args.chatId)) return false
        const token = args.pendingForkSessionToken ?? args.sessionToken
        const status = yield* self.checkSessionArtifactEffect("claude", { cwd: args.cwd, sessionToken: token })
        return status === "missing"
      }
      case "cursor": {
        const status = yield* self.checkSessionArtifactEffect("cursor", { cwd: args.cwd, sessionToken: args.sessionToken })
        return status === "missing"
      }
      case "grok": {
        const status = yield* self.checkSessionArtifactEffect("grok", {
          cwd: args.cwd,
          sessionToken: args.pendingForkSessionToken ?? args.sessionToken,
        })
        return status === "missing"
      }
      case "codex": {
        // No token → nothing to resume; a fork in progress must not be disturbed.
        if (!args.sessionToken || args.pendingForkSessionToken) return false
        const started = yield* Effect.exit(self.codexManager.startSession({
            chatId: args.chatId,
            cwd: args.cwd,
            model: args.model,
            serviceTier: args.serviceTier,
            sessionToken: args.sessionToken,
            pendingForkSessionToken: null,
          }))
        return Exit.isSuccess(started) && started.value?.resumeFellBack === true
      }
      default:
        return false
    }
    })
  })

  /**
   * Recover a chat whose native session is gone: clear the stale token, mark a
   * "Conversation Restored" boundary, and rebuild the wire-only context from
   * the transcript (same machinery as a provider handoff, from==to provider).
   * Nothing warm needs closing — claude/cursor have no live session by
   * construction here, and codex's warm context IS the fresh replacement
   * thread, whose id the turn's session_token stream event persists.
   */
  private prepareSessionRestoreEffect = Effect.fn("Agent.prepareSessionRestore")((
    chatId: string,
    provider: AgentProvider,
    entries: TranscriptEntry[],
  ) => {
    const self = this
    return Effect.gen(function* () {
    yield* storeWriteEffect(self.store.setSessionToken(chatId, null))
    yield* storeWriteEffect(self.store.setPendingForkSessionToken(chatId, null))

    const restore = buildHandoffContext({
      entries,
      fromProvider: provider,
      toProvider: provider,
      transcriptPath: self.store.getTranscriptPath(chatId),
      reason: "session_restore",
    })
    yield* storeWriteEffect(self.store.appendMessage(chatId, timestamped({
      kind: "session_restored",
      provider,
      ...(restore ? { stats: restore.stats } : {}),
    })))
    return restore
    })
  })

  private startTurnForChatEffect = Effect.fn("Agent.startTurnForChat")((args: StartTurnArgs) => {
    const self = this
    return Effect.gen(function* () {
      const previousActive = self.activeTurns.get(args.chatId)
      const previousClaudeSession = self.claudeSessions.get(args.chatId)
      self.markStarting(args.chatId)
      yield* self.startTurnEffect(args).pipe(
        Effect.onInterrupt(() => Effect.gen(function* () {
          // Startup may have acquired a turn or Claude session before an SDK
          // prompt finishes. Recovery interruption must not leave either live.
          const active = self.activeTurns.get(args.chatId)
          if (active && active !== previousActive) {
            active.cancelRequested = true
            active.cancelRecorded = true
            active.customTools?.abort()
            self.activeTurns.delete(args.chatId)
            yield* Effect.exit(active.turn.close)
          }
          // Codex opens a reusable app-server session before its scoped turn.
          // If startup is interrupted in that interval, the turn has no scope
          // yet to release the session for us.
          if (args.provider === "codex") {
            yield* Effect.exit(self.codexManager.stopSession(args.chatId))
          }
          const session = self.claudeSessions.get(args.chatId)
          if (args.provider === "claude" && session && (session !== previousClaudeSession || active !== previousActive)) {
            self.claudeSessions.delete(args.chatId)
            yield* Effect.exit(session.session.close)
          }
          self.emitStateChange(args.chatId)
        })),
        Effect.ensuring(Effect.sync(() => self.unmarkStarting(args.chatId))),
      )
    })
  })

  private startTurnEffect = Effect.fn("Agent.startTurn")((args: StartTurnArgs) => {
    const self = this
    return Effect.gen(function* () {
    const { chat, project, handoff, restore, shouldGenerateTitle, optimisticTitle } = yield* Effect.gen(function* () {
      // A prior result can leave its provider stream draining after the UI is idle.
      const draining = self.drainingStreams.get(args.chatId)
      if (draining) {
        yield* draining.turn.close
        self.drainingStreams.delete(args.chatId)
      }

      const chat = self.store.requireChat(args.chatId)
      if (self.activeTurns.has(args.chatId)) return yield* Effect.fail(new Error("Chat is already running"))
      const previousProvider = chat.provider
      if (previousProvider !== args.provider) yield* storeWriteEffect(self.store.setChatProvider(args.chatId, args.provider))
      yield* storeWriteEffect(self.store.setPlanMode(args.chatId, args.planMode))
      yield* storeWriteEffect(self.store.setAutoPlan(args.chatId, args.autoPlan))

      // Only handoff and restore need the full payload sidecar. The first-title
      // check reads it once for an empty chat; later turns skip it entirely.
      let existingMessagesCache: TranscriptEntry[] | null = null
      const existingMessages = Effect.suspend(() => existingMessagesCache
        ? Effect.succeed(existingMessagesCache)
        : storeWriteEffect(self.store.readMessages(args.chatId)).pipe(
          Effect.tap((messages) => Effect.sync(() => { existingMessagesCache = messages })),
        ))
      const shouldGenerateTitle = args.appendUserPrompt && chat.title === "New Chat"
        && (yield* existingMessages).length === 0
      const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null
      if (optimisticTitle) yield* storeWriteEffect(self.store.renameChat(args.chatId, optimisticTitle))

      const project = self.store.getProject(chat.projectId)
      if (!project) return yield* Effect.fail(new Error("Project not found"))

      const handoff = previousProvider !== null && previousProvider !== args.provider
        ? yield* self.prepareProviderHandoffEffect(args.chatId, previousProvider, args.provider, (yield* existingMessages))
        : null
      const restore = !handoff && previousProvider !== null
        && (yield* self.detectLostProviderSessionEffect({
          chatId: args.chatId,
          provider: args.provider,
          cwd: project.localPath,
          model: args.model,
          serviceTier: args.serviceTier,
          sessionToken: chat.sessionToken,
          pendingForkSessionToken: chat.pendingForkSessionToken,
        }))
        ? yield* self.prepareSessionRestoreEffect(args.chatId, args.provider, (yield* existingMessages))
        : null

      if (args.appendUserPrompt) {
        yield* storeWriteEffect(self.store.appendMessage(args.chatId, timestamped({
          kind: "user_prompt",
          content: args.content,
          attachments: args.attachments,
          steered: args.steered,
          ...(args.source ? { source: args.source } : {}),
        }, Date.now())))
      }
      yield* storeWriteEffect(self.store.recordTurnStarted(args.chatId, args.model))
      return { chat, project, handoff, restore, shouldGenerateTitle, optimisticTitle }
    })

    if (shouldGenerateTitle) {
      self.forkBackground(self.generateTitleInBackgroundEffect(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat"))
    }

    const onToolRequest = (request: HarnessToolRequest) => self.requestToolInput(args.chatId, request)
    let markToolsReady!: () => void
    const toolsReady = new Promise<void>((resolve) => { markToolsReady = resolve })
    const customTools: KannaToolHost = {
      execute: async (name, input, signal) => {
        await toolsReady
        const active = self.activeTurns.get(args.chatId)
        if (!active || active.cancelRequested) {
          return { content: [{ type: "text", text: "Chat turn ended" }], isError: true }
        }
        active.customTools ??= new KannaToolRuntime({
          platform: self.platform,
          chatId: args.chatId,
          cwd: project.localPath,
          dataDir: self.store.dataDir,
          emit: async (entry) => {
            await runStoreWrite(self.store.appendMessage(args.chatId, entry))
            self.emitStateChange(args.chatId)
          },
          requestInput: (request, callSignal) => self.requestToolInput(args.chatId, request, callSignal),
          orchestration: self.orchestration ?? undefined,
        })
        return active.customTools.execute(name, input, signal)
      },
    }

    // Wire-only injections. The transcript above stores the user's typed text
    // verbatim; anything Kanna adds for the harness is applied here and never
    // persisted (the `steered` flag on the entry drives the UI affordance).
    //
    // Steer: prefix the mid-turn <system-message> block — or suffix it when
    // the message is a slash invocation, since claude/pi only expand a message
    // that STARTS with "/name".
    //
    // Concurrent agents: when other chats have active turns in the same
    // project directory, suffix a <system-message> notice listing them (and
    // their transcript paths) so agents don't trample each other's work.
    //
    // Handoff: after a harness switch, the rendered transcript context leads
    // the first prompt sent to the new harness (see handoff.ts).
    //
    // Skills: every "/name" in the prompt, translated per provider:
    //   claude/grok/pi — a leading "/name" passes through (they expand it);
    //                    the rest get the <system-message> failsafe.
    //   codex          — structured skill input item each + failsafe (added
    //                    by the codex manager, after attachments).
    //   cursor         — <system-message> failsafe only (no headless expansion).
    const skills = yield* self.resolvePromptSkillsEffect(args.provider, args.chatId, args.content)
    let wireContent = args.steered ? buildSteeredMessageContent(args.content) : args.content
    if (args.provider !== "codex" && skills.length > 0) {
      wireContent = appendSystemMessageBlock(wireContent, buildSkillSystemMessage(skills))
    }
    const concurrentAgentsNotice = buildConcurrentAgentsNotice(
      self.collectConcurrentProjectChats(args.chatId, project.localPath)
    )
    if (concurrentAgentsNotice) {
      wireContent = appendSystemMessageBlock(wireContent, concurrentAgentsNotice)
    }
    // Orchestration: who sent this prompt when it was not the user, and which
    // sub-chats of this one are still running. The second matters most after a
    // steer, which ends the turn that was tracking them.
    const turnNotices = self.orchestration ? yield* self.orchestration.buildTurnNotices(args.chatId, args.source, {
      provider: args.provider,
      planMode: args.planMode,
      autoPlan: args.autoPlan,
    }) : []
    for (const notice of turnNotices) {
      wireContent = appendSystemMessageBlock(wireContent, notice)
    }

    // Harness switch or session restore: lead with the rebuilt transcript so
    // the user's actual prompt is the last thing in context (trails for slash
    // invocations, which must stay at the very start of the message).
    const contextBlock = handoff ?? restore
    if (contextBlock) {
      wireContent = buildHandoffMessageContent(contextBlock.text, wireContent)
    }

    // Read at each turn start, so a chat made a delegator mid-way is told on
    // its next turn. Grok has no chat tools, so it is told nothing of it.
    const delegator = Boolean(self.store.getChat(args.chatId)?.delegator)
    const { turn, active } = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const turn: ManagedHarnessTurn<unknown, unknown, unknown> = yield* restore(Effect.gen(function* () {
      if (args.provider === "claude") {
        return yield* self.startClaudeTurnEffect({
            chatId: args.chatId,
            localPath: project.localPath,
            model: args.model,
            effort: args.effort,
            serviceTier: args.serviceTier,
            planMode: args.planMode,
            autoPlan: args.autoPlan,
            delegator,
            sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
            forkSession: Boolean(chat.pendingForkSessionToken),
            ...(chat.pendingForkSessionToken && chat.pendingForkAt ? { resumeSessionAt: chat.pendingForkAt } : {}),
            onToolRequest,
            customTools,
        })
      }
      if (args.provider === "cursor") {
        // A failed catalog probe must not delay the turn.
        self.forkBackground(self.refreshCursorModelCatalogEffect())
        let cursorContent = buildPromptText(wireContent, args.attachments)
        // Cursor has no system prompt append hook, so instructions ride the text path.
        cursorContent = appendSystemMessageBlock(
          cursorContent,
          buildKannaSystemMessage(buildKannaAgentId("cursor", args.model), { delegator }),
        )
        return yield* openHarnessTurn(self.cursorManager.startTurn({
          cwd: project.localPath,
          customTools,
          content: cursorContent,
          model: args.model,
          sessionToken: chat.sessionToken,
        }))
      }
      if (args.provider === "grok") {
        self.forkBackground(self.refreshGrokModelCatalogEffect())
        const grokContent = appendSystemMessageBlock(
          buildPromptText(wireContent, args.attachments),
          buildKannaSystemMessage(buildKannaAgentId("grok", args.model), { tools: false }),
        )
        return yield* openHarnessTurn(self.grokManager.startTurn({
          cwd: project.localPath,
          content: grokContent,
          model: args.model,
          effort: args.effort,
          planMode: args.planMode,
          sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
          forkSession: Boolean(chat.pendingForkSessionToken),
          onToolRequest: (request) => Effect.tryPromise(() => onToolRequest(request)),
        }))
      }
      if (args.provider === "pi") {
        const connection = yield* self.resolvePiConnectionEffect()
        return yield* openHarnessTurn(self.piManager.startTurn({
          chatId: args.chatId,
          cwd: project.localPath,
          customTools,
          content: buildPromptText(wireContent, args.attachments),
          model: args.model,
          effort: normalizePiModelOptions(undefined, args.effort).reasoningEffort,
          sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
          forkSession: Boolean(chat.pendingForkSessionToken),
          connection,
          delegator,
        }).pipe(Effect.provide(self.platform)))
      }
      const started = yield* self.codexManager.startSession({
        chatId: args.chatId,
        cwd: project.localPath,
        customTools,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
        pendingForkAt: chat.pendingForkAt,
      })
      if (chat.pendingForkSessionToken && started?.sessionToken) {
        yield* storeWriteEffect(self.store.setPendingForkSessionToken(args.chatId, null))
      }
      // The live app server answers the catalog request off the turn path.
      self.forkBackground(self.refreshCodexModelCatalogEffect())
      return yield* openHarnessTurn(self.codexManager.startTurn({
        chatId: args.chatId,
        content: buildPromptText(wireContent, args.attachments),
        skills: skills.flatMap((skill) => skill.path ? [{ name: skill.name, path: skill.path }] : []),
        model: args.model,
        effort: args.effort as CodexReasoningEffort | undefined,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        delegator,
        skipPlanApproval: self.orchestration?.isAgentToAgent(args.chatId, args.source) ?? false,
        onToolRequest: (request) => Effect.tryPromise(() => onToolRequest(request)),
      }))
    }))

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      autoPlan: args.autoPlan,
      status: args.provider === "claude" ? "running" : "starting",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
    }
    self.activeTurns.set(args.chatId, active)
    markToolsReady()
    self.emitStateChange(args.chatId, { immediate: active.status === "starting" })
    return { turn, active }
    }))

    if (turn.accountInfo) {
      self.forkBackground(Effect.gen(function* () {
          const accountInfo = yield* turn.accountInfo!
          if (!accountInfo) return
          if (args.provider === "claude") {
            const session = self.claudeSessions.get(args.chatId)
            if (session) {
              if (session.accountInfoLoaded) return
              session.accountInfoLoaded = true
            } else {
              return
            }
          }
          yield* storeWriteEffect(self.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo })))
          self.emitStateChange(args.chatId)
        }).pipe(Effect.catch(() => Effect.void)))
    }

    if (args.provider === "claude") {
      const session = self.claudeSessions.get(args.chatId)
      if (!session) {
        return yield* Effect.fail(new Error("Claude session was not initialized"))
      }
      session.suppressResume = false
      const promptSeq = session.nextPromptSeq + 1
      const promptId = crypto.randomUUID()
      session.nextPromptSeq = promptSeq
      session.pendingPrompts.push({ seq: promptSeq, id: promptId })
      active.claudePromptSeq = promptSeq
      active.claudeSessionId = session.id
      logClaudeSteer(self.machine.env, "claude_prompt_sent", {
        chatId: args.chatId,
        sessionId: session.id,
        promptSeq,
        activeStatus: active.status,
        contentPreview: wireContent.slice(0, 160),
        pendingPromptSeqs: session.pendingPrompts.map((prompt) => prompt.seq),
      })
      // setModel() swaps the model on the live session without restarting it,
      // so the agent id in the session prompt can be stale. Re-state it on the
      // turn text (wire-only — the transcript stores args.content) from the
      // drift onward.
      const claudeAgentId = buildKannaAgentId("claude", args.model)
      const claudePrompt = buildPromptText(wireContent, args.attachments)
      yield* session.session.sendPrompt(
        session.promptAgentId === claudeAgentId
          ? claudePrompt
          : appendSystemMessageBlock(claudePrompt, buildKannaAgentCorrection(claudeAgentId)),
        promptId,
      )
      return
    }

    self.forkBackground(self.runTurnEffect(active))
    })
  })

  private startClaudeTurnEffect = Effect.fn("Agent.startClaudeTurn")((args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    autoPlan: boolean
    delegator: boolean
    sessionToken: string | null
    forkSession: boolean
    resumeSessionAt?: string
    customTools?: KannaToolHost
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  }) => {
    const self = this
    return Effect.gen(function* () {
    let session = self.claudeSessions.get(args.chatId)

    // autoPlan changes the SDK's `tools` allowlist, which is fixed at query()
    // time — unlike planMode (setPermissionMode) it can only be applied by
    // restarting the session. The restart resumes by sessionToken, so the
    // conversation carries over. The delegator instructions are part of the
    // system prompt, fixed at the same time, so a chat that became a
    // delegator or stopped being one restarts the same way.
    if (
      !session
      || session.localPath !== args.localPath
      || session.effort !== args.effort
      || session.autoPlan !== args.autoPlan
      || session.delegator !== args.delegator
      || args.forkSession
    ) {
      if (session) {
        yield* session.session.close
        self.claudeSessions.delete(args.chatId)
      }

      let pendingHandle: ClaudeSessionHandle | null = null
      const started = yield* Effect.tryPromise({
        try: (signal) => self.startClaudeSessionFn({
        platform: self.platform,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        autoPlan: args.autoPlan,
        delegator: args.delegator,
        sessionToken: args.sessionToken,
        forkSession: args.forkSession,
        ...(args.resumeSessionAt ? { resumeSessionAt: args.resumeSessionAt } : {}),
        onToolRequest: args.onToolRequest,
        customTools: args.customTools,
        onRateLimitEvent: (info) => self.onClaudeRateLimit?.(info),
        onSubagentActivity: (update) => self.applySubagentActivity(args.chatId, update),
        signal,
        }).then((handle) => {
          if (signal.aborted) handle.close()
          else pendingHandle = handle
          return handle
        }),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => {
        pendingHandle?.close()
      })))
      self.refreshClaudeModelCatalog(started)

      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: effectClaudeSession(args.chatId, started),
        localPath: args.localPath,
        model: args.model,
        promptAgentId: buildKannaAgentId("claude", args.model),
        effort: args.effort,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        autoPlan: args.autoPlan,
        delegator: args.delegator,
        sessionToken: args.sessionToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPrompts: [],
        echoesPromptIds: started.echoesPromptIds ?? false,
        suppressResume: false,
        cancelledPromptSeqs: new Set(),
      }
      self.claudeSessions.set(args.chatId, session)
      self.forkBackground(self.runClaudeSessionEffect(session))
    } else {
      if (session.model !== args.model) {
        yield* session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        yield* session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
      if (session.serviceTier !== args.serviceTier) {
        if (session.session.setFastMode) yield* session.session.setFastMode(args.serviceTier === "fast")
        session.serviceTier = args.serviceTier
      }
    }

    return {
      provider: "claude" as const,
      events: Stream.empty,
      ...(session.session.accountInfo ? {
        accountInfo: session.session.accountInfo,
      } : {}),
      interrupt: session.session.interrupt,
      close: Effect.void,
    }
    })
  })

  /**
   * `source` names the sender when it is not the user: another chat's agent,
   * a sub-chat's report, a schedule. It rides the queue and lands on the
   * transcript entry.
   */
  sendEffect = Effect.fn("Agent.send")((
    command: Extract<ClientCommand, { type: "chat.send" }>,
    extras?: { source?: MessageSource },
  ) => {
    const self = this
    return Effect.gen(function* () {
    let chatId = command.chatId

    if (!chatId) {
      if (!command.projectId) {
        return yield* Effect.fail(new Error("Missing projectId for new chat"))
      }
      const created = yield* storeWriteEffect(self.store.createChat(command.projectId, undefined, { delegator: command.delegator }))
      chatId = created.id
      yield* self.analytics.track("chat_created")
    }

    const chat = self.store.requireChat(chatId)
    // Sending a message to an archived chat resurrects it (viewing alone
    // never unarchives).
    if (chat.archivedAt) {
      yield* storeWriteEffect(self.store.unarchiveChat(chatId))
    }
    // `isBusy`, not just a running turn: two sends can reach an idle chat
    // together (a report and a schedule, say), and the second must queue
    // behind the turn the first is still starting rather than start its own.
    if (self.isBusy(chatId)) {
      if (!extras?.source) yield* self.analytics.track("message_sent")
      const queuedMessage = yield* self.enqueueMessageEffect(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
        autoPlan: command.autoPlan,
        source: extras?.source,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    const provider = self.resolveProvider(command, chat.provider)
    const settings = self.getProviderSettings(provider, command)
    // The count is of messages people send.
    if (!extras?.source) yield* self.analytics.track("message_sent")
    yield* self.startTurnForChatEffect({
      chatId,
      provider,
      content: command.content,
      attachments: command.attachments ?? [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      autoPlan: settings.autoPlan,
      appendUserPrompt: true,
      source: extras?.source,
    })

    return { chatId }
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  send(command: Extract<ClientCommand, { type: "chat.send" }>, extras?: { source?: MessageSource }) {
    return runKanna(this.sendEffect(command, extras))
  }

  enqueueEffect = Effect.fn("Agent.enqueue")((
    command: Extract<ClientCommand, { type: "message.enqueue" }>,
    extras?: { source?: MessageSource; effort?: string },
  ) => {
    const self = this
    return Effect.gen(function* () {
    if (!extras?.source) yield* self.analytics.track("message_sent")
    const queuedMessage = yield* self.enqueueMessageEffect(command.chatId, command.content, command.attachments ?? [], {
      provider: command.provider,
      model: command.model,
      modelOptions: command.modelOptions,
      effort: extras?.effort,
      planMode: command.planMode,
      autoPlan: command.autoPlan,
      source: extras?.source,
    })
    if (command.steer) {
      // The same path as "Send now" on a queued message, so the two can't
      // drift. One thing it has to absorb: the turn can end while the message
      // was being queued, in which case the drain has already started it —
      // the outcome steering wanted, just not by this call.
      const steered = yield* Effect.exit(self.steerEffect({
        type: "message.steer", chatId: command.chatId, queuedMessageId: queuedMessage.id,
      }))
      if (Exit.isFailure(steered)) {
        const drained = !self.store.getQueuedMessage(command.chatId, queuedMessage.id)
          && self.activeTurns.has(command.chatId)
        if (!drained) return yield* Effect.fail(Cause.squash(steered.cause))
      }
    }
    return { queuedMessageId: queuedMessage.id }
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>, extras?: { source?: MessageSource; effort?: string }) {
    return runKanna(this.enqueueEffect(command, extras))
  }

  steerEffect = Effect.fn("Agent.steer")((command: Extract<ClientCommand, { type: "message.steer" }>) => {
    const self = this
    return Effect.gen(function* () {
      const queuedMessage = self.store.getQueuedMessage(command.chatId, command.queuedMessageId)
      if (!queuedMessage) return yield* Effect.fail(new Error("Queued message not found"))

      logClaudeSteer(self.machine.env, "steer_requested", {
        chatId: command.chatId,
        queuedMessageId: command.queuedMessageId,
        activeTurn: self.activeTurns.has(command.chatId),
        queuedMessagePreview: queuedMessage.content.slice(0, 160),
      })

      // The chat is not idle between the cancel and the turn that replaces it.
      self.markStarting(command.chatId)
      yield* Effect.gen(function* () {
        if (self.activeTurns.has(command.chatId)) {
          yield* self.cancelEffect(command.chatId, { hideInterrupted: true })
        }

        logClaudeSteer(self.machine.env, "steer_after_cancel", {
          chatId: command.chatId,
          stillActive: self.activeTurns.has(command.chatId),
        })

        if (self.activeTurns.has(command.chatId)) {
          return yield* Effect.fail(new Error("Chat is still running"))
        }

        yield* self.dequeueAndStartQueuedMessageEffect(command.chatId, queuedMessage, { steered: true })
      }).pipe(Effect.ensuring(Effect.sync(() => self.unmarkStarting(command.chatId))))
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  steer(command: Extract<ClientCommand, { type: "message.steer" }>): Promise<void> {
    return runKanna(this.steerEffect(command))
  }

  dequeueEffect = Effect.fn("Agent.dequeue")((command: Extract<ClientCommand, { type: "message.dequeue" }>) => {
    const self = this
    return Effect.gen(function* () {
      const queuedMessage = self.store.getQueuedMessage(command.chatId, command.queuedMessageId)
      if (!queuedMessage) return yield* Effect.fail(new Error("Queued message not found"))
      yield* storeWriteEffect(self.store.removeQueuedMessage(command.chatId, command.queuedMessageId))
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  dequeue(command: Extract<ClientCommand, { type: "message.dequeue" }>): Promise<void> {
    return runKanna(this.dequeueEffect(command))
  }

  /**
   * Enumerate the skills/commands the selected harness can invoke, for the
   * composer's "/" menu. Prefers the live harness (authoritative — includes
   * built-ins, plugins, and enabled flags) and degrades to Kanna's filesystem
   * scan of the same discovery roots when no session is running yet.
   *
   * Adding a harness = one branch here (list) plus, if its wire protocol needs
   * more than leading-"/name" text, one translation in startTurnForChat.
   */
  listSkillsEffect = Effect.fn("Agent.listSkills")((
    command: Extract<ClientCommand, { type: "chat.listSkills" }>,
  ) => {
    const self = this
    return Effect.gen(function* () {
      const cwd = self.resolveSkillScanCwd(command)
      if (!cwd) return { provider: command.provider, skills: [] as HarnessSkill[], origin: "filesystem" } as const

      switch (command.provider) {
        case "claude": {
          const handle = command.chatId ? self.claudeSessions.get(command.chatId)?.session : undefined
          if (handle?.supportedCommands) {
            const result = yield* Effect.exit(handle.supportedCommands)
            if (Exit.isSuccess(result)) {
              const skills: HarnessSkill[] = result.value
                .filter((entry) => !entry.name.startsWith("._"))
                .map((entry) => ({
                  name: entry.name,
                  description: entry.description ?? "",
                  ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
                  source: "command" as const,
                }))
              return { provider: "claude", skills, origin: "live" } as const
            }
            // Session mid-shutdown or old CLI — fall through to the scan.
          }
          return {
            provider: "claude",
            skills: yield* scanClaudeSkills({ cwd }).pipe(Effect.provide(self.platform)),
            origin: "filesystem",
          } as const
        }
        case "codex": {
          const live = command.chatId
            ? yield* self.codexManager.listSkills({ chatId: command.chatId, cwd })
            : null
          if (live) {
            const skills: HarnessSkill[] = live.map((skill) => ({
              name: skill.name,
              description: skill.shortDescription || skill.description || "",
              source: "skill" as const,
              path: skill.path,
            }))
            return { provider: "codex", skills, origin: "live" } as const
          }
          return {
            provider: "codex",
            skills: yield* scanCodexSkills({ cwd }).pipe(Effect.provide(self.platform)),
            origin: "filesystem",
          } as const
        }
        case "cursor":
          // Cursor has no enumeration protocol; the scan mirrors the CLI's own
          // skill discovery roots, and invocation is failsafe-only by design.
          return {
            provider: "cursor",
            skills: yield* scanCursorSkills({ cwd }).pipe(Effect.provide(self.platform)),
            origin: "filesystem",
          } as const
        case "grok": {
          const live = yield* self.grokManager.listSkills({ cwd })
          if (live.length > 0) return { provider: "grok", skills: live, origin: "live" } as const
          return {
            provider: "grok",
            skills: yield* scanGrokSkills({ cwd }).pipe(Effect.provide(self.platform)),
            origin: "filesystem",
          } as const
        }
        case "pi": {
          const skills = yield* self.piManager.listSkills({ chatId: command.chatId, cwd })
          return { provider: "pi", skills, origin: "live" } as const
        }
      }
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  listSkills(command: Extract<ClientCommand, { type: "chat.listSkills" }>): Promise<ChatSkillsSnapshot> {
    return runKanna(this.listSkillsEffect(command))
  }

  private resolveSkillScanCwd(args: { chatId?: string; projectId?: string }): string | null {
    if (args.chatId) {
      const chat = this.store.getChat(args.chatId)
      const project = chat ? this.store.getProject(chat.projectId) : undefined
      if (project) return project.localPath
    }
    if (args.projectId) {
      const project = this.store.getProject(args.projectId)
      if (project) return project.localPath
    }
    return null
  }

  /**
   * The skills a prompt names that the harness won't expand by itself,
   * resolved against the same list the "/" menu shows (for codex, live
   * skills/list paths are what its structured item must exact-match).
   * Unresolved names stay plain text. The list is only fetched when some
   * mention needs it, so an ordinary leading "/name" on claude/grok/pi costs
   * nothing extra.
   */
  private resolvePromptSkillsEffect = Effect.fn("Agent.resolvePromptSkills")((provider: AgentProvider, chatId: string, content: string) => {
    const expandsLeading = provider === "claude" || provider === "grok" || provider === "pi"
    const mentions = findSkillMentions(content).filter((mention) => !(expandsLeading && mention.leading))
    if (mentions.length === 0) return Effect.succeed([] as SkillReference[])
    return this.listSkillsEffect({ type: "chat.listSkills", provider, chatId }).pipe(
      Effect.map(({ skills }) => resolveSkillMentions(mentions, skills)),
    )
  })

  /**
   * Cancel every in-flight turn because Kanna itself is going down, marking
   * each chat so the next boot picks the work back up (`resumeInterruptedTurn`).
   *
   * Everything a user-initiated cancel does still happens — the harness is
   * interrupted, the pending tool call is discarded, the transcript gets its
   * `interrupted` entry — so a chat that never gets resumed reads exactly as it
   * does today. The marker is written first: a shutdown that dies partway
   * through leaves a chat resumable-but-not-cancelled, which the resume pass
   * handles, rather than cancelled-but-forgotten, which it can't.
   *
   * A turn parked on a tool request (AskUserQuestion, plan approval) is not
   * marked. Cancelling it feeds the harness a discarded result, and a resume
   * would then tell the model to "continue" past a question nobody answered or
   * a plan nobody approved. Those chats stay interrupted so the user re-asks.
   */
  interruptForShutdownEffect = Effect.fn("Agent.interruptForShutdown")(() => {
    const self = this
    return Effect.gen(function* () {
      // These turns come back on the next boot, so none of them has settled.
      self.shuttingDown = true
      for (const [chatId, active] of [...self.activeTurns.entries()]) {
        if (!active.pendingTool) {
          // Best effort — a chat we can't mark still gets cancelled cleanly.
          yield* Effect.exit(storeWriteEffect(self.store.setTurnResumePending(chatId, true)))
        }
        yield* self.cancelEffect(chatId)
      }
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  interruptForShutdown(): Promise<void> {
    return runKanna(this.interruptForShutdownEffect())
  }

  /**
   * Restart a turn that the previous process cut short by shutting down.
   *
   * The prompt is wire-only (`appendUserPrompt: false`), so the transcript
   * shows the interrupted turn picking back up rather than a user message
   * nobody typed. Resuming leans on the harness session having survived: it
   * holds the original prompt and everything the turn did before it died, so
   * "carry on" is all that has to be said. When the session is gone,
   * `startTurnForChat`'s own recovery notices and rebuilds the context from our
   * transcript first (`prepareSessionRestore`), which is exactly what's wanted.
   *
   * Returns whether a turn was actually started.
   */
  resumeInterruptedTurnEffect = Effect.fn("Agent.resumeInterruptedTurn")((chatId: string) => {
    const self = this
    return Effect.gen(function* () {
    const chat = self.store.getChat(chatId)
    if (!chat || chat.deletedAt) return false
    if (!chat.provider) return false
    if (self.activeTurns.has(chatId)) return false
    // No session to resume into means the harness never got far enough to have
    // context worth continuing; a bare "carry on" would be sent into an empty
    // session, so leave the chat interrupted instead.
    if (!chat.sessionToken && !chat.pendingForkSessionToken) return false
    const provider = chat.provider

    // Everything the chat record remembers about how the turn was running:
    // the model it actually ran with plus the two persisted modes. Reasoning
    // effort and fast mode are picked in the composer and never stored server
    // side, so the resumed turn falls back to the provider defaults for those.
    const settings = self.getProviderSettings(provider, {
      model: chat.lastModel,
      planMode: chat.planMode,
      autoPlan: chat.autoPlan,
    })
    yield* self.startTurnForChatEffect({
      chatId,
      provider,
      content: RESUME_AFTER_RESTART_MESSAGE,
      attachments: [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      autoPlan: settings.autoPlan,
      appendUserPrompt: false,
    })
    return true
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  resumeInterruptedTurn(chatId: string): Promise<boolean> {
    return runKanna(this.resumeInterruptedTurnEffect(chatId))
  }

  forkChatEffect = Effect.fn("Agent.forkChat")((
    chatId: string, lineage?: { parentChatId?: string; createdByChatId?: string },
  ) => {
    const self = this
    return Effect.gen(function* () {
    const chat = self.store.requireChat(chatId)
    if (!chat.provider) {
      return yield* Effect.fail(new Error("Chat must have a provider before forking"))
    }
    if (!chat.sessionToken && !chat.pendingForkSessionToken) {
      return yield* Effect.fail(new Error("Chat has no session to fork"))
    }

    // A running chat is forkable: the fork branches from the last completed
    // turn, leaving the turn in flight out of the copy so it never inherits
    // tool calls whose results have not arrived. Nothing here touches the
    // source's turn — it keeps running.
    const running = self.activeTurns.has(chatId) || self.drainingStreams.has(chatId)
    const forked = yield* storeWriteEffect(self.store.forkChat(chatId, { atLastCompletedTurn: running, ...lineage }))
    yield* self.analytics.track("chat_created")
    return { chatId: forked.id }
    })
  })

  /** Compatibility for callers that have not moved to Effect yet. */
  forkChat(chatId: string, lineage?: { parentChatId?: string; createdByChatId?: string }) {
    return runKanna(this.forkChatEffect(chatId, lineage))
  }

  /**
   * Removes and returns the seqs of the prompts a turn-ending entry answers.
   *
   * The CLI also runs turns nobody sent. A task notification starts one, and
   * a resumed session opens with one about background commands the previous
   * process left running. Such a turn can end while the user's prompt waits
   * behind it in the CLI's queue. Crediting its result to the oldest pending
   * prompt ended the user's turn before the CLI had started it: "turn done"
   * with no reply. So each prompt carries an id, and the CLI echoes the ids a
   * turn consumed on its result.
   *
   * A result without ids answers none of ours, unless this CLI has never
   * echoed (a CLAUDE_EXECUTABLE wrapper), where oldest-first is all there
   * is. Error and interrupt results can come back without ids too (an
   * interrupted or failed turn), and they still go oldest-first so a failed
   * turn can't leave the chat spinning.
   */
  private takeAnsweredClaudePrompts(
    session: ClaudeSessionState,
    promptIds: string[] | undefined,
    endedEarly: boolean,
  ): number[] {
    if (promptIds?.length) {
      session.echoesPromptIds = true
      const answered = session.pendingPrompts.filter((prompt) => promptIds.includes(prompt.id))
      session.pendingPrompts = session.pendingPrompts.filter((prompt) => !promptIds.includes(prompt.id))
      return answered.map((prompt) => prompt.seq)
    }
    const head = session.pendingPrompts[0]
    if (!head) return []
    if (session.echoesPromptIds && !endedEarly) return []
    session.pendingPrompts.shift()
    return [head.seq]
  }

  /**
   * Re-registers an active turn for a Claude session that produced new
   * activity after its previous turn finished (e.g. a Monitor or Cron
   * wakeup continued the session). The resumed turn has no prompt seq, so
   * the next result that answers none of our prompts closes it through the
   * normal completion path in runClaudeSession.
   */
  private resumeBackgroundTurnEffect(session: ClaudeSessionState) {
    const self = this
    return Effect.gen(function* () {
    const active: ActiveTurn = {
      chatId: session.chatId,
      provider: "claude",
      turn: {
        provider: "claude",
        events: Stream.empty,
        ...(session.session.accountInfo ? {
          accountInfo: session.session.accountInfo,
        } : {}),
        interrupt: session.session.interrupt,
        close: Effect.void,
      },
      claudeSessionId: session.id,
      model: session.model,
      effort: session.effort,
      planMode: session.planMode,
      autoPlan: session.autoPlan,
      status: "running",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
    }
    self.activeTurns.set(session.chatId, active)
    yield* storeWriteEffect(self.store.recordTurnStarted(session.chatId, session.model))
    self.emitStateChange(session.chatId)
    })
  }

  private runClaudeSessionEffect = Effect.fn("Agent.runClaudeSession")((session: ClaudeSessionState) => {
    const self = this
    const customToolEvents = new KannaToolEventFilter()
    return Effect.gen(function* () {
      const streamExit = yield* Effect.exit(session.session.events.pipe(
        Stream.runForEach((event) => Effect.gen(function* () {
            // Closing a session during restart can leave one SDK event in flight.
            // It belongs to the old session, never to the replacement's turn.
            if (self.claudeSessions.get(session.chatId) !== session) return
            if (event.type === "session_token" && event.sessionToken) {
              session.sessionToken = event.sessionToken
              yield* storeWriteEffect(self.store.setSessionToken(session.chatId, event.sessionToken))
              self.emitStateChange(session.chatId)
              return
            }

            if (!event.entry || customToolEvents.skip(event.entry)) return

            const completedPromptSeqs = event.entry.kind === "result" || event.entry.kind === "interrupted"
              ? self.takeAnsweredClaudePrompts(session, event.promptIds, event.entry.kind === "interrupted" || event.entry.isError)
              : []

            // After an escape/cancel or steer, the SDK ends the cancelled turn
            // with a result of subtype error_during_execution (is_error, usually
            // no text). The cancel already appended an "interrupted" entry, so
            // persisting this would render a spurious "An unknown error
            // occurred." in the UI. Attribute the result to the prompts it
            // answers rather than relying on suppressResume, which a steered
            // follow-up prompt clears before the interrupt error lands.
            const isCancelledPromptErrorResult =
              event.entry.kind === "result"
              && event.entry.isError
              && completedPromptSeqs.length > 0
              && completedPromptSeqs.every((seq) => session.cancelledPromptSeqs.has(seq))
            if (!isCancelledPromptErrorResult) {
              yield* storeWriteEffect(self.store.appendMessage(session.chatId, event.entry))
            }

            // Background wakeups (Monitor, Cron*, ScheduleWakeup, RemoteTrigger)
            // emit new activity after the previous turn completed. Re-register an
            // active turn so the chat reads as in-progress instead of idle.
            if (
              !self.activeTurns.has(session.chatId)
              && !session.suppressResume
              && (
                event.entry.kind === "assistant_text"
                || event.entry.kind === "tool_call"
                || event.entry.kind === "tool_result"
              )
            ) {
              yield* self.resumeBackgroundTurnEffect(session)
            }

            if (event.entry.kind === "result" || event.entry.kind === "interrupted") {
              session.suppressResume = false
            }

            const active = self.activeTurns.get(session.chatId)
            if (event.entry.kind === "system_init" && active) {
              active.status = "running"
              const chat = self.store.getChat(session.chatId)
              if (
                chat?.pendingForkSessionToken
                && session.sessionToken
                && session.sessionToken !== chat.pendingForkSessionToken
              ) {
                yield* storeWriteEffect(self.store.setPendingForkSessionToken(session.chatId, null))
              }
              logClaudeSteer(self.machine.env, "claude_event_system_init", {
                chatId: session.chatId,
                sessionId: session.id,
                activePromptSeq: active.claudePromptSeq ?? null,
                pendingPromptSeqs: session.pendingPrompts.map((prompt) => prompt.seq),
              })
            }

            for (const seq of completedPromptSeqs) {
              session.cancelledPromptSeqs.delete(seq)
            }

            logClaudeSteer(self.machine.env, "claude_event", {
              chatId: session.chatId,
              sessionId: session.id,
              entryKind: event.entry.kind,
              activePromptSeq: active?.claudePromptSeq ?? null,
              completedPromptSeqs,
              activeStatus: active?.status ?? null,
              pendingPromptSeqs: session.pendingPrompts.map((prompt) => prompt.seq),
            })

            // A turn resumed by background activity has no prompt, so any result
            // that answers none of ours ends it.
            const completesActive = active?.claudePromptSeq == null
              ? completedPromptSeqs.length === 0
              : completedPromptSeqs.includes(active.claudePromptSeq)
            if (event.entry.kind === "result" && active && completesActive) {
              active.hasFinalResult = true
              if (event.entry.isError) {
                yield* storeWriteEffect(self.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed"))
              } else if (!active.cancelRequested) {
                yield* storeWriteEffect(self.store.recordTurnFinished(session.chatId))
              }
              active.customTools?.abort()
              self.activeTurns.delete(session.chatId)
              if (!active.cancelRequested) {
                yield* self.maybeStartNextQueuedMessageEffect(session.chatId)
              }
              self.notifySettled(session.chatId)
            }

            self.emitStateChange(session.chatId)
        })),
      ))
      if (Exit.isFailure(streamExit) && self.claudeSessions.get(session.chatId) === session) {
      const active = self.activeTurns.get(session.chatId)
      if (active && !active.cancelRequested) {
        const error = Cause.squash(streamExit.cause)
        const message = error instanceof Error ? error.message : String(error)
        yield* storeWriteEffect(self.store.appendMessage(
          session.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        ))
        yield* storeWriteEffect(self.store.recordTurnFailed(session.chatId, message))
      }
      }
      // Only evict if this session is still the chat's current one — a restart
      // (localPath/effort/autoPlan change, or a fork) closes the old session
      // and immediately registers a replacement, and the old stream's cleanup
      // lands afterwards. Deleting by chatId alone would drop the new session.
      if (self.claudeSessions.get(session.chatId) === session) self.claudeSessions.delete(session.chatId)
      // Only this session's turn. A restart registers the replacement's turn
      // before the old stream ends (the CLI takes a while to exit), and
      // dropping that one left the chat with no turn to finish: its first
      // reply re-registered it as a background turn, the prompt's result
      // could not close that, and the chat read "running" until stopped.
      const active = self.activeTurns.get(session.chatId)
      if (active?.provider === "claude" && active.claudeSessionId === session.id) {
        active.customTools?.abort()
        if (active.cancelRequested && !active.cancelRecorded) {
          yield* storeWriteEffect(self.store.recordTurnCancelled(session.chatId))
        }
        self.activeTurns.delete(session.chatId)
      }
      // The session is gone, so nothing it spawned can report back. Only when
      // no session replaced it: a restart's replacement owns them now. A
      // session closed with no replacement (closeChat, a provider handoff)
      // left the map before its stream ended, and still gets this cleanup.
      if (!self.claudeSessions.has(session.chatId)) {
        self.closeRunningSubagents(session.chatId)
        self.ambientTaskIds.delete(session.chatId)
        self.foregroundTasks.delete(session.chatId)
      }
      yield* session.session.close
      self.emitStateChange(session.chatId)
      self.notifySettled(session.chatId)
    })
  })

  private generateTitleInBackgroundEffect = Effect.fn("Agent.generateTitleInBackground")((
    chatId: string, messageContent: string, cwd: string, expectedCurrentTitle: string,
  ) => {
    const self = this
    return Effect.gen(function* () {
      const generated = yield* Effect.exit(self.generateTitleEffect(messageContent, cwd))
      if (Exit.isFailure(generated)) {
        const error = Cause.squash(generated.cause)
        const message = error instanceof Error ? error.message : String(error)
        self.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed background title generation: ${message}`
        )
        return
      }
      const result = generated.value
      if (result.failureMessage) {
        self.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed provider title generation: ${result.failureMessage}`
        )
      }
      if (!result.title || result.usedFallback) return

      const chat = self.store.requireChat(chatId)
      if (chat.title !== expectedCurrentTitle) return

      yield* storeWriteEffect(self.store.renameChat(chatId, result.title))
      self.emitStateChange(chatId)
    }).pipe(Effect.catch((error) => Effect.sync(() => {
      const message = error instanceof Error ? error.message : String(error)
      self.reportBackgroundError?.(`[title-generation] chat ${chatId} failed background title generation: ${message}`)
    })))
  })

  private runTurnEffect = Effect.fn("Agent.runTurn")((active: ActiveTurn) => {
    const self = this
    const customToolEvents = new KannaToolEventFilter()
    return Effect.gen(function* () {
      const streamExit = yield* Effect.exit(active.turn.events.pipe(
        // Once cancelled, stop processing further stream events: cancel()
        // already removed the turn and notified the UI. One event per chunk,
        // so the check runs before each event, not once per buffered batch.
        Stream.rechunk(1),
        Stream.takeWhile(() => !active.cancelRequested),
        Stream.runForEach((event) => Effect.gen(function* () {
            if (event.type === "session_token" && event.sessionToken) {
              yield* storeWriteEffect(self.store.setSessionToken(active.chatId, event.sessionToken))
              const chat = self.store.getChat(active.chatId)
              if (
                chat?.pendingForkSessionToken
                && event.sessionToken !== chat.pendingForkSessionToken
              ) {
                yield* storeWriteEffect(self.store.setPendingForkSessionToken(active.chatId, null))
              }
              self.emitStateChange(active.chatId)
              return
            }

            if (!event.entry || customToolEvents.skip(event.entry)) return
            yield* storeWriteEffect(self.store.appendMessage(active.chatId, event.entry))
            self.trackSubagentFromEntry(active.chatId, active.provider, event.entry)

            if (event.entry.kind === "system_init") {
              active.status = active.pendingTool ? "waiting_for_user" : "running"
            }

            if (event.entry.kind === "result") {
              active.hasFinalResult = true
              if (event.entry.isError) {
                yield* storeWriteEffect(self.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed"))
              } else if (!active.cancelRequested) {
                yield* storeWriteEffect(self.store.recordTurnFinished(active.chatId))
              }
              // Remove from activeTurns as soon as the result arrives so the UI
              // transitions to idle immediately. The stream may still be open
              // (e.g. background tasks), but the user should be able to send
              // new messages without having to hit stop first.
              self.activeTurns.delete(active.chatId)
              // Track the still-open stream so the UI can show a draining
              // indicator and the user can stop background tasks.
              self.drainingStreams.set(active.chatId, { turn: active.turn })
            }

            self.emitStateChange(active.chatId)
        })),
      ))
      if (Exit.isFailure(streamExit)) {
      if (!active.cancelRequested) {
        const error = Cause.squash(streamExit.cause)
        const message = error instanceof Error ? error.message : String(error)
        yield* storeWriteEffect(self.store.appendMessage(
          active.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        ))
        yield* storeWriteEffect(self.store.recordTurnFailed(active.chatId, message))
      }
      }
      if (active.cancelRequested && !active.cancelRecorded) {
        yield* storeWriteEffect(self.store.recordTurnCancelled(active.chatId))
      }
      active.customTools?.abort()
      yield* active.turn.close
      // Only remove if we're still the active turn for this chat.
      // We may have already been removed by result handling or cancel(),
      // and a new turn may have started for the same chatId.
      if (self.activeTurns.get(active.chatId) === active) {
        self.activeTurns.delete(active.chatId)
      }
      // Stream has fully ended — no longer draining.
      self.drainingStreams.delete(active.chatId)
      // These providers report a subagent only on this stream, so one still
      // marked running can never be closed and would hold the chat in
      // "waiting on subagent" for good. Not when a newer turn has started:
      // the log is that turn's now. Claude's tasks and Codex's agents outlive
      // the turn, and each has its own way of saying one has ended.
      if (tracksSubagentsFromTranscript(active.provider) && !self.activeTurns.has(active.chatId)) {
        self.closeRunningSubagents(active.chatId)
      }
      self.emitStateChange(active.chatId)

      if (active.postToolFollowUp && !active.cancelRequested) {
        const followUp = yield* Effect.exit(self.startTurnForChatEffect({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            attachments: [],
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            // Codex-only path; carry the turn's mode through unchanged.
            autoPlan: active.autoPlan,
            appendUserPrompt: false,
          }))
        if (Exit.isFailure(followUp)) {
          const error = Cause.squash(followUp.cause)
          const message = error instanceof Error ? error.message : String(error)
          yield* storeWriteEffect(self.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          ))
          yield* storeWriteEffect(self.store.recordTurnFailed(active.chatId, message))
          self.emitStateChange(active.chatId)
        }
      } else if (!active.cancelRequested) {
        const queued = yield* Effect.exit(self.maybeStartNextQueuedMessageEffect(active.chatId))
        if (Exit.isFailure(queued)) {
          const error = Cause.squash(queued.cause)
          const message = error instanceof Error ? error.message : String(error)
          yield* storeWriteEffect(self.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          ))
          yield* storeWriteEffect(self.store.recordTurnFailed(active.chatId, message))
          self.emitStateChange(active.chatId)
        }
      }
      // Here rather than at the result: the stream is closed and any follow-up
      // or queued turn has had its chance to start.
      self.notifySettled(active.chatId)
    })
  })

  cancelEffect(chatId: string, options?: { hideInterrupted?: boolean }) {
    const self = this
    const storeWrite = <A, E>(run: () => Effect.Effect<A, E>) =>
      Effect.suspend(() => storeWriteEffect(run())).pipe(
        Effect.catch((cause) => Effect.fail(new AgentCancelError({ chatId, cause }))),
      )
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      // A steer hides its interrupt and replaces the turn, and a shutdown brings
      // it back, so neither is a stop. Fired even when nothing is running here:
      // an idle chat can still have sub-chats to stop.
      const stopped = !options?.hideInterrupted && !self.shuttingDown
      if (stopped) self.onChatStopped?.(chatId)

      // Also clean up any draining stream for this chat.
      const draining = self.drainingStreams.get(chatId)
      if (draining) {
        yield* draining.turn.close
        self.drainingStreams.delete(chatId)
      }

      const active = self.activeTurns.get(chatId)
      if (!active) return

      logClaudeSteer(self.machine.env, "cancel_requested", {
        chatId,
        provider: active.provider,
        activePromptSeq: active.claudePromptSeq ?? null,
      })

      // Guard against concurrent cancel() calls — only the first one does work.
      if (active.cancelRequested) return
      active.cancelRequested = true

      // Keep in-flight stream entries (emitted before the interrupt lands)
      // from re-registering an active turn via resumeBackgroundTurn, and mark
      // the cancelled prompt so its interrupt error result gets dropped.
      if (active.provider === "claude") {
        const session = self.claudeSessions.get(chatId)
        if (session) {
          session.suppressResume = true
          if (active.claudePromptSeq != null) {
            session.cancelledPromptSeqs.add(active.claudePromptSeq)
          }
        }
      }

      const pendingTool = active.pendingTool
      active.pendingTool = null
      active.customTools?.abort()

      if (pendingTool && pendingTool.resultOwner !== "tool") {
        const result = discardedToolResult(pendingTool.tool)
        yield* storeWrite(() => self.store.appendMessage(
          chatId,
          timestamped({
            kind: "tool_result",
            toolId: pendingTool.toolUseId,
            content: result,
          })
        ))
        // These adapters hold their stream open until the request resolves.
        if (
          (active.provider === "codex" && pendingTool.tool.toolKind === "exit_plan_mode")
          || active.provider === "grok"
        ) {
          pendingTool.resolve(result)
        }
      }

      yield* storeWrite(() => self.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted })))
      yield* storeWrite(() => self.store.recordTurnCancelled(chatId))
      active.cancelRecorded = true
      active.hasFinalResult = true

      // Remove from activeTurns immediately so the UI reflects the cancellation
      // right away, rather than waiting for interrupt() which may hang.
      self.activeTurns.delete(chatId)
      if (active.provider === "codex") {
        // Codex's agents run on after the turn that spawned them is interrupted,
        // and each still reports its own end, so their rows stay as they are. A
        // stop is meant for them too. A steer is not: its new turn can go on
        // waiting for them.
        if (stopped) self.forkBackground(self.codexManager.stopAgents(chatId))
      } else {
        self.closeRunningSubagents(chatId)
      }
      self.emitStateChange(chatId)
      if (stopped) self.notifySettled(chatId)
      logClaudeSteer(self.machine.env, "cancel_active_turn_deleted", {
        chatId,
        provider: active.provider,
        activePromptSeq: active.claudePromptSeq ?? null,
      })

      // Now attempt to interrupt/close the underlying stream in the background.
      // This is best-effort — the turn is already removed from active state above,
      // and runTurn()'s finally block will also call close().
      yield* Effect.exit(Effect.raceFirst(active.turn.interrupt, Effect.sleep(5_000)))
      yield* active.turn.close
    }).pipe(Effect.withSpan("Agent.cancel"))
  }

  /** Compatibility for callers that have not moved to Effect yet. */
  cancel(chatId: string, options?: { hideInterrupted?: boolean }): Promise<void> {
    return runKanna(this.cancelEffect(chatId, options))
  }

  private async requestToolInput(chatId: string, request: HarnessToolRequest, signal?: AbortSignal): Promise<unknown> {
    const active = this.activeTurns.get(chatId)
    if (!active || active.cancelRequested) throw new Error("Chat turn ended")
    signal?.throwIfAborted()
    if (active.pendingTool) throw new Error("Another tool is waiting for user input")
    return new Promise<unknown>((resolve) => {
      const pending: PendingToolRequest = {
        toolUseId: request.tool.toolId,
        tool: request.tool,
        resultOwner: request.resultOwner,
        validateResult: request.validateResult,
        resolve: (result) => {
          signal?.removeEventListener("abort", abort)
          resolve(result)
        },
      }
      const abort = () => {
        if (active.pendingTool === pending) {
          active.pendingTool = null
          active.status = "running"
          this.emitStateChange(chatId)
        }
        pending.resolve(discardedToolResult(pending.tool))
      }
      signal?.addEventListener("abort", abort, { once: true })
      active.pendingTool = pending
      active.status = "waiting_for_user"
      this.emitStateChange(chatId)
    })
  }

  respondToolEffect(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const self = this
    return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("chatId", command.chatId)
    const active = self.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      return yield* Effect.fail(new Error("No pending tool request"))
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      return yield* Effect.fail(new Error("Tool response does not match active request"))
    }
    pending.validateResult?.(command.result)

    if (pending.resultOwner !== "tool") {
      yield* storeWriteEffect(self.store.appendMessage(
        command.chatId,
        timestamped({
          kind: "tool_result",
          toolId: command.toolUseId,
          content: command.result,
        })
      ))
    }

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed) {
        active.planExited = true
        // The chat is no longer read-only, and the record is what a turn Kanna
        // starts on its own reads: a sub-chat's report, a schedule, a resume.
      yield* storeWriteEffect(self.store.setPlanMode(command.chatId, false))
      }
      if (result.confirmed && result.clearContext) {
        yield* storeWriteEffect(self.store.setSessionToken(command.chatId, null))
        yield* storeWriteEffect(self.store.appendMessage(command.chatId, timestamped({ kind: "context_cleared" })))
      }

      // Neither can hand the answer back to the running agent, so it goes in
      // a follow-up turn on the same session (see grok-cli startTurn).
      if (active.provider === "codex" || active.provider === "grok") {
        active.postToolFollowUp = result.confirmed
          ? {
              content: result.message
                ? `Proceed with the approved plan. Additional guidance: ${result.message}`
                : "Proceed with the approved plan.",
              planMode: false,
            }
          : {
              content: result.message
                ? `Revise the plan using this feedback: ${result.message}`
                : "Revise the plan using this feedback.",
              planMode: true,
            }
      }
    } else if (pending.tool.toolKind === "ask_user_question" && active.provider === "grok") {
      active.postToolFollowUp = {
        content: formatQuestionAnswersFollowUp(pending.tool.input.questions, command.result),
        planMode: active.planMode,
      }
    }

    pending.resolve(command.result)

    self.emitStateChange(command.chatId)
    }).pipe(Effect.withSpan("Agent.respondTool"))
  }

  /** Compatibility for callers that have not moved to Effect yet. */
  respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>): Promise<void> {
    return runKanna(this.respondToolEffect(command))
  }
}

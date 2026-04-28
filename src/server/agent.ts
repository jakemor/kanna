import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentProvider,
  ChatAttachment,
  ContextWindowUsageSnapshot,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  KannaStatus,
  QueuedChatMessage,
  SlashCommand,
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { EventStore } from "./event-store"
import type { AnalyticsReporter } from "./analytics"
import { NoopAnalyticsReporter } from "./analytics"
import { CodexAppServerManager } from "./codex-app-server"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  codexServiceTierFromModelOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import { AUTO_CONTINUE_EVENT_VERSION, type AutoContinueEvent } from "./auto-continue/events"
import { ClaudeLimitDetector, CodexLimitDetector, type LimitDetection, type LimitDetector } from "./auto-continue/limit-detector"
import type { ScheduleManager } from "./auto-continue/schedule-manager"
import { deriveChatSchedules } from "./auto-continue/read-model"
import type { TunnelGateway } from "./cloudflare-tunnel/gateway"

const CLAUDE_TOOLSET = [
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
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
] as const

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
  resolve: (result: unknown) => void
}

interface ActiveTurn {
  chatId: string
  provider: AgentProvider
  turn: HarnessTurn
  claudePromptSeq?: number
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  status: KannaStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean
  clientTraceId?: string
  profilingStartedAt?: number
}

interface ClaudeSessionHandle {
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<any>
  interrupt: () => Promise<void>
  close: () => void
  sendPrompt: (content: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  getSupportedCommands: () => Promise<SlashCommand[]>
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  pendingPromptSeqs: number[]
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  analytics?: AnalyticsReporter
  codexManager?: CodexAppServerManager
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  tunnelGateway?: TunnelGateway
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  }) => Promise<ClaudeSessionHandle>
  claudeLimitDetector?: LimitDetector
  codexLimitDetector?: LimitDetector
  scheduleManager?: ScheduleManager
  getAutoResumePreference?: () => boolean
  throwOnClaudeSessionStart?: boolean
}

interface SendToStartingProfile {
  traceId: string
  startedAt: number
}

function isClaudeSteerLoggingEnabled() {
  return process.env.KANNA_LOG_CLAUDE_STEER === "1"
}

function logClaudeSteer(stage: string, details?: Record<string, unknown>) {
  if (!isClaudeSteerLoggingEnabled()) return
  console.log("[kanna/claude-steer]", JSON.stringify({
    stage,
    ...details,
  }))
}

const STEERED_MESSAGE_PREFIX = `<system-message>
The user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.
</system-message>`

interface SendMessageOptions {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  effort?: string
  planMode?: boolean
  autoContinue?: { scheduleId: string }
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function buildSteeredMessageContent(content: string) {
  return content.trim().length > 0
    ? `${STEERED_MESSAGE_PREFIX}\n\n${content}`
    : STEERED_MESSAGE_PREFIX
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === "object") {
          const r = item as Record<string, unknown>
          return typeof r.text === "string" ? r.text : ""
        }
        return ""
      })
      .join("")
  }
  return ""
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function isSendToStartingProfilingEnabled() {
  return process.env.KANNA_PROFILE_SEND_TO_STARTING === "1"
}

function elapsedProfileMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

function logSendToStartingProfile(
  profile: SendToStartingProfile | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!profile || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[kanna/send->starting][server]", JSON.stringify({
    traceId: profile.traceId,
    stage,
    elapsedMs: elapsedProfileMs(profile.startedAt),
    ...details,
  }))
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

export function normalizeClaudeUsageSnapshot(
  value: unknown,
  maxTokens?: number,
): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const directInputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens) ?? 0
  const cacheCreationInputTokens =
    asNumber(usage.cache_creation_input_tokens) ?? asNumber(usage.cacheCreationInputTokens) ?? 0
  const cacheReadInputTokens =
    asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cacheReadInputTokens) ?? 0
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens) ?? 0
  const reasoningOutputTokens =
    asNumber(usage.reasoning_output_tokens) ?? asNumber(usage.reasoningOutputTokens)
  const toolUses = asNumber(usage.tool_uses) ?? asNumber(usage.toolUses)
  const durationMs = asNumber(usage.duration_ms) ?? asNumber(usage.durationMs)

  const inputTokens = directInputTokens + cacheCreationInputTokens + cacheReadInputTokens
  const usedTokens = inputTokens + outputTokens
  if (usedTokens <= 0) {
    return null
  }

  return {
    usedTokens,
    inputTokens,
    ...(cacheReadInputTokens > 0 ? { cachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheReadInputTokens > 0 ? { lastCachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
    compactsAutomatically: false,
  }
}

export function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  const record = asRecord(modelUsage)
  if (!record) return undefined

  let maxContextWindow: number | undefined
  for (const value of Object.values(record)) {
    const usage = asRecord(value)
    const contextWindow = asNumber(usage?.contextWindow) ?? asNumber(usage?.context_window)
    if (contextWindow === undefined) continue
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow)
  }
  return maxContextWindow
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

export function normalizeClaudeStreamMessage(message: any): TranscriptEntry[] {
  const debugRaw = JSON.stringify(message)
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
        debugRaw,
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
          debugRaw,
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
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        entries.push(timestamped({
          kind: "tool_result",
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
          debugRaw,
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId, debugRaw })]
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
        debugRaw,
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId, debugRaw })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content, debugRaw })]
  }

  return []
}

async function* createClaudeHarnessStream(q: Query): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined

  for await (const sdkMessage of q as AsyncIterable<any>) {
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken }
    }

    if (sdkMessage?.type === "assistant") {
      const usageId = getClaudeAssistantMessageUsageId(sdkMessage)
      const usageSnapshot = normalizeClaudeUsageSnapshot(sdkMessage.usage, lastKnownContextWindow)
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

      const accumulatedUsage = normalizeClaudeUsageSnapshot(
        sdkMessage.usage,
        resultContextWindow ?? lastKnownContextWindow,
      )
      const finalUsage = latestUsageSnapshot
        ? {
            ...latestUsageSnapshot,
            ...(typeof (resultContextWindow ?? lastKnownContextWindow) === "number"
              ? { maxTokens: resultContextWindow ?? lastKnownContextWindow }
              : {}),
            ...(accumulatedUsage && accumulatedUsage.usedTokens > latestUsageSnapshot.usedTokens
              ? { totalProcessedTokens: accumulatedUsage.usedTokens }
              : {}),
          }
        : accumulatedUsage

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

    for (const entry of normalizeClaudeStreamMessage(sdkMessage)) {
      yield { type: "transcript", entry }
    }
  }
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    if (this.closed) {
      throw new Error("Cannot push to a closed queue")
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }

    this.values.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }

        if (this.closed) {
          return { done: true, value: undefined as never }
        }

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

async function startClaudeSession(args: {
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
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

  const promptQueue = new AsyncMessageQueue<SDKUserMessage>()

  const q = query({
    prompt: promptQueue,
    options: {
      cwd: args.localPath,
      model: args.model,
      effort: args.effort as "low" | "medium" | "high" | "max" | undefined,
      resume: args.sessionToken ?? undefined,
      forkSession: args.forkSession,
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,
      tools: [...CLAUDE_TOOLSET],
      settingSources: ["user", "project", "local"],
      env: (() => { const { CLAUDECODE: _, ...env } = process.env; return env })(),
    },
  })

  return {
    provider: "claude",
    stream: createClaudeHarnessStream(q),
    getAccountInfo: async () => {
      try {
        return await q.accountInfo()
      } catch {
        return null
      }
    },
    interrupt: async () => {
      await q.interrupt()
    },
    sendPrompt: async (content: string) => {
      promptQueue.push({
        type: "user",
        message: {
          role: "user",
          content,
        },
        parent_tool_use_id: null,
        session_id: args.sessionToken ?? "",
      })
    },
    setModel: async (model: string) => {
      await q.setModel(model)
    },
    setPermissionMode: async (planMode: boolean) => {
      await q.setPermissionMode(planMode ? "plan" : "acceptEdits")
    },
    getSupportedCommands: async () => {
      try {
        return await q.supportedCommands()
      } catch (error) {
        console.warn("[kanna/claude] supportedCommands failed", error)
        return []
      }
    },
    close: () => {
      promptQueue.close()
      q.close()
    },
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly analytics: AnalyticsReporter
  private readonly codexManager: CodexAppServerManager
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private reportBackgroundError: ((message: string) => void) | null = null
  readonly activeTurns = new Map<string, ActiveTurn>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()
  private readonly slashCommandsInFlight = new Set<string>()
  private readonly claudeLimitDetector: LimitDetector
  private readonly codexLimitDetector: LimitDetector
  private readonly scheduleManager: ScheduleManager | null
  private readonly getAutoResumePreference: () => boolean
  private readonly throwOnClaudeSessionStart: boolean
  private readonly autoResumeByChat = new Map<string, boolean>()
  private readonly tunnelGateway: TunnelGateway | null
  private readonly pendingBashCalls = new Map<string, { command: string; chatId: string }>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.analytics = args.analytics ?? NoopAnalyticsReporter
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.generateTitle = args.generateTitle ?? generateTitleForChatDetailed
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.claudeLimitDetector = args.claudeLimitDetector ?? new ClaudeLimitDetector()
    this.codexLimitDetector = args.codexLimitDetector ?? new CodexLimitDetector()
    this.scheduleManager = args.scheduleManager ?? null
    this.getAutoResumePreference = args.getAutoResumePreference ?? (() => false)
    this.throwOnClaudeSessionStart = args.throwOnClaudeSessionStart ?? false
    this.tunnelGateway = args.tunnelGateway ?? null
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }

  getActiveStatuses() {
    const statuses = new Map<string, KannaStatus>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return { toolUseId: pending.toolUseId, toolKind: pending.tool.toolKind }
  }

  getDrainingChatIds(): Set<string> {
    return new Set(this.drainingStreams.keys())
  }

  getSlashCommandsLoadingChatIds(): Set<string> {
    return new Set(this.slashCommandsInFlight)
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  private trackBashToolEntry(chatId: string, entry: TranscriptEntry): void {
    if (!this.tunnelGateway) return

    if (entry.kind === "tool_call" && entry.tool.toolKind === "bash") {
      const command = entry.tool.input.command ?? ""
      this.pendingBashCalls.set(entry.tool.toolId, { command, chatId })
      return
    }

    if (entry.kind === "tool_result") {
      const pending = this.pendingBashCalls.get(entry.toolId)
      if (!pending) return
      this.pendingBashCalls.delete(entry.toolId)
      const stdout = stringifyToolResultContent(entry.content)
      void this.tunnelGateway.handleBashResult({
        command: pending.command,
        stdout,
        chatId: pending.chatId,
        sourcePid: null,
      })
    }
  }

  getActiveTurnProfile(chatId: string): SendToStartingProfile | null {
    const active = this.activeTurns.get(chatId)
    if (!active?.clientTraceId || active.profilingStartedAt === undefined) {
      return null
    }

    return {
      traceId: active.clientTraceId,
      startedAt: active.profilingStartedAt,
    }
  }

  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.drainingStreams.delete(chatId)
    this.emitStateChange(chatId)
  }

  async ensureSlashCommandsLoaded(chatId: string): Promise<void> {
    const chat = this.store.getChat(chatId)
    if (!chat) return
    if (chat.provider === "codex") return
    if (chat.slashCommands && chat.slashCommands.length > 0) return
    if (this.slashCommandsInFlight.has(chatId)) return

    const project = this.store.getProject(chat.projectId)
    if (!project) return

    this.slashCommandsInFlight.add(chatId)
    this.emitStateChange(chatId)
    try {
      let commands: SlashCommand[]
      const existing = this.claudeSessions.get(chatId)
      if (existing) {
        commands = await existing.session.getSupportedCommands()
      } else {
        const defaultModel = normalizeServerModel("claude")
        const defaultOptions = normalizeClaudeModelOptions(defaultModel)
        const ephemeral = await this.startClaudeSessionFn({
          localPath: project.localPath,
          model: resolveClaudeApiModelId(defaultModel, defaultOptions.contextWindow),
          effort: defaultOptions.reasoningEffort,
          planMode: chat.planMode ?? false,
          sessionToken: chat.sessionToken ?? null,
          forkSession: false,
          onToolRequest: async () => null,
        })
        try {
          commands = await ephemeral.getSupportedCommands()
        } finally {
          ephemeral.close()
        }
      }
      await this.store.recordSessionCommandsLoaded(chatId, commands)
      this.emitStateChange(chatId)
    } catch (error) {
      console.warn("[kanna/agent] ensureSlashCommandsLoaded failed", error)
    } finally {
      this.slashCommandsInFlight.delete(chatId)
      this.emitStateChange(chatId)
    }
  }

  async closeChat(chatId: string) {
    await this.stopDraining(chatId)
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      claudeSession.session.close()
      this.claudeSessions.delete(chatId)
    }
    this.autoResumeByChat.delete(chatId)
    this.emitStateChange(chatId)
  }

  private resolveProvider(options: SendMessageOptions, currentProvider: AgentProvider | null) {
    if (currentProvider) return currentProvider
    return options.provider ?? "claude"
  }

  private getProviderSettings(provider: AgentProvider, options: SendMessageOptions) {
    const catalog = getServerProviderCatalog(provider)
    if (provider === "claude") {
      const model = normalizeServerModel(provider, options.model)
      const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
      return {
        model: resolveClaudeApiModelId(model, modelOptions.contextWindow),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
      }
    }

    const modelOptions = normalizeCodexModelOptions(options.modelOptions, options.effort)
    return {
      model: normalizeServerModel(provider, options.model),
      effort: modelOptions.reasoningEffort,
      serviceTier: codexServiceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
    }
  }

  private async enqueueMessage(chatId: string, content: string, attachments: ChatAttachment[], options?: SendMessageOptions) {
    const queued = await this.store.enqueueMessage(chatId, {
      content,
      attachments,
      provider: options?.provider,
      model: options?.model,
      modelOptions: options?.modelOptions,
      planMode: options?.planMode,
      autoContinue: options?.autoContinue,
    })
    this.emitStateChange(chatId)
    return queued
  }

  private async dequeueAndStartQueuedMessage(chatId: string, queuedMessage: QueuedChatMessage, options?: { steered?: boolean }) {
    await this.store.removeQueuedMessage(chatId, queuedMessage.id)
    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(queuedMessage, chat.provider)
    const settings = this.getProviderSettings(provider, queuedMessage)
    await this.startTurnForChat({
      chatId,
      provider,
      content: options?.steered ? buildSteeredMessageContent(queuedMessage.content) : queuedMessage.content,
      attachments: queuedMessage.attachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      steered: options?.steered,
      autoContinue: queuedMessage.autoContinue,
    })
  }

  private async maybeStartNextQueuedMessage(chatId: string) {
    if (this.activeTurns.has(chatId)) return false
    const nextQueuedMessage = typeof this.store.getQueuedMessages === "function"
      ? this.store.getQueuedMessages(chatId)[0]
      : undefined
    if (!nextQueuedMessage) return false
    await this.dequeueAndStartQueuedMessage(chatId, nextQueuedMessage)
    return true
  }

  private async startTurnForChat(args: {
    chatId: string
    provider: AgentProvider
    content: string
    attachments: ChatAttachment[]
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    appendUserPrompt: boolean
    steered?: boolean
    autoContinue?: { scheduleId: string }
    profile?: SendToStartingProfile | null
  }) {
    logSendToStartingProfile(args.profile, "start_turn.begin", {
      chatId: args.chatId,
      provider: args.provider,
      appendUserPrompt: args.appendUserPrompt,
      planMode: args.planMode,
    })

    // Close any lingering draining stream before starting a new turn.
    const draining = this.drainingStreams.get(args.chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(args.chatId)
    }

    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId)) {
      throw new Error("Chat is already running")
    }

    if (!chat.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
      logSendToStartingProfile(args.profile, "start_turn.provider_set", {
        chatId: args.chatId,
        provider: args.provider,
      })
    }
    await this.store.setPlanMode(args.chatId, args.planMode)
    logSendToStartingProfile(args.profile, "start_turn.plan_mode_set", {
      chatId: args.chatId,
      planMode: args.planMode,
    })

    const existingMessages = this.store.getMessages(args.chatId)
    const shouldGenerateTitle = args.appendUserPrompt && chat.title === "New Chat" && existingMessages.length === 0
    const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null

    if (optimisticTitle) {
      await this.store.renameChat(args.chatId, optimisticTitle)
      logSendToStartingProfile(args.profile, "start_turn.optimistic_title_set", {
        chatId: args.chatId,
        title: optimisticTitle,
      })
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    if (args.appendUserPrompt) {
      const userPromptEntry = timestamped(
        { kind: "user_prompt", content: args.content, attachments: args.attachments, steered: args.steered, autoContinue: args.autoContinue },
        Date.now()
      )
      await this.store.appendMessage(args.chatId, userPromptEntry)
      logSendToStartingProfile(args.profile, "start_turn.user_prompt_appended", {
        chatId: args.chatId,
        entryId: userPromptEntry._id,
      })
    }
    await this.store.recordTurnStarted(args.chatId)
    logSendToStartingProfile(args.profile, "start_turn.turn_started_recorded", {
      chatId: args.chatId,
    })

    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat")
    }

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      const active = this.activeTurns.get(args.chatId)
      if (!active) {
        throw new Error("Chat turn ended unexpectedly")
      }

      active.status = "waiting_for_user"
      this.emitStateChange(args.chatId)

      return await new Promise<unknown>((resolve) => {
        active.pendingTool = {
          toolUseId: request.tool.toolId,
          tool: request.tool,
          resolve,
        }
      })
    }

    let turn: HarnessTurn
    if (args.provider === "claude") {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.startClaudeTurn({
        chatId: args.chatId,
        localPath: project.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        onToolRequest,
      })
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    } else {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      const sessionToken = await this.codexManager.startSession({
        chatId: args.chatId,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
      })
      if (chat.pendingForkSessionToken && sessionToken) {
        await this.store.setPendingForkSessionToken(args.chatId, null)
      }
      logSendToStartingProfile(args.profile, "start_turn.session_ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.codexManager.startTurn({
        chatId: args.chatId,
        content: buildPromptText(args.content, args.attachments),
        model: args.model,
        effort: args.effort as any,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        onToolRequest,
      })
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    }

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      status: args.provider === "claude" ? "running" : "starting",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
      clientTraceId: args.profile?.traceId,
      profilingStartedAt: args.profile?.startedAt,
    }
    this.activeTurns.set(args.chatId, active)
    logSendToStartingProfile(args.profile, "start_turn.active_turn_registered", {
      chatId: args.chatId,
      status: active.status,
    })
    this.emitStateChange(args.chatId, { immediate: active.status === "starting" })
    logSendToStartingProfile(args.profile, "start_turn.state_change_emitted", {
      chatId: args.chatId,
      status: active.status,
    })

    if (turn.getAccountInfo) {
      void turn.getAccountInfo()
        .then(async (accountInfo) => {
          if (!accountInfo) return
          if (args.provider === "claude") {
            const session = this.claudeSessions.get(args.chatId)
            if (session) {
              if (session.accountInfoLoaded) return
              session.accountInfoLoaded = true
            } else {
              return
            }
          }
          await this.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo }))
          this.emitStateChange(args.chatId)
        })
        .catch(() => undefined)
    }

    if (args.provider === "claude") {
      const session = this.claudeSessions.get(args.chatId)
      if (!session) {
        throw new Error("Claude session was not initialized")
      }
      const promptSeq = session.nextPromptSeq + 1
      session.nextPromptSeq = promptSeq
      session.pendingPromptSeqs.push(promptSeq)
      active.claudePromptSeq = promptSeq
      logClaudeSteer("claude_prompt_sent", {
        chatId: args.chatId,
        sessionId: session.id,
        promptSeq,
        activeStatus: active.status,
        contentPreview: args.content.slice(0, 160),
        pendingPromptSeqs: [...session.pendingPromptSeqs],
      })
      await session.session.sendPrompt(buildPromptText(args.content, args.attachments))
      logSendToStartingProfile(args.profile, "start_turn.claude_prompt_sent", {
        chatId: args.chatId,
      })
      return
    }

    void this.runTurn(active)
  }

  private async startClaudeTurn(args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  }): Promise<HarnessTurn> {
    let session = this.claudeSessions.get(args.chatId)

    if (!session || session.localPath !== args.localPath || session.effort !== args.effort || args.forkSession) {
      if (session) {
        session.session.close()
        this.claudeSessions.delete(args.chatId)
      }

      const started = await this.startClaudeSessionFn({
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
      })

      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: started,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
      }
      this.claudeSessions.set(args.chatId, session)
      void this.runClaudeSession(session)
      void (async () => {
        try {
          const commands = await started.getSupportedCommands()
          await this.store.recordSessionCommandsLoaded(args.chatId, commands)
          this.emitStateChange(args.chatId)
        } catch (error) {
          console.warn("[kanna/agent] failed to load slash commands", error)
        }
      })()
    } else {
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
    }

    return {
      provider: "claude",
      stream: {
        async *[Symbol.asyncIterator]() {},
      },
      getAccountInfo: session.session.getAccountInfo,
      interrupt: session.session.interrupt,
      close: () => {},
    }
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>) {
    const profile = command.clientTraceId
      ? { traceId: command.clientTraceId, startedAt: performance.now() }
      : null
    let chatId = command.chatId

    logSendToStartingProfile(profile, "chat_send.received", {
      existingChatId: command.chatId ?? null,
      projectId: command.projectId ?? null,
    })

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      this.analytics.track("chat_created")
      logSendToStartingProfile(profile, "chat_send.chat_created", {
        chatId,
        projectId: command.projectId,
      })
    }

    if (typeof command.autoResumeOnRateLimit === "boolean" && chatId) {
      this.autoResumeByChat.set(chatId, command.autoResumeOnRateLimit)
    }

    const chat = this.store.requireChat(chatId)
    if (this.activeTurns.has(chatId)) {
      this.analytics.track("message_sent")
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    const provider = this.resolveProvider(command, chat.provider)
    const settings = this.getProviderSettings(provider, command)
    this.analytics.track("message_sent")
    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      attachments: command.attachments ?? [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      profile,
    })

    logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
      chatId,
      provider,
      model: settings.model,
    })

    return { chatId }
  }

  async enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>) {
    if (typeof command.autoResumeOnRateLimit === "boolean") {
      this.autoResumeByChat.set(command.chatId, command.autoResumeOnRateLimit)
    }
    this.analytics.track("message_sent")
    const queuedMessage = await this.enqueueMessage(command.chatId, command.content, command.attachments ?? [], {
      provider: command.provider,
      model: command.model,
      modelOptions: command.modelOptions,
      planMode: command.planMode,
    })
    return { queuedMessageId: queuedMessage.id }
  }

  async steer(command: Extract<ClientCommand, { type: "message.steer" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }

    logClaudeSteer("steer_requested", {
      chatId: command.chatId,
      queuedMessageId: command.queuedMessageId,
      activeTurn: this.activeTurns.has(command.chatId),
      queuedMessagePreview: queuedMessage.content.slice(0, 160),
    })

    if (this.activeTurns.has(command.chatId)) {
      await this.cancel(command.chatId, { hideInterrupted: true })
    }

    logClaudeSteer("steer_after_cancel", {
      chatId: command.chatId,
      stillActive: this.activeTurns.has(command.chatId),
    })

    if (this.activeTurns.has(command.chatId)) {
      throw new Error("Chat is still running")
    }

    await this.dequeueAndStartQueuedMessage(command.chatId, queuedMessage, { steered: true })
  }

  async dequeue(command: Extract<ClientCommand, { type: "message.dequeue" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }

    await this.store.removeQueuedMessage(command.chatId, command.queuedMessageId)
  }

  async forkChat(chatId: string) {
    const chat = this.store.requireChat(chatId)
    if (this.activeTurns.has(chatId) || this.drainingStreams.has(chatId)) {
      throw new Error("Chat must be idle before forking")
    }
    if (!chat.provider) {
      throw new Error("Chat must have a provider before forking")
    }
    if (!chat.sessionToken && !chat.pendingForkSessionToken) {
      throw new Error("Chat has no session to fork")
    }

    const forked = await this.store.forkChat(chatId)
    this.analytics.track("chat_created")
    return { chatId: forked.id }
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    try {
      let simulateLimit = this.throwOnClaudeSessionStart
      for await (const event of session.session.stream) {
        if (simulateLimit) {
          simulateLimit = false
          throw new Error("simulated rate limit")
        }
        if (event.type === "session_token" && event.sessionToken) {
          session.sessionToken = event.sessionToken
          await this.store.setSessionToken(session.chatId, event.sessionToken)
          this.emitStateChange(session.chatId)
          continue
        }

        if (!event.entry) continue
        await this.store.appendMessage(session.chatId, event.entry)
        this.trackBashToolEntry(session.chatId, event.entry)
        const active = this.activeTurns.get(session.chatId)
        if (event.entry.kind === "system_init" && active) {
          active.status = "running"
          const chat = this.store.getChat(session.chatId)
          if (
            chat?.pendingForkSessionToken
            && session.sessionToken
            && session.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(session.chatId, null)
          }
          logClaudeSteer("claude_event_system_init", {
            chatId: session.chatId,
            sessionId: session.id,
            activePromptSeq: active.claudePromptSeq ?? null,
            pendingPromptSeqs: [...session.pendingPromptSeqs],
          })
        }

        const completedClaudePromptSeq = event.entry.kind === "result" || event.entry.kind === "interrupted"
          ? (session.pendingPromptSeqs.shift() ?? null)
          : null

        logClaudeSteer("claude_event", {
          chatId: session.chatId,
          sessionId: session.id,
          entryKind: event.entry.kind,
          activePromptSeq: active?.claudePromptSeq ?? null,
          completedPromptSeq: completedClaudePromptSeq,
          activeStatus: active?.status ?? null,
          pendingPromptSeqs: [...session.pendingPromptSeqs],
        })

        if (event.entry.kind === "result" && active && completedClaudePromptSeq === (active.claudePromptSeq ?? null)) {
          active.hasFinalResult = true
          if (event.entry.isError) {
            const resultText = event.entry.result || "Turn failed"
            const detection = this.claudeLimitDetector.detectFromResultText?.(session.chatId, resultText) ?? null
            let handled = false
            if (detection) {
              handled = await this.handleLimitDetection(session.chatId, detection)
            }
            if (handled) {
              await this.store.recordTurnFailed(session.chatId, "rate_limit")
            } else {
              await this.store.recordTurnFailed(session.chatId, resultText)
            }
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(session.chatId)
          }
          this.activeTurns.delete(session.chatId)
          if (!active.cancelRequested) {
            await this.maybeStartNextQueuedMessage(session.chatId)
          }
        }

        this.emitStateChange(session.chatId)
      }
    } catch (error) {
      const active = this.activeTurns.get(session.chatId)
      if (active && !active.cancelRequested) {
        const handled = await this.handleLimitError(session.chatId, this.claudeLimitDetector, error)
        if (!handled) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            session.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(session.chatId, message)
        } else {
          await this.store.recordTurnFailed(session.chatId, "rate_limit")
        }
      }
    } finally {
      this.claudeSessions.delete(session.chatId)
      const active = this.activeTurns.get(session.chatId)
      if (active?.provider === "claude") {
        if (active.cancelRequested && !active.cancelRecorded) {
          await this.store.recordTurnCancelled(session.chatId)
        }
        this.activeTurns.delete(session.chatId)
      }
      session.session.close()
      this.emitStateChange(session.chatId)
    }
  }

  private async generateTitleInBackground(chatId: string, messageContent: string, cwd: string, expectedCurrentTitle: string) {
    try {
      const result = await this.generateTitle(messageContent, cwd)
      if (result.failureMessage) {
        this.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed provider title generation: ${result.failureMessage}`
        )
      }
      if (!result.title || result.usedFallback) return

      const chat = this.store.requireChat(chatId)
      if (chat.title !== expectedCurrentTitle) return

      await this.store.renameChat(chatId, result.title)
      this.emitStateChange(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportBackgroundError?.(
        `[title-generation] chat ${chatId} failed background title generation: ${message}`
      )
    }
  }

  private async runTurn(active: ActiveTurn) {
    try {
      for await (const event of active.turn.stream) {
        // Once cancelled, stop processing further stream events.
        // cancel() already removed us from activeTurns and notified the UI.
        if (active.cancelRequested) break

        if (event.type === "session_token" && event.sessionToken) {
          await this.store.setSessionToken(active.chatId, event.sessionToken)
          const chat = this.store.getChat(active.chatId)
          if (
            chat?.pendingForkSessionToken
            && event.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(active.chatId, null)
          }
          this.emitStateChange(active.chatId)
          continue
        }

        if (!event.entry) continue
        await this.store.appendMessage(active.chatId, event.entry)
        this.trackBashToolEntry(active.chatId, event.entry)

        if (event.entry.kind === "system_init") {
          active.status = "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
          }
          // Remove from activeTurns as soon as the result arrives so the UI
          // transitions to idle immediately. The stream may still be open
          // (e.g. background tasks), but the user should be able to send
          // new messages without having to hit stop first.
          this.activeTurns.delete(active.chatId)
          // Track the still-open stream so the UI can show a draining
          // indicator and the user can stop background tasks.
          this.drainingStreams.set(active.chatId, { turn: active.turn })
        }

        this.emitStateChange(active.chatId)
      }
    } catch (error) {
      if (!active.cancelRequested) {
        const handled = await this.handleLimitError(active.chatId, this.codexLimitDetector, error)
        if (!handled) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
        } else {
          await this.store.recordTurnFailed(active.chatId, "rate_limit")
        }
      }
    } finally {
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId)
      }
      active.turn.close()
      // Only remove if we're still the active turn for this chat.
      // We may have already been removed by result handling or cancel(),
      // and a new turn may have started for the same chatId.
      if (this.activeTurns.get(active.chatId) === active) {
        this.activeTurns.delete(active.chatId)
      }
      // Stream has fully ended — no longer draining.
      this.drainingStreams.delete(active.chatId)
      this.emitStateChange(active.chatId)

      if (active.postToolFollowUp && !active.cancelRequested) {
        try {
          await this.startTurnForChat({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            attachments: [],
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            appendUserPrompt: false,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      } else if (!active.cancelRequested) {
        try {
          await this.maybeStartNextQueuedMessage(active.chatId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      }
    }
  }

  private resolveAutoResumeFor(chatId: string): boolean {
    const cached = this.autoResumeByChat.get(chatId)
    if (typeof cached === "boolean") return cached
    return this.getAutoResumePreference()
  }

  private async emitAutoContinueEvent(event: AutoContinueEvent): Promise<void> {
    await this.store.appendAutoContinueEvent(event)
    this.scheduleManager?.onEvent(event)
    this.emitStateChange(event.chatId)
  }

  private getChatSchedule(chatId: string, scheduleId: string) {
    const events = this.store.getAutoContinueEvents(chatId)
    return deriveChatSchedules(events, chatId).schedules[scheduleId]
  }

  private requireFuture(scheduledAt: number): void {
    if (scheduledAt <= Date.now()) throw new Error("scheduledAt must be in the future")
  }

  private async handleLimitError(chatId: string, detector: LimitDetector, error: unknown): Promise<boolean> {
    const detection = detector.detect(chatId, error)
    if (!detection) return false
    return this.handleLimitDetection(chatId, detection)
  }

  private async handleLimitDetection(chatId: string, detection: LimitDetection): Promise<boolean> {
    const live = deriveChatSchedules(this.store.getAutoContinueEvents(chatId), chatId).liveScheduleId
    if (live !== null) return true

    const now = Date.now()
    const scheduleId = crypto.randomUUID()
    const base = { v: AUTO_CONTINUE_EVENT_VERSION, timestamp: now, chatId, scheduleId }

    const event: AutoContinueEvent = this.resolveAutoResumeFor(chatId)
      ? {
          ...base,
          kind: "auto_continue_accepted",
          scheduledAt: detection.resetAt,
          tz: detection.tz,
          source: "auto_setting",
          resetAt: detection.resetAt,
          detectedAt: now,
        }
      : {
          ...base,
          kind: "auto_continue_proposed",
          detectedAt: now,
          resetAt: detection.resetAt,
          tz: detection.tz,
        }

    await this.emitAutoContinueEvent(event)
    await this.store.appendMessage(chatId, timestamped({
      kind: "auto_continue_prompt",
      scheduleId,
    }))

    return true
  }

  async fireAutoContinue(chatId: string, scheduleId: string) {
    if (!this.store.getChat(chatId)) return

    const event: AutoContinueEvent = {
      v: AUTO_CONTINUE_EVENT_VERSION,
      kind: "auto_continue_fired",
      timestamp: Date.now(),
      chatId,
      scheduleId,
    }
    try {
      await this.store.appendAutoContinueEvent(event)
      await this.enqueueMessage(chatId, "continue", [], { autoContinue: { scheduleId } })
      await this.maybeStartNextQueuedMessage(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(chatId, timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: `Auto-continue failed: ${message}`,
      }))
    }

    this.emitStateChange(chatId)
  }

  async acceptAutoContinue(chatId: string, scheduleId: string, scheduledAt: number): Promise<void> {
    const schedule = this.getChatSchedule(chatId, scheduleId)
    if (!schedule) throw new Error("Schedule not found")
    if (schedule.state !== "proposed") throw new Error("Schedule not pending")
    this.requireFuture(scheduledAt)

    await this.emitAutoContinueEvent({
      v: AUTO_CONTINUE_EVENT_VERSION,
      kind: "auto_continue_accepted",
      timestamp: Date.now(),
      chatId,
      scheduleId,
      scheduledAt,
      tz: schedule.tz,
      source: "user",
      resetAt: schedule.resetAt,
      detectedAt: schedule.detectedAt,
    })
  }

  async rescheduleAutoContinue(chatId: string, scheduleId: string, scheduledAt: number): Promise<void> {
    const schedule = this.getChatSchedule(chatId, scheduleId)
    if (!schedule || schedule.state !== "scheduled") throw new Error("Schedule not active")
    this.requireFuture(scheduledAt)

    await this.emitAutoContinueEvent({
      v: AUTO_CONTINUE_EVENT_VERSION,
      kind: "auto_continue_rescheduled",
      timestamp: Date.now(),
      chatId,
      scheduleId,
      scheduledAt,
    })
  }

  async cancelAutoContinue(chatId: string, scheduleId: string, reason: "user" | "chat_deleted"): Promise<void> {
    const schedule = this.getChatSchedule(chatId, scheduleId)
    if (!schedule) return
    if (schedule.state !== "proposed" && schedule.state !== "scheduled") return

    await this.emitAutoContinueEvent({
      v: AUTO_CONTINUE_EVENT_VERSION,
      kind: "auto_continue_cancelled",
      timestamp: Date.now(),
      chatId,
      scheduleId,
      reason,
    })
  }

  listLiveSchedules(chatId: string): string[] {
    const { schedules } = deriveChatSchedules(this.store.getAutoContinueEvents(chatId), chatId)
    return Object.values(schedules)
      .filter((s) => s.state === "proposed" || s.state === "scheduled")
      .map((s) => s.scheduleId)
      .sort()
  }

  async cancel(chatId: string, options?: { hideInterrupted?: boolean }) {
    // Also clean up any draining stream for this chat.
    const draining = this.drainingStreams.get(chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(chatId)
    }

    const active = this.activeTurns.get(chatId)
    if (!active) return

    logClaudeSteer("cancel_requested", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Guard against concurrent cancel() calls — only the first one does work.
    if (active.cancelRequested) return
    active.cancelRequested = true

    const pendingTool = active.pendingTool
    active.pendingTool = null

    if (pendingTool) {
      const result = discardedToolResult(pendingTool.tool)
      await this.store.appendMessage(
        chatId,
        timestamped({
          kind: "tool_result",
          toolId: pendingTool.toolUseId,
          content: result,
        })
      )
      if (active.provider === "codex" && pendingTool.tool.toolKind === "exit_plan_mode") {
        pendingTool.resolve(result)
      }
    }

    await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
    await this.store.recordTurnCancelled(chatId)
    active.cancelRecorded = true
    active.hasFinalResult = true

    // Remove from activeTurns immediately so the UI reflects the cancellation
    // right away, rather than waiting for interrupt() which may hang.
    this.activeTurns.delete(chatId)
    this.emitStateChange(chatId)
    logClaudeSteer("cancel_active_turn_deleted", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Now attempt to interrupt/close the underlying stream in the background.
    // This is best-effort — the turn is already removed from active state above,
    // and runTurn()'s finally block will also call close().
    try {
      await Promise.race([
        active.turn.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    } catch {
      // interrupt() failed — force close
    }
    active.turn.close()
  }

  async respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const active = this.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      throw new Error("No pending tool request")
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }

    await this.store.appendMessage(
      command.chatId,
      timestamped({
        kind: "tool_result",
        toolId: command.toolUseId,
        content: command.result,
      })
    )

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        await this.store.setSessionToken(command.chatId, null)
        await this.store.appendMessage(command.chatId, timestamped({ kind: "context_cleared" }))
      }

      if (active.provider === "codex") {
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
    }

    pending.resolve(command.result)

    this.emitStateChange(command.chatId)
  }
}

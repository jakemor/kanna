import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "node:os"
import type {
  AgentProvider,
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
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { AsyncQueue } from "./async-queue"
import { EventStore } from "./event-store"
import type { AnalyticsReporter } from "./analytics"
import { NoopAnalyticsReporter } from "./analytics"
import { CodexAppServerManager } from "./codex-app-server"
import { CursorCliManager } from "./cursor-cli"
import { PiAgentManager, resolvePiConnection } from "./pi-agent"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import type { ClaudeRateLimitInfoRaw, ClaudeUsageRaw } from "./usage-limits"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  appendSystemMessageBlock,
  buildSkillSystemMessage,
  findSkillByName,
  parseSkillInvocation,
  scanClaudeSkills,
  scanCodexSkills,
  scanCursorSkills,
} from "./harness-skills"
import {
  applyClaudeSdkModels,
  applyCursorModels,
  type ClaudeSdkModelInfo,
  cursorModelIdForOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizePiModelOptions,
  normalizeServerModel,
  serviceTierFromModelOptions,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import { asNumber, asRecord } from "../shared/json"
import { buildHandoffContext, buildHandoffMessageContent, type HandoffContext } from "./handoff"
import { checkSessionArtifact, type SessionArtifactStatus } from "./session-artifacts"
import { timestamped } from "./transcript"

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
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "Monitor",
  "PushNotification",
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
}

interface ClaudeSessionHandle {
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<any>
  getUsage?: () => Promise<ClaudeUsageRaw | null>
  interrupt: () => Promise<void>
  close: () => void
  sendPrompt: (content: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  setFastMode?: (fastMode: boolean) => Promise<void>
  supportedModels?: () => Promise<ClaudeSdkModelInfo[]>
  supportedCommands?: () => Promise<SlashCommand[]>
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  pendingPromptSeqs: number[]
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
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  analytics?: AnalyticsReporter
  codexManager?: CodexAppServerManager
  cursorManager?: CursorCliManager
  piManager?: PiAgentManager
  resolvePiConnection?: () => Promise<import("./pi-agent").PiConnection | null>
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
  }) => Promise<ClaudeSessionHandle>
  /**
   * Probe whether a provider's native session artifact still exists on disk.
   * Injectable so tests can force a "missing" session without touching the
   * filesystem. Defaults to the real {@link checkSessionArtifact}.
   */
  checkSessionArtifact?: (
    provider: AgentProvider,
    query: { cwd: string; sessionToken: string | null | undefined }
  ) => SessionArtifactStatus
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

export function normalizeClaudeContextUsage(value: unknown): { usedTokens: number; maxTokens?: number } | null {
  const record = asRecord(value)
  if (!record) return null

  const usedTokens = asNumber(record.totalTokens)
  if (usedTokens === undefined || usedTokens <= 0) return null

  const maxTokens = asNumber(record.maxTokens)
  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
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

export function normalizeClaudeStreamMessage(message: any): TranscriptEntry[] {
  // Raw SDK JSON is kept only where the client actually consumes it: the
  // system_init raw view and tool_use_result extraction on tool_result
  // entries. Stamping it on every entry doubled transcript size on disk
  // and on every snapshot push — so serialize lazily, inside only the
  // branches that keep it, never on streaming deltas.
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
    let debugRaw: string | undefined
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        debugRaw ??= JSON.stringify(message)
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

async function* createClaudeHarnessStream(
  q: Query,
  hooks?: {
    onCommandsChanged?: (commands: SlashCommand[]) => void
    onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
  }
): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined

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

    for (const entry of normalizeClaudeStreamMessage(sdkMessage)) {
      yield { type: "transcript", entry }
    }
  }
}


async function startClaudeSession(args: {
  localPath: string
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
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

  const promptQueue = new AsyncQueue<SDKUserMessage>()
  let promptQueueClosed = false

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
      // fastMode must go through the flag-settings layer: the CLI only allows
      // fast mode in Agent SDK sessions when flagSettings.fastMode is true,
      // and an explicit false keeps a user-level settings.json from silently
      // enabling it while the UI shows "Standard".
      settings: { enableWorkflows: true, fastMode: args.serviceTier === "fast" },
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, homedir()) || undefined,
      env: (() => { const { CLAUDECODE: _, ...env } = process.env; return env })(),
    },
  })

  // Latest command list pushed via system/commands_changed; null until the
  // first push. supportedCommands() below prefers this over a q re-fetch.
  const commandsRef: { current: SlashCommand[] | null } = { current: null }

  return {
    provider: "claude",
    stream: createClaudeHarnessStream(q, {
      onCommandsChanged: (commands) => {
        commandsRef.current = commands
      },
      onRateLimitEvent: args.onRateLimitEvent,
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
    sendPrompt: async (content: string) => {
      if (promptQueueClosed) {
        throw new Error("Cannot push to a closed queue")
      }
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
    setFastMode: async (fastMode: boolean) => {
      await q.applyFlagSettings({ fastMode })
    },
    supportedModels: async () => await q.supportedModels(),
    supportedCommands: async () => commandsRef.current ?? await q.supportedCommands(),
    close: () => {
      promptQueueClosed = true
      promptQueue.finish()
      q.close()
    },
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly analytics: AnalyticsReporter
  private readonly codexManager: CodexAppServerManager
  private readonly cursorManager: CursorCliManager
  private readonly piManager: PiAgentManager
  private readonly resolvePiConnection: () => Promise<import("./pi-agent").PiConnection | null>
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly checkSessionArtifactFn: NonNullable<AgentCoordinatorArgs["checkSessionArtifact"]>
  private reportBackgroundError: ((message: string) => void) | null = null
  private onClaudeRateLimit: ((info: ClaudeRateLimitInfoRaw) => void) | null = null
  private cursorModelCatalogApplied = false
  readonly activeTurns = new Map<string, ActiveTurn>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.analytics = args.analytics ?? NoopAnalyticsReporter
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.cursorManager = args.cursorManager ?? new CursorCliManager()
    this.piManager = args.piManager ?? new PiAgentManager()
    this.resolvePiConnection = args.resolvePiConnection ?? resolvePiConnection
    this.generateTitle = args.generateTitle ?? generateTitleForChatDetailed
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.checkSessionArtifactFn = args.checkSessionArtifact ?? checkSessionArtifact
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
      if (state.session.getUsage) {
        const usage = await state.session.getUsage()
        if (usage) return usage
      }
    }
    let probe: ClaudeSessionHandle | null = null
    try {
      probe = await this.startClaudeSessionFn({
        localPath: homedir(),
        // Model choice is irrelevant for the usage read; use the catalog default.
        model: "claude-sonnet-4-6",
        planMode: false,
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
  async fetchCodexRateLimits() {
    return await this.codexManager.readAccountRateLimits(homedir())
  }

  getCodexManager() {
    return this.codexManager
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
  async refreshCursorModelCatalog() {
    if (this.cursorModelCatalogApplied) return
    try {
      const models = await this.cursorManager.listModels()
      this.cursorModelCatalogApplied = true
      if (applyCursorModels(models)) {
        this.emitStateChange(undefined, { immediate: true })
      }
    } catch {
      // Keep the static fallback catalog; the next cursor turn retries.
    }
  }


  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.drainingStreams.delete(chatId)
    this.emitStateChange(chatId)
  }

  async closeChat(chatId: string) {
    await this.stopDraining(chatId)
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      claudeSession.session.close()
      this.claudeSessions.delete(chatId)
    }
    this.piManager.closeChat(chatId)
    this.emitStateChange(chatId)
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
      }
    }

    if (provider === "cursor") {
      const modelOptions = normalizeCursorModelOptions(options.modelOptions)
      return {
        model: cursorModelIdForOptions(normalizeServerModel(provider, options.model), modelOptions),
        effort: undefined,
        serviceTier: undefined,
        planMode: false,
      }
    }

    if (provider === "pi") {
      const modelOptions = normalizePiModelOptions(options.modelOptions, options.effort)
      return {
        model: normalizeServerModel(provider, options.model),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: false,
      }
    }

    const model = normalizeServerModel(provider, options.model)
    const modelOptions = normalizeCodexModelOptions(model, options.modelOptions, options.effort)
    return {
      model,
      effort: modelOptions.reasoningEffort,
      serviceTier: serviceTierFromModelOptions(modelOptions),
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
      content: queuedMessage.content,
      attachments: queuedMessage.attachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      steered: options?.steered,
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
  private async prepareProviderHandoff(
    chatId: string,
    fromProvider: AgentProvider,
    toProvider: AgentProvider,
    entries: TranscriptEntry[],
  ): Promise<HandoffContext | null> {
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      claudeSession.session.close()
      this.claudeSessions.delete(chatId)
    }
    // Codex keeps a warm per-chat app-server session that would silently
    // resume the old thread on switch-back; kill it so the cleared session
    // token actually takes effect. Cursor spawns per turn — nothing to close.
    this.codexManager.stopSession(chatId)
    this.piManager.closeChat(chatId)
    await this.store.setSessionToken(chatId, null)
    await this.store.setPendingForkSessionToken(chatId, null)

    const handoff = buildHandoffContext({
      entries,
      fromProvider,
      toProvider,
      transcriptPath: this.store.getTranscriptPath(chatId),
    })
    await this.store.appendMessage(chatId, timestamped({
      kind: "handoff_boundary",
      fromProvider,
      toProvider,
      ...(handoff ? { stats: handoff.stats } : {}),
    }))
    return handoff
  }

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
  private async detectLostProviderSession(args: {
    chatId: string
    provider: AgentProvider
    cwd: string
    model: string
    serviceTier?: "fast"
    sessionToken: string | null | undefined
    pendingForkSessionToken: string | null | undefined
  }): Promise<boolean> {
    switch (args.provider) {
      case "claude": {
        if (this.claudeSessions.has(args.chatId)) return false
        const token = args.pendingForkSessionToken ?? args.sessionToken
        return this.checkSessionArtifactFn("claude", { cwd: args.cwd, sessionToken: token }) === "missing"
      }
      case "cursor":
        return this.checkSessionArtifactFn("cursor", { cwd: args.cwd, sessionToken: args.sessionToken }) === "missing"
      case "codex": {
        // No token → nothing to resume; a fork in progress must not be disturbed.
        if (!args.sessionToken || args.pendingForkSessionToken) return false
        try {
          const started = await this.codexManager.startSession({
            chatId: args.chatId,
            cwd: args.cwd,
            model: args.model,
            serviceTier: args.serviceTier,
            sessionToken: args.sessionToken,
            pendingForkSessionToken: null,
          })
          return started?.resumeFellBack === true
        } catch {
          return false
        }
      }
      default:
        return false
    }
  }

  /**
   * Recover a chat whose native session is gone: clear the stale token, mark a
   * "Conversation Restored" boundary, and rebuild the wire-only context from
   * the transcript (same machinery as a provider handoff, from==to provider).
   * Nothing warm needs closing — claude/cursor have no live session by
   * construction here, and codex's warm context IS the fresh replacement
   * thread, whose id the turn's session_token stream event persists.
   */
  private async prepareSessionRestore(
    chatId: string,
    provider: AgentProvider,
    entries: TranscriptEntry[],
  ): Promise<HandoffContext | null> {
    await this.store.setSessionToken(chatId, null)
    await this.store.setPendingForkSessionToken(chatId, null)

    const restore = buildHandoffContext({
      entries,
      fromProvider: provider,
      toProvider: provider,
      transcriptPath: this.store.getTranscriptPath(chatId),
      reason: "session_restore",
    })
    await this.store.appendMessage(chatId, timestamped({
      kind: "session_restored",
      provider,
      ...(restore ? { stats: restore.stats } : {}),
    }))
    return restore
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
  }) {

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

    const previousProvider = chat.provider
    if (chat.provider !== args.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
    }
    await this.store.setPlanMode(args.chatId, args.planMode)

    const existingMessages = this.store.getMessages(args.chatId)
    const shouldGenerateTitle = args.appendUserPrompt && chat.title === "New Chat" && existingMessages.length === 0
    const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null

    if (optimisticTitle) {
      await this.store.renameChat(args.chatId, optimisticTitle)
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    // Mid-conversation harness switch: drop the old provider's session (its
    // native context is stale the moment another harness takes a turn — we
    // never resume it, even when switching back), mark the boundary in the
    // transcript, and build the wire-only handoff context from the entries
    // that precede this turn's prompt.
    const handoff = previousProvider !== null && previousProvider !== args.provider
      ? await this.prepareProviderHandoff(args.chatId, previousProvider, args.provider, existingMessages)
      : null

    // Same-provider session recovery: when we're NOT switching harnesses but
    // the provider's native session for this chat is gone (e.g. the CLI
    // garbage-collected its session file, or codex's resume fell back to a
    // fresh thread), rebuild context from our transcript exactly like a
    // handoff — clear the stale token, mark a "Conversation Restored" boundary,
    // and prepend the rebuilt context on the wire. Runs before the user prompt
    // is appended so the boundary precedes it, mirroring the handoff ordering.
    const restore = !handoff && previousProvider !== null
      && await this.detectLostProviderSession({
        chatId: args.chatId,
        provider: args.provider,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
      })
      ? await this.prepareSessionRestore(args.chatId, args.provider, existingMessages)
      : null

    if (args.appendUserPrompt) {
      const userPromptEntry = timestamped(
        { kind: "user_prompt", content: args.content, attachments: args.attachments, steered: args.steered },
        Date.now()
      )
      await this.store.appendMessage(args.chatId, userPromptEntry)
    }
    await this.store.recordTurnStarted(args.chatId)

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
    let wireContent = args.steered ? buildSteeredMessageContent(args.content) : args.content
    const concurrentAgentsNotice = buildConcurrentAgentsNotice(
      this.collectConcurrentProjectChats(args.chatId, project.localPath)
    )
    if (concurrentAgentsNotice) {
      wireContent = appendSystemMessageBlock(wireContent, concurrentAgentsNotice)
    }

    // Harness switch or session restore: lead with the rebuilt transcript so
    // the user's actual prompt is the last thing in context (trails for slash
    // invocations, which must stay at the very start of the message).
    const contextBlock = handoff ?? restore
    if (contextBlock) {
      wireContent = buildHandoffMessageContent(contextBlock.text, wireContent)
    }

    // "/name" skill invocation, translated per provider:
    //   claude/pi — passthrough; both harnesses expand a leading "/name".
    //   codex     — structured skill input item + <system-message> failsafe.
    //   cursor    — <system-message> failsafe only (no headless expansion).
    const skillInvocation = (args.provider === "codex" || args.provider === "cursor")
      ? parseSkillInvocation(args.content)
      : null

    let turn: HarnessTurn
    if (args.provider === "claude") {
      turn = await this.startClaudeTurn({
        chatId: args.chatId,
        localPath: project.localPath,
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        onToolRequest,
      })
    } else if (args.provider === "cursor") {
      // Refresh the model catalog off the turn's critical path if a previous
      // fetch never succeeded (e.g. the user just logged in to cursor-agent).
      void this.refreshCursorModelCatalog()
      let cursorContent = buildPromptText(wireContent, args.attachments)
      if (skillInvocation) {
        const match = findSkillByName(scanCursorSkills({ cwd: project.localPath }), skillInvocation.name)
        if (match?.path) {
          cursorContent = appendSystemMessageBlock(cursorContent, buildSkillSystemMessage(match.path))
        }
      }
      // Cursor cannot fork (see canForkChat), so a turn always resumes its own session.
      turn = await this.cursorManager.startTurn({
        cwd: project.localPath,
        content: cursorContent,
        model: args.model,
        sessionToken: chat.sessionToken,
      })
    } else if (args.provider === "pi") {
      // A missing connection or session boot failure surfaces as an error
      // result in the turn stream (like Cursor spawn failures) rather than throwing.
      const connection = await this.resolvePiConnection()
      turn = await this.piManager.startTurn({
        chatId: args.chatId,
        cwd: project.localPath,
        content: buildPromptText(wireContent, args.attachments),
        model: args.model,
        effort: normalizePiModelOptions(undefined, args.effort).reasoningEffort,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        connection,
      })
    } else {
      const started = await this.codexManager.startSession({
        chatId: args.chatId,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
      })
      if (chat.pendingForkSessionToken && started?.sessionToken) {
        await this.store.setPendingForkSessionToken(args.chatId, null)
      }
      turn = await this.codexManager.startTurn({
        chatId: args.chatId,
        content: buildPromptText(wireContent, args.attachments),
        skill: skillInvocation
          ? await this.resolveCodexSkill(args.chatId, project.localPath, skillInvocation.name)
          : undefined,
        model: args.model,
        effort: args.effort as CodexReasoningEffort | undefined,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        onToolRequest,
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
    }
    this.activeTurns.set(args.chatId, active)
    this.emitStateChange(args.chatId, { immediate: active.status === "starting" })

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
      session.suppressResume = false
      const promptSeq = session.nextPromptSeq + 1
      session.nextPromptSeq = promptSeq
      session.pendingPromptSeqs.push(promptSeq)
      active.claudePromptSeq = promptSeq
      logClaudeSteer("claude_prompt_sent", {
        chatId: args.chatId,
        sessionId: session.id,
        promptSeq,
        activeStatus: active.status,
        contentPreview: wireContent.slice(0, 160),
        pendingPromptSeqs: [...session.pendingPromptSeqs],
      })
      await session.session.sendPrompt(buildPromptText(wireContent, args.attachments))
      return
    }

    void this.runTurn(active)
  }

  private async startClaudeTurn(args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    serviceTier?: "fast"
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
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
        onRateLimitEvent: (info) => this.onClaudeRateLimit?.(info),
      })
      this.refreshClaudeModelCatalog(started)

      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: started,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        suppressResume: false,
        cancelledPromptSeqs: new Set(),
      }
      this.claudeSessions.set(args.chatId, session)
      void this.runClaudeSession(session)
    } else {
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
      if (session.serviceTier !== args.serviceTier) {
        await session.session.setFastMode?.(args.serviceTier === "fast")
        session.serviceTier = args.serviceTier
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
    let chatId = command.chatId


    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      this.analytics.track("chat_created")
    }

    const chat = this.store.requireChat(chatId)
    // Sending a message to an archived chat resurrects it (viewing alone
    // never unarchives).
    if (chat.archivedAt) {
      await this.store.unarchiveChat(chatId)
    }
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
    })


    return { chatId }
  }

  async enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>) {
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

  /**
   * Enumerate the skills/commands the selected harness can invoke, for the
   * composer's "/" menu. Prefers the live harness (authoritative — includes
   * built-ins, plugins, and enabled flags) and degrades to Kanna's filesystem
   * scan of the same discovery roots when no session is running yet.
   *
   * Adding a harness = one branch here (list) plus, if its wire protocol needs
   * more than leading-"/name" text, one translation in startTurnForChat.
   */
  async listSkills(
    command: Extract<ClientCommand, { type: "chat.listSkills" }>
  ): Promise<ChatSkillsSnapshot> {
    const cwd = this.resolveSkillScanCwd(command)
    if (!cwd) {
      return { provider: command.provider, skills: [], origin: "filesystem" }
    }

    switch (command.provider) {
      case "claude": {
        const handle = command.chatId ? this.claudeSessions.get(command.chatId)?.session : undefined
        if (handle?.supportedCommands) {
          try {
            const commands = await handle.supportedCommands()
            const skills: HarnessSkill[] = commands
              .filter((entry) => !entry.name.startsWith("._"))
              .map((entry) => ({
                name: entry.name,
                description: entry.description ?? "",
                ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
                source: "command" as const,
              }))
            return { provider: "claude", skills, origin: "live" }
          } catch {
            // Session mid-shutdown or old CLI — fall through to the scan.
          }
        }
        return { provider: "claude", skills: scanClaudeSkills({ cwd }), origin: "filesystem" }
      }
      case "codex": {
        const live = command.chatId
          ? await this.codexManager.listSkills({ chatId: command.chatId, cwd })
          : null
        if (live) {
          const skills: HarnessSkill[] = live.map((skill) => ({
            name: skill.name,
            description: skill.shortDescription || skill.description || "",
            source: "skill" as const,
            path: skill.path,
          }))
          return { provider: "codex", skills, origin: "live" }
        }
        return { provider: "codex", skills: scanCodexSkills({ cwd }), origin: "filesystem" }
      }
      case "cursor":
        // Cursor has no enumeration protocol; the scan mirrors the CLI's own
        // skill discovery roots, and invocation is failsafe-only by design.
        return { provider: "cursor", skills: scanCursorSkills({ cwd }), origin: "filesystem" }
      case "pi": {
        const skills = await this.piManager.listSkills({ chatId: command.chatId, cwd })
        return { provider: "pi", skills, origin: "live" }
      }
    }
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
   * Resolve a typed `/name` to a codex skill for the structured input item.
   * Live skills/list is authoritative (paths must exact-match the server's own
   * discovery for the item to inject); the fs scan of the same roots covers
   * codex versions that predate skills/list. Unresolved names degrade to plain
   * text — codex silently ignores unknown skill items anyway.
   */
  private async resolveCodexSkill(
    chatId: string,
    cwd: string,
    name: string
  ): Promise<{ name: string; path: string } | undefined> {
    const live = await this.codexManager.listSkills({ chatId, cwd })
    if (live) {
      const match = live.find((skill) => skill.name === name)
      return match ? { name: match.name, path: match.path } : undefined
    }
    const scanned = findSkillByName(scanCodexSkills({ cwd }), name)
    return scanned?.path ? { name: scanned.name, path: scanned.path } : undefined
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

  /**
   * Re-registers an active turn for a Claude session that produced new
   * activity after its previous turn finished (e.g. a Monitor or Cron
   * wakeup continued the session). The resumed turn has no prompt seq, so
   * the next result entry (pendingPromptSeqs empty → null === null) closes
   * it through the normal completion path in runClaudeSession.
   */
  private async resumeBackgroundTurn(session: ClaudeSessionState) {
    const active: ActiveTurn = {
      chatId: session.chatId,
      provider: "claude",
      turn: {
        provider: "claude",
        stream: {
          async *[Symbol.asyncIterator]() {},
        },
        getAccountInfo: session.session.getAccountInfo,
        interrupt: session.session.interrupt,
        close: () => {},
      },
      model: session.model,
      effort: session.effort,
      planMode: session.planMode,
      status: "running",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
    }
    this.activeTurns.set(session.chatId, active)
    await this.store.recordTurnStarted(session.chatId)
    this.emitStateChange(session.chatId)
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    try {
      for await (const event of session.session.stream) {
        if (event.type === "session_token" && event.sessionToken) {
          session.sessionToken = event.sessionToken
          await this.store.setSessionToken(session.chatId, event.sessionToken)
          this.emitStateChange(session.chatId)
          continue
        }

        if (!event.entry) continue

        // After an escape/cancel or steer, the SDK ends the cancelled turn
        // with a result of subtype error_during_execution (is_error, usually
        // no text). The cancel already appended an "interrupted" entry, so
        // persisting this would render a spurious "An unknown error
        // occurred." in the UI. Attribute the result to the prompt it
        // completes (pendingPromptSeqs[0]) rather than relying on
        // suppressResume, which a steered follow-up prompt clears before the
        // interrupt error lands.
        const completingPromptSeq = event.entry.kind === "result" || event.entry.kind === "interrupted"
          ? (session.pendingPromptSeqs[0] ?? null)
          : null
        const isCancelledPromptErrorResult =
          event.entry.kind === "result"
          && event.entry.isError
          && completingPromptSeq !== null
          && session.cancelledPromptSeqs.has(completingPromptSeq)
        if (!isCancelledPromptErrorResult) {
          await this.store.appendMessage(session.chatId, event.entry)
        }

        // Background wakeups (Monitor, Cron*, ScheduleWakeup, RemoteTrigger)
        // emit new activity after the previous turn completed. Re-register an
        // active turn so the chat reads as in-progress instead of idle.
        if (
          !this.activeTurns.has(session.chatId)
          && !session.suppressResume
          && (
            event.entry.kind === "assistant_text"
            || event.entry.kind === "tool_call"
            || event.entry.kind === "tool_result"
          )
        ) {
          await this.resumeBackgroundTurn(session)
        }

        if (event.entry.kind === "result" || event.entry.kind === "interrupted") {
          session.suppressResume = false
        }

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
        if (completedClaudePromptSeq !== null) {
          session.cancelledPromptSeqs.delete(completedClaudePromptSeq)
        }

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
            await this.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
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

    // Keep in-flight stream entries (emitted before the interrupt lands)
    // from re-registering an active turn via resumeBackgroundTurn, and mark
    // the cancelled prompt so its interrupt error result gets dropped.
    if (active.provider === "claude") {
      const session = this.claudeSessions.get(chatId)
      if (session) {
        session.suppressResume = true
        if (active.claudePromptSeq != null) {
          session.cancelledPromptSeqs.add(active.claudePromptSeq)
        }
      }
    }

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

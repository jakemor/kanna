import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createKannaMcpServer, type KannaMcpDelegationContext } from "./kanna-mcp"
import { KANNA_MCP_SERVER_NAME } from "../shared/tools"
import { homedir } from "node:os"
import type {
  AccountInfo,
  AgentProvider,
  ChatAttachment,
  ContextWindowUsageSnapshot,
  McpServerConfig,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  KannaStatus,
  QueuedChatMessage,
  SlashCommand,
  Subagent,
  TranscriptEntry,
} from "../shared/types"
import type { ChatRecord, ProjectRecord } from "./events"
import { buildHistoryPrimer, shouldInjectPrimer } from "./history-primer"
import {
  getLatestContextWindowUsage,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  shouldProactivelyCompact,
} from "./proactive-compact"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { LOG_PREFIX } from "../shared/branding"
import { KANNA_SYSTEM_PROMPT_APPEND, buildKannaSystemPromptAppend } from "../shared/kanna-system-prompt"
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
import { resolveClaudeApiModelId, type ClaudeDriverPreference } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import { AUTO_CONTINUE_EVENT_VERSION, type AutoContinueEvent } from "./auto-continue/events"
import { ClaudeLimitDetector, CodexLimitDetector, type LimitDetection, type LimitDetector } from "./auto-continue/limit-detector"
import { ClaudeAuthErrorDetector, type AuthErrorDetection } from "./auto-continue/auth-error-detector"
import type { ScheduleManager } from "./auto-continue/schedule-manager"
import { deriveChatSchedules } from "./auto-continue/read-model"
import type { TunnelGateway } from "./cloudflare-tunnel/gateway"
import { OAuthTokenPool } from "./oauth-pool/oauth-token-pool"
import { maskOauthKey } from "../shared/mask-oauth-key"
import { parseMentions, type ParsedMention } from "./mention-parser"
import { SubagentOrchestrator, type ProviderRunStart } from "./subagent-orchestrator"
import { buildSubagentProviderRun, type BuildSubagentProviderRunArgs } from "./subagent-provider-run"
import type { ToolCallbackService } from "./tool-callback"
import type { ChatPermissionPolicy } from "../shared/permission-policy"
import { mergePolicyOverride, POLICY_DEFAULT } from "../shared/permission-policy"
import { startClaudeSessionPTY, type StartClaudeSessionPtyArgs } from "./claude-pty/driver"

type SdkMcpEntry =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers: Record<string, string> }
  | { type: "sse"; url: string; headers: Record<string, string> }
  | { type: "ws"; url: string; headers: Record<string, string> }

export function buildUserMcpServers(
  servers: readonly McpServerConfig[],
): Record<string, SdkMcpEntry> {
  const out: Record<string, SdkMcpEntry> = {}
  for (const s of servers) {
    if (!s.enabled) continue
    if (s.name === KANNA_MCP_SERVER_NAME) continue
    if (s.transport === "stdio") {
      out[s.name] = {
        type: "stdio",
        command: s.command,
        args: s.args,
        env: s.env,
        ...(s.cwd ? { cwd: s.cwd } : {}),
      }
    } else {
      out[s.name] = {
        type: s.transport,
        url: s.url,
        headers: s.headers,
      }
    }
  }
  return out
}

export function resolveSpawnPaths(
  chat: Pick<ChatRecord, "id" | "stackBindings">,
  fallbackLocalPath: string,
): { cwd: string; additionalDirectories: string[] } {
  if (!chat.stackBindings || chat.stackBindings.length === 0) {
    return { cwd: fallbackLocalPath, additionalDirectories: [] }
  }
  const primary = chat.stackBindings.find((b) => b.role === "primary")
  if (!primary) {
    throw new Error(`Chat ${chat.id} has stackBindings but no primary`)
  }
  const additionalDirectories = chat.stackBindings
    .filter((b) => b.role === "additional")
    .map((b) => b.worktreePath)
  return { cwd: primary.worktreePath, additionalDirectories }
}

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
  waitStartedAt: number | null
  // True when this turn was synthesised by Kanna to inject `/compact` before
  // the user's real message. Used to update the per-chat compact circuit
  // breaker on completion (reset on success, increment on failure).
  proactiveCompactInjection?: boolean
  // _id of the user_prompt entry that triggered this turn (when appended on
  // this turn). Used to attribute main-Claude-initiated subagent runs to the
  // originating user message.
  userMessageId: string | null
}

export interface ClaudeSessionHandle {
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  interrupt: () => Promise<void>
  close: () => void
  sendPrompt: (content: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  getSupportedCommands: () => Promise<SlashCommand[]>
  /** Present only for keep-alive channel-delivery sessions; drives turn 2+. */
  pushChannelPrompt?: (text: string) => Promise<void>
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  additionalDirectories: string[]
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  pendingPromptSeqs: number[]
  activeTokenId: string | null
  oauthKeyMasked: string | null
  lastUsedAt: number
}

interface ClaudeSessionLifecycleOptions {
  idleMs: number
  maxResidentSessions: number
  sweepIntervalMs: number
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  analytics?: AnalyticsReporter
  codexManager?: CodexAppServerManager
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  tunnelGateway?: TunnelGateway
  startClaudeSession?: (args: {
    projectId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    oauthToken: string | null
    additionalDirectories?: string[]
    chatId?: string
    tunnelGateway?: TunnelGateway | null
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    /**
     * Append text for the claude_code preset's `systemPrompt.append`.
     * Defaults to the static refusal-policy blurb; production callers in
     * `agent.ts` pass the dynamic value from `buildKannaSystemPromptAppend`
     * so the subagent roster is embedded.
     */
    systemPromptAppend?: string
    /** Orchestrator for delegate_subagent. Omit to hide the tool. */
    subagentOrchestrator?: SubagentOrchestrator
    /** Per-spawn delegation context (depth / ancestor chain / parentUserMessageId resolver). */
    delegationContext?: KannaMcpDelegationContext
    /**
     * Subagent-only override. When set, REPLACES the claude_code preset
     * append on systemPrompt entirely. Primary chats leave this unset.
     */
    systemPromptOverride?: string
    /**
     * Subagent-only one-shot prompt. When set, the SDK queue is primed with
     * this prompt and closed immediately so the session terminates after the
     * single turn. Primary chats leave this unset and call sendPrompt later.
     */
    initialPrompt?: string
    /** Routes AskUserQuestion/ExitPlanMode through tool-callback when KANNA_MCP_TOOL_CALLBACKS=1. */
    toolCallback?: ToolCallbackService
    /** Per-chat permission policy. Defaults to POLICY_DEFAULT if omitted. */
    chatPolicy?: ChatPermissionPolicy
    /** Enabled user MCP servers, merged into the SDK's mcpServers map. */
    customMcpServers?: readonly McpServerConfig[]
    /** Backs the `schedule_wakeup` MCP tool. Omit to hide the tool. */
    scheduleWakeup?: (a: { delayMs: number; prompt: string }) => Promise<string | null>
  }) => Promise<ClaudeSessionHandle>
  startClaudeSessionPTY?: (args: StartClaudeSessionPtyArgs) => Promise<ClaudeSessionHandle>
  claudeLimitDetector?: LimitDetector
  codexLimitDetector?: LimitDetector
  scheduleManager?: ScheduleManager
  getAutoResumePreference?: () => boolean
  /**
   * Max consecutive agent-driven wakes (`ScheduleWakeup` / pending-workflow)
   * per chat before Kanna refuses to arm another — runaway-loop guard so a
   * self-scheduling agent cannot burn OAuth quota indefinitely. The chain
   * resets on any real (non-auto-continue) user message. Default 25.
   */
  maxAgentWakes?: number
  /**
   * Delay (ms) for the pending-workflow harvest wake armed when a turn ends
   * with a background Workflow still running. Kanna gets no mid-flight
   * completion signal, so the wake replays a "check your background work"
   * prompt after this delay; the model harvests or re-schedules. Default
   * 120000 (2 min). Bounded by `maxAgentWakes`.
   */
  pendingWorkflowPollMs?: number
  getSubagents?: () => Subagent[]
  getAppSettingsSnapshot?: () => {
    claudeAuth?: { authenticated?: boolean } | null
    claudeDriver?: {
      preference?: ClaudeDriverPreference
      lifecycle?: { idleTimeoutMs?: number; maxConcurrent?: number }
    }
    globalPromptAppend?: string
    customMcpServers?: readonly McpServerConfig[]
  }
  throwOnClaudeSessionStart?: boolean
  oauthPool?: OAuthTokenPool
  /** Populated on boot; will be consumed by canUseTool in Task 11. */
  toolCallback?: ToolCallbackService
  /** Per-chat permission policy forwarded to startClaudeSession. Defaults to POLICY_DEFAULT if omitted. */
  chatPolicy?: ChatPermissionPolicy
  /** Claude subprocess lifecycle tuning. Defaults are conservative and may be overridden in tests. */
  claudeSessionLifecycle?: Partial<ClaudeSessionLifecycleOptions>
  /** On-disk registry of claude PTY children for crash-orphan reap on next boot. Forwarded to every PTY spawn. */
  claudePtyRegistry?: import("./claude-pty/pid-registry.adapter").ClaudePtyRegistry
  /** In-memory live-status registry surfaced to the UI. Forwarded to every PTY spawn. */
  ptyInstanceRegistry?: import("./claude-pty/pty-instance-registry").PtyInstanceRegistry
  /** Registry of workflow runs per chat, populated by PTY driver from the on-disk workflows dir. */
  workflowRegistry?: import("./workflow-registry").WorkflowRegistry
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

export function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function isPromptTooLongMessage(message: string): boolean {
  return /\bprompt\b.*\btoo\s+long\b/i.test(message)
    || /\bprompt\b.*\btoo\s+large\b/i.test(message)
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

// Resolve the single `context_window_updated` snapshot emitted at end of a
// turn. `latestUsageSnapshot` is the last per-`assistant`-message usage — a
// single-request view, the real live context size. `accumulatedUsage` is
// derived from SDK `result.usage`, which is CUMULATIVE: it re-counts
// `cache_read_input_tokens` on every tool round-trip, so its `usedTokens`
// balloons to millions on long turns.
//
// The cumulative figure must never become `usedTokens` — proactive-compact
// reads `usedTokens` and would trip far below the real threshold, then the
// no-assistant-usage compact turn would re-inflate and force a second
// compact (the double-compact bug). So cumulative only ever enriches
// `totalProcessedTokens`. When no per-assistant snapshot exists (compact /
// system turns), return null: the caller skips emission and proactive-compact
// falls back to the prior live snapshot (or a compact_boundary → no compact).
export function resolveFinalTurnUsage(
  latestUsageSnapshot: ContextWindowUsageSnapshot | null,
  accumulatedUsage: ContextWindowUsageSnapshot | null,
  lastKnownContextWindow: number | undefined,
): ContextWindowUsageSnapshot | null {
  if (!latestUsageSnapshot) return null
  return {
    ...latestUsageSnapshot,
    ...(typeof lastKnownContextWindow === "number" ? { maxTokens: lastKnownContextWindow } : {}),
    ...(accumulatedUsage && accumulatedUsage.usedTokens > latestUsageSnapshot.usedTokens
      ? { totalProcessedTokens: accumulatedUsage.usedTokens }
      : {}),
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

// The SDK's `result.modelUsage[*].contextWindow` can lie: it reports 200_000 even
// when the user opted into the 1M beta via the `[1m]` model id suffix
// (claude-agent-sdk-typescript#238). Without this hint, proactive-compact would
// trip at 167k tokens — ~17% of the real 1M window — and compact far too often.
// We derive the configured window from the SDK model id and use it as a floor.
export function parseConfiguredContextWindowFromModelId(modelId: string): number | undefined {
  return modelId.endsWith("[1m]") ? 1_000_000 : undefined
}

export function getClaudeAssistantMessageUsageId(message: any): string | null {
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
    if (message.isApiErrorMessage === true || message.message?.model === "<synthetic>") {
      const joinedText = message.message.content
        .filter((c: { type?: string; text?: string }) => c.type === "text" && typeof c.text === "string")
        .map((c: { text: string }) => c.text)
        .join("")
      const statusFromField = typeof message.apiErrorStatus === "number" ? message.apiErrorStatus : undefined
      const statusFromText = (() => {
        const match = /API Error:\s*(\d{3})/i.exec(joinedText)
        return match ? Number.parseInt(match[1], 10) : undefined
      })()
      const requestId = typeof message.request_id === "string"
        ? message.request_id
        : (typeof message.requestId === "string" ? message.requestId : undefined)
      return [timestamped({
        kind: "api_error",
        messageId,
        status: statusFromField ?? statusFromText ?? 0,
        text: joinedText,
        requestId,
        debugRaw,
      })]
    }
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

  // No `result.subtype === "compaction"` branch by design: Kanna never relies
  // on the SDK's in-loop auto-compact. The SDK `query()` driver spawns a fresh
  // subprocess per turn and never enters claude-code's REPL loop, so that
  // compaction stop is unreachable here (see proactive-compact.ts). Context
  // compaction is instead driven by Kanna injecting a native `/compact` turn
  // and surfaces purely as the `system/compact_boundary` message handled
  // below — not as a result subtype.
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

  // Interactive TUI claude never writes a `type: "result"` row — it writes
  // `system/turn_duration` instead (per canon/shannon research). Synthesize a
  // turn-end `result` so the agent loop and UI see the turn complete.
  if (message.type === "system" && message.subtype === "turn_duration") {
    const durationMs = typeof message.durationMs === "number"
      ? message.durationMs
      : typeof message.duration_ms === "number"
        ? message.duration_ms
        : 0
    const pendingWorkflowCount = typeof message.pendingWorkflowCount === "number"
      ? message.pendingWorkflowCount
      : undefined
    return [
      timestamped({
        kind: "result",
        messageId,
        subtype: "success",
        isError: false,
        durationMs,
        result: "",
        costUsd: undefined,
        ...(pendingWorkflowCount !== undefined ? { pendingWorkflowCount } : {}),
        debugRaw,
      }),
    ]
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

export async function* createClaudeHarnessStream(
  q: Query,
  configuredContextWindow?: number,
): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined = configuredContextWindow
  const detector = new ClaudeLimitDetector()

  for await (const sdkMessage of q as AsyncIterable<any>) {
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken }
    }

    if (sdkMessage?.type === "rate_limit_event") {
      const detection = detector.detectFromSdkRateLimitInfo("", sdkMessage.rate_limit_info)
      if (detection) {
        yield { type: "rate_limit", rateLimit: { resetAt: detection.resetAt, tz: detection.tz } }
      }
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
      // Never let SDK lower the configured window — see comment on
      // parseConfiguredContextWindowFromModelId for the 1M beta footgun.
      if (resultContextWindow !== undefined) {
        lastKnownContextWindow = Math.max(lastKnownContextWindow ?? 0, resultContextWindow)
      }

      const accumulatedUsage = normalizeClaudeUsageSnapshot(
        sdkMessage.usage,
        lastKnownContextWindow,
      )
      const finalUsage = resolveFinalTurnUsage(
        latestUsageSnapshot,
        accumulatedUsage,
        lastKnownContextWindow,
      )

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

/** Args for the `buildCanUseTool` helper — exposed for unit testing. */
export interface BuildCanUseToolArgs {
  localPath: string
  chatId?: string
  sessionToken?: string | null
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  toolCallback?: ToolCallbackService
  chatPolicy?: ChatPermissionPolicy
}

/**
 * Builds the `canUseTool` callback passed to the SDK `query()`.
 * Exported so unit tests can exercise the dual-routing logic without
 * going through the full `startClaudeSession` factory.
 */
export function buildCanUseTool(args: BuildCanUseToolArgs): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      return { behavior: "allow", updatedInput: input }
    }

    const tool = normalizeToolCall({
      toolName,
      toolId: options.toolUseID,
      input: (input ?? {}) as Record<string, unknown>,
    })

    if (tool.toolKind !== "ask_user_question" && tool.toolKind !== "exit_plan_mode") {
      return { behavior: "deny", message: "Unsupported tool request" }
    }

    // ── Flag-on path: route through tool-callback ──────────────────────────
    if (process.env.KANNA_MCP_TOOL_CALLBACKS === "1" && args.toolCallback) {
      const result = await args.toolCallback.submit({
        chatId: args.chatId ?? "",
        sessionId: args.sessionToken ?? "",
        toolUseId: options.toolUseID,
        toolName: `mcp__kanna__${tool.toolKind}`,
        args: (tool.rawInput ?? {}) as Record<string, unknown>,
        chatPolicy: args.chatPolicy ?? POLICY_DEFAULT,
        cwd: args.localPath,
      })

      if (result.decision.kind === "deny") {
        return { behavior: "deny", message: result.decision.reason ?? "denied" }
      }

      const payload = (result.decision.payload && typeof result.decision.payload === "object")
        ? result.decision.payload as Record<string, unknown>
        : {}

      if (tool.toolKind === "ask_user_question") {
        return {
          behavior: "allow",
          updatedInput: {
            ...(tool.rawInput ?? {}),
            questions: payload.questions ?? tool.input.questions,
            answers: payload.answers ?? result.decision.payload,
          },
        } satisfies PermissionResult
      }

      // exit_plan_mode
      if (payload.confirmed) {
        return {
          behavior: "allow",
          updatedInput: { ...(tool.rawInput ?? {}), ...payload },
        } satisfies PermissionResult
      }

      return {
        behavior: "deny",
        message: typeof payload.message === "string"
          ? `User wants to suggest edits to the plan: ${payload.message}`
          : "User wants to suggest edits to the plan before approving.",
      } satisfies PermissionResult
    }

    // ── Legacy path (flag off OR toolCallback not provided) ────────────────
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
        updatedInput: { ...(tool.rawInput ?? {}), ...record },
      } satisfies PermissionResult
    }

    return {
      behavior: "deny",
      message: typeof record.message === "string"
        ? `User wants to suggest edits to the plan: ${record.message}`
        : "User wants to suggest edits to the plan before approving.",
    } satisfies PermissionResult
  }
}

export function buildClaudeEnv(baseEnv: NodeJS.ProcessEnv, oauthToken: string | null): NodeJS.ProcessEnv {
  const { CLAUDECODE: _unused, ...rest } = baseEnv
  // Empty string is treated the same as null. Blank tokens are rejected at persistence time
  // by normalizeTokenEntry, so in practice oauthToken is either a non-empty string or null.
  if (!oauthToken) return rest
  return { ...rest, CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
}

async function startClaudeSession(args: {
  projectId: string
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  oauthToken: string | null
  additionalDirectories?: string[]
  chatId?: string
  tunnelGateway?: TunnelGateway | null
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  systemPromptAppend?: string
  systemPromptOverride?: string
  initialPrompt?: string
  /** Routes AskUserQuestion/ExitPlanMode through tool-callback when KANNA_MCP_TOOL_CALLBACKS=1. */
  toolCallback?: ToolCallbackService
  /** Per-chat permission policy. Defaults to POLICY_DEFAULT if omitted. */
  chatPolicy?: ChatPermissionPolicy
  /** Orchestrator for delegate_subagent. Omit to hide the tool. */
  subagentOrchestrator?: SubagentOrchestrator
  /** Per-spawn delegation context (depth / ancestor chain / parentUserMessageId resolver). */
  delegationContext?: KannaMcpDelegationContext
  /** Backs the `schedule_wakeup` MCP tool. Omit to hide the tool. */
  scheduleWakeup?: (a: { delayMs: number; prompt: string }) => Promise<string | null>
  /** Enabled user MCP servers, merged into the SDK's mcpServers map. */
  customMcpServers?: readonly McpServerConfig[]
}): Promise<ClaudeSessionHandle> {
  const canUseTool = buildCanUseTool({
    localPath: args.localPath,
    chatId: args.chatId,
    sessionToken: args.sessionToken,
    onToolRequest: args.onToolRequest,
    toolCallback: args.toolCallback,
    chatPolicy: args.chatPolicy,
  })

  const promptQueue = new AsyncMessageQueue<SDKUserMessage>()

  const q = query({
    prompt: promptQueue,
    options: {
      cwd: args.localPath,
      ...(args.additionalDirectories && args.additionalDirectories.length > 0
        ? { additionalDirectories: args.additionalDirectories }
        : {}),
      model: args.model,
      effort: args.effort as "low" | "medium" | "high" | "max" | undefined,
      resume: args.sessionToken ?? undefined,
      forkSession: args.forkSession,
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,
      tools: [...CLAUDE_TOOLSET],
      mcpServers: {
        [KANNA_MCP_SERVER_NAME]: createKannaMcpServer({
          projectId: args.projectId,
          localPath: args.localPath,
          chatId: args.chatId,
          sessionId: args.sessionToken ?? undefined,
          tunnelGateway: args.tunnelGateway ?? null,
          toolCallback: args.toolCallback,
          chatPolicy: args.chatPolicy,
          subagentOrchestrator: args.subagentOrchestrator,
          delegationContext: args.delegationContext,
          scheduleWakeup: args.scheduleWakeup,
        }),
        ...buildUserMcpServers(args.customMcpServers ?? []),
      },
      systemPrompt: args.systemPromptOverride != null
        ? args.systemPromptOverride
        : {
            type: "preset",
            preset: "claude_code",
            append: args.systemPromptAppend ?? KANNA_SYSTEM_PROMPT_APPEND,
          },
      settingSources: ["user", "project", "local"],
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, homedir()) || undefined,
      env: buildClaudeEnv(process.env, args.oauthToken),
    },
  })

  if (args.initialPrompt != null) {
    promptQueue.push({
      type: "user",
      message: {
        role: "user",
        content: args.initialPrompt,
      },
      parent_tool_use_id: null,
      session_id: args.sessionToken ?? undefined,
    })
    promptQueue.close()
  }

  return {
    provider: "claude",
    stream: createClaudeHarnessStream(q, parseConfiguredContextWindowFromModelId(args.model)),
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
      // Do NOT cancel pending tool-callback records here. close() also fires
      // on token rotation and idle-session sweep — both of which preserve
      // the model's logical turn (it will resume / re-emit). Denying
      // mid-turn used to mask the question prompt as a silent drop. Pending
      // records are now reaped by the explicit chat.cancel / chat.delete
      // paths in ws-router.ts and by recoverOnStartup on server boot.
    },
  }
}

const TOKEN_ROTATION_SCHEDULE_DELAY_MS = 100
// When a single OAuth token is shared by N chats (per
// adr-20260522-oauth-token-share-cap), all N chats can detect the same
// rate-limit / auth-error simultaneously. Each respawn (esp. under PTY) is
// expensive; offset them by this many ms per additional victim so the cold-
// boot herd spreads across roughly a second instead of stampeding.
const TOKEN_ROTATION_HERD_STAGGER_MS = 250
// Dedupe window for repeat rotation events on the same tokenId. Within this
// window, secondary detectors only increment the stagger counter; they do
// not double-mark the pool or double-pick a fresh target via pickActive().
const TOKEN_ROTATION_DEDUPE_WINDOW_MS = 5_000
const DEFAULT_CLAUDE_SESSION_IDLE_MS = 10 * 60 * 1000
const DEFAULT_CLAUDE_SESSION_MAX_RESIDENT = 4
const DEFAULT_CLAUDE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Thrown by Claude spawn paths when the OAuth pool has tokens but every one
// is currently unusable (rate-limited, errored, disabled, or reserved by
// another chat). `startTurnForChat` catches this and persists `message` as a
// `result` transcript entry instead of letting it surface as an ephemeral
// commandError that gets wiped by the next chat snapshot tick.
export class OAuthPoolUnavailableError extends Error {
  readonly kind = "oauth_pool_unavailable" as const
  constructor(message: string) {
    super(message)
    this.name = "OAuthPoolUnavailableError"
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly analytics: AnalyticsReporter
  private readonly codexManager: CodexAppServerManager
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly startClaudeSessionPTYFn: (args: StartClaudeSessionPtyArgs) => Promise<ClaudeSessionHandle>
  private reportBackgroundError: ((message: string) => void) | null = null
  readonly activeTurns = new Map<string, ActiveTurn>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()
  private readonly slashCommandsInFlight = new Set<string>()
  private readonly claudeLimitDetector: LimitDetector
  private readonly codexLimitDetector: LimitDetector
  private readonly claudeAuthErrorDetector: ClaudeAuthErrorDetector
  private readonly scheduleManager: ScheduleManager | null
  private readonly getAutoResumePreference: () => boolean
  private readonly getSubagents: () => Subagent[]
  private readonly getAppSettingsSnapshot: NonNullable<AgentCoordinatorArgs["getAppSettingsSnapshot"]>
  private readonly subagentOrchestrator: SubagentOrchestrator
  /** Public accessor for tests + the `delegate_subagent` MCP tool wiring. */
  getSubagentOrchestrator(): SubagentOrchestrator {
    return this.subagentOrchestrator
  }
  private readonly throwOnClaudeSessionStart: boolean
  private readonly autoResumeByChat = new Map<string, boolean>()
  // Per-chat consecutive agent-wake counter (runaway-loop guard). Incremented
  // on each scheduleAgentWakeup; reset to 0 when a real user message enqueues
  // (enqueueMessage without an autoContinue option). In-memory by design — a
  // server restart resetting the chain is acceptable (restart also breaks any
  // runaway loop) and avoids threading a counter through the event log.
  private readonly agentWakeChainByChat = new Map<string, number>()
  private readonly maxAgentWakes: number
  private readonly pendingWorkflowPollMs: number
  // Per-tokenId rotation dedupe state. When a shared OAuth token throws
  // limit/auth-error against N chats simultaneously, only the first chat
  // pays the cost of marking the pool + picking a fresh target; subsequent
  // chats within TOKEN_ROTATION_DEDUPE_WINDOW_MS reuse the dedupe slot to
  // stagger their respawns by TOKEN_ROTATION_HERD_STAGGER_MS each.
  private readonly tokenRotationDedupe = new Map<string, { firstSeenAt: number; staggerCount: number }>()
  // Per-chat circuit breaker for proactive `/compact` injection lives in the
  // persisted ChatRecord (`compactFailureCount`): increments on every compact
  // attempt that fails (turn errored / cancelled) and resets on success.
  // After MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, skip further proactive
  // compacts on this chat so doomed sessions don't hammer the API on every
  // turn (mirrors claude-code's autoCompact circuit breaker). Persisting it
  // means a server restart cannot reset a doomed chat's breaker to 0.
  private readonly tunnelGateway: TunnelGateway | null
  private readonly oauthPool: OAuthTokenPool | null
  private readonly toolCallback: ToolCallbackService | null
  private readonly chatPolicy: ChatPermissionPolicy
  private readonly claudeSessionLifecycle: ClaudeSessionLifecycleOptions
  private readonly claudeSessionSweepTimer: ReturnType<typeof setInterval> | null
  private readonly claudePtyRegistry: import("./claude-pty/pid-registry.adapter").ClaudePtyRegistry | null
  private readonly ptyInstanceRegistry: import("./claude-pty/pty-instance-registry").PtyInstanceRegistry | null
  private readonly workflowRegistry: import("./workflow-registry").WorkflowRegistry | null
  private readonly subagentPendingResolvers = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.analytics = args.analytics ?? NoopAnalyticsReporter
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.generateTitle = args.generateTitle ?? generateTitleForChatDetailed
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.startClaudeSessionPTYFn = args.startClaudeSessionPTY ?? startClaudeSessionPTY
    this.claudeLimitDetector = args.claudeLimitDetector ?? new ClaudeLimitDetector()
    this.codexLimitDetector = args.codexLimitDetector ?? new CodexLimitDetector()
    this.claudeAuthErrorDetector = new ClaudeAuthErrorDetector()
    this.scheduleManager = args.scheduleManager ?? null
    this.getAutoResumePreference = args.getAutoResumePreference ?? (() => false)
    this.maxAgentWakes = args.maxAgentWakes ?? 25
    this.pendingWorkflowPollMs = args.pendingWorkflowPollMs ?? 120_000
    this.getSubagents = args.getSubagents ?? (() => [])
    this.getAppSettingsSnapshot = args.getAppSettingsSnapshot ?? (() => ({}))
    this.subagentOrchestrator = new SubagentOrchestrator({
      store: this.store,
      appSettings: { getSnapshot: () => ({ subagents: this.getSubagents() }) },
      startProviderRun: (a) => this.buildSubagentProviderRunForChat({
        subagent: a.subagent,
        chatId: a.chatId,
        primer: a.primer,
        userInstruction: a.userInstruction,
        runId: a.runId,
        abortSignal: a.abortSignal,
        depth: a.depth,
        ancestorSubagentIds: a.ancestorSubagentIds,
        parentUserMessageId: a.parentUserMessageId,
      }),
      onRunTerminal: (chatId, runId) => {
        this.rejectPendingResolversForRun(chatId, runId)
        // failRun appended the terminal event synchronously before invoking
        // this hook, so the store already has the new state. Emit now so
        // multi-subagent fan-outs do not have to wait for Promise.all.
        this.emitStateChange(chatId)
      },
      onRunProgress: (chatId) => {
        // Run start + every persisted subagent entry. Without this the
        // client only gets a snapshot at terminal, so a delegated run
        // renders blank until it finishes (delegate_subagent blocks the
        // main turn, which itself emits nothing meanwhile). ws-router
        // coalesces (16ms) and signature-dedups, so per-entry fan-out is
        // cheap.
        this.emitStateChange(chatId)
      },
      maxLive: positiveIntegerFromEnv(process.env.KANNA_SUBAGENT_MAX_LIVE, 0) || undefined,
      liveIdleTimeoutMs: positiveIntegerFromEnv(process.env.KANNA_SUBAGENT_IDLE_TIMEOUT_MS, 0) || undefined,
    })
    this.throwOnClaudeSessionStart = args.throwOnClaudeSessionStart ?? false
    this.tunnelGateway = args.tunnelGateway ?? null
    this.oauthPool = args.oauthPool ?? null
    this.toolCallback = args.toolCallback ?? null
    this.chatPolicy = args.chatPolicy ?? POLICY_DEFAULT
    this.claudeSessionLifecycle = {
      idleMs: args.claudeSessionLifecycle?.idleMs
        ?? positiveIntegerFromEnv(process.env.KANNA_CLAUDE_SESSION_IDLE_MS, DEFAULT_CLAUDE_SESSION_IDLE_MS),
      maxResidentSessions: args.claudeSessionLifecycle?.maxResidentSessions
        ?? positiveIntegerFromEnv(process.env.KANNA_CLAUDE_SESSION_MAX_RESIDENT, DEFAULT_CLAUDE_SESSION_MAX_RESIDENT),
      sweepIntervalMs: args.claudeSessionLifecycle?.sweepIntervalMs
        ?? positiveIntegerFromEnv(process.env.KANNA_CLAUDE_SESSION_SWEEP_INTERVAL_MS, DEFAULT_CLAUDE_SESSION_SWEEP_INTERVAL_MS),
    }
    this.claudeSessionSweepTimer = this.claudeSessionLifecycle.sweepIntervalMs > 0
      ? setInterval(() => { this.sweepIdleClaudeSessions() }, this.claudeSessionLifecycle.sweepIntervalMs)
      : null
    this.claudeSessionSweepTimer?.unref?.()
    this.claudePtyRegistry = args.claudePtyRegistry ?? null
    this.ptyInstanceRegistry = args.ptyInstanceRegistry ?? null
    this.workflowRegistry = args.workflowRegistry ?? null
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }

  dispose() {
    if (this.claudeSessionSweepTimer) clearInterval(this.claudeSessionSweepTimer)
    for (const [chatId, session] of [...this.claudeSessions.entries()]) {
      this.closeClaudeSession(chatId, session)
    }
  }

  getActiveStatuses() {
    const statuses = new Map<string, KannaStatus>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getWaitStartedAtByChatId(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      if (turn.waitStartedAt != null) out.set(chatId, turn.waitStartedAt)
    }
    return out
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

  /**
   * Snapshot of live claude PTY session states per chat. Used by the
   * sidebar badge selector. Chats not present are implicitly `cold`.
   */
  getClaudeSessionStates(): Map<string, "warming" | "active" | "idle"> {
    const out = new Map<string, "warming" | "active" | "idle">()
    const now = Date.now()
    for (const [chatId, session] of this.claudeSessions) {
      if (this.activeTurns.get(chatId)?.provider === "claude") {
        out.set(chatId, "active")
      } else if (now - session.lastUsedAt >= this.resolveClaudeIdleMs()) {
        out.set(chatId, "idle")
      } else {
        out.set(chatId, "warming")
      }
    }
    return out
  }

  get toolCallbackService(): ToolCallbackService | null {
    return this.toolCallback
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  private resolveClaudeDriverPreference(): ClaudeDriverPreference {
    const fromSettings = this.getAppSettingsSnapshot().claudeDriver?.preference
    if (fromSettings === "pty" || fromSettings === "sdk") return fromSettings
    return process.env.KANNA_CLAUDE_DRIVER === "pty" ? "pty" : "sdk"
  }

  private getEnabledCustomMcpServers(): readonly McpServerConfig[] {
    const snap = this.getAppSettingsSnapshot()
    const list = (snap as { customMcpServers?: readonly McpServerConfig[] }).customMcpServers
    if (!Array.isArray(list)) return []
    return list.filter((s) => s.enabled)
  }

  /**
   * Resolves the effective ChatPermissionPolicy for a chat: starts from the
   * coordinator-wide default, overlays the chat's persisted policyOverride.
   */
  private resolveChatPolicy(chatId: string): ChatPermissionPolicy {
    // store.state may be absent in test fakes that don't implement the full
    // EventStore — fall through to the global default policy in that case.
    const override = this.store.state?.chatsById?.get(chatId)?.policyOverride ?? null
    return mergePolicyOverride(this.chatPolicy, override)
  }

  private resolveClaudeIdleMs(): number {
    const fromSettings = this.getAppSettingsSnapshot().claudeDriver?.lifecycle?.idleTimeoutMs
    if (typeof fromSettings === "number" && Number.isFinite(fromSettings) && fromSettings > 0) {
      return Math.round(fromSettings)
    }
    return this.claudeSessionLifecycle.idleMs
  }

  private resolveClaudeMaxResident(): number {
    const fromSettings = this.getAppSettingsSnapshot().claudeDriver?.lifecycle?.maxConcurrent
    if (typeof fromSettings === "number" && Number.isFinite(fromSettings) && fromSettings > 0) {
      return Math.round(fromSettings)
    }
    return this.claudeSessionLifecycle.maxResidentSessions
  }

  /**
   * True when the chat is hosting an in-flight background Workflow (a run the
   * #358 disk-watch registry reports as `status: "running"`). A live workflow
   * runs inside the warm PTY claude process but registers no activeTurn,
   * pendingPromptSeq, or lastUsedAt bump, so without this signal the idle
   * reaper / budget enforcer would tear the process down mid-run and abort the
   * workflow. The sidecar status is written terminal on abort/exit, so a dead
   * run never strands a session in a false `running` state.
   */
  private hasLiveWorkflow(chatId: string): boolean {
    return this.workflowRegistry?.snapshot(chatId).some((run) => run.status === "running") ?? false
  }

  private isClaudeSessionIdle(chatId: string, session: ClaudeSessionState, now = Date.now()): boolean {
    if (this.activeTurns.get(chatId)?.provider === "claude") return false
    if (session.pendingPromptSeqs.length > 0) return false
    if (this.hasLiveWorkflow(chatId)) return false
    return now - session.lastUsedAt >= this.resolveClaudeIdleMs()
  }

  /**
   * Tear down a Claude session and (by default) release the OAuth-pool
   * reservation owned by the chat.
   *
   * `keepReservation: true` — used by rate-limit / auth-error rotation
   * paths that have ALREADY claimed a fresh token via `pickActive(chatId)`
   * before calling close. Without this flag, `release(chatId)` would
   * scan reservedBy for `owner === chatId` and drop the *new* token the
   * rotation just claimed, leaking the rotation's reservation (audit #9d).
   */
  private closeClaudeSession(
    chatId: string,
    session: ClaudeSessionState,
    opts?: { keepReservation?: boolean },
  ): void {
    if (this.claudeSessions.get(chatId) === session) {
      this.claudeSessions.delete(chatId)
    }
    if (!opts?.keepReservation) {
      this.oauthPool?.release(chatId)
    }
    session.session.close()
  }

  private sweepIdleClaudeSessions(now = Date.now()): void {
    for (const [chatId, session] of [...this.claudeSessions.entries()]) {
      if (!this.isClaudeSessionIdle(chatId, session, now)) continue
      this.closeClaudeSession(chatId, session)
      this.emitStateChange(chatId)
    }
  }

  private enforceClaudeSessionBudget(protectedChatId?: string): void {
    const max = this.resolveClaudeMaxResident()
    if (max <= 0 || this.claudeSessions.size <= max) return

    const candidates = [...this.claudeSessions.entries()]
      .filter(([chatId, session]) => (
        chatId !== protectedChatId
        && !this.activeTurns.has(chatId)
        && session.pendingPromptSeqs.length === 0
        && !this.hasLiveWorkflow(chatId)
      ))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)

    while (this.claudeSessions.size > max && candidates.length > 0) {
      const next = candidates.shift()
      if (!next) break
      const [chatId, session] = next
      this.closeClaudeSession(chatId, session)
      this.emitStateChange(chatId)
    }
  }

  /**
   * Format a refusal message when `pickActive(chatId)` returned null but the
   * pool has tokens. Names the offending tokens so the user knows which
   * chat to close or which token to add a quota to, instead of seeing the
   * generic "all tokens unavailable" line that doesn't say what's holding
   * them. `scopeSuffix` lets the subagent path tag its variant.
   */
  private buildPoolUnavailableMessage(reservedFor: string, scopeSuffix: string): string {
    const pool = this.oauthPool
    if (!pool) {
      return `All OAuth tokens are unavailable${scopeSuffix} (rate-limited, errored, or in use).`
    }
    const now = Date.now()
    const fmtTime = (ms: number) => {
      const mins = Math.max(0, Math.round((ms - now) / 60_000))
      if (mins < 60) return `${mins}m`
      const h = Math.floor(mins / 60)
      const m = mins % 60
      return m === 0 ? `${h}h` : `${h}h${m}m`
    }
    const lines: string[] = []
    for (const u of pool.describeUnavailability(reservedFor)) {
      if (u.reason === "available") continue
      const label = u.label || u.tokenId.slice(0, 8)
      if (u.reason === "limited") {
        lines.push(`  - ${label}: rate-limited (~${fmtTime(u.until)} remaining)`)
      } else if (u.reason === "reserved") {
        const refs = u.byChatIds.map((id) => {
          const chat = this.store.getChat(id)
          const title = chat?.title || `chat ${id.slice(0, 8)}`
          return `[${title}](/chat/${id})`
        })
        const joined = refs.length === 0 ? "another chat" : refs.join(", ")
        lines.push(`  - ${label}: in use by ${joined}`)
      } else if (u.reason === "error") {
        lines.push(`  - ${label}: errored${u.message ? ` (${u.message})` : ""}`)
      } else if (u.reason === "disabled") {
        lines.push(`  - ${label}: disabled`)
      }
    }
    const header = `All OAuth tokens are unavailable${scopeSuffix}:`
    const footer = "Close the chat holding a contested token, wait for the rate-limit to reset, or add another token."
    return [header, ...lines, footer].join("\n")
  }

  private subagentPendingKey(chatId: string, runId: string, toolUseId: string): string {
    return `${chatId}::${runId}::${toolUseId}`
  }

  private rejectPendingResolvers(predicate: (key: string) => boolean, reason: string) {
    for (const [key, resolver] of this.subagentPendingResolvers) {
      if (!predicate(key)) continue
      this.subagentPendingResolvers.delete(key)
      resolver.reject(new Error(reason))
    }
  }

  private rejectPendingResolversForChat(chatId: string) {
    const prefix = `${chatId}::`
    this.rejectPendingResolvers((k) => k.startsWith(prefix), "chat cancelled")
  }

  private rejectPendingResolversForRun(chatId: string, runId: string) {
    const prefix = `${chatId}::${runId}::`
    this.rejectPendingResolvers((k) => k.startsWith(prefix), "subagent run terminated")
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

  private clearDrainingStream(chatId: string): void {
    this.drainingStreams.delete(chatId)
  }

  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.clearDrainingStream(chatId)
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
        // Ephemeral spawn: reserve under a synthetic key so two concurrent
        // ensureSlashCommandsLoaded calls (different chats) cannot be handed
        // the same token by lastUsedAt ordering. The lease MUST be released
        // once the throwaway session closes (audit #2).
        const lease = this.oauthPool?.pickEphemeral() ?? null
        // Skip the ephemeral spawn entirely when the pool has tokens but
        // nothing is usable — avoids 401 against the CLI's keychain fallback
        // and an opaque "supportedCommands failed" warning. Slash commands
        // will load on the next turn once a token is available.
        if (this.oauthPool && this.oauthPool.hasAnyToken() && !lease) {
          return
        }
        const picked = lease?.token ?? null
        if (picked) this.oauthPool!.markUsed(picked.id)
        const usePtyEphemeral = this.resolveClaudeDriverPreference() === "pty"
        const ephemeralSystemPromptAppend = buildKannaSystemPromptAppend(this.getSubagents(), {
          globalPromptAppend: this.getAppSettingsSnapshot().globalPromptAppend,
        })
        try {
          const ephemeral = usePtyEphemeral
            ? await this.startClaudeSessionPTYFn({
                chatId,
                projectId: project.id,
                localPath: project.localPath,
                model: resolveClaudeApiModelId(defaultModel, defaultOptions.contextWindow),
                effort: defaultOptions.reasoningEffort,
                planMode: chat.planMode ?? false,
                sessionToken: chat.sessionTokensByProvider.claude ?? null,
                forkSession: false,
                oauthToken: picked?.token ?? null,
                oauthLabel: picked?.label,
                oauthKeyMasked: picked ? maskOauthKey(picked.token) : undefined,
                onToolRequest: async () => null,
                systemPromptAppend: ephemeralSystemPromptAppend,
                ptyRegistry: this.claudePtyRegistry ?? undefined,
                ptyInstanceRegistry: this.ptyInstanceRegistry ?? undefined,
                workflowRegistry: this.workflowRegistry ?? undefined,
                customMcpServers: this.getEnabledCustomMcpServers(),
                  })
            : await this.startClaudeSessionFn({
                projectId: project.id,
                localPath: project.localPath,
                model: resolveClaudeApiModelId(defaultModel, defaultOptions.contextWindow),
                effort: defaultOptions.reasoningEffort,
                planMode: chat.planMode ?? false,
                sessionToken: chat.sessionTokensByProvider.claude ?? null,
                forkSession: false,
                oauthToken: picked?.token ?? null,
                onToolRequest: async () => null,
                systemPromptAppend: ephemeralSystemPromptAppend,
                customMcpServers: this.getEnabledCustomMcpServers(),
              })
          try {
            commands = await ephemeral.getSupportedCommands()
          } finally {
            ephemeral.close()
          }
        } finally {
          lease?.release()
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
      this.closeClaudeSession(chatId, claudeSession)
    }
    this.autoResumeByChat.delete(chatId)
    this.emitStateChange(chatId)
  }

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

    // Mentions no longer short-circuit the main turn (Anthropic-style
    // Task-tool pattern). The main agent always runs; mention metadata is
    // still attached to the user_prompt entry by `startTurnForChat` →
    // `appendUserPrompt`.
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
    userClearedContext?: boolean
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
      this.clearDrainingStream(args.chatId)
    }

    // A new user turn implicitly clears any prior cancellation marker —
    // otherwise a Stop-then-resend cycle wedges every delegate_subagent
    // call in this chat with "Chat cancelled before run started" until
    // process restart. Mirrors the clear already done by
    // runMentionsForUserMessage for the @mention path.
    this.subagentOrchestrator.clearChatCancellation(args.chatId)

    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId)) {
      throw new Error("Chat is already running")
    }

    // A real human turn (appendUserPrompt, not an auto-continue replay) breaks
    // any agent-wake chain: the user is back in the loop, so the runaway-loop
    // budget (`maxAgentWakes`) resets. Auto-continue fires carry `autoContinue`
    // and must NOT reset, or the cap could never trip.
    if (args.appendUserPrompt && !args.autoContinue) {
      this.agentWakeChainByChat.delete(args.chatId)
    }

    if (chat.provider !== args.provider) {
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

    let appendedUserMessageId: string | null = null
    if (args.appendUserPrompt) {
      const parsedMentions = parseMentions(args.content, this.getSubagents())
      const subagentMentions = parsedMentions
        .filter((mention): mention is Extract<ParsedMention, { kind: "subagent" }> => mention.kind === "subagent")
        .map((mention) => ({ subagentId: mention.subagentId, raw: mention.raw }))
      const unknownSubagentMentions = parsedMentions
        .filter((mention): mention is Extract<ParsedMention, { kind: "unknown-subagent" }> => mention.kind === "unknown-subagent")
        .map((mention) => ({ name: mention.name, raw: mention.raw }))
      const userPromptEntry = timestamped(
        {
          kind: "user_prompt",
          content: args.content,
          attachments: args.attachments,
          steered: args.steered,
          autoContinue: args.autoContinue,
          ...(subagentMentions.length > 0 ? { subagentMentions } : {}),
          ...(unknownSubagentMentions.length > 0 ? { unknownSubagentMentions } : {}),
        },
        Date.now()
      )
      await this.store.appendMessage(args.chatId, userPromptEntry)
      appendedUserMessageId = userPromptEntry._id
      logSendToStartingProfile(args.profile, "start_turn.user_prompt_appended", {
        chatId: args.chatId,
        entryId: userPromptEntry._id,
      })
    }
    await this.store.recordTurnStarted(args.chatId)
    logSendToStartingProfile(args.profile, "start_turn.turn_started_recorded", {
      chatId: args.chatId,
    })

    try {
      await this.startTurnAfterTurnStarted({
        args,
        chat,
        project,
        existingMessages,
        shouldGenerateTitle,
        optimisticTitle,
        appendedUserMessageId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isOAuthRefusal = error instanceof OAuthPoolUnavailableError
      console.error(`${LOG_PREFIX} startTurnForChat failed after turn_started`, {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
        planMode: args.planMode,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        kind: isOAuthRefusal ? "oauth_pool_unavailable" : "unknown",
      })
      // OAuth-pool refusal: persist the formatted refusal (with chat-link
      // markdown produced by `buildPoolUnavailableMessage`) as a `result`
      // transcript entry so the UI's transcript renders it inline and
      // durably, instead of relying on the ephemeral commandError banner
      // that gets wiped by the next chat snapshot tick.
      if (isOAuthRefusal) {
        try {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
        } catch (appendErr) {
          console.error(`${LOG_PREFIX} append refusal result entry failed`, {
            chatId: args.chatId,
            appendErr: appendErr instanceof Error ? appendErr.message : String(appendErr),
          })
        }
      }
      try {
        await this.store.recordTurnFailed(args.chatId, message)
      } catch (recordErr) {
        console.error(`${LOG_PREFIX} recordTurnFailed also failed`, {
          chatId: args.chatId,
          recordErr: recordErr instanceof Error ? recordErr.message : String(recordErr),
        })
      }
      this.activeTurns.delete(args.chatId)
      this.emitStateChange(args.chatId, { immediate: true })
      // Swallow refusals — the transcript entry above is the user-facing
      // signal. Re-throwing would surface a transient commandError banner
      // that races with snapshot ticks and visibly flickers (see #235).
      if (isOAuthRefusal) {
        return
      }
      throw error
    }
  }

  private async startTurnAfterTurnStarted(ctx: {
    args: {
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
      userClearedContext?: boolean
      profile?: SendToStartingProfile | null
    }
    chat: ChatRecord
    project: ProjectRecord
    existingMessages: TranscriptEntry[]
    shouldGenerateTitle: boolean
    optimisticTitle: string | null
    appendedUserMessageId: string | null
  }): Promise<void> {
    const { args, chat, project, existingMessages, shouldGenerateTitle, optimisticTitle, appendedUserMessageId } = ctx
    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat")
    }

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      let active = this.activeTurns.get(args.chatId)
      if (!active) {
        // The prior turn's `result` event already deleted the activeTurn, but
        // the Claude SDK fired another `canUseTool` — happens when the SDK
        // self-resumes after a background task notification. Re-promote a
        // minimal activeTurn from the live session so the question renders
        // instead of failing with "Chat turn ended unexpectedly".
        active = this.recreateActiveTurnFromSession(args)
        if (!active) {
          throw new Error("Chat turn ended unexpectedly")
        }
      }

      active.status = "waiting_for_user"
      active.waitStartedAt = Date.now()
      this.emitStateChange(args.chatId)

      return await new Promise<unknown>((resolve) => {
        active.pendingTool = {
          toolUseId: request.tool.toolId,
          tool: request.tool,
          resolve,
        }
      })
    }

    const targetProvider: AgentProvider = args.provider
    const existingToken = chat.sessionTokensByProvider[targetProvider] ?? null
    const pendingForkToken = chat.pendingForkSessionToken?.provider === targetProvider
      ? chat.pendingForkSessionToken.token
      : null
    const shouldPrime = shouldInjectPrimer(
      chat.sessionTokensByProvider,
      targetProvider,
      Boolean(args.userClearedContext),
    )
    const userPromptText = buildPromptText(args.content, args.attachments)
    const primer = shouldPrime
      ? buildHistoryPrimer(existingMessages, targetProvider, userPromptText)
      : null
    const promptContent = primer ?? userPromptText

    let turn: HarnessTurn
    if (args.provider === "claude") {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      const spawn = resolveSpawnPaths(chat, project.localPath)
      turn = await this.startClaudeTurn({
        chatId: args.chatId,
        projectId: project.id,
        localPath: spawn.cwd,
        additionalDirectories: spawn.additionalDirectories,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: pendingForkToken ?? existingToken,
        forkSession: pendingForkToken != null,
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
      // Codex single-cwd: peer worktrees not passed to startSession. Cross-root writes use grantRoot.
      const sessionToken = await this.codexManager.startSession({
        chatId: args.chatId,
        cwd: resolveSpawnPaths(chat, project.localPath).cwd,
        projectId: project.id,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: existingToken,
        pendingForkSessionToken: pendingForkToken,
      })
      if (pendingForkToken && sessionToken) {
        await this.store.setPendingForkSessionToken(args.chatId, null)
      }
      logSendToStartingProfile(args.profile, "start_turn.session_ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.codexManager.startTurn({
        chatId: args.chatId,
        content: promptContent,
        model: args.model,
        effort: args.effort as any,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        onToolRequest,
        developerInstructions: this.getAppSettingsSnapshot().globalPromptAppend,
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
      waitStartedAt: null,
      userMessageId: appendedUserMessageId ?? this.findLastUserMessageId(args.chatId),
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
          let augmented = accountInfo
          if (args.provider === "claude") {
            const session = this.claudeSessions.get(args.chatId)
            if (session) {
              if (session.accountInfoLoaded) return
              session.accountInfoLoaded = true
              if (session.oauthKeyMasked && !accountInfo.oauthKeyMasked) {
                augmented = { ...accountInfo, oauthKeyMasked: session.oauthKeyMasked }
              }
            } else {
              return
            }
          }
          await this.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo: augmented }))
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
      await session.session.sendPrompt(promptContent)
      session.lastUsedAt = Date.now()
      logSendToStartingProfile(args.profile, "start_turn.claude_prompt_sent", {
        chatId: args.chatId,
      })
      return
    }

    void this.runTurn(active)
  }

  private recreateActiveTurnFromSession(args: {
    chatId: string
    provider: AgentProvider
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    clientTraceId?: string
  }): ActiveTurn | undefined {
    if (args.provider !== "claude") return undefined
    const session = this.claudeSessions.get(args.chatId)
    if (!session) return undefined

    const ghostTurn: HarnessTurn = {
      provider: "claude",
      stream: { async *[Symbol.asyncIterator]() {} },
      getAccountInfo: session.session.getAccountInfo,
      interrupt: session.session.interrupt,
      close: () => {},
    }

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn: ghostTurn,
      model: session.model,
      effort: session.effort,
      serviceTier: args.serviceTier,
      planMode: session.planMode,
      status: "waiting_for_user",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
      clientTraceId: args.clientTraceId,
      waitStartedAt: null,
      userMessageId: this.findLastUserMessageId(args.chatId),
    }
    this.activeTurns.set(args.chatId, active)
    return active
  }

  private findLastUserMessageId(chatId: string): string | null {
    const messages = this.store.getMessages(chatId) as TranscriptEntry[]
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const entry = messages[i]
      if (entry.kind === "user_prompt") return entry._id
    }
    return null
  }

  private async startClaudeTurn(args: {
    chatId: string
    projectId: string
    localPath: string
    additionalDirectories?: string[]
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  }): Promise<HarnessTurn> {
    let session = this.claudeSessions.get(args.chatId)

    if (
      !session ||
      session.localPath !== args.localPath ||
      session.effort !== args.effort ||
      args.forkSession ||
      session.additionalDirectories.join("|") !== (args.additionalDirectories ?? []).join("|")
    ) {
      if (session) {
        this.closeClaudeSession(args.chatId, session)
      }

      this.enforceClaudeSessionBudget(args.chatId)
      const picked = this.oauthPool?.pickActive(args.chatId) ?? null
      // If the pool is populated but every token is currently unusable
      // (limited/error/disabled/reserved), refuse to spawn rather than let
      // the CLI fall back to its keychain auth — that path serves whichever
      // login the CLI binary's keychain holds, which is typically
      // expired in a pool-managed setup and produces opaque 401 loops.
      if (this.oauthPool && this.oauthPool.hasAnyToken() && !picked) {
        throw new OAuthPoolUnavailableError(this.buildPoolUnavailableMessage(args.chatId, ""))
      }
      if (picked) this.oauthPool!.markUsed(picked.id)
      const usePty = this.resolveClaudeDriverPreference() === "pty"
      const systemPromptAppend = buildKannaSystemPromptAppend(this.getSubagents(), {
        globalPromptAppend: this.getAppSettingsSnapshot().globalPromptAppend,
      })
      const chatIdForCtx = args.chatId
      const delegationContext: KannaMcpDelegationContext = {
        parentSubagentId: null,
        parentRunId: null,
        ancestorSubagentIds: [],
        depth: 0,
        getParentUserMessageId: () => this.activeTurns.get(chatIdForCtx)?.userMessageId ?? null,
      }
      let started: ClaudeSessionHandle
      try {
        started = usePty
          ? await this.startClaudeSessionPTYFn({
              chatId: args.chatId,
              projectId: args.projectId,
              localPath: args.localPath,
              model: args.model,
              effort: args.effort,
              planMode: args.planMode,
              sessionToken: args.sessionToken,
              forkSession: args.forkSession,
              oauthToken: picked?.token ?? null,
              oauthLabel: picked?.label,
              oauthKeyMasked: picked ? maskOauthKey(picked.token) : undefined,
              additionalDirectories: args.additionalDirectories,
              onToolRequest: args.onToolRequest,
              systemPromptAppend,
              subagentOrchestrator: this.subagentOrchestrator,
              delegationContext,
              scheduleWakeup: (a) => this.scheduleAgentWakeup({
                chatId: chatIdForCtx, delayMs: a.delayMs, prompt: a.prompt, source: "agent_wakeup",
              }),
              toolCallback: this.toolCallback ?? undefined,
              tunnelGateway: this.tunnelGateway,
              chatPolicy: this.resolveChatPolicy(args.chatId),
              ptyRegistry: this.claudePtyRegistry ?? undefined,
                ptyInstanceRegistry: this.ptyInstanceRegistry ?? undefined,
              workflowRegistry: this.workflowRegistry ?? undefined,
              customMcpServers: this.getEnabledCustomMcpServers(),
            })
          : await this.startClaudeSessionFn({
              projectId: args.projectId,
              localPath: args.localPath,
              model: args.model,
              effort: args.effort,
              planMode: args.planMode,
              sessionToken: args.sessionToken,
              forkSession: args.forkSession,
              oauthToken: picked?.token ?? null,
              additionalDirectories: args.additionalDirectories,
              chatId: args.chatId,
              tunnelGateway: this.tunnelGateway,
              onToolRequest: args.onToolRequest,
              systemPromptAppend,
              subagentOrchestrator: this.subagentOrchestrator,
              delegationContext,
              scheduleWakeup: (a) => this.scheduleAgentWakeup({
                chatId: chatIdForCtx, delayMs: a.delayMs, prompt: a.prompt, source: "agent_wakeup",
              }),
              toolCallback: this.toolCallback ?? undefined,
              chatPolicy: this.resolveChatPolicy(args.chatId),
              customMcpServers: this.getEnabledCustomMcpServers(),
            })
      } catch (err) {
        // Spawn failed before we registered the session — release the OAuth
        // pool reservation we took at line ~2144. Without this the token
        // stays "in use" until process restart, eventually starving every
        // chat once all tokens are reserved.
        if (picked) this.oauthPool?.release(args.chatId)
        throw err
      }

      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: started,
        localPath: args.localPath,
        additionalDirectories: args.additionalDirectories ?? [],
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: args.sessionToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        activeTokenId: picked?.id ?? null,
        oauthKeyMasked: picked ? maskOauthKey(picked.token) : null,
        lastUsedAt: Date.now(),
      }
      this.claudeSessions.set(args.chatId, session)
      this.enforceClaudeSessionBudget(args.chatId)
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
      session.lastUsedAt = Date.now()
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

    // Mentions no longer short-circuit the main turn. The main agent always
    // runs and decides whether to delegate via `mcp__kanna__delegate_subagent`
    // (Anthropic-style Task-tool pattern). `parseMentions` still runs inside
    // `startTurnForChat` → `appendUserPrompt` so the user_prompt entry
    // continues to carry `subagentMentions` metadata for UI badges + analytics.
    const provider = this.resolveProvider(command, chat.provider)
    const settings = this.getProviderSettings(provider, command)
    this.analytics.track("message_sent")

    // Proactive compact: if the latest usage snapshot crossed claude-code's
    // auto-compact threshold, inject a synthetic `/compact` turn ahead of the
    // user's real message. The user's prompt sits in the queue and runs after
    // `/compact` produces its summary, so the next turn ships with a bounded
    // history instead of looping on "Prompt is too long".
    if (
      provider === "claude"
      && this.shouldInjectProactiveCompact(chatId, command.content)
    ) {
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      await this.startTurnForChat({
        chatId,
        provider,
        content: "/compact",
        attachments: [],
        model: settings.model,
        effort: settings.effort,
        serviceTier: settings.serviceTier,
        planMode: settings.planMode,
        // /compact is a slash command, not the user's actual message — don't
        // persist a user_prompt transcript entry for it.
        appendUserPrompt: false,
        profile,
      })
      // Tag the active turn so the result handler can update the circuit
      // breaker (reset on success / increment on failure).
      const compactActive = this.activeTurns.get(chatId)
      if (compactActive) compactActive.proactiveCompactInjection = true

      logSendToStartingProfile(profile, "chat_send.proactive_compact_injected", {
        chatId,
        provider,
        model: settings.model,
        queuedUserMessageId: queuedMessage.id,
      })

      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

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

  private shouldInjectProactiveCompact(chatId: string, content: string): boolean {
    // Never recurse — if the user (or Kanna itself) is already sending a
    // slash command, run it as-is. Compacting before `/clear` or another
    // `/compact` would be wasted work.
    if (content.trimStart().startsWith("/")) return false
    const failures = this.store.getChat(chatId)?.compactFailureCount ?? 0
    if (failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) return false
    const usage = getLatestContextWindowUsage(this.store.getMessages(chatId))
    return shouldProactivelyCompact(usage)
  }

  /**
   * D6 — subagent Claude starter. When `KANNA_CLAUDE_DRIVER=pty` the
   * subagent turn runs through the PTY driver (subscription billing)
   * instead of always falling back to the SDK (API billing). Adapts the
   * SDK-shaped `startClaudeSession` arg to `StartClaudeSessionPtyArgs`,
   * injecting the coordinator-owned preflight / toolCallback / tunnel /
   * policy context and `oneShot: true` so the REPL closes after the
   * single subagent turn (depends on Phase 4 D7).
   */
  private buildClaudeSubagentStarter(): NonNullable<BuildSubagentProviderRunArgs["startClaudeSession"]> {
    return async (a) => {
      if (this.resolveClaudeDriverPreference() === "pty") {
        return this.startClaudeSessionPTYFn({
          chatId: a.chatId ?? "",
          projectId: a.projectId,
          localPath: a.localPath,
          model: a.model,
          effort: a.effort,
          planMode: a.planMode,
          sessionToken: a.sessionToken,
          forkSession: a.forkSession,
          oauthToken: a.oauthToken,
          additionalDirectories: a.additionalDirectories,
          onToolRequest: a.onToolRequest,
          systemPromptOverride: a.systemPromptOverride,
          initialPrompt: a.initialPrompt,
          subagentOrchestrator: a.subagentOrchestrator,
          delegationContext: a.delegationContext,
          toolCallback: this.toolCallback ?? undefined,
          tunnelGateway: this.tunnelGateway,
          chatPolicy: a.chatId ? this.resolveChatPolicy(a.chatId) : undefined,
          oneShot: true,
          ptyRegistry: this.claudePtyRegistry ?? undefined,
                ptyInstanceRegistry: this.ptyInstanceRegistry ?? undefined,
          workflowRegistry: this.workflowRegistry ?? undefined,
          customMcpServers: this.getEnabledCustomMcpServers(),
        })
      }
      return this.startClaudeSessionFn({ ...a, customMcpServers: this.getEnabledCustomMcpServers() })
    }
  }

  private buildSubagentProviderRunForChat(args: {
    subagent: Subagent
    chatId: string
    primer: string | null
    userInstruction: string | null
    runId: string
    abortSignal: AbortSignal
    depth: number
    ancestorSubagentIds: string[]
    parentUserMessageId: string
  }): ProviderRunStart {
    const chat = this.store.requireChat(args.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error(`Project ${chat.projectId} not found for chat ${args.chatId}`)
    const spawn = resolveSpawnPaths(chat, project.localPath)

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      if (request.tool.toolKind !== "ask_user_question"
          && request.tool.toolKind !== "exit_plan_mode") {
        // Non-interactive tools (bash, read, write, ...) — SDK handles
        // them via canUseTool wrapper. No forwarding needed.
        return null
      }
      const toolUseId = request.tool.toolId
      const key = this.subagentPendingKey(args.chatId, args.runId, toolUseId)
      await this.store.appendSubagentEvent({
        v: 3,
        type: "subagent_tool_pending",
        timestamp: Date.now(),
        chatId: args.chatId,
        runId: args.runId,
        toolUseId,
        toolKind: request.tool.toolKind,
        input: request.tool.input,
      })
      this.emitStateChange(args.chatId)
      this.subagentOrchestrator.notifySubagentToolPending(args.runId)
      return await new Promise<unknown>((resolve, reject) => {
        // Defensive: if `canUseTool` somehow fires twice for the same
        // (chatId, runId, toolUseId) — e.g. SDK retry — reject the previous
        // resolver before overwriting so its Promise doesn't leak.
        const existing = this.subagentPendingResolvers.get(key)
        if (existing) {
          existing.reject(new Error("superseded by retry"))
        }
        this.subagentPendingResolvers.set(key, { resolve, reject })
      })
    }

    const delegationContext: KannaMcpDelegationContext = {
      parentSubagentId: args.subagent.id,
      parentRunId: args.runId,
      ancestorSubagentIds: [...args.ancestorSubagentIds, args.subagent.id],
      depth: args.depth + 1,
      // For sub-spawn-sub, the parent_user_message_id stays anchored to the
      // chat turn that started the whole chain — that's the attribution the
      // run_started events use, and the orchestrator's depth/cycle checks
      // protect against runaway chains.
      getParentUserMessageId: () => args.parentUserMessageId,
    }

    return buildSubagentProviderRun({
      subagent: args.subagent,
      chatId: args.chatId,
      primer: args.primer,
      userInstruction: args.userInstruction,
      runId: args.runId,
      abortSignal: args.abortSignal,
      cwd: spawn.cwd,
      additionalDirectories: spawn.additionalDirectories,
      projectId: project.id,
      startClaudeSession: this.buildClaudeSubagentStarter(),
      subagentOrchestrator: this.subagentOrchestrator,
      delegationContext,
      codexManager: this.codexManager,
      onToolRequest,
      globalPromptAppend: this.getAppSettingsSnapshot().globalPromptAppend,
      authReady: async (provider) => {
        if (provider === "claude") {
          const settings = this.getAppSettingsSnapshot()
          // Pass parent chat id so a token already reserved by the parent
          // counts as usable. Subagent runs are sequential under the parent
          // (parent's turn is paused), so sharing the parent's reservation
          // is correct — see oauth-token-pool isEligible.
          return Boolean(settings.claudeAuth?.authenticated || this.oauthPool?.hasUsable(args.chatId))
        }
        return true
      },
      pickOauthToken: () => {
        // Subagent inherits the parent chat's reservation by re-picking under
        // the same chatId. pickActive treats the parent's reservation as
        // owned-by-self (drops + re-binds to chatId), so the lifecycle stays
        // bound to the parent's close path — no separate subagent release.
        const picked = this.oauthPool?.pickActive(args.chatId) ?? null
        if (this.oauthPool && this.oauthPool.hasAnyToken() && !picked) {
          throw new OAuthPoolUnavailableError(this.buildPoolUnavailableMessage(args.chatId, " for subagent run"))
        }
        if (picked) this.oauthPool!.markUsed(picked.id)
        return picked?.token ?? null
      },
    })
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
      await this.cancel(command.chatId, { hideInterrupted: true, skipQueueDrain: true })
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

    // Refuse to drop the queued message while a Kanna-injected `/compact`
    // turn is running. The compact was triggered specifically to make room
    // for this queued message; auto-draining it after compact completes
    // would silently lose user intent and waste the compact spend.
    const active = this.activeTurns.get(command.chatId)
    if (active?.proactiveCompactInjection) {
      throw new Error("Cannot remove queued message while compact is running")
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
    const currentProviderToken = chat.provider
      ? chat.sessionTokensByProvider[chat.provider] ?? null
      : null
    const pendingForkForProvider = chat.pendingForkSessionToken?.provider === chat.provider
      ? chat.pendingForkSessionToken.token
      : null
    if (!currentProviderToken && !pendingForkForProvider) {
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
          await this.store.setSessionTokenForProvider(session.chatId, "claude", event.sessionToken)
          this.emitStateChange(session.chatId)
          continue
        }

        if (event.type === "rate_limit" && event.rateLimit) {
          // Stale rate_limit events from a session that has already been
          // rotated away must not trigger another rotation/continue.
          if (this.claudeSessions.get(session.chatId) !== session) continue
          await this.handleLimitDetection(session.chatId, {
            chatId: session.chatId,
            resetAt: event.rateLimit.resetAt,
            tz: event.rateLimit.tz,
            raw: event,
          })
          if (this.claudeSessions.get(session.chatId) !== session) break
          continue
        }

        if (!event.entry) continue
        if (this.claudeSessions.get(session.chatId) !== session) break
        await this.store.appendMessage(session.chatId, event.entry)
        const active = this.activeTurns.get(session.chatId)
        if (event.entry.kind === "system_init" && active) {
          active.status = "running"
          const chat = this.store.getChat(session.chatId)
          if (
            chat?.pendingForkSessionToken
            && session.sessionToken
            && session.sessionToken !== chat.pendingForkSessionToken.token
          ) {
            await this.store.setPendingForkSessionToken(session.chatId, null)
          }
          // Refresh the chat's slashCommands from the live system_init list
          // every spawn. The cold-start `getSupportedCommands()` call right
          // after spawn often returns the static fallback because system_init
          // hadn't arrived yet; this overwrites that with the canonical list
          // (skills + plugins + built-ins, no `/` prefix).
          if (Array.isArray((event.entry as { slashCommands?: unknown }).slashCommands)) {
            const names = (event.entry as { slashCommands: string[] }).slashCommands
            const commands: SlashCommand[] = names.map((name) => ({
              name,
              description: "",
              argumentHint: "",
            }))
            await this.store.recordSessionCommandsLoaded(session.chatId, commands)
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
          session.lastUsedAt = Date.now()
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
          // True once a rate-limit / auth-error was routed through
          // handleLimitDetection / handleAuthFailure. Those paths already
          // marked the failed token limited/errored (dropping its
          // reservation) and, when a rotation target exists, pinned the
          // replacement token under this chatId for the scheduled
          // auto-continue to reuse. The turn-scoped release below MUST be
          // skipped in that case — otherwise it drops the freshly-pinned
          // rotation token and a concurrent chat can steal it before
          // fireAutoContinue spawns the replacement session (audit #1).
          let failureHandled = false
          if (event.entry.isError) {
            const resultText = event.entry.result || "Turn failed"
            const debugRaw = typeof (event.entry as { debugRaw?: unknown }).debugRaw === "string"
              ? (event.entry as { debugRaw: string }).debugRaw
              : ""
            const detection = this.claudeLimitDetector.detectFromResultText?.(session.chatId, resultText) ?? null
            const authDetection = this.claudeAuthErrorDetector.detectFromResultText(session.chatId, resultText)
              ?? this.claudeAuthErrorDetector.detectFromResultText(session.chatId, debugRaw)
            let handled = false
            if (detection) {
              handled = await this.handleLimitDetection(session.chatId, detection)
            } else if (authDetection) {
              handled = await this.handleAuthFailure(session, authDetection)
            }
            failureHandled = handled
            if (handled) {
              await this.store.recordTurnFailed(session.chatId, detection ? "rate_limit" : "auth_error")
            } else if (isPromptTooLongMessage(resultText)) {
              await this.store.recordTurnFailed(session.chatId, resultText)
              this.closeClaudeSession(session.chatId, session)
              await this.store.setSessionTokenForProvider(session.chatId, "claude", null)
            } else {
              await this.store.recordTurnFailed(session.chatId, resultText)
            }
            if (active.proactiveCompactInjection) {
              const prev = this.store.getChat(session.chatId)?.compactFailureCount ?? 0
              await this.store.setCompactFailureCount(session.chatId, prev + 1)
            }
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(session.chatId)
            if (active.proactiveCompactInjection) {
              await this.store.setCompactFailureCount(session.chatId, 0)
            }
            await this.maybeArmPendingWorkflowWake(session.chatId, event.entry)
          }
          this.activeTurns.delete(session.chatId)
          // Turn-scoped reservation: release on turn end so other chats can
          // claim the same token while this chat is idle. The next turn for
          // this chat reuses the same claude session (no re-pick); the
          // rotation race between in-flight turns is still serialized via
          // markLimited/markError (both drop the reservation) and the
          // atomic single-threaded pickActive(chatId) calls.
          //
          // Skip when a rotation handled the failure: the rotation already
          // pinned the replacement token under this chatId and the
          // scheduled auto-continue (TOKEN_ROTATION_SCHEDULE_DELAY_MS later)
          // depends on that pin still being held.
          if (!failureHandled) {
            this.oauthPool?.release(session.chatId)
          }
          if (!active.cancelRequested) {
            await this.maybeStartNextQueuedMessage(session.chatId)
          }
        }

        this.emitStateChange(session.chatId)
      }
    } catch (error) {
      const active = this.activeTurns.get(session.chatId)
      if (active && !active.cancelRequested) {
        const limitHandled = await this.handleLimitError(session.chatId, this.claudeLimitDetector, error)
        const authDetection = limitHandled
          ? null
          : this.claudeAuthErrorDetector.detect(session.chatId, error)
        const authHandled = authDetection
          ? await this.handleAuthFailure(session, authDetection)
          : false
        const handled = limitHandled || authHandled
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
          if (isPromptTooLongMessage(message)) {
            this.closeClaudeSession(session.chatId, session)
            await this.store.setSessionTokenForProvider(session.chatId, "claude", null)
          }
        } else {
          await this.store.recordTurnFailed(session.chatId, limitHandled ? "rate_limit" : "auth_error")
        }
      }
    } finally {
      const active = this.activeTurns.get(session.chatId)
      const isCurrentSession = this.claudeSessions.get(session.chatId) === session
      // Trace point: stream-end-without-final-result is the hang signature.
      // If `hasActiveTurn=true` && `hasFinalResult=false` && this fires,
      // the user will see "still running" forever unless we fail-close.
      console.log("[kanna/agent] runClaudeSession stream ended", {
        chatId: session.chatId,
        sessionId: session.id,
        sessionToken: session.sessionToken,
        isCurrentSession,
        hasActiveTurn: Boolean(active),
        activeStatus: active?.status,
        cancelRequested: active?.cancelRequested,
        hasFinalResult: active?.hasFinalResult,
      })
      // Only clear chat state if it still points at us. A cancel-then-steer,
      // or an oauth-pool rotation that closes this session and schedules an
      // auto-continue, can install a fresh session (and activeTurn) under
      // the same chatId before this finally runs; wiping either
      // unconditionally would break the fresh session's bookkeeping and
      // leave its stream running headless (no isError branch fires →
      // sessionToken never cleared → next turn loops with the same
      // too-large --resume context).
      if (isCurrentSession) {
        this.claudeSessions.delete(session.chatId)
        this.oauthPool?.release(session.chatId)
        if (active?.provider === "claude") {
          if (active.cancelRequested && !active.cancelRecorded) {
            await this.store.recordTurnCancelled(session.chatId)
          } else if (!active.hasFinalResult) {
            // Stream ended without any terminal result event (PTY died,
            // SDK transport dropped, etc). Fail-close the turn so the UI
            // stops showing "running" forever. Without this the chat is
            // wedged until the user manually clicks Stop or reloads.
            console.warn("[kanna/agent] stream ended with no final result — recording turn failure", { chatId: session.chatId, sessionId: session.id })
            await this.store.recordTurnFailed(session.chatId, "session stream ended without a result")
          }
          this.activeTurns.delete(session.chatId)
        }
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
          await this.store.setSessionTokenForProvider(active.chatId, active.provider, event.sessionToken)
          const chat = this.store.getChat(active.chatId)
          if (
            chat?.pendingForkSessionToken
            && event.sessionToken !== chat.pendingForkSessionToken.token
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
      this.clearDrainingStream(active.chatId)
      // Turn-scoped reservation: release so another chat can claim this
      // token while this chat is idle. The rotation race between concurrent
      // in-flight turns is still serialized — both startClaudeTurn and the
      // pickActive() inside markLimited/markError run atomically in the JS
      // event loop, and a token marked limited/errored already drops its
      // reservation. The next turn for this chat reuses its existing claude
      // session (no re-pick) or pickActive again if it needs a fresh one.
      this.oauthPool?.release(active.chatId)
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

  /**
   * Returns the additional scheduling delay (ms) for a respawn caused by a
   * rotation event on `tokenId`. The first detector in a
   * TOKEN_ROTATION_DEDUPE_WINDOW_MS window gets 0; each later detector gets
   * an additional TOKEN_ROTATION_HERD_STAGGER_MS so PTY cold-boots spread
   * out instead of stampeding. Also reports whether this caller is the
   * first detector (used to skip duplicate markLimited/markError calls).
   */
  private acquireRotationSlot(tokenId: string | null): { extraDelayMs: number; isFirst: boolean } {
    if (!tokenId) return { extraDelayMs: 0, isFirst: true }
    const now = Date.now()
    const existing = this.tokenRotationDedupe.get(tokenId)
    if (!existing || now - existing.firstSeenAt > TOKEN_ROTATION_DEDUPE_WINDOW_MS) {
      this.tokenRotationDedupe.set(tokenId, { firstSeenAt: now, staggerCount: 0 })
      return { extraDelayMs: 0, isFirst: true }
    }
    existing.staggerCount += 1
    return { extraDelayMs: existing.staggerCount * TOKEN_ROTATION_HERD_STAGGER_MS, isFirst: false }
  }

  private async handleLimitError(chatId: string, detector: LimitDetector, error: unknown): Promise<boolean> {
    const detection = detector.detect(chatId, error)
    if (!detection) return false
    return this.handleLimitDetection(chatId, detection)
  }

  private async handleLimitDetection(chatId: string, detection: LimitDetection): Promise<boolean> {
    const live = deriveChatSchedules(this.store.getAutoContinueEvents(chatId), chatId).liveScheduleId
    if (live !== null) return true

    const session = this.claudeSessions.get(chatId)
    const limitedTokenId = session?.activeTokenId ?? null
    const slot = this.acquireRotationSlot(limitedTokenId)
    if (this.oauthPool && limitedTokenId && slot.isFirst) {
      this.oauthPool.markLimited(limitedTokenId, detection.resetAt)
    }
    const rotationTarget = this.oauthPool?.pickActive(chatId) ?? null
    const canRotate = rotationTarget !== null
      && (!limitedTokenId || rotationTarget.id !== limitedTokenId)

    if (this.oauthPool) {
      console.log("[oauth-pool] rate-limit detected", {
        chatId,
        markedLimitedTokenId: limitedTokenId,
        resetAt: new Date(detection.resetAt).toISOString(),
        tz: detection.tz,
        nextTokenId: rotationTarget?.id ?? null,
        canRotate,
        herdSlot: slot,
      })
    }

    const now = Date.now()
    const scheduleId = crypto.randomUUID()
    const base = { v: AUTO_CONTINUE_EVENT_VERSION, timestamp: now, chatId, scheduleId }

    // When no rotation is possible, "wait until rate-limit clears" means waiting
    // for the earliest token in the pool to become available again — not just
    // the current detection's resetAt, which would over-shoot if another pool
    // token has an earlier limitedUntil.
    const earliestPoolUnlimit = this.oauthPool?.earliestUnlimit() ?? null
    const waitUntil = earliestPoolUnlimit !== null
      ? Math.min(detection.resetAt, earliestPoolUnlimit)
      : detection.resetAt

    const event: AutoContinueEvent = canRotate
      ? {
          ...base,
          kind: "auto_continue_accepted",
          scheduledAt: now + TOKEN_ROTATION_SCHEDULE_DELAY_MS + slot.extraDelayMs,
          tz: detection.tz,
          source: "token_rotation",
          resetAt: detection.resetAt,
          detectedAt: now,
        }
      : this.resolveAutoResumeFor(chatId)
        ? {
            ...base,
            kind: "auto_continue_accepted",
            scheduledAt: waitUntil,
            tz: detection.tz,
            source: "auto_setting",
            resetAt: waitUntil,
            detectedAt: now,
          }
        : {
            ...base,
            kind: "auto_continue_proposed",
            detectedAt: now,
            resetAt: waitUntil,
            tz: detection.tz,
          }

    await this.emitAutoContinueEvent(event)
    if (canRotate && session) {
      // Tear down the session bound to the limited token so the next turn
      // spawns a fresh subprocess with the rotated token's credentials.
      // Without this, startClaudeTurn reuses the cached session and
      // sendPrompt is routed to the still-limited token's subprocess.
      // keepReservation: true — the `pickActive(chatId)` above already
      // claimed `rotationTarget` under this chatId; the default `release`
      // path would scan reservedBy for owner===chatId and drop it,
      // leaking the rotation's reservation (audit #9d).
      this.closeClaudeSession(chatId, session, { keepReservation: true })
      const active = this.activeTurns.get(chatId)
      if (active) {
        await this.store.recordTurnFailed(chatId, "rate_limit")
        this.activeTurns.delete(chatId)
      }
    }
    if (!canRotate) {
      await this.store.appendMessage(chatId, timestamped({
        kind: "auto_continue_prompt",
        scheduleId,
      }))
    }

    return true
  }

  /**
   * Handle an OAuth 401 / authentication failure on a live Claude session:
   *   1. Mark the offending token as `error` in the pool so subsequent
   *      pickActive() calls skip it.
   *   2. Try to rotate to another usable token. If one exists, tear down
   *      the dead session and schedule an immediate auto-continue with
   *      source `token_rotation` (mirrors the rate-limit rotation path).
   *   3. If no rotation target exists, surface an auto_continue_proposed
   *      event so the UI can prompt the user to fix their token pool
   *      instead of looping silently.
   *
   * Returns true when the failure was handled (rotated or proposed),
   * false otherwise (caller logs the raw error).
   */
  private async handleAuthFailure(
    session: ClaudeSessionState,
    detection: AuthErrorDetection,
  ): Promise<boolean> {
    const chatId = session.chatId
    const live = deriveChatSchedules(this.store.getAutoContinueEvents(chatId), chatId).liveScheduleId
    if (live !== null) return true

    const erroredTokenId = session.activeTokenId
    const slot = this.acquireRotationSlot(erroredTokenId)
    if (this.oauthPool && erroredTokenId && slot.isFirst) {
      this.oauthPool.markError(erroredTokenId, detection.reason)
    }
    const rotationTarget = this.oauthPool?.pickActive(chatId) ?? null
    const canRotate = rotationTarget !== null
      && (!erroredTokenId || rotationTarget.id !== erroredTokenId)

    if (this.oauthPool) {
      console.log("[oauth-pool] auth-error detected", {
        chatId,
        markedErrorTokenId: erroredTokenId,
        reason: detection.reason,
        nextTokenId: rotationTarget?.id ?? null,
        canRotate,
        herdSlot: slot,
      })
    }

    const now = Date.now()
    const scheduleId = crypto.randomUUID()
    const base = { v: AUTO_CONTINUE_EVENT_VERSION, timestamp: now, chatId, scheduleId }

    // Auth errors mean the token is dead, not throttled — rotate
    // immediately when possible, no wait window.
    const event: AutoContinueEvent = canRotate
      ? {
          ...base,
          kind: "auto_continue_accepted",
          scheduledAt: now + TOKEN_ROTATION_SCHEDULE_DELAY_MS + slot.extraDelayMs,
          tz: "system",
          source: "token_rotation",
          resetAt: now,
          detectedAt: now,
        }
      : {
          ...base,
          kind: "auto_continue_proposed",
          detectedAt: now,
          resetAt: now,
          tz: "system",
        }

    await this.emitAutoContinueEvent(event)
    if (canRotate) {
      // Tear down the session bound to the dead token so the next turn
      // spawns a fresh subprocess with the rotated token in env.
      // keepReservation: true — `pickActive(chatId)` above already claimed
      // the rotation target under this chatId. The previous inline close +
      // delete pair sidestepped `closeClaudeSession` to avoid the
      // accidental release; route through the helper now that release is
      // opt-out, for symmetry with the rate-limit rotation path.
      this.closeClaudeSession(chatId, session, { keepReservation: true })
      const active = this.activeTurns.get(chatId)
      if (active) {
        await this.store.recordTurnFailed(chatId, "auth_error")
        this.activeTurns.delete(chatId)
      }
    }
    if (!canRotate) {
      await this.store.appendMessage(chatId, timestamped({
        kind: "auto_continue_prompt",
        scheduleId,
      }))
    }

    return true
  }

  async fireAutoContinue(chatId: string, scheduleId: string) {
    if (!this.store.getChat(chatId)) return

    // Agent-driven wakes (`agent_wakeup` / `pending_workflow`) carry the prompt
    // the model asked to resume with; provider-failure schedules carry none and
    // fall back to the literal "continue".
    const schedule = this.getChatSchedule(chatId, scheduleId)
    const promptToReplay = schedule?.prompt ?? "continue"

    const event: AutoContinueEvent = {
      v: AUTO_CONTINUE_EVENT_VERSION,
      kind: "auto_continue_fired",
      timestamp: Date.now(),
      chatId,
      scheduleId,
    }
    try {
      await this.store.appendAutoContinueEvent(event)
      await this.enqueueMessage(chatId, promptToReplay, [], { autoContinue: { scheduleId } })
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

  /**
   * Arm a Kanna-owned wake for an agent-driven signal — the model calling
   * `ScheduleWakeup` (`source: "agent_wakeup"`) or a turn ending with a
   * background Workflow still running (`source: "pending_workflow"`). Routes
   * through the same event-sourced `ScheduleManager` as provider-failure
   * resume, so it survives restart and obeys the cancel cascade. The native
   * claude-code wake cannot work under Kanna's spawn model (the fire lands as
   * an `isMeta:true` line that `jsonl-to-event.ts` drops), so Kanna owns it.
   * See adr-20260603-agent-self-scheduled-wake.
   *
   * Returns the new `scheduleId`, or `null` when the per-chat runaway-loop cap
   * (`maxAgentWakes`) is reached — the caller surfaces that to the model.
   */
  async scheduleAgentWakeup(args: {
    chatId: string
    delayMs: number
    prompt: string
    source: "agent_wakeup" | "pending_workflow"
  }): Promise<string | null> {
    const { chatId, delayMs, prompt, source } = args
    if (!this.store.getChat(chatId)) throw new Error("Chat not found")

    const chainLength = this.agentWakeChainByChat.get(chatId) ?? 0
    if (chainLength >= this.maxAgentWakes) return null

    const now = Date.now()
    const scheduledAt = now + Math.max(0, delayMs)
    const scheduleId = crypto.randomUUID()
    await this.emitAutoContinueEvent({
      v: AUTO_CONTINUE_EVENT_VERSION,
      kind: "auto_continue_accepted",
      timestamp: now,
      chatId,
      scheduleId,
      scheduledAt,
      tz: "system",
      source,
      resetAt: scheduledAt,
      detectedAt: now,
      prompt,
    })
    this.agentWakeChainByChat.set(chatId, chainLength + 1)
    return scheduleId
  }

  /**
   * When a turn ends with a background Workflow still running, arm a single
   * Kanna-owned wake so the agent re-enters to harvest results instead of
   * going idle (the reported failure mode: a Workflow launched, the turn
   * ended with `pendingWorkflowCount: 1`, and the chat sat idle forever).
   * Kanna gets no mid-flight completion signal, so the replayed prompt asks
   * the model to check its background work; if still running, the model can
   * call `schedule_wakeup` to wait longer. The runaway cap bounds the poll.
   * No-op when the count is absent/0 or a schedule is already live.
   */
  private async maybeArmPendingWorkflowWake(chatId: string, entry: TranscriptEntry): Promise<void> {
    if (entry.kind !== "result") return
    const count = entry.pendingWorkflowCount ?? 0
    if (count <= 0) return
    const live = deriveChatSchedules(this.store.getAutoContinueEvents(chatId), chatId).liveScheduleId
    if (live !== null) return
    await this.scheduleAgentWakeup({
      chatId,
      delayMs: this.pendingWorkflowPollMs,
      prompt:
        `A background Workflow was still running when your last turn ended `
        + `(${count} pending). Check its result/output now and continue. If it is `
        + `still running, call schedule_wakeup to wait longer rather than ending idle.`,
      source: "pending_workflow",
    })
  }

  listLiveSchedules(chatId: string): string[] {
    const { schedules } = deriveChatSchedules(this.store.getAutoContinueEvents(chatId), chatId)
    return Object.values(schedules)
      .filter((s) => s.state === "proposed" || s.state === "scheduled")
      .map((s) => s.scheduleId)
      .sort()
  }

  async killPtyInstance(chatId: string): Promise<void> {
    const instance = this.ptyInstanceRegistry?.snapshot().find((entry) => entry.chatId === chatId)
    if (!instance || instance.pid === null) {
      throw new Error("No live PTY instance for chat")
    }
    const { killPgroup } = await import("./claude-pty/pid-registry.adapter")
    killPgroup(instance.pid)
    this.ptyInstanceRegistry?.upsert(chatId, {
      phase: "exited",
      exitedAt: Date.now(),
      lastEventAt: Date.now(),
    })
  }

  async cancel(chatId: string, options?: { hideInterrupted?: boolean; skipQueueDrain?: boolean }) {
    // Also clean up any draining stream for this chat.
    const draining = this.drainingStreams.get(chatId)
    if (draining) {
      draining.turn.close()
      this.clearDrainingStream(chatId)
    }

    // Reject any subagent canUseTool Promises waiting on a user response in
    // this chat, and signal the orchestrator. Both happen unconditionally —
    // a chat may have no active main-turn (e.g. just an @mention with the
    // main turn already ended) while subagents are still running. Without
    // this, the SDK's canUseTool callback hangs forever, wedging the
    // subagent session and leaking the resolver entry.
    this.rejectPendingResolversForChat(chatId)
    this.subagentOrchestrator.cancelChat(chatId)

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

    // Drain the cancelled prompt's seq from the Claude session's pending
    // queue. The SDK does not always echo a `result.subtype=cancelled` for
    // an interrupted prompt — when the stream just ends, the seq would
    // otherwise linger and cause a FIFO mismatch when the next turn's
    // result arrives, leaving the chat stuck in "running".
    if (active.provider === "claude" && active.claudePromptSeq != null) {
      const session = this.claudeSessions.get(chatId)
      if (session) {
        const idx = session.pendingPromptSeqs.indexOf(active.claudePromptSeq)
        if (idx >= 0) session.pendingPromptSeqs.splice(idx, 1)
      }
    }

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

    // For Claude under the PTY driver, `active.turn` is a ghost facade over
    // the long-lived `claudeSessions` entry and its `close()` is a no-op.
    // The PTY driver's `interrupt()` sends SIGINT which terminates the CLI,
    // so the underlying session is dead — drop it from the map so the next
    // turn respawns a fresh `claude --resume <sessionToken>` (preserves
    // transcript context). For the SDK driver, `interrupt()` is honored
    // in-band without killing the worker, so reuse is still valid.
    if (active.provider === "claude" && this.resolveClaudeDriverPreference() === "pty") {
      const session = this.claudeSessions.get(chatId)
      if (session) {
        this.closeClaudeSession(chatId, session)
      }
    }

    // Drain the queue. A queued message must auto-start after cancel; the
    // result-success branch in runClaudeSession is the only other place this
    // is called, and it can never fire for a cancelled turn (active has been
    // deleted above before the result event arrives).
    //
    // `skipQueueDrain` is passed by callers that handle dequeue themselves
    // (e.g. `steer`, which dequeues the head message with the steer wrapper).
    if (!options?.skipQueueDrain) {
      await this.maybeStartNextQueuedMessage(chatId)
    }
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
    active.waitStartedAt = null

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        await this.store.setSessionTokenForProvider(command.chatId, active.provider, null)
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

  async respondSubagentTool(command: Extract<ClientCommand, { type: "chat.respondSubagentTool" }>) {
    const key = this.subagentPendingKey(command.chatId, command.runId, command.toolUseId)
    const resolver = this.subagentPendingResolvers.get(key)
    if (!resolver) {
      // Idempotent: a double-submit (client retry, concurrent WS messages, or
      // a response arriving after the run already terminated) should not
      // surface a confusing error to the UI. Resolver-absent = already
      // resolved or run died; nothing to do.
      return
    }
    this.subagentPendingResolvers.delete(key)
    await this.store.appendSubagentEvent({
      v: 3,
      type: "subagent_tool_resolved",
      timestamp: Date.now(),
      chatId: command.chatId,
      runId: command.runId,
      toolUseId: command.toolUseId,
      result: command.result,
      resolution: "user",
    })
    this.subagentOrchestrator.notifySubagentToolResolved(command.runId)
    resolver.resolve(command.result)
    this.emitStateChange(command.chatId)
  }

  async cancelSubagentRun(
    command: Extract<ClientCommand, { type: "chat.cancelSubagentRun" }>,
  ) {
    this.subagentOrchestrator.cancelRun(command.chatId, command.runId)
  }
}

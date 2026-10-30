// Minimal typed subset vendored from `codex app-server generate-ts`.
// Keep names and field shapes aligned with the official app-server protocol.

import type { CodexReasoningEffort, ServiceTier } from "../shared/types"

export type CodexRequestId = string | number

export interface JsonRpcResponse<TResult = unknown> {
  id: CodexRequestId
  result?: TResult
  error?: {
    code?: number
    message?: string
  }
}

export interface InitializeParams {
  clientInfo: {
    name: string
    title: string
    version: string
  }
  capabilities: {
    experimentalApi: boolean
  }
}

export interface ThreadStartParams {
  config?: Record<string, unknown>
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  experimentalRawEvents: boolean
  persistExtendedHistory: boolean
}

export interface ThreadResumeParams {
  config?: Record<string, unknown>
  threadId: string
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  persistExtendedHistory: boolean
}

export interface ThreadForkParams {
  config?: Record<string, unknown>
  threadId: string
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  ephemeral?: boolean
  persistExtendedHistory: boolean
  /** The last turn to fork through, inclusive: turns after it are left out of the fork. It cannot be in progress. */
  lastTurnId?: string | null
}

export interface TextUserInput {
  type: "text"
  text: string
  text_elements: []
}

/**
 * Structured skill invocation: the server resolves `path` by exact match
 * against its own discovered+enabled skills and injects the SKILL.md contents
 * into the turn. Unmatched paths are silently skipped by codex, which is why
 * Kanna also appends a `<system-message>` failsafe to the text item.
 */
export interface SkillUserInput {
  type: "skill"
  name: string
  path: string
}

export type CodexUserInput = TextUserInput | SkillUserInput

export interface CollaborationMode {
  mode: "default" | "plan"
  settings: {
    model: string | null
    reasoning_effort: ReasoningEffort | null
    developer_instructions: string | null
  }
}

export type ReasoningEffort = CodexReasoningEffort

export interface TurnStartParams {
  threadId: string
  input: CodexUserInput[]
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  model?: string | null
  effort?: ReasoningEffort | null
  serviceTier?: ServiceTier | null
  collaborationMode?: CollaborationMode | null
}

export interface TurnInterruptParams {
  threadId: string
  turnId: string
}

/** `skills/list` (codex >= 0.73). Older servers answer with "method not found". */
export interface SkillsListParams {
  cwds: string[]
  forceReload?: boolean
}

export interface CodexSkillInterfaceMetadata {
  displayName?: string
  shortDescription?: string
  defaultPrompt?: string
}

export interface CodexSkillMetadata {
  name: string
  description: string
  shortDescription?: string
  interface?: CodexSkillInterfaceMetadata | null
  /** Absolute path to the SKILL.md file itself — the resolution key for SkillUserInput. */
  path: string
  scope: "user" | "repo" | "system" | "admin"
  enabled: boolean
}

export interface SkillsListResponse {
  data: {
    cwd: string
    skills: CodexSkillMetadata[]
    errors?: { path: string; message: string }[]
  }[]
}

/** `model/list`: the models the signed-in account can run, in picker order. */
export interface ModelListParams {
  cursor?: string | null
  limit?: number | null
  includeHidden?: boolean | null
}

export interface ModelReasoningEffortOption {
  reasoningEffort: string
  description: string
}

export interface ModelServiceTier {
  id: string
  name: string
  description: string
}

export interface CodexModelSummary {
  id: string
  /** The slug passed to `thread/start` (e.g. "gpt-5.6-sol"). */
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: ModelReasoningEffortOption[]
  /** Deprecated upstream in favour of `serviceTiers`; older servers still send it. */
  additionalSpeedTiers?: string[]
  serviceTiers?: ModelServiceTier[]
  defaultServiceTier?: string | null
  upgrade?: string | null
}

export interface ModelListResponse {
  data: CodexModelSummary[]
  nextCursor?: string | null
}

export interface ThreadSummary {
  id: string
  /** Set on a thread an agent spawned: the thread that spawned it. */
  parentThreadId?: string | null
}

export interface ThreadStartResponse {
  thread: ThreadSummary
  model: string
  reasoningEffort: ReasoningEffort | null
}

export type ThreadResumeResponse = ThreadStartResponse
export type ThreadForkResponse = ThreadStartResponse

/**
 * `codexErrorInfo` is a serde externally-tagged enum. Causes without data
 * arrive as a bare string (`"usageLimitExceeded"`); the HTTP family arrives as
 * a one-key object (`{ responseStreamDisconnected: { httpStatusCode: 502 } }`).
 * The object form is the stream-drop family that `willRetry` retries cover.
 */
export type CodexErrorInfo = string | Record<string, { httpStatusCode?: number | null } | null | undefined>

/**
 * Shape codex uses for every error it reports — the `error` notification and
 * the error on a failed turn are the same struct. `message` is often only a
 * summary; `codexErrorInfo` carries the specific cause.
 */
export interface CodexError {
  message?: string
  codexErrorInfo?: CodexErrorInfo | null
  additionalDetails?: unknown
}

export interface TurnSummary {
  id: string
  status: "inProgress" | "completed" | "failed" | "interrupted"
  error: CodexError | null
}

export interface TurnStartResponse {
  turn: TurnSummary
}

export interface ThreadStartedNotification {
  thread: ThreadSummary
}

export interface ThreadStatusChangedNotification {
  threadId: string
  /** `active` while a turn runs. `idle` between turns, and for a moment before a new thread's first. */
  status: { type: "notLoaded" | "idle" | "systemError" | "active" }
}

export interface ThreadClosedNotification {
  threadId: string
}

export interface TurnStartedNotification {
  threadId: string
  turn: TurnSummary
}

export interface TurnCompletedNotification {
  threadId: string
  turn: TurnSummary
}

export interface TurnPlanStep {
  step: string
  status: "pending" | "inProgress" | "completed"
}

export interface TurnPlanUpdatedNotification {
  threadId: string
  turnId: string
  explanation: string | null
  plan: TurnPlanStep[]
}

export interface PlanDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ContextCompactedNotification {
  threadId: string
  turnId: string
}

export interface TokenUsageCounter {
  input_tokens?: number
  inputTokens?: number
  cached_input_tokens?: number
  cachedInputTokens?: number
  output_tokens?: number
  outputTokens?: number
  reasoning_output_tokens?: number
  reasoningOutputTokens?: number
  total_tokens?: number
  totalTokens?: number
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string
  turnId: string
  tokenUsage: {
    total_token_usage?: TokenUsageCounter
    total?: TokenUsageCounter
    last_token_usage?: TokenUsageCounter
    last?: TokenUsageCounter
    model_context_window?: number
    modelContextWindow?: number
  }
}

export interface ToolRequestUserInputOption {
  label: string
  description?: string | null
}

export interface ToolRequestUserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: ToolRequestUserInputOption[] | null
}

export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: ToolRequestUserInputQuestion[]
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
}

export interface CommandExecutionRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  approvalId?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
}

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"

export type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision
}

export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision
}

export interface ToolRequestUserInputRequest {
  id: CodexRequestId
  method: "item/tool/requestUserInput"
  params: ToolRequestUserInputParams
}

export interface DynamicToolCallParams {
  threadId: string
  turnId: string
  callId: string
  tool: string
  arguments: Record<string, unknown> | unknown[] | string | number | boolean | null
}

export interface DynamicToolCallOutputContentItem {
  type: "inputText" | "inputImage"
  text?: string
  imageUrl?: string
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[]
  success: boolean
}

export interface DynamicToolCallRequest {
  id: CodexRequestId
  method: "item/tool/call"
  params: DynamicToolCallParams
}

export interface CommandExecutionRequestApprovalRequest {
  id: CodexRequestId
  method: "item/commandExecution/requestApproval"
  params: CommandExecutionRequestApprovalParams
}

export interface FileChangeRequestApprovalRequest {
  id: CodexRequestId
  method: "item/fileChange/requestApproval"
  params: FileChangeRequestApprovalParams
}

export type ServerRequest =
  | ToolRequestUserInputRequest
  | DynamicToolCallRequest
  | CommandExecutionRequestApprovalRequest
  | FileChangeRequestApprovalRequest

export interface UserMessageItem {
  type: "userMessage"
  id: string
  content: Array<{
    type: "text"
    text: string
    text_elements: []
  }>
}

export interface ReasoningItem {
  type: "reasoning"
  id: string
  summary: unknown[]
  content: unknown[]
}

export interface AgentMessageItem {
  type: "agentMessage"
  id: string
  text: string
  phase?: string
}

export interface PlanItem {
  type: "plan"
  id: string
  text: string
}

export interface CommandExecutionItem {
  type: "commandExecution"
  id: string
  command: string
  cwd?: string
  processId?: string
  status: "inProgress" | "completed" | "failed" | "declined"
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
}

export interface McpToolCallItem {
  type: "mcpToolCall"
  id: string
  server: string
  tool: string
  arguments?: Record<string, unknown> | null
  result?: {
    content?: unknown[]
    structuredContent?: unknown
  } | null
  error?: {
    message?: string
  } | null
  status: "inProgress" | "completed" | "failed"
}

export interface DynamicToolCallItem {
  type: "dynamicToolCall"
  id: string
  tool: string
  arguments?: Record<string, unknown> | unknown[] | string | number | boolean | null
  status: "inProgress" | "completed" | "failed"
  contentItems?: DynamicToolCallOutputContentItem[] | null
  success?: boolean | null
  durationMs?: number | null
}

export interface CollabAgentToolCallItem {
  type: "collabAgentToolCall"
  id: string
  tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents"
  status: "inProgress" | "completed" | "failed" | "interrupted"
  senderThreadId: string
  receiverThreadIds: string[]
  prompt?: string | null
  agentsStates?: Record<string, { status: string; message: string | null }> | null
}

export interface WebSearchItem {
  type: "webSearch"
  id: string
  query: string
  action?: {
    type?: string
    query?: string
    queries?: string[]
  } | null
}

export interface FileChangeItem {
  type: "fileChange"
  id: string
  changes: Array<{
    path: string
    kind:
      | "add"
      | "delete"
      | "update"
      | {
          type: "add" | "delete" | "update"
          move_path?: string | null
        }
    diff?: string | null
  }>
  status: "inProgress" | "completed" | "failed" | "declined"
}

export interface ErrorItem {
  type: "error"
  id: string
  message: string
}

/**
 * How newer Codex announces an agent a thread spawned, in place of a
 * `collabAgentToolCall` for `spawnAgent`. It arrives on the spawning thread:
 * `started` with the new thread's id, and later `completed` or `interrupted`
 * for each turn that agent ends, which can be after the turn that spawned it.
 */
export interface SubAgentActivityItem {
  type: "subAgentActivity"
  id: string
  kind: "started" | "interacted" | "interrupted" | "completed"
  agentThreadId: string
  /** The agent's name under its parent, as a path: `/root/audit_parser`. */
  agentPath: string
}

export type ThreadItem =
  | UserMessageItem
  | ReasoningItem
  | AgentMessageItem
  | PlanItem
  | CommandExecutionItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
  | SubAgentActivityItem
  | WebSearchItem
  | FileChangeItem
  | ErrorItem

export interface ItemStartedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface ItemCompletedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface ErrorNotification {
  error: CodexError
  /**
   * True while codex is still retrying on its own — the turn has not failed
   * and `error.message` is a progress notice ("Reconnecting... 2/5"), not the
   * outcome. Only `willRetry: false` is terminal.
   */
  willRetry: boolean
  threadId?: string
  turnId?: string
}

export interface CodexRateLimitWindow {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

export interface CodexRateLimitSnapshot {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexRateLimitWindow | null
  secondary?: CodexRateLimitWindow | null
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null
  planType?: string | null
  /** Enterprise spend cap: decimal-string amounts, `resetsAt` in Unix seconds. */
  individualLimit?: {
    limit?: string | null
    used?: string | null
    remainingPercent?: number | null
    resetsAt?: number | null
  } | null
  spendControlReached?: boolean | null
}

export interface AccountRateLimitsUpdatedNotification {
  rateLimits: CodexRateLimitSnapshot
}

export interface GetAccountRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot | null | undefined> | null
}

export type ServerNotification =
  | { method: "thread/started"; params: ThreadStartedNotification }
  | { method: "thread/status/changed"; params: ThreadStatusChangedNotification }
  | { method: "thread/closed"; params: ThreadClosedNotification }
  | { method: "thread/tokenUsage/updated"; params: ThreadTokenUsageUpdatedNotification }
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "turn/plan/updated"; params: TurnPlanUpdatedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "item/plan/delta"; params: PlanDeltaNotification }
  | { method: "thread/compacted"; params: ContextCompactedNotification }
  | { method: "account/rateLimits/updated"; params: AccountRateLimitsUpdatedNotification }
  | { method: "error"; params: ErrorNotification }

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return Boolean(value) && typeof value === "object" && "id" in (value as Record<string, unknown>)
    && ("result" in (value as Record<string, unknown>) || "error" in (value as Record<string, unknown>))
    && !("method" in (value as Record<string, unknown>))
}

export function isServerRequest(value: unknown): value is ServerRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.method !== "string" || !("id" in candidate)) return false
  return candidate.method === "item/tool/requestUserInput"
    || candidate.method === "item/tool/call"
    || candidate.method === "item/commandExecution/requestApproval"
    || candidate.method === "item/fileChange/requestApproval"
}

export function isServerNotification(value: unknown): value is ServerNotification {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.method !== "string" || "id" in candidate) return false
  return candidate.method === "thread/started"
    || candidate.method === "thread/status/changed"
    || candidate.method === "thread/closed"
    || candidate.method === "thread/tokenUsage/updated"
    || candidate.method === "turn/started"
    || candidate.method === "turn/completed"
    || candidate.method === "turn/plan/updated"
    || candidate.method === "item/started"
    || candidate.method === "item/completed"
    || candidate.method === "item/plan/delta"
    || candidate.method === "thread/compacted"
    || candidate.method === "account/rateLimits/updated"
    || candidate.method === "error"
}

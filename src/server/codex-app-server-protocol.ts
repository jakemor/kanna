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
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  experimentalRawEvents: boolean
  persistExtendedHistory: boolean
}

export interface ThreadResumeParams {
  threadId: string
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  persistExtendedHistory: boolean
}

export interface TextUserInput {
  type: "text"
  text: string
  text_elements: []
}

export type CodexUserInput = TextUserInput

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

export interface ThreadSummary {
  id: string
}

export interface ThreadStartResponse {
  thread: ThreadSummary
  model: string
  reasoningEffort: ReasoningEffort | null
}

export type ThreadResumeResponse = ThreadStartResponse

export interface TurnSummary {
  id: string
  status: "inProgress" | "completed" | "failed" | "interrupted"
  error: {
    message?: string
  } | null
}

export interface TurnStartResponse {
  turn: TurnSummary
}

export interface ThreadStartedNotification {
  thread: ThreadSummary
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
  tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent"
  status: "inProgress" | "completed" | "failed"
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

export type ThreadItem =
  | UserMessageItem
  | ReasoningItem
  | AgentMessageItem
  | PlanItem
  | CommandExecutionItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
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
  error: {
    message: string
    codexErrorInfo?: string
    additionalDetails?: unknown
  }
  willRetry: boolean
  threadId?: string
  turnId?: string
}

export type ServerNotification =
  | { method: "thread/started"; params: ThreadStartedNotification }
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "turn/plan/updated"; params: TurnPlanUpdatedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "item/plan/delta"; params: PlanDeltaNotification }
  | { method: "thread/compacted"; params: ContextCompactedNotification }
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
    || candidate.method === "turn/started"
    || candidate.method === "turn/completed"
    || candidate.method === "turn/plan/updated"
    || candidate.method === "item/started"
    || candidate.method === "item/completed"
    || candidate.method === "item/plan/delta"
    || candidate.method === "thread/compacted"
    || candidate.method === "error"
}

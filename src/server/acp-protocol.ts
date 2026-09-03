// Minimal typed subset of the Agent Client Protocol (ACP), vendored the same
// way codex-app-server-protocol.ts vendors the codex app-server types.
//
// ACP is the editor<->agent protocol behind Zed's agent panel: newline-delimited
// JSON-RPC 2.0 over the agent's stdio. Kanna speaks the *client* half.
//
// Field shapes here were captured from a live `opencode acp` (v1.18.8) session
// rather than transcribed from the spec, so they reflect what an agent actually
// puts on the wire. Anything Kanna does not consume is left off.
//
// Spec: https://agentclientprotocol.com

export const ACP_PROTOCOL_VERSION = 1

export type AcpRequestId = string | number

export interface AcpJsonRpcResponse<TResult = unknown> {
  id: AcpRequestId
  result?: TResult
  error?: { code?: number; message?: string; data?: unknown }
}

/** A request *from* the agent that the client must answer (permissions, fs, terminal). */
export interface AcpServerRequest {
  id: AcpRequestId
  method: string
  params?: Record<string, unknown>
}

export interface AcpNotification {
  method: string
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------- initialize

export interface AcpInitializeParams {
  protocolVersion: number
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean }
    terminal: boolean
  }
  clientInfo: { name: string; title: string; version: string }
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: Record<string, unknown>
  }
  agentInfo?: { name?: string; version?: string }
  authMethods?: Array<{ id: string; name?: string; description?: string }>
}

// ------------------------------------------------------------------ sessions

export interface AcpNewSessionParams {
  cwd: string
  mcpServers: unknown[]
}

export interface AcpResumeSessionParams {
  sessionId: string
  cwd: string
  mcpServers: unknown[]
}

/**
 * Session-scoped settings the agent exposes for the client to render as
 * pickers. opencode reports two: `model` (its full provider/model list) and
 * `mode` (build/plan — its agent selector). Both `session/new` and
 * `session/set_config_option` answer with the full, updated list.
 */
export interface AcpConfigOption {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: string
  options?: Array<{ value: string; name?: string; description?: string }>
}

export interface AcpSessionResult {
  /** Absent on session/resume, which reuses the id the client passed in. */
  sessionId?: string
  configOptions?: AcpConfigOption[]
}

export interface AcpSetConfigOptionParams {
  sessionId: string
  /** Note: `configId`, not `optionId` — the latter is rejected as invalid params. */
  configId: string
  value: string
}

// -------------------------------------------------------------------- prompt

export interface AcpPromptParams {
  sessionId: string
  prompt: Array<{ type: "text"; text: string }>
}

/**
 * `refusal` and the `max_*` reasons are terminal-but-not-successful; Kanna
 * renders them as an errored result so the turn does not look like it simply
 * ended.
 */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"

export interface AcpPromptResult {
  stopReason: AcpStopReason
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    thoughtTokens?: number
    cachedReadTokens?: number
  }
}

export interface AcpCancelParams {
  sessionId: string
}

// ------------------------------------------------------------ session/update

export interface AcpTextContent {
  type: "text"
  text: string
}

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update"
  toolCallId: string
  /**
   * On the first frame this is the tool's name ("read", "bash"); on later
   * frames agents overwrite it with a human label ("notes.txt", "ls"), so the
   * name must be latched from the first frame that carries it.
   */
  title?: string
  kind?: string
  status?: AcpToolCallStatus
  locations?: Array<{ path?: string }>
  /** Empty on the `pending` frame; populated once the agent resolves arguments. */
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
  content?: Array<{ type: string; content?: AcpTextContent }>
}

export interface AcpMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"
  messageId?: string
  content?: AcpTextContent
}

export interface AcpUsageUpdate {
  sessionUpdate: "usage_update"
  used?: number
  size?: number
  cost?: { amount?: number; currency?: string }
}

export interface AcpPlanUpdate {
  sessionUpdate: "plan"
  entries?: Array<{ content?: string; priority?: string; status?: string }>
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: "available_commands_update"
  availableCommands?: Array<{ name?: string; description?: string }>
}

export type AcpSessionUpdate =
  | AcpToolCallUpdate
  | AcpMessageChunkUpdate
  | AcpUsageUpdate
  | AcpPlanUpdate
  | AcpAvailableCommandsUpdate
  | { sessionUpdate: string }

export interface AcpSessionUpdateParams {
  sessionId: string
  update: AcpSessionUpdate
}

// -------------------------------------------------------- permission (client)

export interface AcpPermissionOption {
  optionId: string
  name?: string
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export interface AcpRequestPermissionParams {
  sessionId: string
  options?: AcpPermissionOption[]
  toolCall?: { toolCallId?: string; title?: string }
}

// -------------------------------------------------------------------- guards

export function isAcpResponse(value: Record<string, unknown>): value is AcpJsonRpcResponse & Record<string, unknown> {
  return value.id !== undefined && value.method === undefined
}

export function isAcpServerRequest(value: Record<string, unknown>): value is AcpServerRequest & Record<string, unknown> {
  return value.id !== undefined && typeof value.method === "string"
}

export function isAcpNotification(value: Record<string, unknown>): value is AcpNotification & Record<string, unknown> {
  return value.id === undefined && typeof value.method === "string"
}

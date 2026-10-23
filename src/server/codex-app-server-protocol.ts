// Minimal typed subset vendored from `codex app-server generate-ts`.
// Keep names and field shapes aligned with the official app-server protocol.
//
// What Kanna sends is plain interfaces. What codex sends is a Schema, and the
// type of the same name is derived from it. Those schemas are deliberately
// loose: a newer codex adds fields, item types, statuses and notification
// methods, and none of that may stop a turn. So extra fields are allowed,
// fields the adapter can do without are optional, and status-like fields are
// plain strings rather than closed unions. Only what the adapter cannot work
// without is required.

import { Option, Predicate, Schema } from "effect"
import type { CodexReasoningEffort, ServiceTier } from "../shared/types"

/** Optional, and null when codex sends it as null. */
const maybe = <S extends Schema.Constraint>(schema: S) => Schema.optionalKey(Schema.NullishOr(schema))

export type CodexRequestId = string | number
export const CodexRequestId = Schema.Union([Schema.String, Schema.Number])

// ---------------------------------------------------------------------------
// What Kanna sends
// ---------------------------------------------------------------------------

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

/** `model/list`: the models the signed-in account can run, in picker order. */
export interface ModelListParams {
  cursor?: string | null
  limit?: number | null
  includeHidden?: boolean | null
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
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

export interface DynamicToolCallOutputContentItem {
  type: "inputText" | "inputImage"
  text?: string
  imageUrl?: string
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[]
  success: boolean
}

// ---------------------------------------------------------------------------
// What codex sends: responses
// ---------------------------------------------------------------------------

export const CodexSkillMetadata = Schema.Struct({
  name: Schema.String,
  description: maybe(Schema.String),
  shortDescription: maybe(Schema.String),
  interface: maybe(Schema.Struct({
    displayName: maybe(Schema.String),
    shortDescription: maybe(Schema.String),
    defaultPrompt: maybe(Schema.String),
  })),
  /** Absolute path to the SKILL.md file itself — the resolution key for SkillUserInput. */
  path: Schema.String,
  /** "user" | "repo" | "system" | "admin" */
  scope: maybe(Schema.String),
  enabled: Schema.Boolean,
})
export type CodexSkillMetadata = typeof CodexSkillMetadata.Type

export const SkillsListResponse = Schema.Struct({
  data: maybe(Schema.Array(Schema.Struct({
    cwd: maybe(Schema.String),
    skills: maybe(Schema.Array(CodexSkillMetadata)),
  }))),
})
export type SkillsListResponse = typeof SkillsListResponse.Type

/** One `model/list` row: the fields the catalog reads (`applyCodexModels`). */
export const CodexModelSummary = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  /** The slug passed to `thread/start` (e.g. "gpt-5.6-sol"). */
  model: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  hidden: maybe(Schema.Boolean),
  isDefault: Schema.optionalKey(Schema.Boolean),
  defaultReasoningEffort: Schema.optionalKey(Schema.String),
  supportedReasoningEfforts: Schema.optionalKey(Schema.Array(Schema.Struct({
    reasoningEffort: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }))),
  /** Deprecated upstream in favour of `serviceTiers`; older servers still send it. */
  additionalSpeedTiers: Schema.optionalKey(Schema.Array(Schema.String)),
  serviceTiers: Schema.optionalKey(Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
  }))),
  defaultServiceTier: maybe(Schema.String),
  upgrade: Schema.optionalKey(Schema.Unknown),
})
export type CodexModelSummary = typeof CodexModelSummary.Type

export const ModelListResponse = Schema.Struct({
  data: maybe(Schema.Array(CodexModelSummary)),
  nextCursor: maybe(Schema.String),
})
export type ModelListResponse = typeof ModelListResponse.Type

export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  /** Set on a thread an agent spawned: the thread that spawned it. */
  parentThreadId: maybe(Schema.String),
})
export type ThreadSummary = typeof ThreadSummary.Type

/** `thread/start`, `thread/resume` and `thread/fork` all answer with the thread. */
export const ThreadStartResponse = Schema.Struct({ thread: ThreadSummary })
export type ThreadStartResponse = typeof ThreadStartResponse.Type

/**
 * Shape codex uses for every error it reports — the `error` notification and
 * the error on a failed turn are the same struct. `message` is often only a
 * summary; `codexErrorInfo` carries the specific cause.
 *
 * `codexErrorInfo` is a serde externally-tagged enum. Causes without data
 * arrive as a bare string (`"usageLimitExceeded"`); the HTTP family arrives as
 * a one-key object (`{ responseStreamDisconnected: { httpStatusCode: 502 } }`).
 * The object form is the stream-drop family that `willRetry` retries cover.
 * It is read defensively (`formatCodexError`), so any shape is accepted here.
 */
export const CodexError = Schema.Struct({
  message: maybe(Schema.String),
  codexErrorInfo: Schema.optionalKey(Schema.Unknown),
  additionalDetails: Schema.optionalKey(Schema.Unknown),
})
export type CodexError = typeof CodexError.Type

export const TurnSummary = Schema.Struct({
  id: Schema.String,
  /** "inProgress" | "completed" | "failed" | "interrupted" */
  status: maybe(Schema.String),
  error: maybe(CodexError),
})
export type TurnSummary = typeof TurnSummary.Type

export const TurnStartResponse = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) })
export type TurnStartResponse = typeof TurnStartResponse.Type

const CodexRateLimitWindow = Schema.Struct({
  usedPercent: Schema.optionalKey(Schema.Number),
  windowDurationMins: maybe(Schema.Number),
  resetsAt: maybe(Schema.Number),
})

export const CodexRateLimitSnapshot = Schema.Struct({
  limitId: maybe(Schema.String),
  limitName: maybe(Schema.String),
  primary: maybe(CodexRateLimitWindow),
  secondary: maybe(CodexRateLimitWindow),
  credits: maybe(Schema.Struct({
    hasCredits: Schema.optionalKey(Schema.Boolean),
    unlimited: Schema.optionalKey(Schema.Boolean),
    balance: maybe(Schema.String),
  })),
  planType: maybe(Schema.String),
})
export type CodexRateLimitSnapshot = typeof CodexRateLimitSnapshot.Type

export const GetAccountRateLimitsResponse = Schema.Struct({
  rateLimits: maybe(CodexRateLimitSnapshot),
  rateLimitsByLimitId: maybe(Schema.Record(Schema.String, Schema.NullishOr(CodexRateLimitSnapshot))),
})
export type GetAccountRateLimitsResponse = typeof GetAccountRateLimitsResponse.Type

/** Any JSON-RPC result: requests whose answer Kanna does not read (`initialize`, `turn/interrupt`). */
export const AnyResult = Schema.Unknown

// ---------------------------------------------------------------------------
// What codex sends: thread items
// ---------------------------------------------------------------------------

export const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  text: Schema.String,
  phase: maybe(Schema.String),
})

export const PlanItem = Schema.Struct({
  type: Schema.Literal("plan"),
  id: Schema.String,
  text: Schema.String,
})

export const CommandExecutionItem = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  id: Schema.String,
  command: Schema.String,
  cwd: maybe(Schema.String),
  processId: maybe(Schema.String),
  /** "inProgress" | "completed" | "failed" | "declined" */
  status: maybe(Schema.String),
  aggregatedOutput: maybe(Schema.String),
  exitCode: maybe(Schema.Number),
  durationMs: maybe(Schema.Number),
})

export const McpToolCallItem = Schema.Struct({
  type: Schema.Literal("mcpToolCall"),
  id: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  arguments: maybe(Schema.Record(Schema.String, Schema.Unknown)),
  result: maybe(Schema.Struct({
    content: maybe(Schema.Array(Schema.Unknown)),
    structuredContent: Schema.optionalKey(Schema.Unknown),
  })),
  error: maybe(Schema.Struct({
    message: maybe(Schema.String),
  })),
  /** "inProgress" | "completed" | "failed" */
  status: maybe(Schema.String),
})
export type McpToolCallItem = typeof McpToolCallItem.Type

export const DynamicToolCallContentItem = Schema.Struct({
  /** "inputText" | "inputImage" */
  type: Schema.String,
  text: maybe(Schema.String),
  imageUrl: maybe(Schema.String),
})
export type DynamicToolCallContentItem = typeof DynamicToolCallContentItem.Type

export const DynamicToolCallItem = Schema.Struct({
  type: Schema.Literal("dynamicToolCall"),
  id: Schema.String,
  tool: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  /** "inProgress" | "completed" | "failed" */
  status: maybe(Schema.String),
  contentItems: maybe(Schema.Array(DynamicToolCallContentItem)),
  success: maybe(Schema.Boolean),
  durationMs: maybe(Schema.Number),
})

export const CollabAgentToolCallItem = Schema.Struct({
  type: Schema.Literal("collabAgentToolCall"),
  id: Schema.String,
  /** "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | … */
  tool: Schema.String,
  /** "inProgress" | "completed" | "failed" | "interrupted" */
  status: maybe(Schema.String),
  senderThreadId: maybe(Schema.String),
  receiverThreadIds: maybe(Schema.Array(Schema.String)),
  prompt: maybe(Schema.String),
  agentsStates: Schema.optionalKey(Schema.Unknown),
})
export type CollabAgentToolCallItem = typeof CollabAgentToolCallItem.Type

export const WebSearchItem = Schema.Struct({
  type: Schema.Literal("webSearch"),
  id: Schema.String,
  query: maybe(Schema.String),
  action: maybe(Schema.Struct({
    type: maybe(Schema.String),
    query: maybe(Schema.String),
    queries: maybe(Schema.Array(Schema.Unknown)),
  })),
})

export const FileChangeItem = Schema.Struct({
  type: Schema.Literal("fileChange"),
  id: Schema.String,
  changes: Schema.Array(Schema.Struct({
    path: Schema.String,
    /** "add" | "delete" | "update", or `{ type, move_path }` */
    kind: Schema.Union([
      Schema.String,
      Schema.Struct({
        type: Schema.String,
        move_path: maybe(Schema.String),
      }),
    ]),
    diff: maybe(Schema.String),
  })),
  /** "inProgress" | "completed" | "failed" | "declined" */
  status: maybe(Schema.String),
})

export const ErrorItem = Schema.Struct({
  type: Schema.Literal("error"),
  id: Schema.String,
  message: Schema.String,
})

/**
 * How newer Codex announces an agent a thread spawned, in place of a
 * `collabAgentToolCall` for `spawnAgent`. It arrives on the spawning thread:
 * `started` with the new thread's id, and later `completed` or `interrupted`
 * for each turn that agent ends, which can be after the turn that spawned it.
 */
export const SubAgentActivityItem = Schema.Struct({
  type: Schema.Literal("subAgentActivity"),
  id: Schema.String,
  /** "started" | "interacted" | "interrupted" | "completed" */
  kind: Schema.String,
  agentThreadId: Schema.String,
  /** The agent's name under its parent, as a path: `/root/audit_parser`. */
  agentPath: Schema.String,
})

/**
 * The items the adapter reads. Others (`userMessage`, `reasoning`, and
 * whatever newer codex adds) show nothing, so an item that is none of these
 * is skipped rather than decoded.
 */
export const ThreadItem = Schema.Union([
  AgentMessageItem,
  PlanItem,
  CommandExecutionItem,
  McpToolCallItem,
  DynamicToolCallItem,
  CollabAgentToolCallItem,
  SubAgentActivityItem,
  WebSearchItem,
  FileChangeItem,
  ErrorItem,
])
export type ThreadItem = typeof ThreadItem.Type

// ---------------------------------------------------------------------------
// What codex sends: notifications
// ---------------------------------------------------------------------------

export const ThreadStartedNotification = Schema.Struct({ thread: ThreadSummary })

export const ThreadStatusChangedNotification = Schema.Struct({
  threadId: Schema.String,
  /** `active` while a turn runs. `idle` between turns, and for a moment before a new thread's first. */
  status: Schema.Struct({ type: Schema.String }),
})

export const ThreadClosedNotification = Schema.Struct({ threadId: Schema.String })

export const TurnNotification = Schema.Struct({
  threadId: maybe(Schema.String),
  turn: TurnSummary,
})
export type TurnCompletedNotification = typeof TurnNotification.Type

export const TurnPlanStep = Schema.Struct({
  step: Schema.String,
  /** "pending" | "inProgress" | "completed" */
  status: Schema.String,
})
export type TurnPlanStep = typeof TurnPlanStep.Type

export const TurnPlanUpdatedNotification = Schema.Struct({
  turnId: Schema.String,
  explanation: maybe(Schema.String),
  plan: Schema.Array(TurnPlanStep),
})
export type TurnPlanUpdatedNotification = typeof TurnPlanUpdatedNotification.Type

export const PlanDeltaNotification = Schema.Struct({
  itemId: Schema.String,
  delta: Schema.String,
})
export type PlanDeltaNotification = typeof PlanDeltaNotification.Type

/**
 * Token counters arrive snake_case from older servers and camelCase from
 * newer ones; `normalizeCodexTokenUsage` reads each field defensively.
 */
const TokenUsageCounter = Schema.Record(Schema.String, Schema.Unknown)

export const ThreadTokenUsageUpdatedNotification = Schema.Struct({
  tokenUsage: Schema.Struct({
    total_token_usage: maybe(TokenUsageCounter),
    total: maybe(TokenUsageCounter),
    last_token_usage: maybe(TokenUsageCounter),
    last: maybe(TokenUsageCounter),
    model_context_window: Schema.optionalKey(Schema.Unknown),
    modelContextWindow: Schema.optionalKey(Schema.Unknown),
  }),
})
export type ThreadTokenUsageUpdatedNotification = typeof ThreadTokenUsageUpdatedNotification.Type

/** The `item` is kept unknown here and read with `ThreadItem` on its own, so an item of a type the adapter does not know does not make the notification malformed. */
export const ItemNotification = Schema.Struct({
  item: Schema.Unknown,
})

export const ErrorNotification = Schema.Struct({
  error: CodexError,
  /**
   * True while codex is still retrying on its own — the turn has not failed
   * and `error.message` is a progress notice ("Reconnecting... 2/5"), not the
   * outcome. Only `willRetry: false` is terminal.
   */
  willRetry: maybe(Schema.Boolean),
  threadId: maybe(Schema.String),
  turnId: maybe(Schema.String),
})
export type ErrorNotification = typeof ErrorNotification.Type

export const AccountRateLimitsUpdatedNotification = Schema.Struct({
  rateLimits: maybe(CodexRateLimitSnapshot),
})

const notification = <M extends string, P extends Schema.Constraint>(method: M, params: P) =>
  Schema.Struct({ method: Schema.Literal(method), params })

export const ServerNotification = Schema.Union([
  notification("thread/started", ThreadStartedNotification),
  notification("thread/status/changed", ThreadStatusChangedNotification),
  notification("thread/closed", ThreadClosedNotification),
  notification("thread/tokenUsage/updated", ThreadTokenUsageUpdatedNotification),
  notification("turn/started", TurnNotification),
  notification("turn/completed", TurnNotification),
  notification("turn/plan/updated", TurnPlanUpdatedNotification),
  notification("item/started", ItemNotification),
  notification("item/completed", ItemNotification),
  notification("item/plan/delta", PlanDeltaNotification),
  notification("thread/compacted", Schema.Struct({})),
  notification("account/rateLimits/updated", AccountRateLimitsUpdatedNotification),
  notification("error", ErrorNotification),
])
export type ServerNotification = typeof ServerNotification.Type

const NOTIFICATION_METHODS: ReadonlySet<string> = new Set(ServerNotification.members.map((member) => member.fields.method.literal))

// ---------------------------------------------------------------------------
// What codex sends: requests
// ---------------------------------------------------------------------------

export const ToolRequestUserInputQuestion = Schema.Struct({
  id: Schema.String,
  header: maybe(Schema.String),
  question: Schema.String,
  isOther: maybe(Schema.Boolean),
  isSecret: maybe(Schema.Boolean),
  options: maybe(Schema.Array(Schema.Struct({
    label: Schema.String,
    description: maybe(Schema.String),
  }))),
})
export type ToolRequestUserInputQuestion = typeof ToolRequestUserInputQuestion.Type

export const ToolRequestUserInputParams = Schema.Struct({
  itemId: Schema.String,
  questions: Schema.Array(ToolRequestUserInputQuestion),
})
export type ToolRequestUserInputParams = typeof ToolRequestUserInputParams.Type

export const DynamicToolCallParams = Schema.Struct({
  callId: Schema.String,
  tool: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
})

export const CommandExecutionRequestApprovalParams = Schema.Struct({
  threadId: maybe(Schema.String),
  turnId: maybe(Schema.String),
  itemId: maybe(Schema.String),
  approvalId: maybe(Schema.String),
  reason: maybe(Schema.String),
  command: maybe(Schema.String),
  cwd: maybe(Schema.String),
})
export type CommandExecutionRequestApprovalParams = typeof CommandExecutionRequestApprovalParams.Type

export const FileChangeRequestApprovalParams = Schema.Struct({
  threadId: maybe(Schema.String),
  turnId: maybe(Schema.String),
  itemId: maybe(Schema.String),
  reason: maybe(Schema.String),
  grantRoot: maybe(Schema.String),
})
export type FileChangeRequestApprovalParams = typeof FileChangeRequestApprovalParams.Type

const request = <M extends string, P extends Schema.Constraint>(method: M, params: P) =>
  Schema.Struct({ id: CodexRequestId, method: Schema.Literal(method), params })

export const ServerRequest = Schema.Union([
  request("item/tool/requestUserInput", ToolRequestUserInputParams),
  request("item/tool/call", DynamicToolCallParams),
  request("item/commandExecution/requestApproval", CommandExecutionRequestApprovalParams),
  request("item/fileChange/requestApproval", FileChangeRequestApprovalParams),
])
export type ServerRequest = typeof ServerRequest.Type

const REQUEST_METHODS: ReadonlySet<string> = new Set(ServerRequest.members.map((member) => member.fields.method.literal))

// ---------------------------------------------------------------------------
// One line from codex's stdout
// ---------------------------------------------------------------------------

export const JsonRpcResponse = Schema.Struct({
  id: CodexRequestId,
  result: Schema.optionalKey(Schema.Unknown),
  error: maybe(Schema.Struct({
    code: Schema.optionalKey(Schema.Unknown),
    message: maybe(Schema.String),
  })),
})
export type JsonRpcResponse = typeof JsonRpcResponse.Type

/**
 * What one stdout line is. `Ignored` covers what Kanna has never handled: a
 * line that is not JSON, and methods it does not know. `Malformed` is a method
 * it knows whose payload does not fit, which is worth a log line.
 */
export type CodexInbound =
  | { readonly _tag: "Response"; readonly response: JsonRpcResponse }
  | { readonly _tag: "Request"; readonly request: ServerRequest }
  | { readonly _tag: "Notification"; readonly notification: ServerNotification }
  | { readonly _tag: "Malformed"; readonly method: string; readonly request: boolean }
  | { readonly _tag: "Ignored" }

// Plain JSON.parse into `unknown`, which the schemas below then check: on
// codex's thousands of lines a turn, `Schema.fromJsonString` doubled the cost
// of reading a line and checked nothing more.
const decodeJsonLine: (line: string) => Option.Option<unknown> = Option.liftThrowable(JSON.parse)
const isResponse = Schema.is(JsonRpcResponse)
const isServerRequest = Schema.is(ServerRequest)
const isServerNotification = Schema.is(ServerNotification)
const IGNORED: CodexInbound = { _tag: "Ignored" }

/**
 * Reads one line. The decoded value is the parsed JSON itself, checked rather
 * than copied, so items keep every field codex sent when they are stored as a
 * tool call's raw input.
 */
export function decodeCodexLine(line: string): CodexInbound {
  const parsed = decodeJsonLine(line)
  if (Option.isNone(parsed) || !Predicate.isObject(parsed.value)) return IGNORED
  const value = parsed.value
  const method = "method" in value ? value.method : undefined

  if (method === undefined) {
    if (!("result" in value) && !("error" in value)) return IGNORED
    return isResponse(value) ? { _tag: "Response", response: value } : IGNORED
  }
  if (typeof method !== "string") return IGNORED

  if ("id" in value) {
    if (!REQUEST_METHODS.has(method)) return IGNORED
    return isServerRequest(value) ? { _tag: "Request", request: value } : { _tag: "Malformed", method, request: true }
  }
  if (!NOTIFICATION_METHODS.has(method)) return IGNORED
  return isServerNotification(value) ? { _tag: "Notification", notification: value } : { _tag: "Malformed", method, request: false }
}

/** The thread a notification is about, for the ones that are about one. */
export function notificationThreadId(notification: ServerNotification): string | undefined {
  const params: object = notification.params
  const threadId = "threadId" in params ? params.threadId : undefined
  return typeof threadId === "string" ? threadId : undefined
}

export const isThreadItem = Schema.is(ThreadItem)

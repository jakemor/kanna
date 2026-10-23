import { randomUUID } from "node:crypto"
import { Cause, Context, Deferred, Effect, Exit, Layer, Match, PubSub, Queue, Result, Schema, Scope, Stream } from "effect"
import type {
  AskUserQuestionItem,
  CodexReasoningEffort,
  ContextWindowUsageSnapshot,
  ServiceTier,
  TodoItem,
  TranscriptEntry,
} from "../shared/types"
import type { HarnessEvent, HarnessToolRequest, HarnessTurnEffect } from "./harness-types"
import { appendSystemMessageBlock, buildSkillSystemMessage } from "./harness-skills"
import { buildKannaAgentId } from "./attribution"
import { buildKannaSystemInstructions } from "./harness-instructions"
import type { SubagentActivityUpdate } from "./background-tasks"
import type { KannaToolHost } from "./kanna-tools"
import { type KannaMcpEndpoint, serveKannaMcp } from "./kanna-mcp"
import { HttpHost } from "./platform/http-host"
import { runKannaSync } from "./effect/bridge"
import type { PlatformServices } from "./platform"
import { type CommandSpawnError, ProcessSpawner, type ProcessSignal, type SpawnedProcess } from "./platform/process-spawner"
import { asNumber, asRecord } from "../shared/json"
import { timestamped } from "./transcript"
import {
  AnyResult,
  type CodexError,
  type CodexModelSummary,
  type CodexRateLimitSnapshot,
  type CodexRequestId,
  type CodexSkillMetadata,
  type CodexUserInput,
  type CollabAgentToolCallItem,
  type CommandExecutionApprovalDecision,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallContentItem,
  type DynamicToolCallResponse,
  type ErrorNotification,
  type FileChangeApprovalDecision,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  GetAccountRateLimitsResponse,
  type InitializeParams,
  type JsonRpcResponse,
  type McpToolCallItem,
  type ModelListParams,
  ModelListResponse,
  type PlanDeltaNotification,
  type ServerNotification,
  type ServerRequest,
  type SkillsListParams,
  SkillsListResponse,
  type ThreadForkParams,
  type ThreadItem,
  type ThreadResumeParams,
  type ThreadStartParams,
  ThreadStartResponse,
  type ThreadTokenUsageUpdatedNotification,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TurnCompletedNotification,
  type TurnInterruptParams,
  type TurnPlanStep,
  type TurnPlanUpdatedNotification,
  type TurnStartParams,
  TurnStartResponse,
  decodeCodexLine,
  isThreadItem,
  notificationThreadId,
} from "./codex-app-server-protocol"

/**
 * The slice of a child process the manager drives, shaped like node's
 * `ChildProcess` (tests hand in node streams and an EventEmitter). `close`
 * comes once the process has exited and both output pipes have been read
 * to the end.
 */
export interface CodexAppServerProcess {
  stdin: { write(chunk: string): unknown }
  stdout: AsyncIterable<Uint8Array>
  stderr: AsyncIterable<Uint8Array>
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  once(event: "close", listener: (code: number | null) => void): this
  once(event: "error", listener: (error: Error) => void): this
}

/** Starts `codex app-server` in `cwd`; the process belongs to the scope. */
export type SpawnCodexAppServer = (
  cwd: string,
) => Effect.Effect<CodexAppServerProcess, CommandSpawnError, Scope.Scope | ProcessSpawner>

export interface CodexAppServerOptions {
  spawnProcess?: SpawnCodexAppServer
}

/** Spawning `codex app-server` threw. A missing binary does not throw: it fails the session's first request. */
export class CodexSpawnError extends Schema.TaggedError<CodexSpawnError>()(
  "@kanna/server/codex-app-server/CodexSpawnError",
  {
    chatId: Schema.String,
    cwd: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * A JSON-RPC request did not get the answer it needed: codex answered with an
 * error (`"<method> failed: <message>"`), the session ended while it waited
 * (the session's last words: stderr, the exit code, or "Codex session
 * closed"), or the result was not the shape the method answers with.
 */
export class CodexRequestError extends Schema.TaggedError<CodexRequestError>()(
  "@kanna/server/codex-app-server/CodexRequestError",
  {
    chatId: Schema.String,
    method: Schema.String,
    message: Schema.String,
  },
) {}

export class CodexSessionNotStartedError extends Schema.TaggedError<CodexSessionNotStartedError>()(
  "@kanna/server/codex-app-server/CodexSessionNotStartedError",
  {
    chatId: Schema.String,
    message: Schema.String,
  },
) {}

export class CodexTurnBusyError extends Schema.TaggedError<CodexTurnBusyError>()(
  "@kanna/server/codex-app-server/CodexTurnBusyError",
  {
    chatId: Schema.String,
    message: Schema.String,
  },
) {}

export type CodexStartTurnError = CodexSessionNotStartedError | CodexTurnBusyError | CodexRequestError

/** How the agent's Promise callbacks reach the adapter: `Effect.tryPromise(() => callback(request))`. */
type CodexCallback<A> = Effect.Effect<A, Cause.UnknownError>

export type CodexApprovalRequest =
  | {
      requestId: CodexRequestId
      kind: "command_execution"
      params: CommandExecutionRequestApprovalParams
    }
  | {
      requestId: CodexRequestId
      kind: "file_change"
      params: FileChangeRequestApprovalParams
    }

interface PendingRequest {
  method: string
  deferred: Deferred.Deferred<unknown, CodexRequestError>
}

interface PendingTurn {
  turnId: string | null
  model: string
  planMode: boolean
  skipPlanApproval: boolean
  queue: Queue.Queue<HarnessEvent, Cause.Done>
  startedToolIds: Set<string>
  handledDynamicToolIds: Set<string>
  latestPlanExplanation: string | null
  latestPlanSteps: ReadonlyArray<TurnPlanStep>
  latestPlanText: string | null
  planTextByItemId: Map<string, string>
  todoSequence: number
  pendingWebSearchResultToolId: string | null
  /**
   * Most informative error from this turn's retry sequence, if it had one.
   * Kept so a turn that ends up failing can still name the problem — codex
   * reports the cause once, somewhere in the sequence, and the terminal
   * notification that follows can be empty.
   */
  retryCause: CodexError | null
  resolved: boolean
  onToolRequest: (request: HarnessToolRequest) => CodexCallback<unknown>
  onApprovalRequest?: (request: CodexApprovalRequest) => CodexCallback<CommandExecutionApprovalDecision | FileChangeApprovalDecision>
}

/**
 * An agent the chat's thread spawned, or one of those agents spawned.
 *
 * Codex runs each as a thread of its own on the chat's connection, and sends
 * that thread's turns and items in with the chat's, told apart only by
 * `threadId`. An agent outlives the turn that spawned it: the chat's turn can
 * end while the agent works, and nothing wakes the chat when it finishes.
 */
interface SpawnedAgent {
  threadId: string
  label: string
  description?: string
  /** The `spawnAgent` call that made it, where Codex reports one. */
  toolUseId?: string
  /**
   * Its turn now in flight. This is what the agent's task row follows: the row
   * runs exactly while this is set, so it ends the way any Codex turn ends,
   * with a `turn/completed`, or with the process.
   */
  turnId: string | null
}

/**
 * One `codex app-server` process and what is in flight on it. Mutated from
 * the session's reader fiber and from callers' fibers, all on the one JS
 * thread, so it is a plain record rather than Refs (as `Terminals` keeps its
 * PTY sessions).
 */
interface SessionContext {
  customTools?: KannaMcpEndpoint
  chatId: string
  cwd: string
  child: CodexAppServerProcess
  /** Owns the process, the MCP server and the reader fibers. Closing it stops them all. */
  scope: Scope.Closeable
  pendingRequests: Map<CodexRequestId, PendingRequest>
  pendingTurn: PendingTurn | null
  sessionToken: string | null
  /** By thread id. */
  agents: Map<string, SpawnedAgent>
  /**
   * Turns in flight on threads no spawn has named yet, by thread id. The
   * spawn and the agent's first turn arrive within a few milliseconds of each
   * other, and not always in the same order.
   */
  unclaimedTurns: Map<string, string>
  stderrLines: string[]
  closed: boolean
}

export interface StartCodexSessionArgs {
  customTools?: KannaToolHost
  chatId: string
  cwd: string
  model: string
  serviceTier?: ServiceTier
  sessionToken: string | null
  pendingForkSessionToken?: string | null
  /** The source's last turn the fork keeps (`ChatRecord.pendingForkAt`). */
  pendingForkAt?: string | null
}

export interface StartedCodexSession {
  sessionToken: string
  /**
   * A requested resume failed recoverably and a fresh thread was started
   * instead. The caller surfaces this as a "Conversation Restored" boundary
   * so the silent context loss becomes visible.
   */
  resumeFellBack: boolean
}

export interface StartCodexTurnArgs {
  chatId: string
  model: string
  /** The chat is a delegator, which its instructions say. */
  delegator?: boolean
  /**
   * The turn's message came from another agent, so nobody is there to approve
   * a plan. A plan-mode turn then ends with the plan as its reply.
   */
  skipPlanApproval?: boolean
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
  content: string
  /**
   * Skills the prompt names, resolved. Each one adds a structured
   * `{type:"skill", name, path}` item to the turn input (deterministic
   * server-side injection), and one `<system-message>` failsafe listing them
   * is appended to the text item — codex silently skips skill items whose
   * path no longer matches a discovered skill, so the failsafe keeps the
   * intent visible to the model regardless.
   */
  skills?: { name: string; path: string }[]
  planMode: boolean
  onToolRequest: (request: HarnessToolRequest) => CodexCallback<unknown>
  onApprovalRequest?: PendingTurn["onApprovalRequest"]
}

export interface GenerateStructuredArgs {
  cwd: string
  prompt: string
  model?: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
}

export interface CodexResourceCounts {
  codexSessions: number
  codexPendingRequests: number
  codexStderrChars: number
}

export type CodexTaskActivityListener = (chatId: string, update: SubagentActivityUpdate) => void

function codexSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "codex",
    model,
    tools: ["Bash", "Write", "Edit", "WebSearch", "TodoWrite", "AskUserQuestion", "ExitPlanMode"],
    agents: ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"],
    slashCommands: [],
    mcpServers: [],
  })
}


const AGENT_LABEL_LIMIT = 80

/** `/root/audit_parser` → "audit parser": the name the spawning agent gave it. */
function agentLabelFromPath(agentPath: string): string {
  const name = agentPath.split("/").filter(Boolean).pop() ?? ""
  return name.replace(/_/g, " ").trim() || "Agent"
}

function agentLabelFromPrompt(prompt: string | null | undefined): string {
  const line = prompt?.trim().split("\n")[0]?.trim() ?? ""
  if (!line) return "Agent"
  return line.length > AGENT_LABEL_LIMIT ? `${line.slice(0, AGENT_LABEL_LIMIT - 1)}…` : line
}

/**
 * The cause as one readable token. String variants pass through; object
 * variants name their single key and, when the upstream sent one, the HTTP
 * status ("responseStreamDisconnected (HTTP 502)"). Without this the exact
 * errors a retry sequence is about would read as having no cause at all.
 */
function errorDetail(error: CodexError): string {
  const info = error.codexErrorInfo
  if (typeof info === "string") return info.trim()
  if (!info || typeof info !== "object") return ""
  const [kind, data] = Object.entries(info)[0] ?? []
  if (!kind) return ""
  const status = asRecord(data)?.httpStatusCode
  return typeof status === "number" ? `${kind} (HTTP ${status})` : kind
}

/**
 * codex splits an error across `message` and `codexErrorInfo`, and the message
 * on its own is often just a summary. Keep both when the detail adds anything,
 * so a failed turn names the cause rather than the category.
 */
function formatCodexError(error: CodexError | null | undefined): string {
  if (!error) return ""
  const message = error.message?.trim() ?? ""
  const detail = errorDetail(error)
  if (!detail || message.includes(detail)) return message
  return message ? `${message}: ${detail}` : detail
}

/**
 * Of the errors in one retry sequence, keep the one that explains the most.
 * codex mixes a cause ("stream disconnected: unexpected EOF") in with bare
 * progress notices ("Reconnecting... 2/5") and the order isn't guaranteed —
 * the sequences in the wild open with a counter — so neither "first wins" nor
 * "last wins" reliably holds the cause. Prefer whichever carries
 * `codexErrorInfo`, and otherwise keep the first: letting a counter overwrite
 * a real cause is the exact failure this fallback exists to prevent.
 */
function preferredRetryCause(current: CodexError | null, next: CodexError): CodexError {
  if (!current) return next
  if (errorDetail(next) && !errorDetail(current)) return next
  return current
}

function isRecoverableResumeError(errorMessage: string): boolean {
  const message = errorMessage.toLowerCase()
  if (!message.includes("thread/resume")) return false
  return ["not found", "missing thread", "no such thread", "unknown thread", "does not exist"].some((snippet) =>
    message.includes(snippet)
  )
}

const MULTI_SELECT_HINT_PATTERN = /\b(all that apply|select all|choose all|pick all|select multiple|choose multiple|pick multiple|multiple selections?|multiple choice|more than one|one or more)\b/i

function inferQuestionAllowsMultiple(question: ToolRequestUserInputQuestion): boolean {
  const combinedText = [question.header, question.question].filter(Boolean).join(" ")
  return MULTI_SELECT_HINT_PATTERN.test(combinedText)
}

function toAskUserQuestionItems(params: ToolRequestUserInputParams): AskUserQuestionItem[] {
  return params.questions.map((question) => ({
    id: question.id,
    question: question.question,
    header: question.header || undefined,
    options: question.options?.map((option) => ({
      label: option.label,
      description: option.description ?? undefined,
    })),
    multiSelect: inferQuestionAllowsMultiple(question),
  }))
}

function toToolRequestUserInputResponse(raw: unknown, questions: ToolRequestUserInputParams["questions"]): ToolRequestUserInputResponse {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const answersValue = record.answers
  const value = answersValue && typeof answersValue === "object" && !Array.isArray(answersValue)
    ? answersValue as Record<string, unknown>
    : record
  const answers = Object.fromEntries(
    questions.map((question) => {
      const rawAnswer = value[question.id] ?? value[question.question]
      if (Array.isArray(rawAnswer)) {
        return [question.id, { answers: rawAnswer.map((entry) => String(entry)) }]
      }
      if (typeof rawAnswer === "string") {
        return [question.id, { answers: [rawAnswer] }]
      }
      if (rawAnswer && typeof rawAnswer === "object" && Array.isArray((rawAnswer as { answers?: unknown }).answers)) {
        return [question.id, { answers: ((rawAnswer as { answers: unknown[] }).answers).map((entry) => String(entry)) }]
      }
      return [question.id, { answers: [] }]
    })
  )
  return { answers }
}

function contentFromMcpResult(item: McpToolCallItem): unknown {
  if (item.error?.message) {
    return { error: item.error.message }
  }
  return item.result?.structuredContent ?? item.result?.content ?? null
}

function normalizeCodexTokenUsage(
  notification: ThreadTokenUsageUpdatedNotification,
): ContextWindowUsageSnapshot | null {
  const usage = notification.tokenUsage
  const totalUsage = usage.total_token_usage ?? usage.total
  const lastUsage = usage.last_token_usage ?? usage.last

  const totalProcessedTokens = asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens)
  const usedTokens = asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens
  if (usedTokens === undefined || usedTokens <= 0) {
    return null
  }

  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens)
  const cachedInputTokens = asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens)
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens)
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens)
  const maxTokens = asNumber(usage.model_context_window) ?? asNumber(usage.modelContextWindow)

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  }
}

function todoStatus(status: string): TodoItem["status"] {
  if (status === "completed") return "completed"
  if (status === "inProgress") return "in_progress"
  return "pending"
}

function planStepsToTodos(steps: ReadonlyArray<TurnPlanStep>): TodoItem[] {
  return steps.map((step) => ({
    content: step.step,
    status: todoStatus(step.status),
    activeForm: step.step,
  }))
}

function renderPlanMarkdownFromSteps(steps: ReadonlyArray<TurnPlanStep>): string {
  return steps.map((step) => {
    const checkbox = step.status === "completed" ? "[x]" : "[ ]"
    return `- ${checkbox} ${step.step}`
  }).join("\n")
}

function dynamicContentToText(contentItems: ReadonlyArray<DynamicToolCallContentItem> | null | undefined): string {
  if (!contentItems?.length) return ""
  return contentItems
    .map((item) => item.type === "inputText" ? item.text ?? "" : item.imageUrl ?? "")
    .filter(Boolean)
    .join("\n")
}

function dynamicToolPayload(value: unknown): Record<string, unknown> {
  const record = asRecord(value)
  if (record) return record
  return { value }
}

function webSearchQuery(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  return item.query || item.action?.query || item.action?.queries?.find((query): query is string => typeof query === "string") || ""
}

function genericDynamicToolCall(toolId: string, toolName: string, input: Record<string, unknown>): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "unknown_tool",
      toolName,
      toolId,
      input: {
        payload: input,
      },
      rawInput: input,
    },
  })
}

function collabToolCall(item: CollabAgentToolCallItem): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "subagent_task",
      toolName: "Task",
      toolId: item.id,
      input: {
        subagentType: item.tool,
        ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
      },
      rawInput: item,
    },
  })
}

function todoToolCall(toolId: string, steps: ReadonlyArray<TurnPlanStep>): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId,
      input: {
        todos: planStepsToTodos(steps),
      },
      rawInput: {
        plan: steps,
      },
    },
  })
}

function fileChangeKind(
  kind: string | { readonly type: string; readonly move_path?: string | null | undefined }
): { type: string; movePath?: string | null } {
  if (typeof kind === "string") {
    return { type: kind }
  }
  return {
    type: kind.type,
    movePath: kind.move_path ?? null,
  }
}

function fileChangeToolId(itemId: string, index: number, totalChanges: number): string {
  if (totalChanges === 1) {
    return itemId
  }
  return `${itemId}:change:${index}`
}

function fileChangePayload(
  item: Extract<ThreadItem, { type: "fileChange" }>,
  change: Extract<ThreadItem, { type: "fileChange" }>["changes"][number]
): Record<string, unknown> {
  return {
    ...item,
    changes: [change],
  }
}

function parseUnifiedDiff(diff: string): { oldString: string; newString: string } {
  const oldLines: string[] = []
  const newLines: string[] = []

  for (const line of diff.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue
    if (line === "\\ No newline at end of file") continue

    const prefix = line[0]
    const content = line.slice(1)

    if (prefix === " ") {
      oldLines.push(content)
      newLines.push(content)
      continue
    }
    if (prefix === "-") {
      oldLines.push(content)
      continue
    }
    if (prefix === "+") {
      newLines.push(content)
    }
  }

  return {
    oldString: oldLines.join("\n"),
    newString: newLines.join("\n"),
  }
}

function isUnifiedDiff(diff: string) {
  return diff.includes("@@")
    || diff.startsWith("---")
    || diff.startsWith("+++")
    || diff.split(/\r?\n/).some((line) => (
      line.startsWith("+")
      || line.startsWith("-")
      || line.startsWith(" ")
      || line === "\\ No newline at end of file"
    ))
}

function fileChangeToToolCalls(item: Extract<ThreadItem, { type: "fileChange" }>): TranscriptEntry[] {
  return item.changes.map((change, index) => {
    const payload = fileChangePayload(item, change)
    const toolId = fileChangeToolId(item.id, index, item.changes.length)
    const normalizedKind = fileChangeKind(change.kind)

    if (normalizedKind.movePath) {
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: "FileChange",
          toolId,
          input: {
            payload,
          },
          rawInput: payload,
        },
      })
    }

    if (typeof change.diff === "string") {
      const diffIsUnified = isUnifiedDiff(change.diff)
      const { oldString, newString } = diffIsUnified
        ? parseUnifiedDiff(change.diff)
        : { oldString: change.diff, newString: change.diff }

      if (normalizedKind.type === "add") {
        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "write_file",
            toolName: "Write",
            toolId,
            input: {
              filePath: change.path,
              content: newString,
            },
            rawInput: payload,
          },
        })
      }

      if (normalizedKind.type === "update") {
        if (!diffIsUnified) {
          return timestamped({
            kind: "tool_call",
            tool: {
              kind: "tool",
              toolKind: "unknown_tool",
              toolName: "FileChange",
              toolId,
              input: {
                payload,
              },
              rawInput: payload,
            },
          })
        }

        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "edit_file",
            toolName: "Edit",
            toolId,
            input: {
              filePath: change.path,
              oldString,
              newString,
            },
            rawInput: payload,
          },
        })
      }

      if (normalizedKind.type === "delete") {
        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "delete_file",
            toolName: "Delete",
            toolId,
            input: {
              filePath: change.path,
              content: oldString,
            },
            rawInput: payload,
          },
        })
      }
    }

    return timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "unknown_tool",
        toolName: "FileChange",
        toolId,
        input: {
          payload,
        },
        rawInput: payload,
      },
    })
  })
}

function fileChangeToToolResults(item: Extract<ThreadItem, { type: "fileChange" }>): TranscriptEntry[] {
  return item.changes.map((change, index) => timestamped({
    kind: "tool_result",
    toolId: fileChangeToolId(item.id, index, item.changes.length),
    content: fileChangePayload(item, change),
    isError: item.status === "failed" || item.status === "declined",
  }))
}

function itemToToolCalls(item: ThreadItem): TranscriptEntry[] {
  switch (item.type) {
    case "dynamicToolCall":
      return [genericDynamicToolCall(item.id, item.tool, dynamicToolPayload(item.arguments))]
    case "collabAgentToolCall":
      return [collabToolCall(item)]
    case "commandExecution":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: item.id,
          input: {
            command: item.command,
          },
          rawInput: item,
        },
      })]
    case "webSearch":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "web_search",
          toolName: "WebSearch",
          toolId: item.id,
          input: {
            query: webSearchQuery(item),
          },
          rawInput: item,
        },
      })]
    case "mcpToolCall":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "mcp_generic",
          toolName: `mcp__${item.server}__${item.tool}`,
          toolId: item.id,
          input: {
            server: item.server,
            tool: item.tool,
            payload: item.arguments ?? {},
          },
          rawInput: item.arguments ?? {},
        },
      })]
    case "fileChange":
      return fileChangeToToolCalls(item)
    case "plan":
      return []
    case "error":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: "Error",
          toolId: item.id,
          input: {
            payload: item,
          },
          rawInput: item,
        },
      })]
    default:
      return []
  }
}

function itemToToolResults(item: ThreadItem): TranscriptEntry[] {
  switch (item.type) {
    case "dynamicToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: dynamicContentToText(item.contentItems) || item,
        isError: item.status === "failed" || item.success === false,
      })]
    case "collabAgentToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item,
        isError: item.status === "failed",
      })]
    case "commandExecution":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item.aggregatedOutput ?? item,
        isError: (typeof item.exitCode === "number" && item.exitCode !== 0) || item.status === "failed" || item.status === "declined",
      })]
    case "webSearch":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item,
      })]
    case "mcpToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: contentFromMcpResult(item),
        isError: item.status === "failed",
      })]
    case "fileChange":
      return fileChangeToToolResults(item)
    case "plan":
      return []
    case "error":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item.message,
        isError: true,
      })]
    default:
      return []
  }
}


const isThreadStartResponse = Schema.is(ThreadStartResponse)
const isTurnStartResponse = Schema.is(TurnStartResponse)
const isModelListResponse = Schema.is(ModelListResponse)
const isSkillsListResponse = Schema.is(SkillsListResponse)
const isRateLimitsResponse = Schema.is(GetAccountRateLimitsResponse)
const isAnyResult = Schema.is(AnyResult)

const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "kanna_desktop",
    title: "Kanna",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: true,
  },
} satisfies InitializeParams

/** The node-style events of a `CodexAppServerProcess`, without node's EventEmitter. */
class ProcessEvents {
  private readonly listeners = {
    close: [] as Array<{ fn: (code: number | null) => void; once: boolean }>,
    error: [] as Array<{ fn: (error: Error) => void; once: boolean }>,
  }

  add(event: "close" | "error", fn: ((code: number | null) => void) | ((error: Error) => void), once: boolean) {
    if (event === "close") this.listeners.close.push({ fn: fn as (code: number | null) => void, once })
    else this.listeners.error.push({ fn: fn as (error: Error) => void, once })
  }

  emitClose(code: number | null) {
    const current = this.listeners.close
    this.listeners.close = current.filter((listener) => !listener.once)
    for (const listener of current) listener.fn(code)
  }

  emitError(error: Error) {
    const current = this.listeners.error
    this.listeners.error = current.filter((listener) => !listener.once)
    for (const listener of current) listener.fn(error)
  }
}

function eventSurface(events: ProcessEvents) {
  return {
    on(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
      events.add(event, listener, false)
      return this
    },
    once(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
      events.add(event, listener, true)
      return this
    },
  }
}

/**
 * `codex app-server` on the machine's `ProcessSpawner`, presented as the
 * node-shaped process the manager drives. stdin writes go out in order
 * through one fiber; `close` comes after the exit and both pipes drained, as
 * node's did. A binary that can't start doesn't fail the spawn: it reports
 * an `error`, which fails the session's first request, as node's spawn did.
 */
const spawnCodexAppServer: SpawnCodexAppServer = Effect.fn("CodexAppServer.spawnProcess")(function* (cwd: string) {
  const spawner = yield* ProcessSpawner
  const events = new ProcessEvents()
  const spawned = yield* Effect.result(spawner.spawn(["codex", "app-server"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }))
  if (Result.isFailure(spawned)) return failedProcess(events, spawned.failure)
  const proc: SpawnedProcess = spawned.success

  let drained = 0
  let exitCode: number | null | undefined
  const maybeClose = () => {
    if (drained === 2 && exitCode !== undefined) events.emitClose(exitCode)
  }
  const pipe = (stream: Stream.Stream<Uint8Array, CommandSpawnError>) =>
    Stream.toAsyncIterable(stream.pipe(
      // A pipe that errors as the process dies just ends, as node's did.
      Stream.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Stream.empty),
      Stream.ensuring(Effect.sync(() => {
        drained++
        maybeClose()
      })),
    ))
  yield* proc.exited.pipe(
    Effect.flatMap((exit) => Effect.sync(() => {
      exitCode = exit.exitCode
      maybeClose()
    })),
    Effect.forkScoped,
  )

  const writes = yield* Queue.unbounded<string>()
  yield* Queue.take(writes).pipe(
    Effect.flatMap((chunk) => proc.writeStdin(chunk)),
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (error) =>
      Effect.logWarning("Failed to write to Codex app-server:", error.message)),
    Effect.forever,
    Effect.forkScoped,
  )

  const child = {
    stdin: { write: (chunk: string) => Queue.offerUnsafe(writes, chunk) },
    stdout: pipe(proc.stdout),
    stderr: pipe(proc.stderr),
    killed: false,
    kill(signal?: NodeJS.Signals | number) {
      child.killed = true
      Effect.runFork(proc.kill(typeof signal === "string" ? signal as ProcessSignal : undefined))
    },
    ...eventSurface(events),
  }
  return child as CodexAppServerProcess
})

function failedProcess(events: ProcessEvents, failure: CommandSpawnError): CodexAppServerProcess {
  const error = new Error(failure.message)
  const empty: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {} }
  const surface = eventSurface(events)
  const child = {
    stdin: { write: () => false },
    stdout: empty,
    stderr: empty,
    killed: false,
    kill() {
      child.killed = true
    },
    on(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
      surface.on(event, listener)
      // Reported after the listener is on, a tick later, like node's `error`.
      if (event === "error") queueMicrotask(() => events.emitError(error))
      return child
    },
    once(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
      surface.once(event, listener)
      if (event === "error") queueMicrotask(() => events.emitError(error))
      return child
    },
  }
  return child as unknown as CodexAppServerProcess
}

/**
 * The lines of a child's output, split as readline split them (on \n, \r\n
 * or \r). Read a chunk at a time rather than a line at a time: codex sends
 * thousands of lines a turn. The stream is taken now, so nothing written
 * before the reader runs is lost.
 */
function readLines(readable: AsyncIterable<Uint8Array>): Stream.Stream<string, unknown> {
  const chunks: AsyncIterator<Uint8Array> = readable[Symbol.asyncIterator]()
  return Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => chunks }, (cause) => cause).pipe(
    Stream.decodeText(),
    Stream.splitLines,
  )
}

function killQuietly(child: CodexAppServerProcess) {
  try {
    child.kill("SIGKILL")
  } catch {
    // ignore kill failures
  }
}

function emit(turn: PendingTurn, event: HarnessEvent) {
  Queue.offerUnsafe(turn.queue, event)
}

function finish(turn: PendingTurn) {
  Queue.endUnsafe(turn.queue)
}

/** Logs a callback the agent handed in that failed, where the old Promise rejection went unhandled. */
const logCallbackFailure = (what: string) => <A>(effect: CodexCallback<A>) =>
  effect.pipe(
    Effect.tapError((error) => Effect.logWarning(`Codex ${what} failed:`, error.cause)),
    Effect.ignore,
  )

/**
 * The chats' `codex app-server` processes: one per chat, kept warm between
 * turns, speaking JSON-RPC over stdio. Turns, the user's answers to codex's
 * questions, approvals, and the agents a thread spawns are all multiplexed
 * over that one connection.
 *
 * Each process lives in a scope of its own under the layer's: stopping the
 * session (or the layer) kills the process, closes its Kanna MCP server, and
 * ends the fibers reading its output.
 *
 * `rateLimitPushes` carries `account/rateLimits/updated` from any session, from
 * the moment of subscribing; it never replays.
 */
export class CodexAppServer extends Context.Service<CodexAppServer, {
  /**
   * Starts the chat's process and thread, or keeps the live one when it is
   * for the same cwd and no fork is asked for (then `undefined`). A resume of
   * a thread codex no longer has falls back to a fresh thread.
   */
  readonly startSession: (
    args: StartCodexSessionArgs,
  ) => Effect.Effect<StartedCodexSession | undefined, CodexSpawnError | CodexRequestError>
  /**
   * Starts a turn on the chat's session. The turn's scope is the old
   * `close()`, which was a no-op for Codex: the session outlives its turns,
   * so closing the scope leaves both as they are. `stopSession` ends them.
   */
  readonly startTurn: (args: StartCodexTurnArgs) => Effect.Effect<HarnessTurnEffect, CodexStartTurnError, Scope.Scope>
  /**
   * Agent skills via `skills/list` on the chat's live process. Null when the
   * chat has no running process or codex predates skills/list (< 0.73);
   * callers fall back to Kanna's filesystem scan of the same roots.
   */
  readonly listSkills: (args: { chatId: string; cwd: string }) => Effect.Effect<ReadonlyArray<CodexSkillMetadata> | null>
  /**
   * The models the signed-in account can run, from `model/list`. Reuses a
   * live session's process when one exists; otherwise spawns a short-lived
   * probe. Hidden rows are left out. Null only when the probe cannot be
   * spawned; fails on protocol errors, including "method not found" from a
   * codex older than model/list (callers keep the static catalog then).
   */
  readonly listModels: (probeCwd: string) => Effect.Effect<ReadonlyArray<CodexModelSummary> | null, CodexRequestError>
  /**
   * Account rate limits on demand, from a live session's process or a
   * short-lived probe. Null only when the probe cannot be spawned; fails on
   * protocol errors (e.g. API-key auth → "chatgpt auth required").
   */
  readonly readAccountRateLimits: (probeCwd: string) => Effect.Effect<GetAccountRateLimitsResponse | null, CodexRequestError>
  /** One prompt on a throwaway session; the assistant's text (or the result's), or null. */
  readonly generateStructured: (args: GenerateStructuredArgs) => Effect.Effect<string | null, CodexSpawnError | CodexRequestError>
  /**
   * Stops one spawned agent's turn, as a turn of the chat's own is stopped.
   * Its end comes back as a `turn/completed`, which is what closes its row.
   * False when the chat has no such agent running.
   */
  readonly stopAgent: (chatId: string, agentThreadId: string) => Effect.Effect<boolean, CodexRequestError>
  /**
   * Stops every agent a chat has running. Codex leaves them going when the
   * turn that spawned them is interrupted, so stopping the chat has to ask.
   */
  readonly stopAgents: (chatId: string) => Effect.Effect<void>
  /**
   * Kills the chat's process. Everything that happens synchronously — the
   * turn's error result, waiting requests failing, the kill — is done by the
   * time this is first run; the rest (its fibers ending) follows.
   */
  readonly stopSession: (chatId: string) => Effect.Effect<void>
  readonly stopAll: Effect.Effect<void>
  readonly resourceCounts: Effect.Effect<CodexResourceCounts>
  readonly rateLimitPushes: Stream.Stream<CodexRateLimitSnapshot>
  /**
   * The sink for the agents a chat's thread spawns: a `started` each time one
   * begins a turn, a `stopped` when that turn ends. They come this way and
   * not on a turn's stream because an agent outlives the turn that spawned
   * it, and that turn's stream closes with the turn.
   *
   * A synchronous listener rather than a Stream: the agent applies each
   * update in step with the turn events around it, and a Stream would hand
   * them over a fiber hop later. It becomes a Stream when agent.ts moves to
   * Effect (wave 4).
   */
  readonly setTaskActivityListener: (listener: CodexTaskActivityListener | null) => void
}>()("@kanna/server/CodexAppServer") {
  static readonly layer = (options: CodexAppServerOptions = {}) => Layer.effect(this, makeCodexAppServer(options))
}

/**
 * For Promise code that still builds its own (agent.ts's default, the shared
 * quick response): a service whose scope is never closed, as the class it
 * replaces was never disposed. Its sessions still end with `stopSession` /
 * `stopAll`. Goes when those callers get it from the server's runtime.
 */
export function createCodexAppServer(
  platform: Context.Context<PlatformServices>,
  options: CodexAppServerOptions = {},
): CodexAppServer["Service"] {
  return runKannaSync(makeCodexAppServer(options).pipe(Scope.provide(Scope.makeUnsafe()), Effect.provide(platform)))
}

export const makeCodexAppServer = Effect.fn("CodexAppServer.make")(function* (options: CodexAppServerOptions = {}) {
  const spawnProcess = options.spawnProcess ?? spawnCodexAppServer
  const spawner = yield* ProcessSpawner
  const http = yield* HttpHost
  const layerScope = yield* Effect.scope
  const sessions = new Map<string, SessionContext>()
  const rateLimits = yield* PubSub.unbounded<CodexRateLimitSnapshot>()
  let onTaskActivity: CodexTaskActivityListener | null = null

  // ---------------------------------------------------------------------------
  // The connection
  // ---------------------------------------------------------------------------

  const writeMessage = (context: SessionContext, message: Record<string, unknown>) => {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * One JSON-RPC request, answered when its response line arrives. `is`
   * checks the result's shape; the result is passed on as codex sent it.
   */
  const sendRequest = <A>(
    context: SessionContext,
    method: string,
    params: unknown,
    is: (value: unknown) => value is A,
  ): Effect.Effect<A, CodexRequestError> => Effect.suspend(() => {
    const fail = (message: string) => new CodexRequestError({ chatId: context.chatId, method, message })
    if (context.closed) return Effect.fail(fail("Codex session closed"))
    const id = randomUUID()
    const deferred = Deferred.makeUnsafe<unknown, CodexRequestError>()
    context.pendingRequests.set(id, { method, deferred })
    writeMessage(context, { id, method, params })
    return Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => Effect.sync(() => context.pendingRequests.delete(id))),
      Effect.flatMap((result) => is(result) ? Effect.succeed(result) : Effect.fail(fail(`${method} returned an unexpected result`))),
    )
  })

  const initialize = (context: SessionContext) =>
    sendRequest(context, "initialize", INITIALIZE_PARAMS, isAnyResult).pipe(
      Effect.andThen(Effect.sync(() => writeMessage(context, { method: "initialized" }))),
    )

  const handleResponse = (context: SessionContext, response: JsonRpcResponse) => {
    const pending = context.pendingRequests.get(response.id)
    if (!pending) return
    context.pendingRequests.delete(response.id)
    if (response.error) {
      Deferred.doneUnsafe(pending.deferred, Exit.fail(new CodexRequestError({
        chatId: context.chatId,
        method: pending.method,
        message: `${pending.method} failed: ${response.error.message ?? "Unknown error"}`,
      })))
      return
    }
    Deferred.doneUnsafe(pending.deferred, Exit.succeed(response.result))
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Spawns a process in a scope of its own and starts reading it. `register`
   * puts it in `sessions` straight away, before its first await, so a second
   * `startSession` for the chat sees it (as it always has).
   */
  const openSession = Effect.fn("CodexAppServer.openSession")(function* (args: {
    chatId: string
    cwd: string
    customTools?: KannaToolHost
    register: boolean
  }) {
    yield* Effect.annotateCurrentSpan("chatId", args.chatId)
    const scope = yield* Scope.fork(layerScope)
    return yield* Effect.gen(function* () {
      const child = yield* spawnProcess(args.cwd).pipe(
        Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", (error) =>
          Effect.fail(new CodexSpawnError({ chatId: args.chatId, cwd: args.cwd, message: error.message, cause: error.cause }))),
        Effect.tap((child) => Effect.addFinalizer(() => Effect.sync(() => killQuietly(child)))),
        Effect.provideService(ProcessSpawner, spawner),
        Scope.provide(scope),
      )
      const customTools = args.customTools
        ? yield* serveKannaMcp(args.customTools).pipe(Scope.provide(scope), Effect.provideService(HttpHost, http))
        : undefined
      const context: SessionContext = {
        ...(customTools ? { customTools } : {}),
        chatId: args.chatId,
        cwd: args.cwd,
        child,
        scope,
        pendingRequests: new Map(),
        pendingTurn: null,
        sessionToken: null,
        agents: new Map(),
        unclaimedTurns: new Map(),
        stderrLines: [],
        closed: false,
      }
      yield* Scope.addFinalizer(scope, Effect.sync(() => failContext(context, "Codex session closed")))
      if (args.register) sessions.set(args.chatId, context)
      yield* attachListeners(context)
      return context
    }).pipe(Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void)))
  })

  /**
   * Reads the process's output and watches for it ending. Listeners go on
   * synchronously: an `error` event with no listener would throw, and lines
   * that arrive before the readers start must not be lost.
   */
  const attachListeners = (context: SessionContext) => Effect.gen(function* () {
    const exited = Deferred.makeUnsafe<number | null>()
    const errored = Deferred.makeUnsafe<Error>()
    context.child.on("close", (code) => {
      Deferred.doneUnsafe(exited, Exit.succeed(code))
    })
    context.child.on("error", (error) => {
      Deferred.doneUnsafe(errored, Exit.succeed(error))
    })
    const stdout = readLines(context.child.stdout)
    const stderr = readLines(context.child.stderr)

    yield* stdout.pipe(
      // A bug while handling one line costs that line, not the reader: the old
      // async handlers rejected on their own and the next line still arrived.
      Stream.runForEach((line) => handleLine(context, line).pipe(
        Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("Failed to handle a Codex app-server message:", Cause.squash(cause))),
      )),
      Effect.tapError((cause) => Effect.logWarning("Failed to read Codex app-server output:", cause)),
      Effect.ignore,
      Effect.forkIn(context.scope),
    )
    yield* stderr.pipe(
      Stream.runForEach((line) => Effect.sync(() => {
        if (line.trim()) {
          context.stderrLines = [line.trim().slice(-8192)]
        }
      })),
      Effect.ignore,
      Effect.forkIn(context.scope),
    )
    yield* Deferred.await(errored).pipe(
      Effect.flatMap((error) => failSession(context, error.message)),
      Effect.forkIn(context.scope),
    )
    // A turn after the exit: the output already read is handled first, and
    // a stop that is under way has the last word.
    yield* Deferred.await(exited).pipe(
      Effect.flatMap((code) => context.closed ? Effect.void : Effect.yieldNow.pipe(
        Effect.andThen(Effect.suspend(() => context.closed
          ? Effect.void
          : failSession(context, context.stderrLines.at(-1) || `Codex app-server exited with code ${code ?? 1}`))),
      )),
      Effect.forkIn(context.scope),
    )
  })

  /**
   * The session is over: its turn ends with `message` as an error result,
   * waiting requests fail with it, its agents are closed as cut off, and the
   * process is killed. Synchronous, so a stop has finished all of this before
   * it returns; the scope (fibers) is closed by the caller.
   */
  const failContext = (context: SessionContext, message: string) => {
    closeAgents(context)
    const pendingTurn = context.pendingTurn
    if (pendingTurn && !pendingTurn.resolved) {
      emit(pendingTurn, {
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        }),
      })
      finish(pendingTurn)
      context.pendingTurn = null
    }

    // Book-keeping first: a waiter resumes synchronously, and may come
    // straight back to stop this same session.
    const pending = [...context.pendingRequests.values()]
    context.pendingRequests.clear()
    context.closed = true
    if (sessions.get(context.chatId) === context) sessions.delete(context.chatId)
    // A non-retryable protocol error (e.g. a usage-limit hit) leaves the
    // subprocess itself running — only the child's "close" path had
    // actually exited already. Without this, the process survives orphaned,
    // still holding its thread's write lock, until the whole Kanna process
    // is killed. A later resume then spawns a second process for the same
    // thread and collides with the still-alive first one.
    killQuietly(context.child)
    for (const request of pending) {
      Deferred.doneUnsafe(request.deferred, Exit.fail(new CodexRequestError({
        chatId: context.chatId,
        method: request.method,
        message,
      })))
    }
  }

  /**
   * `failContext` from inside the session (its reader, its exit watcher).
   * The scope closes on a fiber of its own, since the one calling this is
   * among those the close ends.
   */
  const failSession = (context: SessionContext, message: string) => Effect.suspend(() => {
    failContext(context, message)
    return Scope.close(context.scope, Exit.void).pipe(Effect.forkDetach, Effect.asVoid)
  })

  const stopSession = Effect.fn("CodexAppServer.stopSession")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const context = sessions.get(chatId)
    if (!context) return
    failContext(context, "Codex session closed")
    if (context.pendingTurn) finish(context.pendingTurn)
    sessions.delete(chatId)
    yield* Scope.close(context.scope, Exit.void)
  })

  const stopAll = Effect.suspend(() => {
    const all = [...sessions.values()]
    for (const context of all) {
      failContext(context, "Codex session closed")
      if (context.pendingTurn) finish(context.pendingTurn)
    }
    sessions.clear()
    return Effect.forEach(all, (context) => Scope.close(context.scope, Exit.void), { concurrency: "unbounded", discard: true })
  }).pipe(Effect.withSpan("CodexAppServer.stopAll"))

  yield* Effect.addFinalizer(() => stopAll.pipe(Effect.andThen(PubSub.shutdown(rateLimits))))

  const requireSession = (chatId: string) => Effect.suspend(() => {
    const context = sessions.get(chatId)
    if (!context || context.closed) {
      return Effect.fail(new CodexSessionNotStartedError({ chatId, message: "Codex session not started" }))
    }
    return Effect.succeed(context)
  })

  /**
   * Runs `run` against a throwaway process: spawn, handshake, `run`, then
   * kill. Account-level reads (rate limits, the model list) use this when no
   * chat has a live process to piggyback on. Null when it cannot be spawned.
   */
  const withProbe = <A, E>(cwd: string, run: (context: SessionContext) => Effect.Effect<A, E>) =>
    openSession({ chatId: `probe-${randomUUID()}`, cwd, register: false }).pipe(
      Effect.flatMap((context) => initialize(context).pipe(
        Effect.andThen(run(context)),
        Effect.ensuring(Scope.close(context.scope, Exit.void)),
      )),
      Effect.catchTag("@kanna/server/codex-app-server/CodexSpawnError", () => Effect.succeed(null)),
    )

  /** The first live session, for account-level reads that any process can answer. */
  const liveSession = () => [...sessions.values()].find((context) => !context.closed)

  const startSession = Effect.fn("CodexAppServer.startSession")(function* (args: StartCodexSessionArgs) {
    yield* Effect.annotateCurrentSpan("chatId", args.chatId)
    const existing = sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && !args.pendingForkSessionToken) {
      return undefined
    }
    if (existing) {
      yield* stopSession(args.chatId)
    }

    const context = yield* openSession({ chatId: args.chatId, cwd: args.cwd, customTools: args.customTools, register: true })
    return yield* startThread(context, args).pipe(
      Effect.onError(() => stopSession(args.chatId)),
    )
  })

  const startThread = (context: SessionContext, args: StartCodexSessionArgs) => Effect.gen(function* () {
    yield* initialize(context)

    // Resume and fork accept MCP config, but this CLI only accepts dynamic tools on thread/start.
    const customTools = context.customTools
    const toolConfig = customTools ? {
      config: {
        "mcp_servers.kanna": {
          url: customTools.url,
          http_headers: customTools.headers,
          tool_timeout_sec: 86400,
        },
      },
    } : {}
    // Standard speed is an explicit null. An omitted tier inherits the
    // user's config.toml (`service_tier = "priority"` runs fast while the
    // UI shows "Standard"), and on turn/start it keeps the thread's tier, so
    // turning fast mode off mid-chat would never take effect.
    const serviceTier = args.serviceTier ?? null
    const threadParams = {
      model: args.model,
      cwd: args.cwd,
      serviceTier,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ...toolConfig,
    } satisfies ThreadStartParams
    const startFresh = sendRequest(context, "thread/start", threadParams, isThreadStartResponse)

    let resumeFellBack = false
    let response: ThreadStartResponse
    if (args.pendingForkSessionToken) {
      response = yield* sendRequest(context, "thread/fork", {
        threadId: args.pendingForkSessionToken,
        model: args.model,
        cwd: args.cwd,
        serviceTier,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: false,
        // Cut at the turn the fork's transcript ends on: the source may
        // have run more turns since the fork was made.
        ...(args.pendingForkAt ? { lastTurnId: args.pendingForkAt } : {}),
        ...toolConfig,
      } satisfies ThreadForkParams, isThreadStartResponse)
    } else if (args.sessionToken) {
      response = yield* sendRequest(context, "thread/resume", {
        threadId: args.sessionToken,
        model: args.model,
        cwd: args.cwd,
        serviceTier,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: false,
        ...toolConfig,
      } satisfies ThreadResumeParams, isThreadStartResponse).pipe(
        Effect.catchTag("@kanna/server/codex-app-server/CodexRequestError", (error) => {
          if (!isRecoverableResumeError(error.message)) return Effect.fail(error)
          resumeFellBack = true
          return startFresh
        }),
      )
    } else {
      response = yield* startFresh
    }

    context.sessionToken = response.thread.id
    return { sessionToken: context.sessionToken, resumeFellBack } satisfies StartedCodexSession
  })

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  const startTurn = Effect.fn("CodexAppServer.startTurn")(function* (args: StartCodexTurnArgs) {
    yield* Effect.annotateCurrentSpan("chatId", args.chatId)
    const context = yield* requireSession(args.chatId)
    if (context.pendingTurn) {
      return yield* new CodexTurnBusyError({ chatId: args.chatId, message: "Codex turn is already running" })
    }

    const queue = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
    const pendingTurn: PendingTurn = {
      turnId: null,
      model: args.model,
      planMode: args.planMode,
      skipPlanApproval: Boolean(args.skipPlanApproval),
      queue,
      startedToolIds: new Set(),
      handledDynamicToolIds: new Set(),
      latestPlanExplanation: null,
      latestPlanSteps: [],
      latestPlanText: null,
      planTextByItemId: new Map(),
      todoSequence: 0,
      pendingWebSearchResultToolId: null,
      retryCause: null,
      resolved: false,
      onToolRequest: args.onToolRequest,
      ...(args.onApprovalRequest ? { onApprovalRequest: args.onApprovalRequest } : {}),
    }
    if (context.sessionToken) {
      emit(pendingTurn, { type: "session_token", sessionToken: context.sessionToken })
    }
    emit(pendingTurn, { type: "transcript", entry: codexSystemInitEntry(args.model) })
    context.pendingTurn = pendingTurn

    const input: CodexUserInput[] = [
      {
        type: "text",
        text: args.skills?.length
          ? appendSystemMessageBlock(args.content, buildSkillSystemMessage(args.skills))
          : args.content,
        text_elements: [],
      },
    ]
    for (const skill of args.skills ?? []) {
      input.push({ type: "skill", name: skill.name, path: skill.path })
    }
    const response = yield* sendRequest(context, "turn/start", {
      threadId: context.sessionToken ?? "",
      input,
      approvalPolicy: "never",
      model: args.model,
      effort: args.effort,
      // null, not omitted: see startThread.
      serviceTier: args.serviceTier ?? null,
      collaborationMode: {
        mode: args.planMode ? "plan" : "default",
        settings: {
          model: args.model,
          reasoning_effort: args.effort ?? null,
          // Codex's instruction channel is per-turn, not per-session: this is
          // re-sent every turn by design. It appends to the built-in
          // developer message rather than replacing it.
          developer_instructions: buildKannaSystemInstructions(buildKannaAgentId("codex", args.model), { delegator: args.delegator }),
        },
      },
    } satisfies TurnStartParams, isTurnStartResponse).pipe(
      Effect.onError(() => Effect.sync(() => {
        context.pendingTurn = null
        finish(pendingTurn)
      })),
    )
    if (context.pendingTurn) {
      context.pendingTurn.turnId = response.turn.id
    } else {
      pendingTurn.turnId = response.turn.id
    }

    return {
      provider: "codex",
      events: Stream.fromQueue(queue),
      interrupt: interruptTurn(context),
    } satisfies HarnessTurnEffect
  })

  /**
   * Ends the turn now (its stream finishes) and asks codex to stop it. The
   * agent races this against a timeout and ignores a failure, so a failed
   * `turn/interrupt` is dropped here.
   */
  const interruptTurn = (context: SessionContext) => Effect.suspend(() => {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return Effect.void

    context.pendingTurn = null
    pendingTurn.resolved = true
    finish(pendingTurn)

    if (!pendingTurn.turnId || !context.sessionToken) return Effect.void

    return sendRequest(context, "turn/interrupt", {
      threadId: context.sessionToken,
      turnId: pendingTurn.turnId,
    } satisfies TurnInterruptParams, isAnyResult).pipe(Effect.ignore)
  }).pipe(Effect.withSpan("CodexAppServer.interruptTurn"))

  const listSkills = Effect.fn("CodexAppServer.listSkills")(function* (args: { chatId: string; cwd: string }) {
    yield* Effect.annotateCurrentSpan("chatId", args.chatId)
    const context = sessions.get(args.chatId)
    if (!context || context.closed) return null
    return yield* sendRequest(context, "skills/list", {
      cwds: [args.cwd],
    } satisfies SkillsListParams, isSkillsListResponse).pipe(
      Effect.map((response) => {
        const skills = (response.data ?? []).flatMap((entry) => entry.skills ?? [])
        // Disabled skills fail structured resolution server-side (silently), so
        // they never belong in the invocation menu.
        return skills.filter((skill) => skill.enabled)
      }),
      Effect.catchTag("@kanna/server/codex-app-server/CodexRequestError", () => Effect.succeed(null)),
    )
  })

  const requestModelList = (context: SessionContext) => Effect.gen(function* () {
    const models: CodexModelSummary[] = []
    let cursor: string | null | undefined
    do {
      const response = yield* sendRequest(
        context,
        "model/list",
        (cursor ? { cursor } : {}) satisfies ModelListParams,
        isModelListResponse,
      )
      models.push(...(response.data ?? []).filter((model) => !model.hidden))
      cursor = response.nextCursor
    } while (cursor)
    return models
  })

  const listModels = Effect.fn("CodexAppServer.listModels")(function* (probeCwd: string) {
    const live = liveSession()
    if (live) return yield* requestModelList(live)
    return yield* withProbe(probeCwd, requestModelList)
  })

  const readAccountRateLimits = Effect.fn("CodexAppServer.readAccountRateLimits")(function* (probeCwd: string) {
    const read = (context: SessionContext) => sendRequest(context, "account/rateLimits/read", {}, isRateLimitsResponse)
    const live = liveSession()
    if (live) return yield* read(live)
    return yield* withProbe(probeCwd, read)
  })

  const generateStructured = Effect.fn("CodexAppServer.generateStructured")(function* (args: GenerateStructuredArgs) {
    const chatId = `quick-${randomUUID()}`
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    return yield* Effect.gen(function* () {
      yield* startSession({
        chatId,
        cwd: args.cwd,
        model: args.model ?? "gpt-5.5",
        serviceTier: args.serviceTier ?? "fast",
        sessionToken: null,
      })
      const turn = yield* startTurn({
        chatId,
        model: args.model ?? "gpt-5.5",
        effort: args.effort,
        serviceTier: args.serviceTier ?? "fast",
        content: args.prompt,
        planMode: false,
        onToolRequest: () => Effect.succeed({}),
      }).pipe(
        // The session was started just above under a chat id of its own.
        Effect.catchTags({
          "@kanna/server/codex-app-server/CodexSessionNotStartedError": Effect.die,
          "@kanna/server/codex-app-server/CodexTurnBusyError": Effect.die,
        }),
      )

      let assistantText = ""
      let resultText = ""
      yield* Stream.runForEach(turn.events, (event) => Effect.sync(() => {
        if (event.type !== "transcript" || !event.entry) return
        if (event.entry.kind === "assistant_text") {
          assistantText += assistantText ? `\n${event.entry.text}` : event.entry.text
        }
        if (event.entry.kind === "result" && !event.entry.isError && event.entry.result.trim()) {
          resultText = event.entry.result
        }
      }))

      const candidate = assistantText.trim() || resultText.trim()
      return candidate || null
    }).pipe(
      Effect.scoped,
      Effect.ensuring(stopSession(chatId)),
    )
  })

  const stopAgent = Effect.fn("CodexAppServer.stopAgent")(function* (chatId: string, agentThreadId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const context = sessions.get(chatId)
    const agent = context?.agents.get(agentThreadId)
    if (!context || context.closed || !agent?.turnId) return false
    yield* sendRequest(context, "turn/interrupt", {
      threadId: agent.threadId,
      turnId: agent.turnId,
    } satisfies TurnInterruptParams, isAnyResult)
    return true
  })

  const stopAgents = Effect.fn("CodexAppServer.stopAgents")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const running = [...(sessions.get(chatId)?.agents.values() ?? [])].filter((agent) => agent.turnId !== null)
    yield* Effect.forEach(running, (agent) => stopAgent(chatId, agent.threadId).pipe(Effect.ignore), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  // ---------------------------------------------------------------------------
  // What codex sends
  // ---------------------------------------------------------------------------

  const handleLine = (context: SessionContext, line: string): Effect.Effect<void> => {
    const inbound = decodeCodexLine(line)
    return Match.valueTags(inbound, {
      Response: ({ response }) => Effect.sync(() => handleResponse(context, response)),
      Request: ({ request }) => handleServerRequest(context, request),
      Notification: ({ notification }) => handleNotification(context, notification),
      // A request codex now waits on for good (the old cast failed the same
      // way) is worth a warning; a notification is only dropped.
      Malformed: ({ method, request }) => request
        ? Effect.logWarning(`Ignoring a malformed Codex ${method} request`)
        : Effect.logDebug(`Ignoring a malformed Codex ${method} notification`),
      Ignored: () => Effect.void,
    })
  }

  /**
   * Codex's questions to the user, its tool calls, and approvals. The
   * transcript entries go out at once; the wait for the user's answer runs
   * on a fiber of its own (started at once, as the old async handler was),
   * so the reader goes on with the next line.
   */
  const handleServerRequest = (context: SessionContext, request: ServerRequest): Effect.Effect<void> => Effect.suspend(() => {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) {
      writeMessage(context, {
        id: request.id,
        error: {
          message: "No active turn",
        },
      })
      return Effect.void
    }

    const answerLater = <A>(wait: CodexCallback<A>, what: string, answer: (value: A) => unknown) =>
      wait.pipe(
        Effect.flatMap((value) => Effect.sync(() => writeMessage(context, { id: request.id, result: answer(value) }))),
        logCallbackFailure(what),
        Effect.forkIn(context.scope, { startImmediately: true }),
        Effect.asVoid,
      )

    return Match.value(request).pipe(
      Match.discriminatorsExhaustive("method")({
        "item/tool/requestUserInput": (request) => {
          const questions = toAskUserQuestionItems(request.params)
          const toolRequest: HarnessToolRequest = {
            tool: {
              kind: "tool",
              toolKind: "ask_user_question",
              toolName: "AskUserQuestion",
              toolId: request.params.itemId,
              input: { questions },
              rawInput: {
                questions: request.params.questions,
              },
            },
          }
          emit(pendingTurn, {
            type: "transcript",
            entry: timestamped({
              kind: "tool_call",
              tool: toolRequest.tool,
            }),
          })
          return answerLater(
            pendingTurn.onToolRequest(toolRequest),
            "question",
            (result) => toToolRequestUserInputResponse(result, request.params.questions) satisfies ToolRequestUserInputResponse,
          )
        },
        "item/tool/call": (request) => Effect.sync(() => handleDynamicToolCall(context, pendingTurn, request)),
        "item/commandExecution/requestApproval": (request) => answerLater(
          pendingTurn.onApprovalRequest?.({ requestId: request.id, kind: "command_execution", params: request.params })
            ?? Effect.succeed<CommandExecutionApprovalDecision | FileChangeApprovalDecision>("decline"),
          "approval",
          (decision) => ({ decision } satisfies CommandExecutionRequestApprovalResponse),
        ),
        "item/fileChange/requestApproval": (request) => answerLater(
          pendingTurn.onApprovalRequest?.({ requestId: request.id, kind: "file_change", params: request.params })
            ?? Effect.succeed<CommandExecutionApprovalDecision | FileChangeApprovalDecision>("decline"),
          "approval",
          (decision) => ({ decision } satisfies FileChangeRequestApprovalResponse),
        ),
      }),
    )
  })

  const handleDynamicToolCall = (
    context: SessionContext,
    pendingTurn: PendingTurn,
    request: Extract<ServerRequest, { method: "item/tool/call" }>,
  ) => {
    pendingTurn.handledDynamicToolIds.add(request.params.callId)
    if (request.params.tool === "update_plan") {
      const args = asRecord(request.params.arguments)
      const plan = Array.isArray(args?.plan) ? args.plan : []
      const steps: TurnPlanStep[] = plan
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .map((entry) => {
          const status =
            entry.status === "completed"
              ? "completed"
              : entry.status === "inProgress" || entry.status === "in_progress"
                ? "inProgress"
                : "pending"
          return {
            step: typeof entry.step === "string" ? entry.step : "",
            status,
          }
        })
        .filter((step) => step.step.length > 0)

      if (steps.length > 0) {
        pendingTurn.latestPlanSteps = steps
        pendingTurn.latestPlanExplanation = typeof args?.explanation === "string" ? args.explanation : pendingTurn.latestPlanExplanation
        emit(pendingTurn, {
          type: "transcript",
          entry: todoToolCall(request.params.callId, steps),
        })
        emit(pendingTurn, {
          type: "transcript",
          entry: timestamped({
            kind: "tool_result",
            toolId: request.params.callId,
            content: "",
          }),
        })
      }

      writeMessage(context, {
        id: request.id,
        result: {
          contentItems: [],
          success: true,
        } satisfies DynamicToolCallResponse,
      })
      return
    }

    const payload = dynamicToolPayload(request.params.arguments)
    emit(pendingTurn, {
      type: "transcript",
      entry: genericDynamicToolCall(request.params.callId, request.params.tool, payload),
    })
    const errorMessage = `Unsupported dynamic tool call: ${request.params.tool}`
    emit(pendingTurn, {
      type: "transcript",
      entry: timestamped({
        kind: "tool_result",
        toolId: request.params.callId,
        content: errorMessage,
        isError: true,
      }),
    })
    writeMessage(context, {
      id: request.id,
      result: {
        contentItems: [{ type: "inputText", text: errorMessage }],
        success: false,
      } satisfies DynamicToolCallResponse,
    })
  }

  const handleNotification = (context: SessionContext, notification: ServerNotification): Effect.Effect<void> => Effect.suspend(() => {
    if (notification.method === "thread/started") {
      // A spawned agent's thread is not a new thread for the chat. Taking its
      // id would send the chat's next turn to the agent.
      const thread = notification.params.thread
      if (thread.parentThreadId || context.agents.has(thread.id)) return Effect.void
      context.sessionToken = thread.id
      if (context.pendingTurn) {
        emit(context.pendingTurn, {
          type: "session_token",
          sessionToken: thread.id,
        })
      }
      return Effect.void
    }

    // Account rate limits arrive independent of any active turn.
    if (notification.method === "account/rateLimits/updated") {
      const snapshot = notification.params.rateLimits
      return snapshot ? PubSub.publish(rateLimits, snapshot).pipe(Effect.asVoid) : Effect.void
    }

    // Everything past here is about one thread, and the threads of the agents
    // a chat spawns report on this connection too. Read as the chat's own, an
    // agent's `turn/completed` ended the chat's turn while it was still
    // waiting on that agent, and the agent's messages and commands went into
    // the chat's transcript.
    const threadId = notificationThreadId(notification)
    if (threadId && context.sessionToken && threadId !== context.sessionToken) {
      handleAgentNotification(context, threadId, notification)
      return Effect.void
    }

    // Items the adapter does not know (reasoning, user messages, whatever a
    // newer codex adds) show nothing, as before.
    const item = (notification.method === "item/started" || notification.method === "item/completed")
      && isThreadItem(notification.params.item)
      ? notification.params.item
      : null

    // Before the check for a turn: an agent's end is reported on the chat's
    // thread, and can come after the turn that spawned it is over.
    if (item) trackSpawnedAgents(context, item)

    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return Effect.void

    // A switch rather than Match: this runs for every line codex sends.
    switch (notification.method) {
      case "thread/tokenUsage/updated":
        handleTokenUsageUpdated(pendingTurn, notification.params)
        return Effect.void
      case "turn/plan/updated":
        handlePlanUpdated(pendingTurn, notification.params)
        return Effect.void
      case "item/started":
        if (item) handleItemStarted(pendingTurn, item)
        return Effect.void
      case "item/completed":
        if (item) handleItemCompleted(pendingTurn, item)
        return Effect.void
      case "item/plan/delta":
        handlePlanDelta(pendingTurn, notification.params)
        return Effect.void
      case "turn/completed":
        return handleTurnCompleted(context, notification.params)
      case "thread/compacted":
        handleContextCompacted(pendingTurn)
        return Effect.void
      case "error":
        return handleErrorNotification(context, notification.params)
      default:
        return Effect.void
    }
  })

  /**
   * A notification about a thread that is not the chat's. Only the threads of
   * agents the chat spawned are followed, and of those only the turns: what
   * an agent says and runs is its own, and is not the chat's transcript.
   *
   * The signals were read off `codex app-server` 0.159: a spawned agent's
   * `turn/started` and `turn/completed` arrive here with its thread id, and an
   * agent whose turn is interrupted reports `turn/completed` as `interrupted`.
   */
  const handleAgentNotification = (context: SessionContext, threadId: string, notification: ServerNotification) => {
    switch (notification.method) {
      case "turn/started":
        agentTurnStarted(context, threadId, notification.params.turn.id)
        return
      case "turn/completed": {
        const { id, status } = notification.params.turn
        agentTurnEnded(context, threadId, id, status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "completed")
        return
      }
      case "item/started":
      case "item/completed":
        // An agent can spawn agents of its own.
        if (context.agents.has(threadId) && isThreadItem(notification.params.item)) {
          trackSpawnedAgents(context, notification.params.item)
        }
        return
      case "error":
        // The end of the agent's turn, not of the chat's session.
        if (!notification.params.willRetry) agentTurnEnded(context, threadId, notification.params.turnId ?? null, "failed")
        return
      case "thread/closed":
        agentTurnEnded(context, threadId, null, "stopped")
        return
      case "thread/status/changed": {
        // Only the states a thread does not come back from. `idle` is left to
        // `turn/completed`: a new thread is idle for a moment before its
        // first turn, and reading that as an end would close the row early.
        const status = notification.params.status.type
        if (status === "systemError") agentTurnEnded(context, threadId, null, "failed")
        else if (status === "notLoaded") agentTurnEnded(context, threadId, null, "stopped")
        return
      }
      default:
        return
    }
  }

  /**
   * Learns of an agent from the item that spawned it, and of one of its turns
   * ending from the item that says so. Codex has announced a spawn two ways:
   * a `spawnAgent` call whose result names the new threads, and since then a
   * `subAgentActivity` item. Neither starts a row. The agent's own
   * `turn/started` does, so a row always has a turn that must end.
   */
  const trackSpawnedAgents = (context: SessionContext, item: ThreadItem) => {
    if (item.type === "collabAgentToolCall") {
      if (item.tool !== "spawnAgent") return
      for (const threadId of item.receiverThreadIds ?? []) {
        nameAgent(context, {
          threadId,
          label: agentLabelFromPrompt(item.prompt),
          ...(item.prompt?.trim() ? { description: item.prompt.trim() } : {}),
          toolUseId: item.id,
        })
      }
      return
    }
    if (item.type !== "subAgentActivity") return
    if (item.kind === "started" || item.kind === "interacted") {
      nameAgent(context, { threadId: item.agentThreadId, label: agentLabelFromPath(item.agentPath) })
      return
    }
    // The item's id names the turn that ended ("subagent-completed-<turn id>"),
    // which keeps a late report of one turn from ending the agent's next.
    const turnId = /^subagent-(?:completed|interrupted)-(.+)$/.exec(item.id)?.[1] ?? null
    agentTurnEnded(context, item.agentThreadId, turnId, item.kind === "interrupted" ? "stopped" : "completed")
  }

  const nameAgent = (context: SessionContext, named: Omit<SpawnedAgent, "turnId">) => {
    if (named.threadId === context.sessionToken || context.agents.has(named.threadId)) return
    context.agents.set(named.threadId, { ...named, turnId: null })
    const turnId = context.unclaimedTurns.get(named.threadId)
    if (turnId === undefined) return
    context.unclaimedTurns.delete(named.threadId)
    agentTurnStarted(context, named.threadId, turnId)
  }

  const agentTurnStarted = (context: SessionContext, threadId: string, turnId: string) => {
    const agent = context.agents.get(threadId)
    if (!agent) {
      context.unclaimedTurns.set(threadId, turnId)
      return
    }
    agent.turnId = turnId
    onTaskActivity?.(context.chatId, {
      kind: "started",
      id: threadId,
      type: "subagent",
      label: agent.label,
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.toolUseId ? { toolUseId: agent.toolUseId } : {}),
      stoppable: true,
    })
  }

  /** `turnId` is null when the report is of the thread, not of one turn. */
  const agentTurnEnded = (
    context: SessionContext,
    threadId: string,
    turnId: string | null,
    outcome: "completed" | "failed" | "stopped",
  ) => {
    if (turnId === null || context.unclaimedTurns.get(threadId) === turnId) context.unclaimedTurns.delete(threadId)
    const agent = context.agents.get(threadId)
    if (!agent || agent.turnId === null) return
    if (turnId !== null && turnId !== agent.turnId) return
    agent.turnId = null
    onTaskActivity?.(context.chatId, {
      kind: "stopped",
      id: threadId,
      failed: outcome === "failed",
      ...(outcome === "stopped" ? { stopped: true } : {}),
    })
  }

  /**
   * The process is gone, or about to be, and its agents with it. None of them
   * can report an end now, so each one still running is closed here, as cut
   * off rather than finished. Without this a dropped connection would leave
   * the chat waiting on a subagent for good.
   */
  const closeAgents = (context: SessionContext) => {
    for (const agent of context.agents.values()) {
      if (agent.turnId === null) continue
      agent.turnId = null
      onTaskActivity?.(context.chatId, { kind: "stopped", id: agent.threadId, failed: true })
    }
    context.agents.clear()
    context.unclaimedTurns.clear()
  }

  const handleTurnCompleted = (context: SessionContext, notification: TurnCompletedNotification): Effect.Effect<void> => Effect.suspend(() => {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return Effect.void
    const status = notification.turn.status
    const isCancelled = status === "interrupted"
    const isError = status === "failed"
    pendingTurn.pendingWebSearchResultToolId = null

    if (!isCancelled && !isError && pendingTurn.planMode) {
      const planText = pendingTurn.latestPlanText?.trim()
        || renderPlanMarkdownFromSteps(pendingTurn.latestPlanSteps).trim()

      if (planText && pendingTurn.skipPlanApproval) {
        // The plan item is in no transcript entry of its own: the approval
        // card is what shows it. Without the card it goes in as the reply,
        // which is what the sender's report carries.
        emit(pendingTurn, {
          type: "transcript",
          entry: timestamped({ kind: "assistant_text", text: planText }),
        })
      } else if (planText) {
        pendingTurn.turnId = null
        const tool = {
          kind: "tool" as const,
          toolKind: "exit_plan_mode" as const,
          toolName: "ExitPlanMode",
          toolId: `${notification.turn.id}:exit-plan`,
          input: {
            plan: planText,
            summary: pendingTurn.latestPlanExplanation ?? undefined,
          },
          rawInput: {
            plan: planText,
            summary: pendingTurn.latestPlanExplanation ?? undefined,
          },
        }
        emit(pendingTurn, {
          type: "transcript",
          entry: timestamped({
            kind: "tool_call",
            tool,
          }),
        })
        // The turn ends once the user has answered the plan. Only this turn:
        // an interrupt may have let the chat's next one start meanwhile.
        return pendingTurn.onToolRequest({ tool }).pipe(
          Effect.andThen(Effect.sync(() => {
            pendingTurn.resolved = true
            finish(pendingTurn)
            if (context.pendingTurn === pendingTurn) context.pendingTurn = null
          })),
          logCallbackFailure("plan approval"),
          Effect.forkIn(context.scope, { startImmediately: true }),
          Effect.asVoid,
        )
      }
    }

    pendingTurn.resolved = true
    emit(pendingTurn, {
      type: "transcript",
      entry: timestamped({
        kind: "result",
        // The turn's id: a fork of this chat branches through it (`forkPointOf`, `lastTurnId`).
        ...(notification.turn.id ? { messageId: notification.turn.id } : {}),
        subtype: isCancelled ? "cancelled" : isError ? "error" : "success",
        isError,
        durationMs: 0,
        result: isError
          ? formatCodexError(notification.turn.error)
            || formatCodexError(pendingTurn.retryCause)
            || "Codex turn failed"
          : formatCodexError(notification.turn.error),
      }),
    })
    finish(pendingTurn)
    context.pendingTurn = null
    return Effect.void
  })

  /**
   * codex reports two different things through `error`. A dropped model stream
   * arrives with `willRetry: true` and a message that is only a progress
   * counter ("Reconnecting... 2/5") — the turn is still alive and codex retries
   * on its own. Failing here killed turns that would have recovered a second
   * later, and reported the counter as the outcome, which says nothing about
   * what went wrong. Show it as a status line instead (the transcript renders
   * only the last one, so it clears itself when the stream comes back) and let
   * the turn run. Only `willRetry: false` is terminal.
   */
  const handleErrorNotification = (context: SessionContext, notification: ErrorNotification): Effect.Effect<void> => {
    const message = formatCodexError(notification.error) || "Codex reported an error"
    if (!notification.willRetry) return failSession(context, message)

    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return Effect.void
    pendingTurn.retryCause = preferredRetryCause(pendingTurn.retryCause, notification.error)
    emit(pendingTurn, {
      type: "transcript",
      entry: timestamped({ kind: "status", status: message }),
    })
    return Effect.void
  }

  return CodexAppServer.of({
    startSession,
    startTurn,
    listSkills,
    listModels,
    readAccountRateLimits,
    generateStructured,
    stopAgent,
    stopAgents,
    stopSession,
    stopAll,
    resourceCounts: Effect.sync(() => ({
      codexSessions: sessions.size,
      codexPendingRequests: [...sessions.values()].reduce((sum, session) => sum + session.pendingRequests.size, 0),
      codexStderrChars: [...sessions.values()].reduce((sum, session) => sum + session.stderrLines.reduce((total, line) => total + line.length, 0), 0),
    })),
    rateLimitPushes: Stream.fromPubSub(rateLimits),
    setTaskActivityListener: (listener) => {
      onTaskActivity = listener
    },
  })
})

function handleItemStarted(pendingTurn: PendingTurn, item: ThreadItem) {
  if (item.type === "plan") {
    pendingTurn.planTextByItemId.set(item.id, item.text)
    pendingTurn.latestPlanText = item.text
    return
  }

  if (
    item.type === "commandExecution"
    || item.type === "webSearch"
    || item.type === "mcpToolCall"
    || item.type === "dynamicToolCall"
    || item.type === "collabAgentToolCall"
    || item.type === "fileChange"
    || item.type === "error"
  ) {
    if (pendingTurn.handledDynamicToolIds.has(item.id)) {
      return
    }
    if (item.type === "webSearch" && !webSearchQuery(item)) {
      return
    }
  }

  const entries = itemToToolCalls(item)
  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      pendingTurn.startedToolIds.add(entry.tool.toolId)
    }
    emit(pendingTurn, { type: "transcript", entry })
  }
}

function handleItemCompleted(pendingTurn: PendingTurn, item: ThreadItem) {
  if (item.type === "agentMessage") {
    emit(pendingTurn, {
      type: "transcript",
      entry: timestamped({
        kind: "assistant_text",
        text: item.text,
      }),
    })
    if (pendingTurn.pendingWebSearchResultToolId && item.text.trim()) {
      emit(pendingTurn, {
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: pendingTurn.pendingWebSearchResultToolId,
          content: item.text,
        }),
      })
      pendingTurn.pendingWebSearchResultToolId = null
    }
    return
  }

  if (item.type === "plan") {
    pendingTurn.planTextByItemId.set(item.id, item.text)
    pendingTurn.latestPlanText = item.text
    return
  }

  if (pendingTurn.handledDynamicToolIds.has(item.id)) {
    return
  }

  const startedEntries = itemToToolCalls(item)
  for (const entry of startedEntries) {
    if (entry.kind !== "tool_call") {
      continue
    }
    if (pendingTurn.startedToolIds.has(entry.tool.toolId)) {
      continue
    }
    pendingTurn.startedToolIds.add(entry.tool.toolId)
    emit(pendingTurn, { type: "transcript", entry })
  }

  const resultEntries = itemToToolResults(item)
  for (const entry of resultEntries) {
    emit(pendingTurn, { type: "transcript", entry })
    if (item.type === "webSearch" && entry.kind === "tool_result" && !entry.isError) {
      pendingTurn.pendingWebSearchResultToolId = item.id
    }
  }
}

function handlePlanUpdated(pendingTurn: PendingTurn, notification: TurnPlanUpdatedNotification) {
  pendingTurn.latestPlanExplanation = notification.explanation ?? null
  pendingTurn.latestPlanSteps = notification.plan
  if (notification.plan.length === 0) {
    return
  }
  pendingTurn.todoSequence += 1
  emit(pendingTurn, {
    type: "transcript",
    entry: todoToolCall(
      `${notification.turnId}:todo-${pendingTurn.todoSequence}`,
      notification.plan
    ),
  })
}

function handlePlanDelta(pendingTurn: PendingTurn, notification: PlanDeltaNotification) {
  const current = pendingTurn.planTextByItemId.get(notification.itemId) ?? ""
  const next = `${current}${notification.delta}`
  pendingTurn.planTextByItemId.set(notification.itemId, next)
  pendingTurn.latestPlanText = next
}

function handleContextCompacted(pendingTurn: PendingTurn) {
  emit(pendingTurn, {
    type: "transcript",
    entry: timestamped({ kind: "compact_boundary" }),
  })
}

function handleTokenUsageUpdated(pendingTurn: PendingTurn, notification: ThreadTokenUsageUpdatedNotification) {
  const usage = normalizeCodexTokenUsage(notification)
  if (!usage) {
    return
  }

  emit(pendingTurn, {
    type: "transcript",
    entry: timestamped({
      kind: "context_window_updated",
      usage,
    }),
  })
}

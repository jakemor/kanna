import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type {
  AskUserQuestionItem,
  CodexReasoningEffort,
  ContextWindowUsageSnapshot,
  ServiceTier,
  TodoItem,
  TranscriptEntry,
} from "../shared/types"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  type CollabAgentToolCallItem,
  type ContextCompactedNotification,
  type CodexRequestId,
  type CommandExecutionApprovalDecision,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallOutputContentItem,
  type DynamicToolCallResponse,
  type FileChangeApprovalDecision,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  type InitializeParams,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type JsonRpcResponse,
  type McpToolCallItem,
  type PlanDeltaNotification,
  type ServerNotification,
  type ServerRequest,
  type ThreadItem,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadTokenUsageUpdatedNotification,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TurnPlanStep,
  type TurnPlanUpdatedNotification,
  type TurnCompletedNotification,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResponse,
  isJsonRpcResponse,
  isServerNotification,
  isServerRequest,
} from "./codex-app-server-protocol"

interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  once(event: "close", listener: (code: number | null) => void): this
  once(event: "error", listener: (error: Error) => void): this
}

type SpawnCodexAppServer = (cwd: string) => CodexAppServerProcess

interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

interface PendingTurn {
  turnId: string | null
  model: string
  planMode: boolean
  queue: AsyncQueue<HarnessEvent>
  startedToolIds: Set<string>
  handledDynamicToolIds: Set<string>
  latestPlanExplanation: string | null
  latestPlanSteps: TurnPlanStep[]
  latestPlanText: string | null
  planTextByItemId: Map<string, string>
  todoSequence: number
  pendingWebSearchResultToolId: string | null
  resolved: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: (
    request:
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
  ) => Promise<CommandExecutionApprovalDecision | FileChangeApprovalDecision>
}

interface SessionContext {
  chatId: string
  cwd: string
  child: CodexAppServerProcess
  pendingRequests: Map<CodexRequestId, PendingRequest<unknown>>
  pendingTurn: PendingTurn | null
  sessionToken: string | null
  stderrLines: string[]
  closed: boolean
}

export interface StartCodexSessionArgs {
  chatId: string
  cwd: string
  model: string
  serviceTier?: ServiceTier
  sessionToken: string | null
}

export interface StartCodexTurnArgs {
  chatId: string
  model: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
  content: string
  planMode: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: PendingTurn["onApprovalRequest"]
}

export interface GenerateStructuredArgs {
  cwd: string
  prompt: string
  model?: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

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

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isRecoverableResumeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
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

function todoStatus(status: TurnPlanStep["status"]): TodoItem["status"] {
  if (status === "completed") return "completed"
  if (status === "inProgress") return "in_progress"
  return "pending"
}

function planStepsToTodos(steps: TurnPlanStep[]): TodoItem[] {
  return steps.map((step) => ({
    content: step.step,
    status: todoStatus(step.status),
    activeForm: step.step,
  }))
}

function renderPlanMarkdownFromSteps(steps: TurnPlanStep[]): string {
  return steps.map((step) => {
    const checkbox = step.status === "completed" ? "[x]" : "[ ]"
    return `- ${checkbox} ${step.step}`
  }).join("\n")
}

function dynamicContentToText(contentItems: DynamicToolCallOutputContentItem[] | null | undefined): string {
  if (!contentItems?.length) return ""
  return contentItems
    .map((item) => item.type === "inputText" ? item.text ?? "" : item.imageUrl ?? "")
    .filter(Boolean)
    .join("\n")
}

function dynamicToolPayload(value: Record<string, unknown> | unknown[] | string | number | boolean | null | undefined): Record<string, unknown> {
  const record = asRecord(value)
  if (record) return record
  return { value }
}

function webSearchQuery(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  return item.query || item.action?.query || item.action?.queries?.find((query) => typeof query === "string") || ""
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
      },
      rawInput: item as unknown as Record<string, unknown>,
    },
  })
}

function todoToolCall(toolId: string, steps: TurnPlanStep[]): TranscriptEntry {
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
  kind: "add" | "delete" | "update" | { type: "add" | "delete" | "update"; move_path?: string | null }
): { type: "add" | "delete" | "update"; movePath?: string | null } {
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
  } as unknown as Record<string, unknown>
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
      const { oldString, newString } = parseUnifiedDiff(change.diff)

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
            payload: item as unknown as Record<string, unknown>,
          },
          rawInput: item as unknown as Record<string, unknown>,
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

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  push(value: T) {
    if (this.done) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
      return
    }
    this.values.push(value)
  }

  finish() {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

export class CodexAppServerManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly spawnProcess: SpawnCodexAppServer

  constructor(args: { spawnProcess?: SpawnCodexAppServer } = {}) {
    this.spawnProcess = args.spawnProcess ?? ((cwd) =>
      spawn("codex", ["app-server"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as unknown as CodexAppServerProcess)
  }

  async startSession(args: StartCodexSessionArgs) {
    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd) {
      return
    }

    if (existing) {
      this.stopSession(args.chatId)
    }

    const child = this.spawnProcess(args.cwd)
    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: null,
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(args.chatId, context)
    this.attachListeners(context)

    await this.sendRequest(context, "initialize", {
      clientInfo: {
        name: "kanna_desktop",
        title: "Kanna",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    } satisfies InitializeParams)
    this.writeMessage(context, {
      method: "initialized",
    })

    const threadParams = {
      model: args.model,
      cwd: args.cwd,
      serviceTier: args.serviceTier,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    } satisfies ThreadStartParams

    let response: ThreadStartResponse | ThreadResumeResponse
    if (args.sessionToken) {
      try {
        response = await this.sendRequest<ThreadResumeResponse>(context, "thread/resume", {
          threadId: args.sessionToken,
          model: args.model,
          cwd: args.cwd,
          serviceTier: args.serviceTier,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          persistExtendedHistory: false,
        } satisfies ThreadResumeParams)
      } catch (error) {
        if (!isRecoverableResumeError(error)) {
          this.stopSession(args.chatId)
          throw error
        }
        response = await this.sendRequest<ThreadStartResponse>(context, "thread/start", threadParams)
      }
    } else {
      response = await this.sendRequest<ThreadStartResponse>(context, "thread/start", threadParams)
    }

    context.sessionToken = response.thread.id
  }

  async startTurn(args: StartCodexTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error("Codex turn is already running")
    }

    const queue = new AsyncQueue<HarnessEvent>()
    if (context.sessionToken) {
      queue.push({ type: "session_token", sessionToken: context.sessionToken })
    }
    queue.push({ type: "transcript", entry: codexSystemInitEntry(args.model) })

    const pendingTurn: PendingTurn = {
      turnId: null,
      model: args.model,
      planMode: args.planMode,
      queue,
      startedToolIds: new Set(),
      handledDynamicToolIds: new Set(),
      latestPlanExplanation: null,
      latestPlanSteps: [],
      latestPlanText: null,
      planTextByItemId: new Map(),
      todoSequence: 0,
      pendingWebSearchResultToolId: null,
      resolved: false,
      onToolRequest: args.onToolRequest,
      onApprovalRequest: args.onApprovalRequest,
    }
    context.pendingTurn = pendingTurn

    try {
      const response = await this.sendRequest<TurnStartResponse>(context, "turn/start", {
        threadId: context.sessionToken ?? "",
        input: [
          {
            type: "text",
            text: args.content,
            text_elements: [],
          },
        ],
        approvalPolicy: "never",
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        collaborationMode: {
          mode: args.planMode ? "plan" : "default",
          settings: {
            model: args.model,
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      } satisfies TurnStartParams)
      if (context.pendingTurn) {
        context.pendingTurn.turnId = response.turn.id
      } else {
        pendingTurn.turnId = response.turn.id
      }
    } catch (error) {
      context.pendingTurn = null
      queue.finish()
      throw error
    }

    return {
      provider: "codex",
      stream: queue,
      interrupt: async () => {
        const pendingTurn = context.pendingTurn
        if (!pendingTurn) return

        context.pendingTurn = null
        pendingTurn.resolved = true
        pendingTurn.queue.finish()

        if (!pendingTurn.turnId || !context.sessionToken) return

        await this.sendRequest(context, "turn/interrupt", {
          threadId: context.sessionToken,
          turnId: pendingTurn.turnId,
        } satisfies TurnInterruptParams)
      },
      close: () => {},
    }
  }

  async generateStructured(args: GenerateStructuredArgs): Promise<string | null> {
    const chatId = `quick-${randomUUID()}`
    let turn: HarnessTurn | null = null
    let assistantText = ""
    let resultText = ""

    try {
      await this.startSession({
        chatId,
        cwd: args.cwd,
        model: args.model ?? "gpt-5.4",
        serviceTier: args.serviceTier ?? "fast",
        sessionToken: null,
      })

      turn = await this.startTurn({
        chatId,
        model: args.model ?? "gpt-5.4",
        effort: args.effort,
        serviceTier: args.serviceTier ?? "fast",
        content: args.prompt,
        planMode: false,
        onToolRequest: async () => ({}),
      })

      for await (const event of turn.stream) {
        if (event.type !== "transcript" || !event.entry) continue
        if (event.entry.kind === "assistant_text") {
          assistantText += assistantText ? `\n${event.entry.text}` : event.entry.text
        }
        if (event.entry.kind === "result" && !event.entry.isError && event.entry.result.trim()) {
          resultText = event.entry.result
        }
      }

      const candidate = assistantText.trim() || resultText.trim()
      return candidate || null
    } finally {
      turn?.close()
      this.stopSession(chatId)
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    context.closed = true
    context.pendingTurn?.queue.finish()
    this.sessions.delete(chatId)
    try {
      context.child.kill("SIGKILL")
    } catch {
      // ignore kill failures
    }
  }

  stopAll() {
    for (const chatId of this.sessions.keys()) {
      this.stopSession(chatId)
    }
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed) {
      throw new Error("Codex session not started")
    }
    return context
  }

  private attachListeners(context: SessionContext) {
    const lines = createInterface({ input: context.child.stdout })
    void (async () => {
      for await (const line of lines) {
        const parsed = parseJsonLine(line)
        if (!parsed) continue

        if (isJsonRpcResponse(parsed)) {
          this.handleResponse(context, parsed)
          continue
        }

        if (isServerRequest(parsed)) {
          void this.handleServerRequest(context, parsed)
          continue
        }

        if (isServerNotification(parsed)) {
          void this.handleNotification(context, parsed)
        }
      }
    })()

    const stderr = createInterface({ input: context.child.stderr })
    void (async () => {
      for await (const line of stderr) {
        if (line.trim()) {
          context.stderrLines.push(line.trim())
        }
      }
    })()

    context.child.on("error", (error) => {
      this.failContext(context, error.message)
    })

    context.child.on("close", (code) => {
      if (context.closed) return
      queueMicrotask(() => {
        if (context.closed) return
        const message = context.stderrLines.at(-1) || `Codex app-server exited with code ${code ?? 1}`
        this.failContext(context, message)
      })
    })
  }

  private handleResponse(context: SessionContext, response: JsonRpcResponse) {
    const pending = context.pendingRequests.get(response.id)
    if (!pending) return
    context.pendingRequests.delete(response.id)
    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message ?? "Unknown error"}`))
      return
    }
    pending.resolve(response.result)
  }

  private async handleServerRequest(context: SessionContext, request: ServerRequest) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) {
      this.writeMessage(context, {
        id: request.id,
        error: {
          message: "No active turn",
        },
      })
      return
    }

    if (request.method === "item/tool/requestUserInput") {
      const questions = toAskUserQuestionItems(request.params)
      const toolId = request.params.itemId
      const toolRequest: HarnessToolRequest = {
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId,
          input: { questions },
          rawInput: {
            questions: request.params.questions,
          },
        },
      }
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: toolRequest.tool,
        }),
      })

      const result = await pendingTurn.onToolRequest(toolRequest)
      this.writeMessage(context, {
        id: request.id,
        result: toToolRequestUserInputResponse(result, request.params.questions),
      })
      return
    }

    if (request.method === "item/tool/call") {
      pendingTurn.handledDynamicToolIds.add(request.params.callId)
      if (request.params.tool === "update_plan") {
        const args = asRecord(request.params.arguments)
        const plan = Array.isArray(args?.plan) ? args.plan : []
        const steps: TurnPlanStep[] = plan
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => {
            const status: TurnPlanStep["status"] =
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
          pendingTurn.queue.push({
            type: "transcript",
            entry: todoToolCall(request.params.callId, steps),
          })
          pendingTurn.queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_result",
              toolId: request.params.callId,
              content: "",
            }),
          })
        }

        this.writeMessage(context, {
          id: request.id,
          result: {
            contentItems: [],
            success: true,
          } satisfies DynamicToolCallResponse,
        })
        return
      }

      const payload = dynamicToolPayload(request.params.arguments)
      pendingTurn.queue.push({
        type: "transcript",
        entry: genericDynamicToolCall(request.params.callId, request.params.tool, payload),
      })
      const errorMessage = `Unsupported dynamic tool call: ${request.params.tool}`
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: request.params.callId,
          content: errorMessage,
          isError: true,
        }),
      })
      this.writeMessage(context, {
        id: request.id,
        result: {
          contentItems: [{ type: "inputText", text: errorMessage }],
          success: false,
        } satisfies DynamicToolCallResponse,
      })
      return
    }

    if (request.method === "item/commandExecution/requestApproval") {
      const decision = await pendingTurn.onApprovalRequest?.({
        requestId: request.id,
        kind: "command_execution",
        params: request.params,
      }) ?? "decline"
      this.writeMessage(context, {
        id: request.id,
        result: {
          decision,
        } satisfies CommandExecutionRequestApprovalResponse,
      })
      return
    }

    const decision = await pendingTurn.onApprovalRequest?.({
      requestId: request.id,
      kind: "file_change",
      params: request.params,
    }) ?? "decline"
    this.writeMessage(context, {
      id: request.id,
      result: {
        decision,
      } satisfies FileChangeRequestApprovalResponse,
    })
  }

  private async handleNotification(context: SessionContext, notification: ServerNotification) {
    if (notification.method === "thread/started") {
      context.sessionToken = notification.params.thread.id
      if (context.pendingTurn) {
        context.pendingTurn.queue.push({
          type: "session_token",
          sessionToken: notification.params.thread.id,
        })
      }
      return
    }

    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return

    switch (notification.method) {
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(pendingTurn, notification.params)
        return
      case "turn/plan/updated":
        this.handlePlanUpdated(pendingTurn, notification.params)
        return
      case "item/started":
        this.handleItemStarted(pendingTurn, notification.params)
        return
      case "item/completed":
        this.handleItemCompleted(pendingTurn, notification.params)
        return
      case "item/plan/delta":
        this.handlePlanDelta(pendingTurn, notification.params)
        return
      case "turn/completed":
        await this.handleTurnCompleted(context, notification.params)
        return
      case "thread/compacted":
        this.handleContextCompacted(pendingTurn, notification.params)
        return
      case "error":
        this.failContext(context, notification.params.error.message)
        return
      default:
        return
    }
  }

  private handleItemStarted(pendingTurn: PendingTurn, notification: ItemStartedNotification) {
    if (notification.item.type === "plan") {
      pendingTurn.planTextByItemId.set(notification.item.id, notification.item.text)
      pendingTurn.latestPlanText = notification.item.text
      return
    }

    if (
      notification.item.type === "commandExecution"
      || notification.item.type === "webSearch"
      || notification.item.type === "mcpToolCall"
      || notification.item.type === "dynamicToolCall"
      || notification.item.type === "collabAgentToolCall"
      || notification.item.type === "fileChange"
      || notification.item.type === "error"
    ) {
      if (pendingTurn.handledDynamicToolIds.has(notification.item.id)) {
        return
      }
      if (notification.item.type === "webSearch" && !webSearchQuery(notification.item)) {
        return
      }
    }

    const entries = itemToToolCalls(notification.item)
    for (const entry of entries) {
      if (entry.kind === "tool_call") {
        pendingTurn.startedToolIds.add(entry.tool.toolId)
      }
      pendingTurn.queue.push({ type: "transcript", entry })
    }
  }

  private handleItemCompleted(pendingTurn: PendingTurn, notification: ItemCompletedNotification) {
    if (notification.item.type === "agentMessage") {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "assistant_text",
          text: notification.item.text,
        }),
      })
      if (pendingTurn.pendingWebSearchResultToolId && notification.item.text.trim()) {
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_result",
            toolId: pendingTurn.pendingWebSearchResultToolId,
            content: notification.item.text,
          }),
        })
        pendingTurn.pendingWebSearchResultToolId = null
      }
      return
    }

    if (notification.item.type === "plan") {
      pendingTurn.planTextByItemId.set(notification.item.id, notification.item.text)
      pendingTurn.latestPlanText = notification.item.text
      return
    }

    if (pendingTurn.handledDynamicToolIds.has(notification.item.id)) {
      return
    }

    const startedEntries = itemToToolCalls(notification.item)
    for (const entry of startedEntries) {
      if (entry.kind !== "tool_call") {
        continue
      }
      if (pendingTurn.startedToolIds.has(entry.tool.toolId)) {
        continue
      }
      pendingTurn.startedToolIds.add(entry.tool.toolId)
      pendingTurn.queue.push({ type: "transcript", entry })
    }

    const resultEntries = itemToToolResults(notification.item)
    for (const entry of resultEntries) {
      pendingTurn.queue.push({ type: "transcript", entry })
      if (notification.item.type === "webSearch" && entry.kind === "tool_result" && !entry.isError) {
        pendingTurn.pendingWebSearchResultToolId = notification.item.id
      }
    }
  }

  private handlePlanUpdated(pendingTurn: PendingTurn, notification: TurnPlanUpdatedNotification) {
    pendingTurn.latestPlanExplanation = notification.explanation ?? null
    pendingTurn.latestPlanSteps = notification.plan
    if (notification.plan.length === 0) {
      return
    }
    pendingTurn.todoSequence += 1
    pendingTurn.queue.push({
      type: "transcript",
      entry: todoToolCall(
        `${notification.turnId}:todo-${pendingTurn.todoSequence}`,
        notification.plan
      ),
    })
  }

  private handlePlanDelta(pendingTurn: PendingTurn, notification: PlanDeltaNotification) {
    const current = pendingTurn.planTextByItemId.get(notification.itemId) ?? ""
    const next = `${current}${notification.delta}`
    pendingTurn.planTextByItemId.set(notification.itemId, next)
    pendingTurn.latestPlanText = next
  }

  private handleContextCompacted(pendingTurn: PendingTurn, _notification: ContextCompactedNotification) {
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({ kind: "compact_boundary" }),
    })
  }

  private handleTokenUsageUpdated(
    pendingTurn: PendingTurn,
    notification: ThreadTokenUsageUpdatedNotification,
  ) {
    const usage = normalizeCodexTokenUsage(notification)
    if (!usage) {
      return
    }

    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "context_window_updated",
        usage,
      }),
    })
  }

  private async handleTurnCompleted(context: SessionContext, notification: TurnCompletedNotification) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return
    const status = notification.turn.status
    const isCancelled = status === "interrupted"
    const isError = status === "failed"
    pendingTurn.pendingWebSearchResultToolId = null

    if (!isCancelled && !isError && pendingTurn.planMode) {
      const planText = pendingTurn.latestPlanText?.trim()
        || renderPlanMarkdownFromSteps(pendingTurn.latestPlanSteps).trim()

      if (planText) {
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
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_call",
            tool,
          }),
        })
        await pendingTurn.onToolRequest({ tool })
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
        return
      }
    }

    pendingTurn.resolved = true
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: isCancelled ? "cancelled" : isError ? "error" : "success",
        isError,
        durationMs: 0,
        result: notification.turn.error?.message ?? "",
      }),
    })
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  private failContext(context: SessionContext, message: string) {
    const pendingTurn = context.pendingTurn
    if (pendingTurn && !pendingTurn.resolved) {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        }),
      })
      pendingTurn.queue.finish()
      context.pendingTurn = null
    }

    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error(message))
    }
    context.pendingRequests.clear()
    context.closed = true
  }

  private async sendRequest<TResult>(context: SessionContext, method: string, params: unknown): Promise<TResult> {
    const id = randomUUID()
    const promise = new Promise<TResult>((resolve, reject) => {
      context.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    this.writeMessage(context, {
      id,
      method,
      params,
    })
    return await promise
  }

  private writeMessage(context: SessionContext, message: Record<string, unknown>) {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

import { randomUUID } from "node:crypto"
import type { NormalizedToolCall, TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

type AcpToolCallUpdate = {
  toolCallId: string
  title?: string | null
  kind?: string | null
  locations?: Array<{ path?: string | null }> | null
  content?: Array<Record<string, unknown>> | null
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function stringifyJson(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function parseJsonLine(line: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcMessage
    if (parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0") {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message)
}

export function inferToolNameFromUpdate(toolCall: {
  title?: string | null
  kind?: string | null
  locations?: Array<{ path?: string | null }> | null
  content?: Array<Record<string, unknown>> | null
}) {
  const title = (toolCall.title ?? "").toLowerCase()
  if (title.startsWith("asking user:")) return "AskUserQuestion"
  if (title.startsWith("requesting plan approval for:")) return "ExitPlanMode"
  if (title === "create plan" || title.startsWith("create plan:")) return "ExitPlanMode"
  if (title === "plan" || title.startsWith("plan:")) return "ExitPlanMode"
  if (title === "update todos" || title.startsWith("update todos:")) return "TodoWrite"

  switch (toolCall.kind) {
    case "read":
      return "Read"
    case "edit": {
      const firstDiff = toolCall.content?.find((entry) => entry.type === "diff")
      const oldText = typeof firstDiff?.oldText === "string" ? firstDiff.oldText : null
      const newText = typeof firstDiff?.newText === "string" ? firstDiff.newText : null
      if (!oldText && newText) return "Write"
      return "Edit"
    }
    case "delete":
      return "Edit"
    case "move":
      return "Edit"
    case "search":
      return title.includes("web") ? "WebSearch" : "Grep"
    case "execute":
      return "Bash"
    case "fetch":
      return title.includes("web") ? "WebFetch" : "Read"
    case "switch_mode":
      return "ExitPlanMode"
    default:
      if (toolCall.locations?.[0]?.path) return "Read"
      return "Tool"
  }
}

export function inferToolInput(toolName: string, toolCall: {
  title?: string | null
  locations?: Array<{ path?: string | null }> | null
  content?: Array<Record<string, unknown>> | null
}) {
  const firstLocationPath = typeof toolCall.locations?.[0]?.path === "string"
    ? toolCall.locations[0].path
    : undefined

  if (toolName === "AskUserQuestion") {
    const questionText = (toolCall.title ?? "Agent requested user input").replace(/^Asking user:\s*/i, "").trim()
    return {
      questions: [{ question: questionText || "Agent requested user input." }],
    }
  }

  if (toolName === "ExitPlanMode") {
    const planPath = (toolCall.title ?? "")
      .replace(/^Requesting plan approval for:\s*/i, "")
      .replace(/^Create plan:?\s*/i, "")
      .replace(/^Plan:?\s*/i, "")
      .trim()
    return {
      summary: planPath || undefined,
    }
  }

  if (toolName === "TodoWrite") {
    return {
      todos: [],
    }
  }

  if (toolName === "Read") {
    return { file_path: firstLocationPath ?? "" }
  }

  if (toolName === "Write" || toolName === "Edit") {
    const firstDiff = toolCall.content?.find((entry) => entry.type === "diff")
    const diffPath = typeof firstDiff?.path === "string" ? firstDiff.path : firstLocationPath ?? ""
    return {
      file_path: diffPath,
      old_string: typeof firstDiff?.oldText === "string" ? firstDiff.oldText : "",
      new_string: typeof firstDiff?.newText === "string" ? firstDiff.newText : "",
      content: typeof firstDiff?.newText === "string" ? firstDiff.newText : "",
    }
  }

  if (toolName === "Bash") {
    return {
      command: typeof toolCall.title === "string" ? toolCall.title : "",
    }
  }

  if (toolName === "WebSearch") {
    return {
      query: typeof toolCall.title === "string" ? toolCall.title : "",
    }
  }

  if (toolName === "WebFetch") {
    return {
      file_path: firstLocationPath ?? "",
    }
  }

  return {
    payload: {
      title: toolCall.title ?? undefined,
      locations: toolCall.locations ?? [],
      content: toolCall.content ?? [],
    },
  }
}

export function normalizeAcpToolCall(toolCall: AcpToolCallUpdate): NormalizedToolCall {
  const toolName = inferToolNameFromUpdate(toolCall)
  const input = inferToolInput(toolName, toolCall)
  return normalizeToolCall({
    toolName,
    toolId: toolCall.toolCallId,
    input,
  })
}

export function populateExitPlanFromAssistantText(
  tool: NormalizedToolCall,
  assistantText: string | null | undefined
): NormalizedToolCall {
  if (tool.toolKind !== "exit_plan_mode" || tool.input.plan) {
    return tool
  }

  const plan = assistantText?.trim()
  if (!plan) return tool

  return normalizeToolCall({
    toolName: "ExitPlanMode",
    toolId: tool.toolId,
    input: {
      plan,
      summary: tool.input.summary,
    },
  })
}

export function stringifyToolCallContent(content: Array<Record<string, unknown>> | null | undefined) {
  if (!content?.length) return ""
  return content.map((entry) => {
    if (entry.type === "content") {
      const inner = asRecord(entry.content)
      if (typeof inner?.text === "string") return inner.text
    }
    if (entry.type === "diff") {
      const path = typeof entry.path === "string" ? entry.path : "unknown"
      return `Updated ${path}`
    }
    return stringifyJson(entry)
  }).filter(Boolean).join("\n\n")
}

export function createResultEntry(result: { stopReason?: unknown }): TranscriptEntry {
  const stopReason = typeof result.stopReason === "string" ? result.stopReason : "end_turn"
  if (stopReason === "cancelled") {
    return timestamped({
      kind: "result",
      subtype: "cancelled",
      isError: false,
      durationMs: 0,
      result: "",
    })
  }

  return timestamped({
    kind: "result",
    subtype: "success",
    isError: false,
    durationMs: 0,
    result: "",
  })
}

export class AsyncQueue<T> implements AsyncIterable<T> {
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
      this.resolvers.shift()?.({ value: undefined as T, done: true })
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

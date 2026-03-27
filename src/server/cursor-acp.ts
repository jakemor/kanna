import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { NormalizedToolCall } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  AsyncQueue,
  asRecord,
  createResultEntry,
  errorMessage,
  isJsonRpcResponse,
  normalizeAcpToolCall,
  parseJsonLine,
  populateExitPlanFromAssistantText,
  stringifyToolCallContent,
  timestamped,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PendingRequest,
} from "./acp-shared"

interface CursorSessionContext {
  chatId: string
  cwd: string
  child: ChildProcess
  pendingRequests: Map<JsonRpcId, PendingRequest<unknown>>
  sessionId: string | null
  initialized: boolean
  loadedSessionId: string | null
  currentModel: string | null
  currentPlanMode: boolean | null
  pendingTurn: PendingCursorTurn | null
  stderrLines: string[]
  nextRequestId: number
  closed: boolean
}

interface PendingCursorTurn {
  queue: AsyncQueue<HarnessEvent>
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  pendingPermissionRequestId: JsonRpcId | null
  replayMode: boolean
  replayDrainTimer: ReturnType<typeof setTimeout> | null
  replayDrainPromise: Promise<void> | null
  replayDrainResolve: (() => void) | null
  toolCalls: Map<string, NormalizedToolCall>
  currentTodos: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }>
  assistantText: string
  resultEmitted: boolean
}

export interface StartCursorTurnArgs {
  chatId: string
  content: string
  localPath: string
  model: string
  planMode: boolean
  sessionToken: string | null
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
}

function shouldRespawnContext(context: CursorSessionContext, args: StartCursorTurnArgs) {
  return context.cwd !== args.localPath
}

function modeIdFromPlanMode(planMode: boolean) {
  return planMode ? "plan" : "agent"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function prepareCursorPrompt(content: string, planMode: boolean) {
  if (!planMode) return content

  return [
    "You are already in Cursor architect mode.",
    "Do not implement code changes while plan mode is active.",
    "Research the codebase, produce a concrete implementation plan, then call exit_plan_mode to request user approval before making changes.",
    "",
    content,
  ].join("\n")
}

function isPlanModeMutationTool(tool: NormalizedToolCall) {
  return (
    tool.toolKind === "write_file" ||
    tool.toolKind === "edit_file" ||
    tool.toolKind === "bash" ||
    tool.toolKind === "mcp_generic" ||
    tool.toolKind === "subagent_task" ||
    tool.toolKind === "unknown_tool"
  )
}

function clearReplayDrainTimer(turn: PendingCursorTurn) {
  if (!turn.replayDrainTimer) return
  clearTimeout(turn.replayDrainTimer)
  turn.replayDrainTimer = null
}

function scheduleReplayDrain(turn: PendingCursorTurn) {
  clearReplayDrainTimer(turn)
  turn.replayDrainTimer = setTimeout(() => {
    turn.replayMode = false
    turn.replayDrainResolve?.()
    turn.replayDrainResolve = null
    turn.replayDrainPromise = null
    turn.replayDrainTimer = null
  }, 150)
}

function mergeCursorTodos(
  previous: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }>,
  incoming: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }>,
  merge: boolean
) {
  if (!merge) return incoming

  const next = [...previous]
  const indexById = new Map(next.map((todo, index) => [todo.id, index]))

  for (const todo of incoming) {
    const existingIndex = indexById.get(todo.id)
    if (existingIndex === undefined) {
      indexById.set(todo.id, next.length)
      next.push(todo)
      continue
    }
    next[existingIndex] = todo
  }

  return next
}

export class CursorAcpManager {
  private readonly contexts = new Map<string, CursorSessionContext>()

  async startTurn(args: StartCursorTurnArgs): Promise<HarnessTurn> {
    let context = this.contexts.get(args.chatId)
    if (context && shouldRespawnContext(context, args)) {
      await this.disposeContext(context)
      context = undefined
      this.contexts.delete(args.chatId)
    }

    if (!context) {
      context = await this.createContext(args)
      this.contexts.set(args.chatId, context)
    }

    const queue = new AsyncQueue<HarnessEvent>()
    const pendingTurn: PendingCursorTurn = {
      queue,
      onToolRequest: args.onToolRequest,
      pendingPermissionRequestId: null,
      replayMode: false,
      replayDrainTimer: null,
      replayDrainPromise: null,
      replayDrainResolve: null,
      toolCalls: new Map(),
      currentTodos: [],
      assistantText: "",
      resultEmitted: false,
    }
    context.pendingTurn = pendingTurn

    try {
      await this.ensureSession(context, args)
      queue.push({ type: "session_token", sessionToken: context.sessionId ?? undefined })
      queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "system_init",
          provider: "cursor",
          model: args.model,
          tools: [],
          agents: [],
          slashCommands: [],
          mcpServers: [],
        }),
      })

      if (context.currentModel !== args.model) {
        await this.request(context, "session/set_model", {
          sessionId: context.sessionId,
          modelId: args.model,
        })
        context.currentModel = args.model
      }

      const desiredMode = modeIdFromPlanMode(args.planMode)
      if (context.currentPlanMode !== args.planMode) {
        await this.request(context, "session/set_mode", {
          sessionId: context.sessionId,
          modeId: desiredMode,
        })
        context.currentPlanMode = args.planMode
        await sleep(75)
      }

      const promptPromise = this.request<{ stopReason?: unknown }>(context, "session/prompt", {
        sessionId: context.sessionId,
        prompt: [
          {
            type: "text",
            text: prepareCursorPrompt(args.content, args.planMode),
          },
        ],
      })

      void promptPromise
        .then((result) => {
          if (pendingTurn.resultEmitted) return
          pendingTurn.resultEmitted = true
          pendingTurn.queue.push({
            type: "transcript",
            entry: createResultEntry(result),
          })
          pendingTurn.queue.finish()
        })
        .catch((error) => {
          if (pendingTurn.resultEmitted) return
          pendingTurn.resultEmitted = true
          pendingTurn.queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: errorMessage(error),
            }),
          })
          pendingTurn.queue.finish()
        })
    } catch (error) {
      context.pendingTurn = null
      queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: errorMessage(error),
        }),
      })
      queue.finish()
    }

    return {
      provider: "cursor",
      stream: queue,
      interrupt: async () => {
        if (!context?.sessionId) return
        try {
          await this.notify(context, "session/cancel", { sessionId: context.sessionId })
        } catch {
          if (!context.child.killed) {
            context.child.kill("SIGINT")
          }
        }
      },
      close: () => {
        if (context?.pendingTurn === pendingTurn) {
          context.pendingTurn = null
        }
      },
    }
  }

  stopAll() {
    for (const context of this.contexts.values()) {
      void this.disposeContext(context)
    }
    this.contexts.clear()
  }

  private async createContext(args: StartCursorTurnArgs) {
    const child = spawn("agent", ["acp"], {
      cwd: args.localPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })

    const context: CursorSessionContext = {
      chatId: args.chatId,
      cwd: args.localPath,
      child,
      pendingRequests: new Map(),
      sessionId: null,
      initialized: false,
      loadedSessionId: null,
      currentModel: null,
      currentPlanMode: null,
      pendingTurn: null,
      stderrLines: [],
      nextRequestId: 1,
      closed: false,
    }

    const stdout = child.stdout
    if (!stdout) throw new Error("Cursor ACP stdout is unavailable")

    const rl = createInterface({ input: stdout })
    rl.on("line", (line) => {
      const message = parseJsonLine(line)
      if (!message) return
      void this.handleMessage(context, message)
    })

    const stderr = child.stderr
    if (stderr) {
      const stderrRl = createInterface({ input: stderr })
      stderrRl.on("line", (line) => {
        context.stderrLines.push(line)
        const turn = context.pendingTurn
        if (!turn || !line.trim()) return
        turn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "status",
            status: line.trim(),
          }),
        })
      })
    }

    child.on("close", (code) => {
      context.closed = true
      for (const pending of context.pendingRequests.values()) {
        pending.reject(new Error(`Cursor ACP exited with code ${code ?? "unknown"}`))
      }
      context.pendingRequests.clear()

      const turn = context.pendingTurn
      if (turn && !turn.resultEmitted) {
        turn.resultEmitted = true
        turn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: context.stderrLines.join("\n").trim() || `Cursor ACP exited with code ${code ?? "unknown"}`,
          }),
        })
        turn.queue.finish()
      }
    })

    child.on("error", (error) => {
      const turn = context.pendingTurn
      if (!turn || turn.resultEmitted) return
      turn.resultEmitted = true
      turn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: error.message.includes("ENOENT")
            ? "Cursor Agent CLI not found. Install Cursor and ensure the `agent` command is on your PATH."
            : `Cursor ACP error: ${error.message}`,
        }),
      })
      turn.queue.finish()
    })

    await this.request(context, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    context.initialized = true

    return context
  }

  private async ensureSession(context: CursorSessionContext, args: StartCursorTurnArgs) {
    if (args.sessionToken) {
      if (context.loadedSessionId === args.sessionToken && context.sessionId === args.sessionToken) {
        return
      }

      context.sessionId = args.sessionToken
      context.loadedSessionId = args.sessionToken
      const turn = context.pendingTurn
      if (turn) {
        turn.replayMode = true
        turn.replayDrainPromise = new Promise<void>((resolve) => {
          turn.replayDrainResolve = resolve
        })
      }

      await this.request(context, "session/load", {
        sessionId: args.sessionToken,
        cwd: args.localPath,
        mcpServers: [],
      })

      if (turn?.replayDrainPromise) {
        scheduleReplayDrain(turn)
        await turn.replayDrainPromise
      }
      return
    }

    if (context.sessionId) return

    const result = await this.request<{ sessionId: string }>(context, "session/new", {
      cwd: args.localPath,
      mcpServers: [],
    })
    context.sessionId = typeof result.sessionId === "string" ? result.sessionId : null
  }

  private async handleMessage(context: CursorSessionContext, message: JsonRpcMessage) {
    if (isJsonRpcResponse(message)) {
      const pending = context.pendingRequests.get(message.id)
      if (!pending) return
      context.pendingRequests.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if ("id" in message && message.method === "session/request_permission") {
      await this.handlePermissionRequest(context, message)
      return
    }

    if ("id" in message && message.method === "cursor/create_plan") {
      await this.handleCreatePlanRequest(context, message)
      return
    }

    if ("id" in message && message.method === "cursor/update_todos") {
      await this.handleUpdateTodosRequest(context, message)
      return
    }

    if (message.method === "session/update") {
      await this.handleSessionUpdate(context, asRecord(message.params))
    }
  }

  private async handleCreatePlanRequest(context: CursorSessionContext, message: JsonRpcRequest) {
    const params = asRecord(message.params)
    const toolCallId = typeof params?.toolCallId === "string" ? params.toolCallId : randomUUID()
    const turn = context.pendingTurn

    if (!turn) {
      await this.respondToPermissionRequest(context, message.id, {})
      return
    }

    const explicitPlan = typeof params?.plan === "string" ? params.plan : undefined
    const normalizedTool = normalizeToolCall({
      toolName: "ExitPlanMode",
      toolId: toolCallId,
      input: {
        plan: explicitPlan ?? (turn.assistantText.trim() || undefined),
        summary: typeof params?.overview === "string"
          ? params.overview
          : typeof params?.name === "string"
            ? params.name
            : undefined,
        source: "cursor/create_plan",
      },
    })

    turn.toolCalls.set(normalizedTool.toolId, normalizedTool)
    turn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_call",
        tool: normalizedTool,
      }),
    })

    const rawResult = await turn.onToolRequest({
      tool: normalizedTool as HarnessToolRequest["tool"],
    })

    turn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_result",
        toolId: normalizedTool.toolId,
        content: rawResult && typeof rawResult === "object" ? rawResult as Record<string, unknown> : {},
      }),
    })

    await this.respondToPermissionRequest(context, message.id, {})
  }

  private async handleUpdateTodosRequest(context: CursorSessionContext, message: JsonRpcRequest) {
    const params = asRecord(message.params)
    const turn = context.pendingTurn
    if (!turn) {
      await this.respondToPermissionRequest(context, message.id, {})
      return
    }

    const incomingTodos = Array.isArray(params?.todos)
      ? params.todos
          .map((todo) => {
            const record = asRecord(todo)
            const content = typeof record?.content === "string" ? record.content.trim() : ""
            const status = record?.status
            if (!content) return null
            if (status !== "pending" && status !== "in_progress" && status !== "completed") return null
            return {
              id: typeof record?.id === "string" ? record.id : randomUUID(),
              content,
              status,
            } satisfies { id: string; content: string; status: "pending" | "in_progress" | "completed" }
          })
          .filter((todo): todo is { id: string; content: string; status: "pending" | "in_progress" | "completed" } => Boolean(todo))
      : []

    const mergedTodos = mergeCursorTodos(turn.currentTodos, incomingTodos, Boolean(params?.merge))
    turn.currentTodos = mergedTodos

    const todoTool = normalizeToolCall({
      toolName: "TodoWrite",
      toolId: typeof params?.toolCallId === "string" ? params.toolCallId : randomUUID(),
      input: {
        todos: mergedTodos.map((todo) => ({
          content: todo.content,
          status: todo.status,
          activeForm: todo.content,
        })),
      },
    })

    turn.toolCalls.set(todoTool.toolId, todoTool)
    turn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_call",
        tool: todoTool,
      }),
    })

    await this.respondToPermissionRequest(context, message.id, {})
  }

  private async handlePermissionRequest(context: CursorSessionContext, message: JsonRpcRequest) {
    const params = asRecord(message.params)
    const toolCall = asRecord(params?.toolCall)
    const toolCallId = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : randomUUID()
    let normalizedTool = normalizeAcpToolCall({
      toolCallId,
      title: typeof toolCall?.title === "string" ? toolCall.title : undefined,
      kind: typeof toolCall?.kind === "string" ? toolCall.kind : undefined,
      locations: Array.isArray(toolCall?.locations) ? toolCall.locations as Array<{ path?: string | null }> : undefined,
      content: Array.isArray(toolCall?.content) ? toolCall.content as Array<Record<string, unknown>> : undefined,
    })

    const turn = context.pendingTurn
    if (!turn) {
      await this.respondToPermissionRequest(context, message.id, { outcome: { outcome: "cancelled" } })
      return
    }

    normalizedTool = populateExitPlanFromAssistantText(normalizedTool, turn.assistantText)

    turn.toolCalls.set(normalizedTool.toolId, normalizedTool)
    turn.pendingPermissionRequestId = message.id
    turn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_call",
        tool: normalizedTool,
      }),
    })

    if (context.currentPlanMode && isPlanModeMutationTool(normalizedTool)) {
      turn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: normalizedTool.toolId,
          content: "Blocked by Kanna: Cursor cannot implement changes while plan mode is active. Finish the plan, then call exit_plan_mode and wait for user approval.",
          isError: true,
        }),
      })
      await this.respondToPermissionRequest(context, message.id, { outcome: { outcome: "cancelled" } })
      turn.pendingPermissionRequestId = null
      return
    }

    if (normalizedTool.toolKind !== "ask_user_question" && normalizedTool.toolKind !== "exit_plan_mode") {
      await this.respondToPermissionRequest(context, message.id, {
        outcome: {
          outcome: "selected",
          optionId: this.defaultAllowOptionId(params),
        },
      })
      turn.pendingPermissionRequestId = null
      return
    }

    const rawResult = await turn.onToolRequest({
      tool: normalizedTool as HarnessToolRequest["tool"],
    })

    const structuredResult = normalizedTool.toolKind === "exit_plan_mode"
      ? rawResult && typeof rawResult === "object"
        ? rawResult as Record<string, unknown>
        : {}
      : { answers: {} }

    turn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_result",
        toolId: normalizedTool.toolId,
        content: structuredResult,
      }),
    })

    const confirmed = normalizedTool.toolKind === "exit_plan_mode"
      ? Boolean((structuredResult as Record<string, unknown>).confirmed)
      : true

    await this.respondToPermissionRequest(context, message.id, confirmed
      ? {
          outcome: {
            outcome: "selected",
            optionId: this.defaultAllowOptionId(params),
          },
        }
      : { outcome: { outcome: "cancelled" } })

    turn.pendingPermissionRequestId = null
  }

  private defaultAllowOptionId(params: Record<string, unknown> | null) {
    const options = Array.isArray(params?.options) ? params.options : []
    const allowOption = options.find((option) => {
      const record = asRecord(option)
      return record?.kind === "allow_once" && typeof record.optionId === "string"
    })
    if (allowOption && typeof (allowOption as Record<string, unknown>).optionId === "string") {
      return (allowOption as Record<string, unknown>).optionId as string
    }
    const firstOptionId = asRecord(options[0])?.optionId
    if (typeof firstOptionId === "string") return firstOptionId
    return "allow_once"
  }

  private async respondToPermissionRequest(context: CursorSessionContext, id: JsonRpcId, result: unknown) {
    await this.writeMessage(context, {
      jsonrpc: "2.0",
      id,
      result,
    } satisfies JsonRpcResponse)
  }

  private async handleSessionUpdate(context: CursorSessionContext, params: Record<string, unknown> | null) {
    const turn = context.pendingTurn
    if (!turn) return

    const update = asRecord(params?.update)
    if (!update) return

    const sessionUpdate = update.sessionUpdate
    if (typeof sessionUpdate !== "string") return

    if (turn.replayMode) {
      scheduleReplayDrain(turn)
      return
    }

    if (sessionUpdate === "agent_message_chunk") {
      const content = asRecord(update.content)
      if (content?.type === "text" && typeof content.text === "string") {
        turn.assistantText += content.text
        turn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "assistant_text",
            text: content.text,
          }),
        })
      }
      return
    }

    if (sessionUpdate === "agent_thought_chunk") {
      const content = asRecord(update.content)
      if (content?.type === "text" && typeof content.text === "string") {
        turn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "assistant_thought",
            text: content.text,
          }),
        })
      }
      return
    }

    if (sessionUpdate === "tool_call") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : randomUUID()
      const normalizedTool = normalizeAcpToolCall({
        toolCallId,
        title: typeof update.title === "string" ? update.title : undefined,
        kind: typeof update.kind === "string" ? update.kind : undefined,
        locations: Array.isArray(update.locations) ? update.locations as Array<{ path?: string | null }> : undefined,
        content: Array.isArray(update.content) ? update.content as Array<Record<string, unknown>> : undefined,
      })
      if (
        normalizedTool.toolKind === "ask_user_question" ||
        normalizedTool.toolKind === "exit_plan_mode" ||
        normalizedTool.toolKind === "todo_write"
      ) {
        turn.toolCalls.set(toolCallId, normalizedTool)
        return
      }
      turn.toolCalls.set(toolCallId, normalizedTool)
      turn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: normalizedTool,
        }),
      })
      return
    }

    if (sessionUpdate === "tool_call_update") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : randomUUID()
      const content = Array.isArray(update.content) ? update.content as Array<Record<string, unknown>> : undefined
      const status = typeof update.status === "string" ? update.status : undefined
      const normalizedTool = turn.toolCalls.get(toolCallId)
      if (status === "completed" || status === "failed") {
        if (normalizedTool?.toolKind === "ask_user_question" || normalizedTool?.toolKind === "exit_plan_mode") {
          return
        }
        turn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_result",
            toolId: toolCallId,
            content: stringifyToolCallContent(content),
            isError: status === "failed",
          }),
        })
      }
    }
  }

  private async request<TResult>(context: CursorSessionContext, method: string, params?: unknown): Promise<TResult> {
    const id = context.nextRequestId++
    const promise = new Promise<TResult>((resolve, reject) => {
      context.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    await this.writeMessage(context, {
      jsonrpc: "2.0",
      id,
      method,
      params,
    } satisfies JsonRpcRequest)
    return await promise
  }

  private async notify(context: CursorSessionContext, method: string, params?: unknown) {
    await this.writeMessage(context, {
      jsonrpc: "2.0",
      method,
      params,
    } satisfies JsonRpcNotification)
  }

  private async writeMessage(context: CursorSessionContext, message: JsonRpcMessage) {
    if (!context.child.stdin || context.child.stdin.destroyed) {
      throw new Error("Cursor ACP stdin is unavailable")
    }
    await new Promise<void>((resolve, reject) => {
      context.child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private async disposeContext(context: CursorSessionContext) {
    context.closed = true
    context.pendingTurn = null
    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error("Cursor ACP context disposed"))
    }
    context.pendingRequests.clear()
    if (!context.child.killed) {
      context.child.kill("SIGTERM")
    }
  }
}

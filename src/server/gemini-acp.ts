import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import type { GeminiThinkingMode, NormalizedToolCall, TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"

type JsonRpcId = string | number

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

interface GeminiSessionContext {
  chatId: string
  cwd: string
  child: ChildProcess
  settingsPath: string
  pendingRequests: Map<JsonRpcId, PendingRequest<unknown>>
  sessionId: string | null
  initialized: boolean
  loadedSessionId: string | null
  currentModel: string | null
  currentPlanMode: boolean | null
  currentThinkingMode: GeminiThinkingMode | null
  pendingTurn: PendingGeminiTurn | null
  stderrLines: string[]
  nextRequestId: number
  closed: boolean
}

interface PendingGeminiTurn {
  queue: AsyncQueue<HarnessEvent>
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  pendingPermissionRequestId: JsonRpcId | null
  replayMode: boolean
  replayDrainTimer: ReturnType<typeof setTimeout> | null
  replayDrainPromise: Promise<void> | null
  replayDrainResolve: (() => void) | null
  toolCalls: Map<string, NormalizedToolCall>
  resultEmitted: boolean
}

export interface StartGeminiTurnArgs {
  chatId: string
  content: string
  localPath: string
  model: string
  thinkingMode: GeminiThinkingMode
  planMode: boolean
  sessionToken: string | null
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
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

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function stringifyJson(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseJsonLine(line: string): JsonRpcMessage | null {
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

function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message)
}

function shouldRespawnContext(context: GeminiSessionContext, args: StartGeminiTurnArgs) {
  return (
    context.cwd !== args.localPath ||
    context.currentThinkingMode !== args.thinkingMode
  )
}

function modeIdFromPlanMode(planMode: boolean) {
  return planMode ? "plan" : "yolo"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createThinkingSettings(thinkingMode: GeminiThinkingMode, model: string) {
  const isGemini3 = model.startsWith("gemini-3") || model === "auto-gemini-3"
  const modelConfigs: Record<string, unknown> = {
    customOverrides: [],
  }

  if (!isGemini3) {
    const thinkingBudget = thinkingMode === "off"
      ? 0
      : thinkingMode === "high"
        ? 16384
        : null

    if (thinkingBudget !== null) {
      modelConfigs.customOverrides = [
        {
          match: { model },
          modelConfig: {
            generateContentConfig: {
              thinkingConfig: {
                thinkingBudget,
              },
            },
          },
        },
      ]
    }
  }

  return {
    agents: {
      overrides: {
        codebase_investigator: {
          enabled: false,
        },
      },
    },
    modelConfigs,
  }
}

function inferToolNameFromUpdate(toolCall: {
  title?: string | null
  kind?: string | null
  locations?: Array<{ path?: string | null }> | null
  content?: Array<Record<string, unknown>> | null
}) {
  const title = (toolCall.title ?? "").toLowerCase()
  if (title.startsWith("asking user:")) return "AskUserQuestion"
  if (title.startsWith("requesting plan approval for:")) return "ExitPlanMode"

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

function inferToolInput(toolName: string, toolCall: {
  title?: string | null
  locations?: Array<{ path?: string | null }> | null
  content?: Array<Record<string, unknown>> | null
}) {
  const firstLocationPath = typeof toolCall.locations?.[0]?.path === "string"
    ? toolCall.locations[0].path
    : undefined

  if (toolName === "AskUserQuestion") {
    const questionText = (toolCall.title ?? "Gemini requested user input").replace(/^Asking user:\s*/i, "").trim()
    return {
      questions: [{ question: questionText || "Gemini requested user input." }],
    }
  }

  if (toolName === "ExitPlanMode") {
    const planPath = (toolCall.title ?? "").replace(/^Requesting plan approval for:\s*/i, "").trim()
    return {
      summary: planPath || undefined,
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

function extractExitPlanPath(title: string | null | undefined) {
  const planPath = (title ?? "").replace(/^Requesting plan approval for:\s*/i, "").trim()
  return planPath || null
}

async function resolveGeminiPlanPath(sessionId: string | null, title: string | null | undefined) {
  const explicitPlanPath = extractExitPlanPath(title)
  if (explicitPlanPath) return explicitPlanPath
  if (!sessionId) return null

  const plansDir = join(homedir(), ".gemini", "tmp", "kanna", sessionId, "plans")
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true })
    const markdownEntries = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)

    if (markdownEntries.length === 0) return null

    const withStats = await Promise.all(markdownEntries.map(async (name) => {
      const path = join(plansDir, name)
      const stats = await fs.stat(path)
      return { path, mtimeMs: stats.mtimeMs }
    }))

    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return withStats[0]?.path ?? null
  } catch {
    return null
  }
}

async function resolvePlanPathFromDirectories(planDirectories: string[]) {
  for (const plansDir of planDirectories) {
    try {
      const entries = await fs.readdir(plansDir, { withFileTypes: true })
      const markdownEntries = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)

      if (markdownEntries.length === 0) continue

      const withStats = await Promise.all(markdownEntries.map(async (name) => {
        const path = join(plansDir, name)
        const stats = await fs.stat(path)
        return { path, mtimeMs: stats.mtimeMs }
      }))

      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
      if (withStats[0]?.path) return withStats[0].path
    } catch {
      continue
    }
  }

  return null
}

async function enrichGeminiToolCall(
  tool: NormalizedToolCall,
  title: string | null | undefined,
  sessionId: string | null
) {
  if (tool.toolKind !== "exit_plan_mode" || tool.input.plan) {
    return tool
  }

  const planPath = await resolveGeminiPlanPath(sessionId, title)
    ?? await resolvePlanPathFromDirectories(
      sessionId ? [join(homedir(), ".gemini", "tmp", "kanna", sessionId, "plans")] : []
    )
  if (!planPath) return tool

  try {
    const plan = await fs.readFile(planPath, "utf8")
    return normalizeToolCall({
      toolName: "ExitPlanMode",
      toolId: tool.toolId,
      input: {
        plan,
        summary: planPath,
      },
    })
  } catch {
    return tool
  }
}

function normalizeAcpToolCall(toolCall: {
  toolCallId: string
  title?: string | null
  kind?: string | null
  locations?: Array<{ path?: string | null }> | null
  content?: Array<Record<string, unknown>> | null
}): NormalizedToolCall {
  const toolName = inferToolNameFromUpdate(toolCall)
  const input = inferToolInput(toolName, toolCall)
  return normalizeToolCall({
    toolName,
    toolId: toolCall.toolCallId,
    input,
  })
}

function stringifyToolCallContent(content: Array<Record<string, unknown>> | null | undefined) {
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

function prepareGeminiPrompt(content: string, planMode: boolean) {
  if (!planMode) return content

  return [
    "You are already in Gemini CLI Plan Mode.",
    "Do not claim that enter_plan_mode is unavailable as a blocker.",
    "Research the codebase, write the plan as a Markdown file in the designated Gemini plans directory, then call exit_plan_mode to request user approval.",
    "Do not edit source files, do not implement the plan, and do not proceed past planning until the user explicitly approves the exit_plan_mode request.",
    "",
    content,
  ].join("\n")
}

function isGeminiSessionPlanFile(filePath: string, cwd: string, sessionId: string | null) {
  if (!sessionId || !filePath) return false
  const resolvedPath = resolve(cwd, filePath)
  const plansDir = join(homedir(), ".gemini", "tmp", "kanna", sessionId, "plans")
  return resolvedPath.startsWith(`${plansDir}/`) && resolvedPath.endsWith(".md")
}

function isPlanModeMutationTool(tool: NormalizedToolCall, cwd: string, sessionId: string | null) {
  if (tool.toolKind === "write_file") {
    return !isGeminiSessionPlanFile(tool.input.filePath, cwd, sessionId)
  }

  if (tool.toolKind === "edit_file") {
    return !isGeminiSessionPlanFile(tool.input.filePath, cwd, sessionId)
  }

  return (
    tool.toolKind === "bash" ||
    tool.toolKind === "mcp_generic" ||
    tool.toolKind === "subagent_task" ||
    tool.toolKind === "unknown_tool"
  )
}

function createResultEntry(result: { stopReason?: unknown }): TranscriptEntry {
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

function clearReplayDrainTimer(turn: PendingGeminiTurn) {
  if (!turn.replayDrainTimer) return
  clearTimeout(turn.replayDrainTimer)
  turn.replayDrainTimer = null
}

function scheduleReplayDrain(turn: PendingGeminiTurn) {
  clearReplayDrainTimer(turn)
  turn.replayDrainTimer = setTimeout(() => {
    turn.replayMode = false
    turn.replayDrainResolve?.()
    turn.replayDrainResolve = null
    turn.replayDrainPromise = null
    turn.replayDrainTimer = null
  }, 150)
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

export class GeminiAcpManager {
  private readonly contexts = new Map<string, GeminiSessionContext>()

  async startTurn(args: StartGeminiTurnArgs): Promise<HarnessTurn> {
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
    const pendingTurn: PendingGeminiTurn = {
      queue,
      onToolRequest: args.onToolRequest,
      pendingPermissionRequestId: null,
      replayMode: false,
      replayDrainTimer: null,
      replayDrainPromise: null,
      replayDrainResolve: null,
      toolCalls: new Map(),
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
          provider: "gemini",
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
            text: prepareGeminiPrompt(args.content, args.planMode),
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
      provider: "gemini",
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

  private async createContext(args: StartGeminiTurnArgs) {
    const settingsPath = join(tmpdir(), `kanna-gemini-settings-${randomUUID()}.json`)
    await fs.writeFile(
      settingsPath,
      JSON.stringify(createThinkingSettings(args.thinkingMode, args.model))
    )

    const child = spawn("gemini", ["--acp"], {
      cwd: args.localPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
      },
    })

    const context: GeminiSessionContext = {
      chatId: args.chatId,
      cwd: args.localPath,
      child,
      settingsPath,
      pendingRequests: new Map(),
      sessionId: null,
      initialized: false,
      loadedSessionId: null,
      currentModel: null,
      currentPlanMode: null,
      currentThinkingMode: args.thinkingMode,
      pendingTurn: null,
      stderrLines: [],
      nextRequestId: 1,
      closed: false,
    }

    const stdout = child.stdout
    if (!stdout) throw new Error("Gemini ACP stdout is unavailable")

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
        pending.reject(new Error(`Gemini ACP exited with code ${code ?? "unknown"}`))
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
            result: context.stderrLines.join("\n").trim() || `Gemini ACP exited with code ${code ?? "unknown"}`,
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
            ? "Gemini CLI not found. Install it with: npm install -g @google/gemini-cli"
            : `Gemini ACP error: ${error.message}`,
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

  private async ensureSession(context: GeminiSessionContext, args: StartGeminiTurnArgs) {
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

  private async handleMessage(context: GeminiSessionContext, message: JsonRpcMessage) {
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

    if (message.method === "session/update") {
      await this.handleSessionUpdate(context, asRecord(message.params))
    }
  }

  private async handlePermissionRequest(context: GeminiSessionContext, message: JsonRpcRequest) {
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
    normalizedTool = await enrichGeminiToolCall(
      normalizedTool,
      typeof toolCall?.title === "string" ? toolCall.title : undefined,
      context.sessionId
    )

    const turn = context.pendingTurn
    if (!turn) {
      await this.respondToPermissionRequest(context, message.id, { outcome: { outcome: "cancelled" } })
      return
    }

    turn.toolCalls.set(normalizedTool.toolId, normalizedTool)
    turn.pendingPermissionRequestId = message.id
    turn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_call",
        tool: normalizedTool,
      }),
    })

    if (context.currentPlanMode && isPlanModeMutationTool(normalizedTool, context.cwd, context.sessionId)) {
      turn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: normalizedTool.toolId,
          content: "Blocked by Kanna: Gemini cannot implement changes while plan mode is active. Write the plan, then call exit_plan_mode and wait for user approval.",
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

  private async respondToPermissionRequest(context: GeminiSessionContext, id: JsonRpcId, result: unknown) {
    await this.writeMessage(context, {
      jsonrpc: "2.0",
      id,
      result,
    } satisfies JsonRpcResponse)
  }

  private async handleSessionUpdate(context: GeminiSessionContext, params: Record<string, unknown> | null) {
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
        if (
          normalizedTool?.toolKind === "ask_user_question" ||
          normalizedTool?.toolKind === "exit_plan_mode"
        ) {
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

  private async request<TResult>(context: GeminiSessionContext, method: string, params?: unknown): Promise<TResult> {
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

  private async notify(context: GeminiSessionContext, method: string, params?: unknown) {
    await this.writeMessage(context, {
      jsonrpc: "2.0",
      method,
      params,
    } satisfies JsonRpcNotification)
  }

  private async writeMessage(context: GeminiSessionContext, message: JsonRpcMessage) {
    if (!context.child.stdin || context.child.stdin.destroyed) {
      throw new Error("Gemini ACP stdin is unavailable")
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

  private async disposeContext(context: GeminiSessionContext) {
    context.closed = true
    context.pendingTurn = null
    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error("Gemini ACP context disposed"))
    }
    context.pendingRequests.clear()
    if (!context.child.killed) {
      context.child.kill("SIGTERM")
    }
    await fs.rm(context.settingsPath, { force: true })
  }
}

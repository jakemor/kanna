import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { asNumber, asRecord, asString } from "../shared/json"
import { normalizeToolCall } from "../shared/tools"
import type { ContextWindowUsageSnapshot, HarnessSkill, TranscriptEntry } from "../shared/types"
import { AsyncQueue } from "./async-queue"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { timestamped } from "./transcript"
import {
  ACP_PROTOCOL_VERSION,
  type AcpConfigOption,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpJsonRpcResponse,
  type AcpMessageChunkUpdate,
  type AcpPlanUpdate,
  type AcpPromptResult,
  type AcpRequestId,
  type AcpRequestPermissionParams,
  type AcpSessionResult,
  type AcpSessionUpdate,
  type AcpToolCallUpdate,
  type AcpUsageUpdate,
  isAcpNotification,
  isAcpResponse,
  isAcpServerRequest,
} from "./acp-protocol"

/**
 * Adapter for opencode (`opencode acp`), spoken over the Agent Client Protocol.
 *
 * Shape-wise this is the codex app-server adapter, not the cursor one: a
 * persistent per-chat child process exchanging newline-delimited JSON-RPC,
 * rather than cursor's one-process-per-turn NDJSON stream. Kanna is the ACP
 * *client*; opencode is the agent.
 *
 *   initialize                  -> protocol + capability handshake
 *   session/new | session/resume-> session id (resume survives process restarts)
 *   session/set_config_option   -> model picker + build/plan mode
 *   session/prompt              -> one turn; resolves with a stop reason
 *   session/update (notif)      -> streamed text / tool calls / usage
 *   session/cancel (notif)      -> interrupt
 *
 * Because ACP is agent-agnostic, everything here except the binary name and the
 * tool-name table is reusable for any other ACP agent (gemini-cli,
 * claude-code-acp, …) — see the spike notes before generalizing.
 *
 * Two deliberate client-capability choices:
 *   - fs.readTextFile/writeTextFile = false: opencode then does its own file IO
 *     rather than round-tripping every read through Kanna.
 *   - terminal = false: same, opencode runs its own shell.
 * Both keep Kanna a pure observer of the turn, which is what the transcript
 * model wants.
 */

interface AcpChildProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export type SpawnOpenCodeAcp = (cwd: string) => AcpChildProcess

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface PendingTurn {
  queue: AsyncQueue<HarnessEvent>
  translator: AcpTurnTranslator
  resolved: boolean
}

interface SessionContext {
  chatId: string
  cwd: string
  child: AcpChildProcess
  pendingRequests: Map<AcpRequestId, PendingRequest>
  pendingTurn: PendingTurn | null
  sessionId: string | null
  /** Latest `available_commands_update`, surfaced to the composer's "/" menu. */
  availableCommands: HarnessSkill[]
  configOptions: AcpConfigOption[]
  /** The model the session confirmed, read back from configOptions. */
  model: string | null
  stderrLines: string[]
  closed: boolean
}

export interface StartOpenCodeSessionArgs {
  chatId: string
  cwd: string
  model: string
  planMode: boolean
  sessionToken: string | null
}

export interface StartOpenCodeTurnArgs {
  chatId: string
  content: string
  model: string
}

export interface OpenCodeModelListEntry {
  id: string
  label: string
  /** From the model's `limit.context`, when `--verbose` reported it. */
  contextWindowTokens?: number
}

/**
 * Parse `opencode models --verbose`, which lists only the models the user's
 * configured providers actually expose:
 *
 *   opencode/big-pickle
 *   { "id": "big-pickle", "name": "Big Pickle", "limit": { "context": 200000 }, … }
 *
 * A bare "provider/model" line with no JSON body (plain `opencode models`) is
 * still accepted, with the label derived from the id — so the parser works
 * against either flag.
 */
export function parseOpenCodeModelList(output: string): OpenCodeModelListEntry[] {
  const entries: OpenCodeModelListEntry[] = []
  const seen = new Set<string>()
  const lines = output.split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index]!.trim()
    // A slug line: "provider/model", no whitespace, not part of a JSON body.
    if (!id || !id.includes("/") || /\s/.test(id) || id.startsWith("{") || seen.has(id)) continue
    seen.add(id)

    // A "{" on the next line opens this model's JSON body; consume to its close.
    let detail: Record<string, unknown> | null = null
    if (lines[index + 1]?.trim() === "{") {
      const body: string[] = []
      let depth = 0
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]!
        body.push(line)
        depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0)
        if (depth === 0) break
      }
      try {
        detail = asRecord(JSON.parse(body.join("\n")))
      } catch {
        detail = null
      }
      index = cursor
    }

    const name = asString(detail?.name)
    const contextWindowTokens = asNumber(asRecord(detail?.limit)?.context)
    entries.push({
      id,
      label: name || deriveOpenCodeModelLabel(id),
      ...(contextWindowTokens && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
    })
  }
  return entries
}

/**
 * Parse `opencode auth list`, whose body lists one credential per line as
 * "<Provider label> <type>" between box-drawing rules:
 *
 *   ┌  Credentials ~/.local/share/opencode/auth.json
 *   │
 *   ●  Anthropic api
 *   │
 *   └  1 credentials
 */
export function parseOpenCodeAuthList(output: string): { providers: string[] } {
  const providers: string[] = []
  for (const rawLine of stripBoxDrawing(output).split("\n")) {
    const line = rawLine.trim()
    if (!line || /^credentials\b/i.test(line) || /^\d+\s+credentials?$/i.test(line)) continue
    // "Anthropic api" -> "Anthropic"; the trailing word is the credential type.
    const name = line.replace(/\s+(api|oauth|wellknown)$/i, "").trim()
    if (name) providers.push(name)
  }
  return { providers }
}

/** Drop the CLI's ANSI colors and box-drawing gutter so lines parse plainly. */
function stripBoxDrawing(output: string): string {
  return output
    .replace(/\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/^[┌│└●◆◇▲○\s]+/gm, "")
}

export function parseOpenCodeVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

function deriveOpenCodeModelLabel(id: string): string {
  const name = id.slice(id.indexOf("/") + 1)
  return name
    .split("-")
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ")
}

/**
 * Translate an opencode tool into the Claude-style tool name + snake_case
 * argument keys `normalizeToolCall` understands, so tools render natively.
 * Mirrors translateCursorTool. The ACP `kind` ("read"/"edit"/"execute") is the
 * fallback when the name is unrecognized — e.g. MCP-provided tools.
 */
export function translateOpenCodeTool(
  rawName: string,
  kind: string | undefined,
  args: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } {
  switch (rawName.toLowerCase().replace(/[^a-z]/g, "")) {
    case "bash":
      return { toolName: "Bash", input: { command: args.command ?? "", description: args.description } }
    case "read":
      return { toolName: "Read", input: { file_path: args.filePath ?? "" } }
    case "write":
      return { toolName: "Write", input: { file_path: args.filePath ?? "", content: args.content ?? "" } }
    case "edit":
      return {
        toolName: "Edit",
        input: {
          file_path: args.filePath ?? "",
          old_string: args.oldString ?? "",
          new_string: args.newString ?? "",
        },
      }
    case "glob":
      return { toolName: "Glob", input: { pattern: args.pattern ?? "" } }
    case "grep":
      return { toolName: "Grep", input: { pattern: args.pattern ?? "" } }
    case "todowrite":
      return { toolName: "TodoWrite", input: { todos: Array.isArray(args.todos) ? args.todos : [] } }
    case "webfetch":
      return { toolName: "WebFetch", input: { url: args.url ?? "" } }
    case "task":
      return {
        toolName: "Task",
        input: { subagent_type: args.subagent_type ?? args.subagentType ?? "agent", ...args },
      }
    default:
      break
  }

  // Unknown name: lean on the ACP kind so at least the shape renders right.
  switch (kind) {
    case "read":
      return { toolName: "Read", input: { file_path: args.filePath ?? args.path ?? "" } }
    case "execute":
      return { toolName: "Bash", input: { command: args.command ?? "", description: args.description } }
    default:
      return { toolName: rawName, input: args }
  }
}

/** Flatten ACP tool-result content blocks into something the transcript can show. */
function flattenToolContent(update: AcpToolCallUpdate): unknown {
  const text = (update.content ?? [])
    .map((block) => (block.type === "content" ? block.content?.text ?? "" : ""))
    .join("")
  if (text) return text
  const rawOutput = asRecord(update.rawOutput)
  return rawOutput?.output ?? update.rawOutput ?? ""
}

function normalizeAcpUsage(update: AcpUsageUpdate): ContextWindowUsageSnapshot | null {
  const usedTokens = update.used ?? 0
  if (usedTokens <= 0) return null
  const maxTokens = update.size
  return {
    usedTokens,
    inputTokens: usedTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: usedTokens,
    ...(maxTokens && maxTokens > 0 ? { maxTokens } : {}),
    compactsAutomatically: true,
  }
}

interface TrackedToolCall {
  /** Latched from the first frame that names the tool; later frames relabel it. */
  name: string
  kind?: string
  /** Merged across frames — a `pending` frame may carry only part of the args. */
  input: Record<string, unknown>
  emitted: boolean
}

/**
 * Per-turn translation state.
 *
 * Two things force this to be stateful rather than a pure per-line function
 * like parseCursorLine:
 *
 *  - Text arrives as many tiny chunks sharing a `messageId`. Kanna's transcript
 *    stores whole assistant messages, so chunks accumulate and flush when the
 *    message id changes or the turn ends.
 *  - A tool call's name arrives on the `pending` frame with an empty
 *    `rawInput`; the arguments land on a later `in_progress` frame. The
 *    `tool_call` entry is emitted on the first frame that actually has
 *    arguments, using the latched name.
 */
export class AcpTurnTranslator {
  private readonly tools = new Map<string, TrackedToolCall>()
  private textBuffer = ""
  private textMessageId: string | null = null

  handleUpdate(update: AcpSessionUpdate): HarnessEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.handleMessageChunk(update as AcpMessageChunkUpdate)

      // Reasoning has no transcript kind in Kanna (cursor drops it too), and
      // the user's own prompt is already recorded before the turn starts.
      case "agent_thought_chunk":
      case "user_message_chunk":
        return []

      case "tool_call":
      case "tool_call_update":
        return this.handleToolCall(update as AcpToolCallUpdate)

      case "usage_update": {
        const usage = normalizeAcpUsage(update as AcpUsageUpdate)
        if (!usage) return []
        return [{ type: "transcript", entry: timestamped({ kind: "context_window_updated", usage }) }]
      }

      case "plan":
        return this.handlePlan(update as AcpPlanUpdate)

      // Consumed by the session (for the "/" menu), not the transcript.
      case "available_commands_update":
      default:
        return []
    }
  }

  /** Emit whatever text is still buffered. Called before results and at turn end. */
  flushText(): HarnessEvent[] {
    const text = this.textBuffer
    this.textBuffer = ""
    this.textMessageId = null
    if (!text.trim()) return []
    return [{ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) }]
  }

  private handleMessageChunk(update: AcpMessageChunkUpdate): HarnessEvent[] {
    const text = update.content?.text ?? ""
    if (!text) return []
    const messageId = update.messageId ?? null
    // A new message id closes the previous one.
    const events = messageId !== this.textMessageId && this.textBuffer ? this.flushText() : []
    this.textMessageId = messageId
    this.textBuffer += text
    return events
  }

  private handleToolCall(update: AcpToolCallUpdate): HarnessEvent[] {
    const toolCallId = update.toolCallId
    if (!toolCallId) return []

    const tracked = this.tools.get(toolCallId) ?? {
      name: update.title ?? update.kind ?? "unknown",
      kind: update.kind,
      input: {},
      emitted: false,
    }
    if (!this.tools.has(toolCallId)) this.tools.set(toolCallId, tracked)
    if (update.kind && !tracked.kind) tracked.kind = update.kind
    Object.assign(tracked.input, update.rawInput ?? {})

    const events: HarnessEvent[] = []

    // Emit only once the call leaves `pending`. A pending frame's rawInput is
    // partial — opencode's bash call, for instance, announces `{cwd}` and only
    // adds `{command}` on the in_progress frame — and the transcript is
    // append-only, so emitting early would freeze half-built arguments.
    if (!tracked.emitted && update.status && update.status !== "pending") {
      tracked.emitted = true
      // Text streamed before a tool call belongs above it in the transcript.
      events.push(...this.flushText())
      const { toolName, input } = translateOpenCodeTool(tracked.name, tracked.kind, tracked.input)
      events.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: normalizeToolCall({ toolName, toolId: toolCallId, input }),
        }),
      })
    }

    if (update.status === "completed" || update.status === "failed") {
      events.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: toolCallId,
          content: flattenToolContent(update),
          isError: update.status === "failed",
        }),
      })
    }

    return events
  }

  /**
   * ACP plans map onto Kanna's todo rendering, the same way codex's plan
   * updates become a synthetic TodoWrite call.
   */
  private handlePlan(update: AcpPlanUpdate): HarnessEvent[] {
    const entries = update.entries ?? []
    if (entries.length === 0) return []
    const toolId = `acp-plan-${randomUUID()}`
    const todos = entries.map((entry) => ({
      content: entry.content ?? "",
      status: entry.status === "in_progress" ? "in_progress" : entry.status === "completed" ? "completed" : "pending",
      activeForm: entry.content ?? "",
    }))
    return [
      ...this.flushText(),
      {
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: normalizeToolCall({ toolName: "TodoWrite", toolId, input: { todos } }),
        }),
      },
      { type: "transcript", entry: timestamped({ kind: "tool_result", toolId, content: "" }) },
    ]
  }
}

function openCodeSystemInitEntry(model: string, slashCommands: string[]): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "opencode",
    model,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "TodoWrite", "Task"],
    agents: [],
    slashCommands,
    mcpServers: [],
  })
}

/** Turn a non-success stop reason into the message Kanna shows on the result. */
function stopReasonMessage(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
      return "opencode stopped: token limit reached"
    case "max_turn_requests":
      return "opencode stopped: too many model requests in one turn"
    case "refusal":
      return "opencode declined to continue"
    default:
      return ""
  }
}

export class OpenCodeAcpManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly spawnProcess: SpawnOpenCodeAcp

  constructor(args: { spawnProcess?: SpawnOpenCodeAcp } = {}) {
    this.spawnProcess =
      args.spawnProcess ??
      ((cwd) =>
        spawn("opencode", ["acp"], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }) as unknown as AcpChildProcess)
  }

  /**
   * Start (or reuse) the chat's `opencode acp` process and bind it to a
   * session. Returns the session id plus whether a requested resume silently
   * fell back to a fresh session, which the caller surfaces as a
   * "Conversation Restored" boundary (same contract as codex).
   */
  async startSession(args: StartOpenCodeSessionArgs): Promise<{ sessionToken: string; resumeFellBack: boolean }> {
    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && existing.sessionId) {
      await this.applyConfig(existing, args.model, args.planMode)
      return { sessionToken: existing.sessionId, resumeFellBack: false }
    }
    if (existing) this.stopSession(args.chatId)

    const child = this.spawnProcess(args.cwd)
    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionId: null,
      availableCommands: [],
      configOptions: [],
      model: null,
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(args.chatId, context)
    this.attachListeners(context)

    await this.sendRequest<AcpInitializeResult>(context, "initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "kanna", title: "Kanna", version: "0.1.0" },
    } satisfies AcpInitializeParams)

    let resumeFellBack = false
    let result: AcpSessionResult | null = null
    if (args.sessionToken) {
      try {
        // session/resume, not session/load: load replays the whole history back
        // as session/update notifications, which would duplicate Kanna's own
        // transcript. resume rebinds the session silently.
        result = await this.sendRequest<AcpSessionResult>(context, "session/resume", {
          sessionId: args.sessionToken,
          cwd: args.cwd,
          mcpServers: [],
        })
        context.sessionId = args.sessionToken
      } catch {
        resumeFellBack = true
      }
    }

    if (!context.sessionId) {
      result = await this.sendRequest<AcpSessionResult>(context, "session/new", {
        cwd: args.cwd,
        mcpServers: [],
      })
      context.sessionId = result?.sessionId ?? null
    }

    if (!context.sessionId) {
      this.stopSession(args.chatId)
      throw new Error("opencode acp did not return a session id")
    }

    context.configOptions = result?.configOptions ?? []
    await this.applyConfig(context, args.model, args.planMode)
    return { sessionToken: context.sessionId, resumeFellBack }
  }

  /**
   * Push the chat's model and plan-mode choice onto the session. Both are ACP
   * config options; opencode names them "model" and "mode" (build|plan). A
   * rejected value is non-fatal — the session keeps its current one.
   */
  private async applyConfig(context: SessionContext, model: string, planMode: boolean) {
    if (!context.sessionId) return
    const set = async (configId: string, value: string) => {
      try {
        const result = await this.sendRequest<AcpSessionResult>(context, "session/set_config_option", {
          sessionId: context.sessionId,
          configId,
          value,
        })
        if (result?.configOptions) context.configOptions = result.configOptions
      } catch {
        // Unknown option id or value: leave the session as configured.
      }
    }
    if (model) await set("model", model)
    if (context.configOptions.some((option) => option.id === "mode")) {
      await set("mode", planMode ? "plan" : "build")
    }

    // Trust the session's reported value over the requested one: a model the
    // agent rejected (credential removed, id renamed) leaves the session on
    // its previous choice, and the transcript should say which model actually
    // ran rather than which one Kanna asked for.
    context.model = context.configOptions.find((option) => option.id === "model")?.currentValue ?? model ?? null
  }

  /** The model the chat's session is actually configured with, if it has one. */
  getSessionModel(chatId: string): string | null {
    return this.sessions.get(chatId)?.model ?? null
  }

  /**
   * Read the account's model list (`opencode models --verbose`). Rejects when
   * the binary is missing or errors — callers fall back to the static catalog.
   */
  async listModels(timeoutMs = 30_000): Promise<OpenCodeModelListEntry[]> {
    const proc = Bun.spawn(["opencode", "models", "--verbose"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    }, timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const models = parseOpenCodeModelList(stdout)
      if (code !== 0 || models.length === 0) {
        throw new Error(stderr.trim() || `opencode models exited with code ${code ?? "unknown"}`)
      }
      return models
    } finally {
      clearTimeout(timer)
    }
  }

  /** The session's live slash commands, for the composer's "/" menu. */
  listSkills(chatId: string): HarnessSkill[] | null {
    const context = this.sessions.get(chatId)
    if (!context || context.closed || context.availableCommands.length === 0) return null
    return context.availableCommands
  }

  async startTurn(args: StartOpenCodeTurnArgs): Promise<HarnessTurn> {
    const context = this.sessions.get(args.chatId)
    if (!context || context.closed || !context.sessionId) {
      throw new Error("opencode session not started")
    }
    if (context.pendingTurn) {
      throw new Error("opencode turn is already running")
    }

    const queue = new AsyncQueue<HarnessEvent>()
    queue.push({ type: "session_token", sessionToken: context.sessionId })
    queue.push({
      type: "transcript",
      entry: openCodeSystemInitEntry(
        context.model ?? args.model,
        context.availableCommands.map((skill) => skill.name)
      ),
    })

    const pendingTurn: PendingTurn = { queue, translator: new AcpTurnTranslator(), resolved: false }
    context.pendingTurn = pendingTurn

    const startedAt = Date.now()
    void this.sendRequest<AcpPromptResult>(context, "session/prompt", {
      sessionId: context.sessionId,
      prompt: [{ type: "text", text: args.content }],
    })
      .then((result) => {
        if (pendingTurn.resolved) return
        pendingTurn.resolved = true
        context.pendingTurn = null

        for (const event of pendingTurn.translator.flushText()) queue.push(event)

        const stopReason = result?.stopReason ?? "end_turn"
        const message = stopReasonMessage(stopReason)
        queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: stopReason === "end_turn" ? "success" : stopReason === "cancelled" ? "cancelled" : "error",
            isError: Boolean(message),
            durationMs: Date.now() - startedAt,
            result: message,
          }),
        })
        queue.finish()
      })
      .catch((error: Error) => {
        if (pendingTurn.resolved) return
        pendingTurn.resolved = true
        context.pendingTurn = null
        queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: Date.now() - startedAt,
            result: context.stderrLines.at(-1) || error.message,
          }),
        })
        queue.finish()
      })

    return {
      provider: "opencode",
      stream: queue,
      interrupt: async () => {
        const turn = context.pendingTurn
        if (!turn) return
        context.pendingTurn = null
        turn.resolved = true
        for (const event of turn.translator.flushText()) turn.queue.push(event)
        turn.queue.finish()
        // Notification, not a request — the in-flight prompt answers with
        // stopReason "cancelled", which the resolved turn then ignores.
        this.writeMessage(context, {
          method: "session/cancel",
          params: { sessionId: context.sessionId },
        })
      },
      close: () => {},
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    this.sessions.delete(chatId)
    context.closed = true
    try {
      context.child.kill("SIGKILL")
    } catch {
      // already gone
    }
  }

  stopAll() {
    for (const chatId of [...this.sessions.keys()]) this.stopSession(chatId)
  }

  private attachListeners(context: SessionContext) {
    const lines = createInterface({ input: context.child.stdout })
    void (async () => {
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: Record<string, unknown> | null
        try {
          parsed = asRecord(JSON.parse(trimmed))
        } catch {
          continue
        }
        if (!parsed) continue

        if (isAcpResponse(parsed)) {
          this.handleResponse(context, parsed as AcpJsonRpcResponse)
          continue
        }
        if (isAcpServerRequest(parsed)) {
          this.handleServerRequest(context, parsed.id, parsed.method, asRecord(parsed.params) ?? {})
          continue
        }
        if (isAcpNotification(parsed)) {
          this.handleNotification(context, parsed.method, asRecord(parsed.params) ?? {})
        }
      }
    })()

    const stderr = createInterface({ input: context.child.stderr })
    void (async () => {
      for await (const line of stderr) {
        if (line.trim()) context.stderrLines.push(line.trim())
      }
    })()

    context.child.on("error", (error) => this.failContext(context, error.message))
    context.child.on("close", (code) => {
      if (context.closed) return
      this.failContext(context, context.stderrLines.at(-1) || `opencode acp exited with code ${code ?? 1}`)
    })
  }

  private handleResponse(context: SessionContext, response: AcpJsonRpcResponse) {
    const pending = context.pendingRequests.get(response.id)
    if (!pending) return
    context.pendingRequests.delete(response.id)
    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message ?? "Unknown error"}`))
      return
    }
    pending.resolve(response.result)
  }

  private handleNotification(context: SessionContext, method: string, params: Record<string, unknown>) {
    if (method !== "session/update") return
    const update = asRecord(params.update) as AcpSessionUpdate | null
    if (!update) return

    if (update.sessionUpdate === "available_commands_update") {
      const commands = (update as { availableCommands?: Array<Record<string, unknown>> }).availableCommands ?? []
      context.availableCommands = commands.flatMap((command) => {
        const name = asString(command.name)
        if (!name) return []
        return [{ name, description: asString(command.description) ?? "", source: "command" as const }]
      })
      return
    }

    const turn = context.pendingTurn
    if (!turn || turn.resolved) return
    for (const event of turn.translator.handleUpdate(update)) turn.queue.push(event)
  }

  /**
   * Answer the agent's client-side requests. Kanna advertises no fs/terminal
   * capabilities, so in practice only permission prompts arrive — and only for
   * tools opencode's own permission config gates. Kanna's model is that the
   * harness owns approvals (codex runs with approvalPolicy "never"), so the
   * broadest offered option is selected.
   */
  private handleServerRequest(
    context: SessionContext,
    id: AcpRequestId,
    method: string,
    params: Record<string, unknown>
  ) {
    if (method === "session/request_permission") {
      const options = (params as unknown as AcpRequestPermissionParams).options ?? []
      const choice =
        options.find((option) => option.kind === "allow_always")
        ?? options.find((option) => option.kind === "allow_once")
        ?? options[0]
      this.writeMessage(context, {
        id,
        result: choice
          ? { outcome: { outcome: "selected", optionId: choice.optionId } }
          : { outcome: { outcome: "cancelled" } },
      })
      return
    }
    this.writeMessage(context, {
      id,
      error: { code: -32601, message: `Kanna does not implement ${method}` },
    })
  }

  private failContext(context: SessionContext, message: string) {
    const turn = context.pendingTurn
    if (turn && !turn.resolved) {
      turn.resolved = true
      context.pendingTurn = null
      turn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        }),
      })
      turn.queue.finish()
    }
    for (const pending of context.pendingRequests.values()) pending.reject(new Error(message))
    context.pendingRequests.clear()
    context.closed = true
  }

  private async sendRequest<TResult>(
    context: SessionContext,
    method: string,
    params: unknown
  ): Promise<TResult> {
    const id = randomUUID()
    const promise = new Promise<TResult>((resolve, reject) => {
      context.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    this.writeMessage(context, { jsonrpc: "2.0", id, method, params })
    return await promise
  }

  private writeMessage(context: SessionContext, message: Record<string, unknown>) {
    context.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  }
}

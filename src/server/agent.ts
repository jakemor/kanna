import { query, type CanUseTool, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentProvider,
  NormalizedToolCall,
  PendingToolSnapshot,
  KannaStatus,
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { EventStore } from "./event-store"
import { CodexAppServerManager } from "./codex-app-server"
import { generateTitleForChat } from "./generate-title"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  codexServiceTierFromModelOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
} from "./provider-catalog"

const CLAUDE_TOOLSET = [
  "Skill",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "TodoWrite",
  "KillShell",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
] as const

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
  resolve: (result: unknown) => void
}

interface ActiveTurn {
  chatId: string
  provider: AgentProvider
  turn: HarnessTurn
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  status: KannaStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean
  abandonRequested: boolean
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (change: AgentStateChange) => void
  codexManager?: CodexAppServerManager
  generateTitle?: (messageContent: string, cwd: string) => Promise<string | null>
}

export type AgentStateChange =
  | { type: "sidebar" }
  | { type: "chat-runtime"; chatId: string }
  | { type: "chat-reset"; chatId: string }
  | { type: "chat-message"; chatId: string; entry: TranscriptEntry }

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function discardedToolResult(
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
) {
  if (tool.toolKind === "ask_user_question") {
    return {
      discarded: true,
      answers: {},
    }
  }

  return {
    discarded: true,
  }
}

export function normalizeClaudeStreamMessage(message: any): TranscriptEntry[] {
  const debugRaw = JSON.stringify(message)
  const messageId = typeof message.uuid === "string" ? message.uuid : undefined

  if (message.type === "system" && message.subtype === "init") {
    return [
      timestamped({
        kind: "system_init",
        messageId,
        provider: "claude",
        model: typeof message.model === "string" ? message.model : "unknown",
        tools: Array.isArray(message.tools) ? message.tools : [],
        agents: Array.isArray(message.agents) ? message.agents : [],
        slashCommands: Array.isArray(message.slash_commands)
          ? message.slash_commands.filter((entry: string) => !entry.startsWith("._"))
          : [],
        mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
        debugRaw,
      }),
    ]
  }

  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "text" && typeof content.text === "string") {
        entries.push(timestamped({
          kind: "assistant_text",
          messageId,
          text: content.text,
          debugRaw,
        }))
      }
      if (content.type === "tool_use" && typeof content.name === "string" && typeof content.id === "string") {
        entries.push(timestamped({
          kind: "tool_call",
          messageId,
          tool: normalizeToolCall({
            toolName: content.name,
            toolId: content.id,
            input: (content.input ?? {}) as Record<string, unknown>,
          }),
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        entries.push(timestamped({
          kind: "tool_result",
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
          debugRaw,
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId, debugRaw })]
    }
    return [
      timestamped({
        kind: "result",
        messageId,
        subtype: message.is_error ? "error" : "success",
        isError: Boolean(message.is_error),
        durationMs: typeof message.duration_ms === "number" ? message.duration_ms : 0,
        result: typeof message.result === "string" ? message.result : stringFromUnknown(message.result),
        costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
        debugRaw,
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId, debugRaw })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content, debugRaw })]
  }

  return []
}

async function* createClaudeHarnessStream(q: Query): AsyncGenerator<HarnessEvent> {
  for await (const sdkMessage of q as AsyncIterable<any>) {
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken }
    }
    for (const entry of normalizeClaudeStreamMessage(sdkMessage)) {
      yield { type: "transcript", entry }
    }
  }
}

async function startClaudeTurn(args: {
  content: string
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
}): Promise<HarnessTurn> {
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      return {
        behavior: "allow",
        updatedInput: input,
      }
    }

    const tool = normalizeToolCall({
      toolName,
      toolId: options.toolUseID,
      input: (input ?? {}) as Record<string, unknown>,
    })

    if (tool.toolKind !== "ask_user_question" && tool.toolKind !== "exit_plan_mode") {
      return {
        behavior: "deny",
        message: "Unsupported tool request",
      }
    }

    const result = await args.onToolRequest({ tool })

    if (tool.toolKind === "ask_user_question") {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          questions: record.questions ?? tool.input.questions,
          answers: record.answers ?? result,
        },
      } satisfies PermissionResult
    }

    const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const confirmed = Boolean(record.confirmed)
    if (confirmed) {
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          ...record,
        },
      } satisfies PermissionResult
    }

    return {
      behavior: "deny",
      message: typeof record.message === "string"
        ? `User wants to suggest edits to the plan: ${record.message}`
        : "User wants to suggest edits to the plan before approving.",
    } satisfies PermissionResult
  }

  const q = query({
    prompt: args.content,
    options: {
      cwd: args.localPath,
      model: args.model,
      effort: args.effort as "low" | "medium" | "high" | "max" | undefined,
      resume: args.sessionToken ?? undefined,
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,
      tools: [...CLAUDE_TOOLSET],
      settingSources: ["user", "project", "local"],
      env: (() => { const { CLAUDECODE: _, ...env } = process.env; return env })(),
    },
  })

  return {
    provider: "claude",
    stream: createClaudeHarnessStream(q),
    getAccountInfo: async () => {
      try {
        return await q.accountInfo()
      } catch {
        return null
      }
    },
    interrupt: async () => {
      await q.interrupt()
    },
    close: () => {
      q.close()
    },
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (change: AgentStateChange) => void
  private readonly codexManager: CodexAppServerManager
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<string | null>
  readonly activeTurns = new Map<string, ActiveTurn>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.generateTitle = args.generateTitle ?? generateTitleForChat
  }

  getActiveStatuses() {
    const statuses = new Map<string, KannaStatus>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return { toolUseId: pending.toolUseId, toolKind: pending.tool.toolKind }
  }

  private buildRecoveryPrompt(chatId: string, originalContent: string) {
    const chat = this.store.requireChat(chatId)
    if (chat.sessionToken) {
      return "The previous response was interrupted because the Kanna server restarted. Continue from where you left off without repeating completed work unless necessary."
    }

    return `The previous turn was interrupted by a Kanna server restart before a resumable session was fully established. Please continue by handling the user's pending request.\n\nPending request:\n${originalContent}`
  }

  private resolveProvider(command: Extract<ClientCommand, { type: "chat.send" }>, currentProvider: AgentProvider | null) {
    if (currentProvider) return currentProvider
    return command.provider ?? "claude"
  }

  private getProviderSettings(provider: AgentProvider, command: Extract<ClientCommand, { type: "chat.send" }>) {
    const catalog = getServerProviderCatalog(provider)
    if (provider === "claude") {
      const modelOptions = normalizeClaudeModelOptions(command.modelOptions, command.effort)
      return {
        model: normalizeServerModel(provider, command.model),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(command.planMode) : false,
      }
    }

    const modelOptions = normalizeCodexModelOptions(command.modelOptions, command.effort)
    return {
      model: normalizeServerModel(provider, command.model),
      effort: modelOptions.reasoningEffort,
      serviceTier: codexServiceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(command.planMode) : false,
    }
  }

  private async startTurnForChat(args: {
    chatId: string
    provider: AgentProvider
    content: string
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    appendUserPrompt: boolean
  }) {
    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId)) {
      throw new Error("Chat is already running")
    }

    if (!chat.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
    }
    await this.store.setPlanMode(args.chatId, args.planMode)

    const existingMessages = this.store.getMessages(args.chatId)
    const shouldGenerateTitle = args.appendUserPrompt && chat.title === "New Chat" && existingMessages.length === 0

    if (args.appendUserPrompt) {
      const entry = timestamped({ kind: "user_prompt", content: args.content }, Date.now())
      await this.store.appendMessage(args.chatId, entry)
      this.onStateChange({ type: "chat-message", chatId: args.chatId, entry })
    }
    await this.store.recordTurnStarted(args.chatId, {
      provider: args.provider,
      content: args.content,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
    })

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath)
    }

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      const active = this.activeTurns.get(args.chatId)
      if (!active) {
        throw new Error("Chat turn ended unexpectedly")
      }

      active.status = "waiting_for_user"
      this.onStateChange({ type: "chat-runtime", chatId: args.chatId })
      this.onStateChange({ type: "sidebar" })

      return await new Promise<unknown>((resolve) => {
        active.pendingTool = {
          toolUseId: request.tool.toolId,
          tool: request.tool,
          resolve,
        }
      })
    }

    let turn: HarnessTurn
    if (args.provider === "claude") {
      turn = await startClaudeTurn({
        content: args.content,
        localPath: project.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: chat.sessionToken,
        onToolRequest,
      })
    } else {
      await this.codexManager.startSession({
        chatId: args.chatId,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
      })
      turn = await this.codexManager.startTurn({
        chatId: args.chatId,
        content: args.content,
        model: args.model,
        effort: args.effort as any,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        onToolRequest,
      })
    }

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      status: "starting",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
      abandonRequested: false,
    }
    this.activeTurns.set(args.chatId, active)
    this.onStateChange({ type: "chat-runtime", chatId: args.chatId })
    this.onStateChange({ type: "sidebar" })

    if (turn.getAccountInfo) {
      void turn.getAccountInfo()
        .then(async (accountInfo) => {
          if (!accountInfo) return
          const entry = timestamped({ kind: "account_info", accountInfo })
          await this.store.appendMessage(args.chatId, entry)
          this.onStateChange({ type: "chat-message", chatId: args.chatId, entry })
        })
        .catch(() => undefined)
    }

    void this.runTurn(active)
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>) {
    let chatId = command.chatId

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
    }

    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(command, chat.provider)
    const settings = this.getProviderSettings(provider, command)
    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
    })

    return { chatId }
  }

  private async generateTitleInBackground(chatId: string, messageContent: string, cwd: string) {
    try {
      const title = await this.generateTitle(messageContent, cwd)
      if (!title) return

      const chat = this.store.requireChat(chatId)
      if (chat.title !== "New Chat") return

      await this.store.renameChat(chatId, title)
      this.onStateChange({ type: "chat-runtime", chatId })
      this.onStateChange({ type: "sidebar" })
    } catch {
      // Ignore background title generation failures.
    }
  }

  private async runTurn(active: ActiveTurn) {
    try {
      for await (const event of active.turn.stream) {
        if (active.abandonRequested) {
          break
        }

        if (event.type === "session_token" && event.sessionToken) {
          await this.store.setSessionToken(active.chatId, event.sessionToken)
          this.onStateChange({ type: "chat-runtime", chatId: active.chatId })
          continue
        }

        if (!event.entry) continue
        await this.store.appendMessage(active.chatId, event.entry)

        if (event.entry.kind === "system_init") {
          active.status = "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
          }
        }

        this.onStateChange({ type: "chat-message", chatId: active.chatId, entry: event.entry })
        if (event.entry.kind === "system_init" || event.entry.kind === "result" || event.entry.kind === "status") {
          this.onStateChange({ type: "chat-runtime", chatId: active.chatId })
          this.onStateChange({ type: "sidebar" })
        }
      }
    } catch (error) {
      if (!active.cancelRequested && !active.abandonRequested) {
        const message = error instanceof Error ? error.message : String(error)
        const entry = timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        })
        await this.store.appendMessage(active.chatId, entry)
        await this.store.recordTurnFailed(active.chatId, message)
        this.onStateChange({ type: "chat-message", chatId: active.chatId, entry })
        this.onStateChange({ type: "chat-runtime", chatId: active.chatId })
        this.onStateChange({ type: "sidebar" })
      }
    } finally {
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId)
      }
      active.turn.close()
      this.activeTurns.delete(active.chatId)
      this.onStateChange({ type: "chat-runtime", chatId: active.chatId })
      this.onStateChange({ type: "sidebar" })

      if (active.postToolFollowUp && !active.cancelRequested && !active.abandonRequested) {
        try {
          await this.startTurnForChat({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            appendUserPrompt: false,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const entry = timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
          await this.store.appendMessage(active.chatId, entry)
          await this.store.recordTurnFailed(active.chatId, message)
          this.onStateChange({ type: "chat-message", chatId: active.chatId, entry })
          this.onStateChange({ type: "chat-runtime", chatId: active.chatId })
          this.onStateChange({ type: "sidebar" })
        }
      }
    }
  }

  async cancel(chatId: string) {
    const active = this.activeTurns.get(chatId)
    if (!active) return

    active.cancelRequested = true

    const pendingTool = active.pendingTool
    active.pendingTool = null

    if (pendingTool) {
      const result = discardedToolResult(pendingTool.tool)
      const entry = timestamped({
        kind: "tool_result",
        toolId: pendingTool.toolUseId,
        content: result,
      })
      await this.store.appendMessage(chatId, entry)
      this.onStateChange({ type: "chat-message", chatId, entry })
      if (active.provider === "codex" && pendingTool.tool.toolKind === "exit_plan_mode") {
        pendingTool.resolve(result)
      }
    }

    const interruptedEntry = timestamped({ kind: "interrupted" })
    await this.store.appendMessage(chatId, interruptedEntry)
    await this.store.recordTurnCancelled(chatId)
    active.cancelRecorded = true
    active.hasFinalResult = true

    try {
      await active.turn.interrupt()
    } catch {
      active.turn.close()
    }

    this.activeTurns.delete(chatId)
    this.onStateChange({ type: "chat-message", chatId, entry: interruptedEntry })
    this.onStateChange({ type: "chat-runtime", chatId })
    this.onStateChange({ type: "sidebar" })
  }

  async recoverInterruptedTurns() {
    for (const chat of this.store.listChatsWithActiveTurn()) {
      if (!chat.activeTurn || this.activeTurns.has(chat.id)) continue

      try {
        await this.startTurnForChat({
          chatId: chat.id,
          provider: chat.activeTurn.provider,
          content: this.buildRecoveryPrompt(chat.id, chat.activeTurn.content),
          model: chat.activeTurn.model,
          effort: chat.activeTurn.effort,
          serviceTier: chat.activeTurn.serviceTier,
          planMode: chat.activeTurn.planMode,
          appendUserPrompt: false,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const entry = timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: `Failed to recover interrupted turn after server restart: ${message}`,
        })
        await this.store.appendMessage(chat.id, entry)
        await this.store.recordTurnFailed(chat.id, message)
        this.onStateChange({ type: "chat-message", chatId: chat.id, entry })
        this.onStateChange({ type: "chat-runtime", chatId: chat.id })
        this.onStateChange({ type: "sidebar" })
      }
    }
  }

  shutdown() {
    for (const active of this.activeTurns.values()) {
      active.abandonRequested = true
      const pendingTool = active.pendingTool
      active.pendingTool = null
      if (pendingTool) {
        pendingTool.resolve(discardedToolResult(pendingTool.tool))
      }
      active.turn.close()
    }
    this.codexManager.stopAll()
  }

  async respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const active = this.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      throw new Error("No pending tool request")
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }

    const resultEntry = timestamped({
      kind: "tool_result",
      toolId: command.toolUseId,
      content: command.result,
    })
    await this.store.appendMessage(command.chatId, resultEntry)
    const extraEntries: TranscriptEntry[] = []

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        await this.store.setSessionToken(command.chatId, null)
        const clearEntry = timestamped({ kind: "context_cleared" })
        await this.store.appendMessage(command.chatId, clearEntry)
        extraEntries.push(clearEntry)
      }

      if (active.provider === "codex") {
        active.postToolFollowUp = result.confirmed
          ? {
              content: result.message
                ? `Proceed with the approved plan. Additional guidance: ${result.message}`
                : "Proceed with the approved plan.",
              planMode: false,
            }
          : {
              content: result.message
                ? `Revise the plan using this feedback: ${result.message}`
                : "Revise the plan using this feedback.",
              planMode: true,
            }
      }
    }

    pending.resolve(command.result)

    this.onStateChange({ type: "chat-message", chatId: command.chatId, entry: resultEntry })
    for (const entry of extraEntries) {
      this.onStateChange({ type: "chat-message", chatId: command.chatId, entry })
    }
    this.onStateChange({ type: "chat-runtime", chatId: command.chatId })
    this.onStateChange({ type: "sidebar" })
  }
}

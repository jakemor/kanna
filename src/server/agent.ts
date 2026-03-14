import { query, type CanUseTool, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk"
import type { ClientCommand } from "../shared/protocol"

import type { KannaStatus, PendingToolSnapshot } from "../shared/types"
import { EventStore } from "./event-store"
import { generateTitleForChat } from "./generate-title"

const DEFAULT_MODEL = "opus"

const TOOLSET = [
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
  toolName: "AskUserQuestion" | "ExitPlanMode"
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

interface ActiveTurn {
  chatId: string
  query: Query
  status: KannaStatus
  pendingTool: PendingToolRequest | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: () => void
}

function buildUserPromptPayload(content: string) {
  return JSON.stringify({ type: "user_prompt", content })
}

function buildToolResultPayload(toolUseId: string, body: unknown) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify(body),
        },
      ],
    },
  })
}

function buildCancelledPayload() {
  return JSON.stringify({
    type: "result",
    subtype: "cancelled",
    is_error: false,
    duration_ms: 0,
    result: "Interrupted by user",
  })
}

function buildErrorPayload(message: string) {
  return JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    duration_ms: 0,
    result: message,
  })
}

function deriveChatTitle(content: string) {
  const singleLine = content.replace(/\s+/g, " ").trim()
  return singleLine.slice(0, 60) || "New Chat"
}

function toTranscriptEntry(message: string, messageId?: string) {
  return {
    _id: crypto.randomUUID(),
    messageId,
    message,
    createdAt: Date.now(),
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: () => void
  readonly activeTurns = new Map<string, ActiveTurn>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
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
    return { toolUseId: pending.toolUseId, toolName: pending.toolName }
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
    if (this.activeTurns.has(chatId)) {
      throw new Error("Chat is already running")
    }

    const existingMessages = this.store.getMessages(chatId)
    if (chat.title === "New Chat" && existingMessages.length === 0) {
      // Immediate placeholder: truncated first message
      await this.store.renameChat(chatId, deriveChatTitle(command.content))

      // Fire-and-forget: generate a better title with Haiku in parallel
      void generateTitleForChat(command.content)
        .then(async (title) => {
          if (title) {
            await this.store.renameChat(chatId!, title)
            this.onStateChange()
          }
        })
        .catch(() => undefined)
    }

    await this.store.appendMessage(chatId, toTranscriptEntry(buildUserPromptPayload(command.content), crypto.randomUUID()))
    await this.store.recordTurnStarted(chatId)

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
        return {
          behavior: "allow",
          updatedInput: input,
        }
      }

      const active = this.activeTurns.get(chatId!)
      if (!active) {
        return {
          behavior: "deny",
          message: "Chat turn ended unexpectedly",
        }
      }

      active.status = "waiting_for_user"
      this.onStateChange()

      return await new Promise<PermissionResult>((resolve) => {
        active.pendingTool = {
          toolUseId: options.toolUseID,
          toolName,
          input,
          resolve,
        }
      })
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    const resolvedModel = command.model || DEFAULT_MODEL
    const resolvedEffort = (command.effort as "low" | "medium" | "high" | "max") || undefined
    console.log(`[agent] query model=${resolvedModel} effort=${resolvedEffort} (command.model=${command.model})`)

    const q = query({
      prompt: command.content,
      options: {
        cwd: project.localPath,
        model: resolvedModel,
        effort: resolvedEffort,
        resume: chat.resumeSessionId ?? undefined,
        permissionMode: command.planMode ? "plan" : "acceptEdits",
        canUseTool,
        tools: [...TOOLSET],
        settingSources: ["user", "project", "local"],
        env: {
          ...process.env,
          // CLAUDE_AGENT_SDK_CLIENT_APP: SDK_CLIENT_APP,
        },
      },
    })

    const active: ActiveTurn = {
      chatId,
      query: q,
      status: "starting",
      pendingTool: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
    }
    this.activeTurns.set(chatId, active)
    this.onStateChange()

    void q.accountInfo()
      .then(async (accountInfo) => {
        await this.store.appendMessage(
          chatId!,
          toTranscriptEntry(JSON.stringify({ type: "system", subtype: "account_info", accountInfo }))
        )
        this.onStateChange()
      })
      .catch(() => undefined)

    void this.runTurn(active)

    return { chatId }
  }

  private async runTurn(active: ActiveTurn) {
    try {
      for await (const sdkMessage of active.query) {
        const raw = JSON.stringify(sdkMessage)
        const maybeMessageId = "uuid" in sdkMessage && sdkMessage.uuid ? String(sdkMessage.uuid) : crypto.randomUUID()

        await this.store.appendMessage(active.chatId, toTranscriptEntry(raw, maybeMessageId))

        const sessionId = "session_id" in sdkMessage && typeof sdkMessage.session_id === "string"
          ? sdkMessage.session_id
          : null
        if (sessionId) {
          await this.store.setResumeSession(active.chatId, sessionId)
        }

        if (sdkMessage.type === "system" && sdkMessage.subtype === "init") {
          active.status = "running"
        }

        if (sdkMessage.type === "result") {
          active.hasFinalResult = true
          if (sdkMessage.is_error) {
            const errorText = "errors" in sdkMessage && Array.isArray(sdkMessage.errors)
              ? sdkMessage.errors.join("\n")
              : "Turn failed"
            await this.store.recordTurnFailed(active.chatId, errorText)
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
          }
        }

        this.onStateChange()
      }
    } catch (error) {
      if (!active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(active.chatId, toTranscriptEntry(buildErrorPayload(message)))
        await this.store.recordTurnFailed(active.chatId, message)
      }
    } finally {
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId)
      }
      active.query.close()
      this.activeTurns.delete(active.chatId)
      this.onStateChange()
    }
  }

  async cancel(chatId: string) {
    const active = this.activeTurns.get(chatId)
    if (!active) return

    active.cancelRequested = true
    active.pendingTool = null

    await this.store.appendMessage(chatId, toTranscriptEntry(buildCancelledPayload(), crypto.randomUUID()))
    await this.store.recordTurnCancelled(chatId)
    active.cancelRecorded = true
    active.hasFinalResult = true

    try {
      await active.query.interrupt()
    } catch {
      active.query.close()
    }

    this.activeTurns.delete(chatId)
    this.onStateChange()
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

    await this.store.appendMessage(
      command.chatId,
      toTranscriptEntry(buildToolResultPayload(command.toolUseId, command.result), crypto.randomUUID())
    )

    active.pendingTool = null
    active.status = "running"

    if (pending.toolName === "AskUserQuestion") {
      const result = command.result as { questions?: unknown; answers?: unknown }
      pending.resolve({
        behavior: "allow",
        updatedInput: {
          ...(pending.input ?? {}),
          questions: result.questions ?? (pending.input.questions as unknown),
          answers: result.answers ?? result,
        },
      })
      this.onStateChange()
      return
    }

    const result = (command.result ?? {}) as {
      confirmed?: boolean
      clearContext?: boolean
      message?: string
    }

    if (result.confirmed) {
      if (result.clearContext) {
        await this.store.setResumeSession(command.chatId, null)
        await this.store.appendMessage(
          command.chatId,
          toTranscriptEntry(JSON.stringify({ type: "system", subtype: "context_cleared" }), crypto.randomUUID())
        )
      }
      pending.resolve({
        behavior: "allow",
        updatedInput: {
          ...(pending.input ?? {}),
          ...result,
        },
      })
    } else {
      pending.resolve({
        behavior: "deny",
        message: result.message
          ? `User wants to suggest edits to the plan: ${result.message}`
          : "User wants to suggest edits to the plan before approving.",
      })
    }

    this.onStateChange()
  }
}

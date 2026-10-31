import { z } from "zod"
import type { NormalizedToolCall, TranscriptEntry } from "../shared/types"
import type { RequestSecretsInput, RequestSecretsToolResult } from "../shared/secrets"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessToolRequest } from "./harness-types"
import { timestamped } from "./transcript"
import { DISPLAY_TOOLS } from "./kanna-display-tools"
import { GENERATE_IMAGES_TOOL } from "./kanna-image-tools"
import { ORCHESTRATION_TOOLS } from "./kanna-orchestration-tools"
import { SECRET_TOOLS } from "./kanna-secret-tools"
import type { ChatOrchestrator } from "./orchestrator"
import type { SecretsService } from "./secrets"

export interface KannaToolResult {
  [key: string]: unknown
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

interface KannaToolContext {
  chatId: string
  cwd: string
  dataDir?: string
  signal: AbortSignal
  requestInput: (prompt: string) => Promise<string>
  /**
   * Shows the user a `request_secrets` form and waits. The values go from the
   * form to the keychain without passing through here; this gets names.
   */
  requestSecrets?: (request: RequestSecretsInput) => Promise<RequestSecretsToolResult>
  /** Absent only where a runtime is built without a server behind it, as in tests. */
  orchestration?: ChatOrchestrator
  projectId?: string
  secrets?: SecretsService
}

export interface KannaToolDefinition {
  name: string
  description: string
  schema: z.ZodObject<z.ZodRawShape>
  waitsForUser?: boolean
  execute: (input: Record<string, unknown>, context: KannaToolContext) => Promise<KannaToolResult & { transcriptContent?: unknown }>
}

/**
 * The most a tool's description can be. Claude Code cuts every MCP tool
 * description at this many characters (`Sx=2048` in the CLI the Agent SDK
 * ships, 0.3.277) and ends it "[truncated]". What a tool has to say past
 * this goes in the session instructions (`harness-instructions.ts`).
 */
export const KANNA_TOOL_DESCRIPTION_LIMIT = 2048

// Add tools here. Every provider registers the same definitions and calls the same handlers.
export const KANNA_TOOLS: readonly KannaToolDefinition[] = [...DISPLAY_TOOLS, GENERATE_IMAGES_TOOL, ...ORCHESTRATION_TOOLS, ...SECRET_TOOLS]

export const KANNA_TOOL_NAMES = KANNA_TOOLS.map((tool) => tool.name)

export function kannaToolName(name: string): string | undefined {
  return KANNA_TOOL_NAMES.find((candidate) => name === candidate || name === `mcp__kanna__${candidate}`)
}

export function kannaToolSpecs() {
  return KANNA_TOOLS.map(({ name, description, schema }) => ({
    name,
    description,
    inputSchema: z.toJSONSchema(schema),
  }))
}

export interface KannaToolHost {
  execute: (name: string, input: unknown, signal?: AbortSignal) => Promise<KannaToolResult>
}

/** Names only: anything else in a `secrets.submit` answer is refused before the tool sees it. */
const REQUEST_SECRETS_RESULT = z.strictObject({
  saved: z.array(z.string()),
  skipped: z.array(z.string()),
  cancelled: z.literal(true).optional(),
})

export class KannaToolRuntime implements KannaToolHost {
  private readonly abortController = new AbortController()
  private inputTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly context: {
    chatId: string
    cwd: string
    dataDir?: string
    emit: (entry: TranscriptEntry) => Promise<void>
    requestInput: (request: HarnessToolRequest, signal: AbortSignal) => Promise<unknown>
    orchestration?: ChatOrchestrator
    projectId?: string
    secrets?: SecretsService
  }, private readonly definitions: readonly KannaToolDefinition[] = KANNA_TOOLS) {}

  abort() {
    this.abortController.abort()
  }

  async execute(name: string, rawInput: unknown, signal?: AbortSignal): Promise<KannaToolResult> {
    const definition = this.definitions.find((tool) => tool.name === name)
    if (!definition) return { content: [{ type: "text", text: `Unknown Kanna tool: ${name}` }], isError: true }
    const callSignal = signal
      ? AbortSignal.any([signal, this.abortController.signal])
      : this.abortController.signal
    const run = () => this.run(definition, rawInput, callSignal)
    if (!definition.waitsForUser) return run()

    // Two input calls must not replace each other's pending question.
    const result = this.inputTail.then(run, run)
    this.inputTail = result.catch(() => {})
    return result
  }

  private async run(definition: KannaToolDefinition, rawInput: unknown, signal: AbortSignal): Promise<KannaToolResult> {
    const toolId = `kanna-${crypto.randomUUID()}`
    let started = false
    let result: KannaToolResult & { transcriptContent?: unknown }
    try {
      signal.throwIfAborted()
      const input = definition.schema.parse(rawInput)
      let tool: NormalizedToolCall = normalizeToolCall({ toolName: definition.name, toolId, input })
      if (!definition.waitsForUser) {
        await this.context.emit(timestamped({ kind: "tool_call", tool }))
        started = true
      }
      result = await definition.execute(input, {
        chatId: this.context.chatId,
        cwd: this.context.cwd,
        dataDir: this.context.dataDir,
        signal,
        orchestration: this.context.orchestration,
        projectId: this.context.projectId,
        secrets: this.context.secrets,
        requestSecrets: async (request) => {
          tool = normalizeToolCall({ toolName: definition.name, toolId, input: request as unknown as Record<string, unknown> })
          if (tool.toolKind !== "request_secrets") throw new Error("Tool does not request secrets")
          await this.context.emit(timestamped({ kind: "tool_call", tool }))
          started = true
          const response = await this.context.requestInput({
            tool,
            resultOwner: "tool",
            validateResult: (value) => { REQUEST_SECRETS_RESULT.parse(value) },
          }, signal)
          signal.throwIfAborted()
          return REQUEST_SECRETS_RESULT.parse(response)
        },
        requestInput: async (prompt) => {
          tool = normalizeToolCall({ toolName: "AskUserQuestion", toolId, input: { questions: [{ id: "value", question: prompt, options: [] }] } })
          await this.context.emit(timestamped({ kind: "tool_call", tool }))
          started = true
          if (tool.toolKind !== "ask_user_question") throw new Error("Tool does not support user input")
          const responseSchema = z.object({ answers: z.object({ value: z.array(z.string()).min(1) }) })
          const response = await this.context.requestInput({
            tool,
            resultOwner: "tool",
            validateResult: (value) => { responseSchema.parse(value) },
          }, signal)
          signal.throwIfAborted()
          const parsed = responseSchema.parse(response)
          return parsed.answers.value[0]!
        },
      })
      signal.throwIfAborted()
    } catch (error) {
      result = {
        content: [{ type: "text", text: signal.aborted ? "Cancelled" : error instanceof Error ? error.message : String(error) }],
        isError: true,
        ...(signal.aborted ? { structuredContent: { discarded: true } } : {}),
      }
    }
    if (started) {
      await this.context.emit(timestamped({
        kind: "tool_result",
        toolId,
        content: result.transcriptContent ?? result.structuredContent ?? result.content,
        isError: result.isError,
      }))
    }
    const { transcriptContent: _, ...providerResult } = result
    return providerResult
  }
}

// The runtime writes one transcript entry per call. Suppress the provider's copy.
export class KannaToolEventFilter {
  private readonly toolIds = new Set<string>()

  skip(entry: TranscriptEntry): boolean {
    if (entry.kind === "tool_call" && kannaToolName(entry.tool.toolName)) {
      this.toolIds.add(entry.tool.toolId)
      return true
    }
    if (entry.kind === "tool_result" && this.toolIds.delete(entry.toolId)) return true
    return false
  }
}

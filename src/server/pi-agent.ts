import path from "node:path"
import type {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  AgentSession,
  AgentSessionEvent,
} from "@mariozechner/pi-coding-agent"
import type { Model } from "@mariozechner/pi-ai"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Queue, Schema, Stream } from "effect"
import type { ContextWindowUsageSnapshot, HarnessSkill, LlmProviderKind, PiReasoningEffort } from "../shared/types"
import { getDataRootDir } from "../shared/branding"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessTurnEffect } from "./harness-types"
import { KANNA_TOOL_NAMES, type KannaToolHost } from "./kanna-tools"
import { createPiKannaTools } from "./kanna-tool-adapters"
import { buildKannaAgentCorrection, buildKannaAgentId } from "./attribution"
import { buildKannaSystemInstructions } from "./harness-instructions"
import { appendSystemMessageBlock } from "./harness-skills"
import { OPENROUTER_BASE_URL, readLlmProviderSnapshot } from "./llm-provider"
import { Machine } from "./platform/machine"
import { timestamped } from "./transcript"

/**
 * The pi SDK is loaded on first use, not at import time. Its module graph
 * pulls the AWS Bedrock, Google GenAI and Mistral clients and measures ~170 ms
 * to evaluate — paid on every boot, by every user, including the ones who
 * only ever pick Claude.
 */
let piSdkPromise: Promise<typeof import("@mariozechner/pi-coding-agent")> | null = null
const loadPiSdk = Effect.tryPromise({
  try: () => (piSdkPromise ??= import("@mariozechner/pi-coding-agent")),
  catch: (cause) => new PiAgentError({ operation: "load", message: failureText(cause), cause }),
})

/** A pi SDK call failed. The message is the SDK's own, which a failed turn shows the user. */
export class PiAgentError extends Schema.TaggedError<PiAgentError>()(
  "@kanna/server/pi-agent/PiAgentError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const failureText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const piCall = <A>(operation: string, call: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new PiAgentError({ operation, message: failureText(cause), cause }) })
const piSync = <A>(operation: string, call: () => A) =>
  Effect.try({ try: call, catch: (cause) => new PiAgentError({ operation, message: failureText(cause), cause }) })

/**
 * Adapter for the pi coding agent (@mariozechner/pi-coding-agent), driven
 * in-process through its SDK — the same way the Claude Agent SDK harness works,
 * rather than shelling out to a user-installed CLI.
 *
 * This is deliberately an opinionated, bundled setup:
 *   - Pi connects through Kanna's Model Registry (the OpenAI-compatible
 *     connection in Settings): OpenRouter, OpenAI, or any custom base URL.
 *     OPENROUTER_API_KEY is the env fallback when no registry is configured.
 *   - Any model id works: ids known to pi's catalog (for OpenRouter/OpenAI
 *     connections) resolve with full metadata, unknown ids get a synthesized
 *     OpenAI-completions model definition against the registry base URL.
 *   - Reasoning uses pi's standardized thinking levels
 *     (off/minimal/low/medium/high/xhigh), mapped by pi-ai to the endpoint's
 *     native reasoning parameter (`reasoning: { effort }` on OpenRouter,
 *     `reasoning_effort` on OpenAI-style APIs).
 *   - The user's local pi installation (~/.pi) is never read: state lives under
 *     Kanna's data root and credentials stay in memory. Markdown resources
 *     (skills + prompt templates) ARE discovered — from Kanna's agentDir,
 *     project `.pi/{skills,prompts}`, repo `.agents/skills`, and the shared
 *     `~/.agents/skills` — so `/name` invocation and the composer's "/" menu
 *     work. Extension and theme discovery stays disabled (extensions are
 *     arbitrary in-process code). Project AGENTS.md context files still apply.
 *
 * Pi's built-in tool set (read, bash, edit, write, grep, find, ls) is mapped
 * one-to-one onto Kanna's existing normalized tools via Claude-style names
 * (Read, Bash, Edit, Write, Grep, Glob), so everything renders natively.
 */


export const PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const

/** Claude-style tool names surfaced in system_init for the UI. */
export const PI_DISPLAY_TOOLS = ["Read", "Bash", "Edit", "Write", "Grep", "Glob"]

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Translate a pi tool call into the Claude-style tool name + snake_case input
 * that `normalizeToolCall` understands. Every one of pi's seven built-in tools
 * maps onto an existing Kanna tool kind:
 *
 *   read  → Read (read_file)      bash → Bash (bash)
 *   edit  → Edit (edit_file)      write → Write (write_file)
 *   grep  → Grep (grep)           find → Glob (glob)
 *   ls    → Glob (glob, `<path>/*` pattern)
 */
export function translatePiTool(
  rawName: string,
  args: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } {
  switch (rawName) {
    case "read":
      return {
        toolName: "Read",
        input: { file_path: args.path ?? "", offset: args.offset, limit: args.limit },
      }
    case "bash":
      return {
        toolName: "Bash",
        input: {
          command: args.command ?? "",
          // pi's bash timeout is in seconds; Kanna's normalized input is ms.
          timeout: typeof args.timeout === "number" ? args.timeout * 1000 : undefined,
        },
      }
    case "edit": {
      // pi's edit applies a list of {oldText, newText} replacements in one call.
      // Kanna's edit_file renders a single old/new pair, so multi-edit calls are
      // joined — each replacement still shows as its own hunk in the diff view.
      const edits = Array.isArray(args.edits) ? args.edits.map(asRecord) : []
      return {
        toolName: "Edit",
        input: {
          file_path: args.path ?? "",
          old_string: edits.map((edit) => edit.oldText ?? "").join("\n"),
          new_string: edits.map((edit) => edit.newText ?? "").join("\n"),
        },
      }
    }
    case "write":
      return {
        toolName: "Write",
        input: { file_path: args.path ?? "", content: args.content ?? "" },
      }
    case "grep":
      return {
        toolName: "Grep",
        input: {
          pattern: args.pattern ?? "",
          path: args.path,
          glob: args.glob,
          "-i": args.ignoreCase,
          "-C": args.context,
          head_limit: args.limit,
        },
      }
    case "find":
      return {
        toolName: "Glob",
        input: { pattern: args.pattern ?? "", path: args.path },
      }
    case "ls": {
      const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : "."
      return {
        toolName: "Glob",
        input: { pattern: `${dirPath.replace(/\/$/, "")}/*`, path: args.path },
      }
    }
    default:
      // Unmapped tools still render via unknown_tool.
      return { toolName: rawName, input: args }
  }
}

/**
 * Extract renderable content from a pi AgentToolResult ({ content: blocks[] }).
 * Text-only results collapse to a plain string; results with images keep the
 * block structure that `hydrateToolResult` understands.
 */
export function extractPiToolResultContent(result: unknown): unknown {
  const record = asRecord(result)
  const blocks = Array.isArray(record.content) ? record.content : null
  if (!blocks) {
    return typeof result === "string" ? result : record.output ?? result ?? ""
  }

  const hasImage = blocks.some((block) => asRecord(block).type === "image")
  if (hasImage) {
    return { content: blocks }
  }

  return blocks
    .map((block) => {
      const blockRecord = asRecord(block)
      return blockRecord.type === "text" && typeof blockRecord.text === "string" ? blockRecord.text : ""
    })
    .join("")
}

/** Map pi's per-message usage into Kanna's context-window snapshot. */
export function normalizePiUsage(usage: unknown, contextWindow?: number): ContextWindowUsageSnapshot | null {
  const record = asRecord(usage)
  const input = typeof record.input === "number" ? record.input : 0
  const output = typeof record.output === "number" ? record.output : 0
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0

  const inputTokens = input + cacheRead + cacheWrite
  const usedTokens = inputTokens + output
  if (usedTokens <= 0) return null

  return {
    usedTokens,
    inputTokens,
    ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
    ...(output > 0 ? { outputTokens: output } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheRead > 0 ? { lastCachedInputTokens: cacheRead } : {}),
    ...(output > 0 ? { lastOutputTokens: output } : {}),
    ...(contextWindow && contextWindow > 0 ? { maxTokens: contextWindow } : {}),
    compactsAutomatically: true,
  }
}

/** The Model Registry connection pi runs against. */
export interface PiConnection {
  provider: LlmProviderKind
  baseUrl: string
  apiKey: string
}

/**
 * Build a Model definition for an arbitrary model id against the registry's
 * base URL. Reasoning is enabled — endpoints ignore the reasoning parameter
 * for models that don't support it, and pi clamps levels per model.
 */
export function buildRegistryModel(connection: PiConnection, modelId: string): Model<"openai-completions"> {
  const isOpenRouter = connection.baseUrl.includes("openrouter.ai")
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: { thinkingFormat: isOpenRouter ? "openrouter" : "openai" },
  }
}

/**
 * Resolve pi's connection from the Model Registry settings; falls back to an
 * OpenRouter connection built from the OPENROUTER_API_KEY environment variable.
 */
export const resolvePiConnection = Effect.fn("PiAgent.resolveConnection")(function* () {
  // An unreadable registry falls through to the environment variable.
  const snapshot = yield* readLlmProviderSnapshot().pipe(
    Effect.map(Option.some),
    Effect.catchTag("@kanna/server/llm-provider/LlmProviderFileError", () => Effect.succeedNone),
  )
  if (Option.isSome(snapshot) && snapshot.value.apiKey && snapshot.value.resolvedBaseUrl) {
    return {
      provider: snapshot.value.provider,
      baseUrl: snapshot.value.resolvedBaseUrl,
      apiKey: snapshot.value.apiKey,
    } satisfies PiConnection
  }
  const envKey = (yield* Machine).env.get("OPENROUTER_API_KEY")?.trim()
  if (envKey) {
    return { provider: "openrouter", baseUrl: OPENROUTER_BASE_URL, apiKey: envKey } satisfies PiConnection
  }
  return null
})

export const MISSING_PI_CONNECTION_MESSAGE =
  "Pi needs a Model Registry connection. Add an API key under Settings → Providers → Model Registry (OpenRouter, OpenAI, or a custom OpenAI-compatible URL), or export OPENROUTER_API_KEY."

export interface StartPiTurnArgs {
  customTools?: KannaToolHost
  chatId: string
  cwd: string
  content: string
  /** Model id on the registry endpoint, e.g. "moonshotai/kimi-k2.6" or any arbitrary id. */
  model: string
  effort: PiReasoningEffort
  /** Previous pi session file path to resume, if any. */
  sessionToken: string | null
  forkSession: boolean
  /** Model Registry connection (or env fallback). Null surfaces an error turn. */
  connection: PiConnection | null
  /** The chat is a delegator, which its system prompt says. */
  delegator?: boolean
}

interface PiChatSession {
  session: AgentSession
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  resourceLoader: DefaultResourceLoader
  cwd: string
  model: string
  /**
   * The agent id baked into this session's appendSystemPrompt. Frozen at
   * session creation — unlike `model`, which setModel() updates in place — so a
   * mismatch against the turn's model is the drift the per-turn correction in
   * startTurn covers.
   */
  promptAgentId: string
  /** Baked into appendSystemPrompt too. A change opens a new session, which resumes the same file. */
  delegator: boolean
  effort: PiReasoningEffort
  connectionProvider: LlmProviderKind
  connectionBaseUrl: string
}

/**
 * Map pi's loaded resources (prompt templates + skills) into Kanna's
 * normalized skill list. Skills are invoked as `/skill:<name>` in pi (the
 * session expands `text.startsWith("/skill:")`), so the namespaced name is
 * what the composer must insert.
 */
export function collectPiSkills(loader: DefaultResourceLoader): HarnessSkill[] {
  const skills: HarnessSkill[] = []
  for (const template of loader.getPrompts().prompts) {
    skills.push({
      name: template.name,
      description: template.description ?? "",
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
      source: "command",
      path: template.filePath,
    })
  }
  for (const skill of loader.getSkills().skills) {
    skills.push({
      name: `skill:${skill.name}`,
      description: skill.description ?? "",
      source: "skill",
      path: skill.filePath,
    })
  }
  return skills
}


/** A turn that failed before the agent could start (missing key, bad session file). */
function failedPiTurn(message: string): HarnessTurnEffect {
  return {
    provider: "pi",
    events: Stream.make({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: message,
      }),
    }),
    interrupt: Effect.void,
  }
}

/**
 * Pi's sessions, one per chat. A session outlives its turns: the next turn on
 * the chat reuses it, and `closeChat` disposes it. A turn is what
 * `startTurn` opens in its scope.
 */
export class PiAgentManager {
  private readonly sessions = new Map<string, PiChatSession>()
  private readonly agentDir: string
  private readonly sessionsDir: string

  /** `dataDir` is pi's own directory under Kanna's data root (see `piDataDir`). */
  constructor(args: { dataDir: string }) {
    const dataDir = args.dataDir
    this.agentDir = path.join(dataDir, "agent")
    this.sessionsDir = path.join(dataDir, "sessions")
  }

  /**
   * Enumerate prompt templates + skills for the "/" menu. Reuses the live
   * session's resource loader when one exists (exactly what that session will
   * expand); otherwise runs a transient loader over the same roots. A live
   * session snapshots resources at creation, so a skill added mid-session
   * appears here (fresh menu) but only expands after the next session boot.
   */
  readonly listSkills = Effect.fn("PiAgent.listSkills")(function* (this: PiAgentManager, args: { chatId?: string; cwd: string }) {
    const existing = args.chatId ? this.sessions.get(args.chatId) : undefined
    if (existing && existing.cwd === args.cwd) {
      return collectPiSkills(existing.resourceLoader)
    }
    const { DefaultResourceLoader, SettingsManager } = yield* loadPiSdk
    const loader = new DefaultResourceLoader({
      cwd: args.cwd,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noThemes: true,
    })
    yield* piCall("reloadResources", () => loader.reload())
    return collectPiSkills(loader)
  })

  getResourceCounts() {
    return { piSessions: this.sessions.size }
  }

  closeChat(chatId: string) {
    const existing = this.sessions.get(chatId)
    if (!existing) return
    this.sessions.delete(chatId)
    existing.session.dispose()
  }

  dispose() {
    for (const chatId of [...this.sessions.keys()]) {
      this.closeChat(chatId)
    }
  }

  private resolveModel(registry: ModelRegistry, connection: PiConnection, modelId: string): Model<any> {
    // Only OpenRouter/OpenAI connections at their default base URL can borrow
    // pi's bundled model metadata; custom endpoints always get a synthesized
    // definition so requests target the configured base URL.
    if (connection.provider === "openrouter" || connection.provider === "openai") {
      const known = registry.find(connection.provider, modelId)
      if (known) return known
    }
    return buildRegistryModel(connection, modelId)
  }

  private readonly openSession = Effect.fn("PiAgent.openSession")(function* (this: PiAgentManager, args: StartPiTurnArgs & { connection: PiConnection }) {
    const existing = this.sessions.get(args.chatId)
    const connectionUnchanged = existing
      && existing.connectionProvider === args.connection.provider
      && existing.connectionBaseUrl === args.connection.baseUrl
    if (existing && connectionUnchanged && existing.cwd === args.cwd && existing.delegator === Boolean(args.delegator) && !args.forkSession) {
      existing.authStorage.setRuntimeApiKey(args.connection.provider, args.connection.apiKey)
      if (existing.model !== args.model) {
        yield* piCall("setModel", () => existing.session.setModel(this.resolveModel(existing.modelRegistry, args.connection, args.model)))
        existing.model = args.model
      }
      if (existing.effort !== args.effort) {
        existing.session.setThinkingLevel(args.effort)
        existing.effort = args.effort
      }
      return existing
    }

    if (existing) {
      this.sessions.delete(args.chatId)
      existing.session.dispose()
    }

    // All state is Kanna-owned: in-memory credentials/settings, sessions under
    // Kanna's data root, and no discovery of the user's ~/.pi setup.
    const { AuthStorage, ModelRegistry, SettingsManager, DefaultResourceLoader, SessionManager, createAgentSession } = yield* loadPiSdk
    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey(args.connection.provider, args.connection.apiKey)
    const modelRegistry = ModelRegistry.inMemory(authStorage)
    const settingsManager = SettingsManager.inMemory()

    // Skills and prompt templates (markdown-only resources) are discovered so
    // the "/" menu and `/name` invocation work: pi reads Kanna's agentDir plus
    // `<cwd>/.pi/{skills,prompts}`, repo `.agents/skills`, and `~/.agents/skills`
    // (the shared cross-harness dir — hardcoded to $HOME, not agentDir).
    // Extensions stay disabled: they are arbitrary TypeScript executed
    // in-process, and Kanna deliberately never runs code from ~/.pi or repos.
    const resourceLoader = new DefaultResourceLoader({
      cwd: args.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
      appendSystemPrompt: [buildKannaSystemInstructions(buildKannaAgentId("pi", args.model), { delegator: args.delegator })],
    })
    yield* piCall("reloadResources", () => resourceLoader.reload())

    const fs = yield* FileSystem.FileSystem
    // A session file that is gone (or unreadable) starts a fresh session, as a missing one always has.
    const sessionFileExists = args.sessionToken
      ? yield* fs.exists(args.sessionToken).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))
      : false
    const sessionToken = args.sessionToken
    const sessionManager = yield* piSync("openSessionFile", () => args.forkSession && sessionToken && sessionFileExists
      ? SessionManager.forkFrom(sessionToken, args.cwd, this.sessionsDir)
      : sessionToken && sessionFileExists
        ? SessionManager.open(sessionToken, this.sessionsDir, args.cwd)
        : SessionManager.create(args.cwd, this.sessionsDir))

    const { session } = yield* piCall("createSession", () => createAgentSession({
      cwd: args.cwd,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      resourceLoader,
      model: this.resolveModel(modelRegistry, args.connection, args.model),
      thinkingLevel: args.effort,
      tools: [...PI_TOOL_NAMES, ...(args.customTools ? KANNA_TOOL_NAMES : [])],
      customTools: args.customTools ? createPiKannaTools(args.customTools) : undefined,
    }))

    const chatSession: PiChatSession = {
      session,
      authStorage,
      modelRegistry,
      resourceLoader,
      cwd: args.cwd,
      model: args.model,
      promptAgentId: buildKannaAgentId("pi", args.model),
      delegator: Boolean(args.delegator),
      effort: args.effort,
      connectionProvider: args.connection.provider,
      connectionBaseUrl: args.connection.baseUrl,
    }
    this.sessions.set(args.chatId, chatSession)
    return chatSession
  })

  /**
   * One turn on the chat's session, in the caller's scope. The turn's events
   * are what the session reports from the moment the prompt is sent; closing
   * the scope interrupts the prompt (which aborts the model call through its
   * signal, so it can't keep executing tools invisibly after the turn is
   * discarded) and ends the events. The session itself stays for the next
   * turn. A turn that cannot start is a turn whose only event is the error.
   */
  readonly startTurn = Effect.fn("PiAgent.startTurn")(function* (this: PiAgentManager, args: StartPiTurnArgs) {
    yield* Effect.annotateCurrentSpan("chatId", args.chatId)
    if (!args.connection) {
      return failedPiTurn(MISSING_PI_CONNECTION_MESSAGE)
    }

    // Whatever stops the session from opening, a thrown bug included, is the
    // turn's error result, as it always was, not a failed startTurn.
    const opened = yield* Effect.exit(this.openSession({ ...args, connection: args.connection }))
    if (Exit.isFailure(opened)) {
      if (Cause.hasInterruptsOnly(opened.cause)) return yield* Effect.interrupt
      return failedPiTurn(failureText(Cause.squash(opened.cause)))
    }
    const chatSession = opened.value
    const session = chatSession.session
    // A previous turn on this reused session may still be streaming (its turn
    // was closed without an interrupt); pi throws on concurrent prompt() calls,
    // so stop the old run before starting the new one.
    if (session.isStreaming) {
      yield* piCall("abort", () => session.abort())
    }
    const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
    const push = (event: HarnessEvent) => { Queue.offerUnsafe(events, event) }
    const startedAt = Date.now()

    let finished = false
    let turnCostUsd = 0
    let lastError: string | null = null
    let aborted = false

    const pushSessionToken = () => {
      if (session.sessionFile) {
        push({ type: "session_token", sessionToken: session.sessionFile })
      }
    }

    const listener = (event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_end": {
          const message = asRecord(event.message)
          if (message.role !== "assistant") return

          const usageRecord = asRecord(message.usage)
          if (typeof usageRecord.cost === "object") {
            const total = asRecord(usageRecord.cost).total
            if (typeof total === "number") turnCostUsd += total
          }
          const usage = normalizePiUsage(message.usage, session.model?.contextWindow)
          if (usage) {
            push({
              type: "transcript",
              entry: timestamped({ kind: "context_window_updated", usage }),
            })
          }

          if (message.stopReason === "error") {
            lastError = typeof message.errorMessage === "string" && message.errorMessage
              ? message.errorMessage
              : "Pi turn failed"
          }
          if (message.stopReason === "aborted") {
            aborted = true
          }

          const text = Array.isArray(message.content)
            ? message.content
              .map((block) => {
                const blockRecord = asRecord(block)
                return blockRecord.type === "text" && typeof blockRecord.text === "string" ? blockRecord.text : ""
              })
              .join("")
            : ""
          if (text.trim()) {
            push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) })
          }
          return
        }

        case "tool_execution_start": {
          const { toolName, input } = translatePiTool(event.toolName, asRecord(event.args))
          push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_call",
              tool: normalizeToolCall({ toolName, toolId: event.toolCallId, input }),
            }),
          })
          return
        }

        case "tool_execution_end": {
          push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_result",
              toolId: event.toolCallId,
              content: extractPiToolResultContent(event.result),
              isError: event.isError,
            }),
          })
          return
        }

        default:
          return
      }
    }

    // The subscription is the turn's: its release is the turn's end, with
    // the session file's token and, unless the turn was cancelled, its result.
    let unsubscribe: (() => void) | null = null
    const finalize = (result: { isError: boolean; message: string; cancelled?: boolean }) => {
      if (finished) return
      finished = true
      unsubscribe?.()
      unsubscribe = null
      pushSessionToken()
      if (!result.cancelled) {
        push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: result.isError ? "error" : "success",
            isError: result.isError,
            durationMs: Date.now() - startedAt,
            result: result.message,
            ...(turnCostUsd > 0 ? { costUsd: turnCostUsd } : {}),
          }),
        })
      }
      Queue.endUnsafe(events)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => { unsubscribe = session.subscribe(listener) }),
      () => Effect.sync(() => finalize({ isError: false, message: "", cancelled: true })),
    )

    push({
      type: "transcript",
      entry: timestamped({
        kind: "system_init",
        provider: "pi",
        model: args.model,
        tools: [...PI_DISPLAY_TOOLS],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
    })
    pushSessionToken()

    // setModel() swaps the model on the live session without recreating its
    // resource loader, so the agent id in the system prompt can be stale.
    // Re-state it on the turn text from the drift onward.
    const piAgentId = buildKannaAgentId("pi", args.model)
    const piContent = chatSession.promptAgentId === piAgentId
      ? args.content
      : appendSystemMessageBlock(args.content, buildKannaAgentCorrection(piAgentId))

    // The prompt runs in the turn's scope. Interrupting it (closing the
    // scope) aborts the session's in-flight model call through the signal.
    // It starts before startTurn returns, so an interrupt that follows at
    // once finds the run streaming and stops it.
    yield* Effect.forkScoped({ startImmediately: true })(Effect.tryPromise({
      try: (signal) => {
        signal.addEventListener("abort", () => {
          if (session.isStreaming) void session.abort().catch(() => {})
        }, { once: true })
        return session.prompt(piContent)
      },
      catch: (cause) => new PiAgentError({ operation: "prompt", message: failureText(cause), cause }),
    }).pipe(
      Effect.match({
        onSuccess: () => {
          if (aborted) {
            finalize({ isError: false, message: "", cancelled: true })
          } else if (lastError) {
            finalize({ isError: true, message: lastError })
          } else {
            finalize({ isError: false, message: "" })
          }
        },
        onFailure: (error) => finalize({ isError: true, message: error.message }),
      }),
    ))

    return {
      provider: "pi",
      events: Stream.fromQueue(events),
      // Pi stops the run; the turn's events end on their own once it has.
      interrupt: Effect.promise(() => session.abort()),
    } satisfies HarnessTurnEffect
  })
}

/** Pi's directory under Kanna's data root on a machine whose home is `homeDirectory`. */
export function piDataDir(homeDirectory: string) {
  return path.join(getDataRootDir(homeDirectory), "pi")
}

export class PiAgent extends Context.Service<PiAgent, PiAgentManager>()("@kanna/server/PiAgent") {
  static readonly layer = (args: { dataDir?: string } = {}) => Layer.effect(this, Effect.acquireRelease(
    Effect.gen(function* () {
      const machine = yield* Machine
      return new PiAgentManager({ dataDir: args.dataDir ?? piDataDir(machine.homeDirectory) })
    }),
    (manager) => Effect.sync(() => manager.dispose()),
  ))
}

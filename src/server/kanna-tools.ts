import { Cause, Context, Effect, Exit, Schema, Semaphore } from "effect"
import type { NormalizedToolCall, TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessToolRequest } from "./harness-types"
import { timestamped } from "./transcript"
import { DISPLAY_TOOLS } from "./kanna-display-tools"
import { GENERATE_IMAGES_TOOL } from "./kanna-image-tools"
import { ORCHESTRATION_TOOLS } from "./kanna-orchestration-tools"
import { decodeToolArguments, validateToolValueSync } from "./kanna-tool-arguments"
import {
  failureText,
  KannaToolInputError,
  toKannaTool,
  type KannaTool,
  type KannaToolContext,
  type KannaToolDefinition,
  type KannaToolOutput,
  type KannaToolResult,
  type KannaToolServices,
} from "./kanna-tool-definition"
import type { Orchestrator } from "./orchestrator"
import { KannaLoggerLayer } from "./effect/logger"

export {
  defineKannaTool,
  KannaToolCallError,
  KannaToolInputError,
  KannaToolRefusal,
  toKannaTool,
  type KannaTool,
  type KannaToolContext,
  type KannaToolDefinition,
  type KannaToolFailure,
  type KannaToolOutput,
  type KannaToolPromiseContext,
  type KannaToolResult,
} from "./kanna-tool-definition"

/**
 * The most a tool's description can be. Claude Code cuts every MCP tool
 * description at this many characters (`Sx=2048` in the CLI the Agent SDK
 * ships, 0.3.277) and ends it "[truncated]". What a tool has to say past
 * this goes in the session instructions (`harness-instructions.ts`).
 */
export const KANNA_TOOL_DESCRIPTION_LIMIT = 2048

// Add tools here. Every provider registers the same definitions and calls the same handlers.
export const KANNA_TOOLS: readonly KannaTool[] = [...DISPLAY_TOOLS, GENERATE_IMAGES_TOOL, ...ORCHESTRATION_TOOLS]

export const KANNA_TOOL_NAMES = KANNA_TOOLS.map((tool) => tool.name)

export function kannaToolName(name: string): string | undefined {
  return KANNA_TOOL_NAMES.find((candidate) => name === candidate || name === `mcp__kanna__${candidate}`)
}

/** A tool's JSON Schema, as providers are given it: an object schema. */
export interface KannaToolInputSchema {
  [key: string]: unknown
  type: "object"
  properties?: Record<string, object>
}

export function kannaToolSpecs(): Array<{ name: string; description: string; inputSchema: KannaToolInputSchema }> {
  return KANNA_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as KannaToolInputSchema }))
}

/**
 * How a provider's agent calls the tools: by name, with the arguments the
 * model wrote, cancelled through `signal`. Every provider gets one of these
 * from agent.ts; `kanna-mcp.ts` serves it over HTTP and
 * `kanna-tool-adapters.ts` hands it to Claude and pi.
 */
export interface KannaToolHost {
  execute: (name: string, input: unknown, signal?: AbortSignal) => Promise<KannaToolResult>
}

/** Writing a transcript entry for a call failed. */
export class KannaToolEmitError extends Schema.TaggedError<KannaToolEmitError>()(
  "@kanna/server/kanna-tools/KannaToolEmitError",
  {
    chatId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The chat a runtime's calls belong to, and how they reach the transcript and the user. */
export interface KannaToolSession {
  readonly chatId: string
  readonly cwd: string
  readonly dataDir?: string
  readonly orchestration?: Orchestrator["Service"]
  readonly emit: (entry: TranscriptEntry) => Effect.Effect<void, KannaToolEmitError>
  /** Shows the question and waits for the reply. Interrupting it withdraws the question. */
  readonly requestInput: (request: HarnessToolRequest) => Effect.Effect<unknown, KannaToolInputError>
}

/** Runs calls for one chat. */
export interface KannaToolExecutor {
  /**
   * One call. It never fails: a failure is an error result, in the words the
   * agent reads. Interrupting it is the cancel; a call that had started
   * records "Cancelled" in the transcript.
   */
  readonly execute: (name: string, input: unknown) => Effect.Effect<KannaToolResult>
}

/** What a cancelled call returns, as it always has. */
export const CANCELLED_TOOL_RESULT: KannaToolResult = {
  content: [{ type: "text", text: "Cancelled" }],
  isError: true,
  structuredContent: { discarded: true },
}

const errorResult = (text: string): KannaToolOutput => ({ content: [{ type: "text", text }], isError: true })

/** The user's reply to `requestInput`'s question. Other keys are allowed and dropped, as before. */
const UserAnswer = Schema.Struct({
  answers: Schema.Struct({ value: Schema.Array(Schema.String).check(Schema.isMinLength(1)) }),
})
const decodeUserAnswer = decodeToolArguments("AskUserQuestion", UserAnswer, { strict: false })
const validateUserAnswer = validateToolValueSync(UserAnswer, { strict: false })

/**
 * The tool runner for one chat. Each call decodes its arguments, records the
 * call and its result in the transcript (the provider's own copy is dropped
 * by `KannaToolEventFilter`), and turns every failure into an error result.
 * Calls that ask the user wait for each other, so two questions never
 * replace each other.
 */
export const makeKannaToolExecutor = Effect.fn("KannaTools.makeExecutor")(function* (
  session: KannaToolSession,
  definitions: readonly KannaTool[] = KANNA_TOOLS,
) {
  yield* Effect.annotateCurrentSpan("chatId", session.chatId)
  const services = yield* Effect.context<KannaToolServices>()
  const questions = yield* Semaphore.make(1)

  const run = Effect.fn("KannaTools.call")(function* (tool: KannaTool, input: unknown) {
    yield* Effect.annotateCurrentSpan("chatId", session.chatId)
    yield* Effect.annotateCurrentSpan("tool", tool.name)
    const toolId = `kanna-${crypto.randomUUID()}`
    let started = false

    const recordCall = (call: NormalizedToolCall) => session.emit(timestamped({ kind: "tool_call", tool: call })).pipe(
      Effect.tap(() => Effect.sync(() => { started = true })),
      Effect.uninterruptible,
    )
    const recordResult = (result: KannaToolOutput) => started
      ? session.emit(timestamped({
        kind: "tool_result",
        toolId,
        content: result.transcriptContent ?? result.structuredContent ?? result.content,
        isError: result.isError,
      }))
      : Effect.void

    const context: KannaToolContext = {
      chatId: session.chatId,
      cwd: session.cwd,
      dataDir: session.dataDir,
      orchestration: session.orchestration,
      requestInput: Effect.fn("KannaTools.requestInput")(function* (prompt: string) {
        const call = normalizeToolCall({ toolName: "AskUserQuestion", toolId, input: { questions: [{ id: "value", question: prompt, options: [] }] } })
        yield* recordCall(call).pipe(
          Effect.catchTag("@kanna/server/kanna-tools/KannaToolEmitError", (cause) =>
            Effect.fail(new KannaToolInputError({ chatId: session.chatId, message: cause.message, cause }))),
        )
        if (call.toolKind !== "ask_user_question") {
          return yield* new KannaToolInputError({ chatId: session.chatId, message: "Tool does not support user input", cause: null })
        }
        const response = yield* session.requestInput({ tool: call, resultOwner: "tool", validateResult: (value) => { validateUserAnswer(value) } })
        const answer = yield* decodeUserAnswer(response).pipe(
          Effect.catchTag("@kanna/server/kanna-tool-arguments/KannaToolArgumentsError", (cause) =>
            Effect.fail(new KannaToolInputError({ chatId: session.chatId, message: cause.message, cause }))),
        )
        return answer.answers.value[0]!
      }),
    }

    // Only the tool's own work can be cancelled. Once it has a result, that
    // result is recorded and returned as one step, so the agent and the
    // transcript never disagree about how the call ended.
    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const result = yield* restore(Effect.gen(function* () {
        const args = yield* tool.decode(input)
        if (!tool.waitsForUser) yield* recordCall(normalizeToolCall({ toolName: tool.name, toolId, input: args }))
        return yield* tool.execute(args, context)
      })).pipe(
        // Every failure is the call's result: the agent reads its text and decides what to do.
        Effect.catch((error) => Effect.succeed(errorResult(error.message))),
        // The tools always reported a thrown bug the same way, rather than failing the turn.
        Effect.catchDefect((defect) => Effect.succeed(errorResult(failureText(defect)))),
        Effect.onInterrupt(() => recordResult(CANCELLED_TOOL_RESULT).pipe(Effect.orDie)),
        Effect.provideContext(services),
      )
      yield* recordResult(result).pipe(Effect.orDie)
      const { transcriptContent: _, ...providerResult } = result
      return providerResult as KannaToolResult
    }))
  })

  const execute = (name: string, input: unknown): Effect.Effect<KannaToolResult> => {
    const tool = definitions.find((candidate) => candidate.name === name)
    if (!tool) return Effect.succeed(errorResult(`Unknown Kanna tool: ${name}`))
    return tool.waitsForUser ? questions.withPermits(1)(run(tool, input)) : run(tool, input)
  }
  return { execute } satisfies KannaToolExecutor
})

/**
 * Runs one call from Promise code, cancelled by `signal`: the cancelled
 * result comes back as a value, as it did before the tools moved to Effect.
 * Used by the MCP servers and the pi adapter, whose SDKs call with a signal.
 */
export const runKannaToolCall = (call: Effect.Effect<KannaToolResult>, signal?: AbortSignal): Promise<KannaToolResult> => {
  // A call cancelled before it runs records nothing: the fiber would otherwise start before it saw the signal.
  if (signal?.aborted) return Promise.resolve(CANCELLED_TOOL_RESULT)
  return Effect.runPromiseExit(call.pipe(Effect.provide(KannaLoggerLayer)), signal ? { signal } : undefined).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasInterruptsOnly(exit.cause)) return CANCELLED_TOOL_RESULT
    throw Cause.squash(exit.cause)
  })
}

/**
 * The Promise face of `makeKannaToolExecutor`, for agent.ts until it moves
 * to Effect (wave 4 of docs/effect-migration.md). `abort()` cancels every
 * call in flight, as the end of a turn does.
 */
export class KannaToolRuntime implements KannaToolHost {
  private readonly abortController = new AbortController()
  private readonly executor: KannaToolExecutor

  constructor(context: {
    chatId: string
    cwd: string
    dataDir?: string
    emit: (entry: TranscriptEntry) => Promise<void>
    requestInput: (request: HarnessToolRequest, signal: AbortSignal) => Promise<unknown>
    orchestration?: Orchestrator["Service"]
    /** The platform the tools read files and the environment through. */
    platform: Context.Context<KannaToolServices>
  }, definitions: readonly (KannaTool | KannaToolDefinition)[] = KANNA_TOOLS) {
    const session: KannaToolSession = {
      chatId: context.chatId,
      cwd: context.cwd,
      dataDir: context.dataDir,
      orchestration: context.orchestration,
      emit: (entry) => Effect.tryPromise({
        try: () => context.emit(entry),
        catch: (cause) => new KannaToolEmitError({ chatId: context.chatId, message: failureText(cause), cause }),
      }),
      requestInput: (request) => Effect.tryPromise({
        try: (signal) => context.requestInput(request, signal),
        catch: (cause) => new KannaToolInputError({ chatId: context.chatId, message: failureText(cause), cause }),
      }),
    }
    this.executor = Effect.runSync(makeKannaToolExecutor(session, definitions.map(toKannaTool)).pipe(Effect.provide(context.platform)))
  }

  abort() {
    this.abortController.abort()
  }

  execute(name: string, input: unknown, signal?: AbortSignal): Promise<KannaToolResult> {
    const callSignal = signal ? AbortSignal.any([signal, this.abortController.signal]) : this.abortController.signal
    return runKannaToolCall(this.executor.execute(name, input), callSignal)
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

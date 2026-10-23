import { query } from "@anthropic-ai/claude-agent-sdk"
import OpenAI from "openai"
import { Context, Effect, FileSystem, Layer, Option, Schema, Scope, Stream } from "effect"
import { getDataRootDir } from "../shared/branding"
import type { LlmProviderSnapshot } from "../shared/types"
import { type ClaudeExecutableError, requireClaudeExecutable } from "./claude-executable"
import { CodexAppServer, makeCodexAppServer } from "./codex-app-server"
import { runKannaSync } from "./effect/bridge"
import type { PlatformServices } from "./platform"
import { type LlmProviderFileError, readLlmProviderSnapshot } from "./llm-provider"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import { ProcessSpawner } from "./platform/process-spawner"
import type { CommandSpawnError } from "./process-utils"

const CLAUDE_STRUCTURED_TIMEOUT_MS = 5_000
const CODEX_STRUCTURED_MODEL = "gpt-5.4-mini"

type JsonSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: readonly string[]
  additionalProperties?: boolean
}

export interface StructuredQuickResponseArgs<T> {
  cwd: string
  task: string
  prompt: string
  schema: JsonSchema
  parse: (value: unknown) => T | null
}

/** What a provider is asked: the args without the caller's parser. */
export type QuickResponseRequest = Omit<StructuredQuickResponseArgs<unknown>, "parse">

export type QuickResponseProvider = "openai" | "claude" | "codex"

/** A provider's request failed (the SDK threw, the network failed, the app-server errored). */
export class QuickResponseRequestError extends Schema.TaggedError<QuickResponseRequestError>()(
  "@kanna/server/quick-response/QuickResponseRequestError",
  {
    provider: Schema.Literals(["openai", "claude", "codex"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class QuickResponseParseError extends Schema.TaggedError<QuickResponseParseError>()(
  "@kanna/server/quick-response/QuickResponseParseError",
  {
    provider: Schema.Literals(["openai", "claude", "codex"]),
    task: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Any way a provider can fail; each one becomes a failure reason and the next provider is tried. */
export type QuickResponseRunError = QuickResponseRequestError | ClaudeExecutableError | CommandSpawnError

type QuickResponseRunner = (request: QuickResponseRequest) => Effect.Effect<unknown | null, QuickResponseRunError>

export interface QuickResponseOptions {
  codexManager?: Pick<CodexAppServer["Service"], "generateStructured">
  readLlmProvider?: Effect.Effect<LlmProviderSnapshot, LlmProviderFileError>
  runOpenAIStructured?: (
    config: LlmProviderSnapshot,
    request: QuickResponseRequest,
  ) => Effect.Effect<unknown | null, QuickResponseRunError>
  runClaudeStructured?: QuickResponseRunner
  runCodexStructured?: QuickResponseRunner
}

export interface StructuredQuickResponseFailure {
  provider: QuickResponseProvider
  reason: string
}

export interface StructuredQuickResponseResult<T> {
  value: T | null
  failures: StructuredQuickResponseFailure[]
}

/**
 * One-shot structured answers (chat titles, commit messages) from whichever
 * model is available: the user's own OpenAI-compatible provider when it is
 * enabled, then Claude (haiku), then Codex. The first that returns output the
 * caller's `parse` accepts wins; every miss before it is reported in
 * `failures`.
 */
export class QuickResponse extends Context.Service<QuickResponse, {
  readonly generateStructured: <T>(args: StructuredQuickResponseArgs<T>) => Effect.Effect<T | null, LlmProviderFileError>
  readonly generateStructuredWithDiagnostics: <T>(
    args: StructuredQuickResponseArgs<T>,
  ) => Effect.Effect<StructuredQuickResponseResult<T>, LlmProviderFileError>
}>()("@kanna/server/QuickResponse") {
  static readonly layer = (options: QuickResponseOptions = {}) => Layer.effect(this, makeQuickResponse(options))
  static readonly layerWithCodex = Layer.effect(this, Effect.gen(function* () {
    const codexManager = yield* CodexAppServer
    return yield* makeQuickResponse({ codexManager })
  }))
}

export function getQuickResponseWorkspace(env: Record<string, string | undefined>, homeDirectory: string) {
  return getDataRootDir(homeDirectory, env)
}

const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parseJsonText(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const candidates = [trimmed]
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch?.[1]) {
    candidates.unshift(fencedMatch[1].trim())
  }

  for (const candidate of candidates) {
    const parsed = decodeJsonOption(candidate)
    if (Option.isSome(parsed)) return parsed.value
  }

  return null
}

function structuredOutputFromSdkMessage(message: unknown): unknown | null {
  if (!message || typeof message !== "object") return null

  const record = message as Record<string, unknown>
  if (record.type === "result") {
    return record.structured_output ?? null
  }

  const assistantMessage = record.message
  if (!assistantMessage || typeof assistantMessage !== "object") return null
  const content = (assistantMessage as { content?: unknown }).content
  if (!Array.isArray(content)) return null

  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const toolUse = item as Record<string, unknown>
    if (toolUse.type === "tool_use" && toolUse.name === "StructuredOutput") {
      return toolUse.input ?? null
    }
  }

  return null
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

const requestError = (provider: QuickResponseProvider) => (cause: unknown) =>
  new QuickResponseRequestError({ provider, message: errorMessage(cause), cause })

/**
 * Ask haiku through the Agent SDK, on the user's own `claude`. Anything that
 * goes wrong once the query is running (including the 5 s budget running out)
 * reads as no result; a missing or outdated `claude` is a failure.
 */
export const runClaudeStructured = Effect.fn("QuickResponse.runClaude")(function* (request: QuickResponseRequest) {
  const pathToClaudeCodeExecutable = yield* requireClaudeExecutable()
  const machine = yield* Machine
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => query({
        prompt: request.prompt,
        options: {
          cwd: request.cwd,
          pathToClaudeCodeExecutable,
          // Family alias — the harness resolves it to the latest haiku release.
          model: "haiku",
          tools: [],
          systemPrompt: "",
          effort: "low",
          permissionMode: "bypassPermissions",
          outputFormat: {
            type: "json_schema",
            schema: request.schema,
          },
          env: machine.env.snapshot(),
        },
      }),
      catch: requestError("claude"),
    }),
    (q) => Stream.fromAsyncIterable(q, requestError("claude")).pipe(
      Stream.map(structuredOutputFromSdkMessage),
      Stream.filter((output) => output !== null),
      Stream.runHead,
      Effect.timeoutOption(CLAUDE_STRUCTURED_TIMEOUT_MS),
      Effect.map((output) => Option.getOrNull(Option.flatten(output))),
      Effect.catchTag("@kanna/server/quick-response/QuickResponseRequestError", () => Effect.succeed(null)),
    ),
    // Close failures on timed-out or failed quick responses don't matter.
    (q) => Effect.try({ try: () => q.close(), catch: requestError("claude") }).pipe(Effect.ignore),
  )
})

export const runOpenAIStructured = Effect.fn("QuickResponse.runOpenAI")(function* (
  config: LlmProviderSnapshot,
  request: QuickResponseRequest,
) {
  const client = yield* Effect.try({
    try: () => new OpenAI({ apiKey: config.apiKey, baseURL: config.resolvedBaseUrl }),
    catch: requestError("openai"),
  })
  const response = yield* Effect.tryPromise({
    try: (signal) => client.responses.create({
      model: config.model,
      input: request.prompt,
      text: {
        format: {
          type: "json_schema",
          name: "quick_response",
          schema: request.schema,
          strict: true,
        },
      },
    }, { signal }),
    catch: requestError("openai"),
  })
  return parseJsonText(response.output_text)
})

export const runCodexStructured = Effect.fn("QuickResponse.runCodex")(function* (
  codexManager: Pick<CodexAppServer["Service"], "generateStructured">,
  request: QuickResponseRequest,
) {
  const response = yield* codexManager.generateStructured({
    cwd: request.cwd,
    model: CODEX_STRUCTURED_MODEL,
    prompt: `${request.prompt}\n\nReturn JSON only that matches this schema:\n${JSON.stringify(request.schema, null, 2)}`,
  }).pipe(
    Effect.catchTags({
      "@kanna/server/codex-app-server/CodexSpawnError": (error) => Effect.fail(requestError("codex")(error)),
      "@kanna/server/codex-app-server/CodexRequestError": (error) => Effect.fail(requestError("codex")(error)),
    }),
  )
  if (typeof response !== "string") return null
  return parseJsonText(response)
})

const makeQuickResponse = Effect.fn("QuickResponse.make")(function* (options: QuickResponseOptions) {
  const machine = yield* Machine
  const platformContext = Context.pick(FileSystem.FileSystem, Machine, ProcessSpawner, FileSystemExtras)(
    yield* Effect.context<FileSystem.FileSystem | Machine | ProcessSpawner | FileSystemExtras>(),
  )
  // Its sessions are killed when the layer closes.
  const codexManager = options.codexManager ?? (yield* makeCodexAppServer())
  const readLlmProvider = options.readLlmProvider
    ?? readLlmProviderSnapshot().pipe(Effect.provide(platformContext))
  const runOpenAI = options.runOpenAIStructured ?? runOpenAIStructured
  const runClaude: QuickResponseRunner = options.runClaudeStructured
    ?? ((request) => runClaudeStructured(request).pipe(Effect.provide(platformContext)))
  const runCodex: QuickResponseRunner = options.runCodexStructured
    ?? ((request) => runCodexStructured(codexManager, request))

  /** One provider's answer, or why it gave none. */
  const tryProvider = <T>(
    provider: QuickResponseProvider,
    task: string,
    parse: (value: unknown) => T | null,
    run: Effect.Effect<unknown | null, QuickResponseRunError>,
  ): Effect.Effect<{ value: T | null; failure: StructuredQuickResponseFailure | null }> => {
    const failed = (error: QuickResponseRunError) => Effect.succeed({
      value: null,
      failure: { provider, reason: `${provider} failed ${task}: ${error.message}` },
    })
    return run.pipe(
      Effect.flatMap((result) => {
        if (result === null) {
          return Effect.succeed({ value: null, failure: { provider, reason: `${provider} returned no result for ${task}` } })
        }
        return Effect.try({
          try: () => parse(result),
          catch: (cause) => new QuickResponseParseError({ provider, task, cause }),
        }).pipe(Effect.map((parsed) => parsed === null
          ? { value: null, failure: { provider, reason: `${provider} returned invalid structured output for ${task}` } }
          : { value: parsed, failure: null }))
      }),
      Effect.catchTags({
        "@kanna/server/quick-response/QuickResponseRequestError": failed,
        "@kanna/server/quick-response/QuickResponseParseError": () => Effect.succeed({
          value: null,
          failure: { provider, reason: `${provider} returned invalid structured output for ${task}` },
        }),
        "@kanna/server/claude-executable/ClaudeExecutableError": failed,
        "@kanna/server/process-utils/CommandSpawnError": failed,
      }),
    )
  }

  // A plain function with a span rather than `Effect.fn`, which would drop
  // the type parameter.
  const generateStructuredWithDiagnostics = <T>(args: StructuredQuickResponseArgs<T>) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("task", args.task)
      const request: QuickResponseRequest = {
        cwd: getQuickResponseWorkspace(machine.env.snapshot(), machine.homeDirectory),
        task: args.task,
        prompt: args.prompt,
        schema: args.schema,
      }

      const failures: StructuredQuickResponseFailure[] = []
      const llmProvider = yield* readLlmProvider
      // In order, each only once the one before it came up empty.
      type Attempt = readonly [QuickResponseProvider, Effect.Effect<unknown | null, QuickResponseRunError>]
      const openAI: Attempt[] = llmProvider.enabled ? [["openai", Effect.suspend(() => runOpenAI(llmProvider, request))]] : []
      const attempts: Attempt[] = [
        ...openAI,
        ["claude", Effect.suspend(() => runClaude(request))],
        ["codex", Effect.suspend(() => runCodex(request))],
      ]
      for (const [provider, run] of attempts) {
        const result = yield* tryProvider(provider, args.task, args.parse, run)
        if (result.value !== null) return { value: result.value, failures }
        if (result.failure) failures.push(result.failure)
      }
      return { value: null, failures } satisfies StructuredQuickResponseResult<T>
    }).pipe(Effect.withSpan("QuickResponse.generateStructured"))

  return QuickResponse.of({
    generateStructuredWithDiagnostics,
    generateStructured: (args) => generateStructuredWithDiagnostics(args).pipe(Effect.map((result) => result.value)),
  })
})

let sharedQuickResponse: QuickResponse["Service"] | null = null

/**
 * One process-wide `QuickResponse` for callers still on Promises (the agent's
 * title generation, diff-store's commit messages), so they share one
 * CodexAppServer instead of building a fallback stack per request.
 * Goes away when those callers get the service from the server's runtime.
 */
export function getSharedQuickResponse(platform: Context.Context<PlatformServices>): QuickResponse["Service"] {
  // A scope never closed, as the process-wide instance lives as long as the process.
  sharedQuickResponse ??= runKannaSync(makeQuickResponse({}).pipe(Effect.provide(platform), Scope.provide(Scope.makeUnsafe())))
  return sharedQuickResponse
}

/** Runs `effect` against the process-wide `QuickResponse`, built on `platform` the first time. */
export const withSharedQuickResponse = <A, E>(
  platform: Context.Context<PlatformServices>,
  effect: Effect.Effect<A, E, QuickResponse>,
): Effect.Effect<A, E> =>
  Effect.suspend(() => Effect.provideService(effect, QuickResponse, getSharedQuickResponse(platform)))

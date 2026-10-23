import { Effect, Schema, type FileSystem } from "effect"
import { z } from "zod"
import { decodeToolArguments, KannaToolArgumentsError, toolInputSchema } from "./kanna-tool-arguments"
import type { Orchestrator } from "./orchestrator"
import type { FileSystemExtras } from "./platform/file-system-extras"
import type { Machine } from "./platform/machine"

/**
 * What a Kanna tool is. Kept apart from `kanna-tools.ts`, which lists the
 * tools, so a tool module can build itself here without a cycle.
 */

export interface KannaToolResult {
  [key: string]: unknown
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** A result and what the transcript keeps of it, when that differs from what the provider is sent. */
export type KannaToolOutput = KannaToolResult & { transcriptContent?: unknown }

/** Every failure a tool can have carries the text the agent reads as its result. */
export interface KannaToolFailure {
  readonly _tag: string
  readonly message: string
}

/** A call the tool refuses, in words the agent can act on ("Provide exactly one of html or path."). */
export class KannaToolRefusal extends Schema.TaggedError<KannaToolRefusal>()(
  "@kanna/server/kanna-tools/KannaToolRefusal",
  {
    tool: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Something a tool called failed: a file, the orchestrator, a provider. The
 * message is the failure's own, as the agent read it before.
 */
export class KannaToolCallError extends Schema.TaggedError<KannaToolCallError>()(
  "@kanna/server/kanna-tools/KannaToolCallError",
  {
    tool: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Asking the user failed, or the reply did not answer the question. */
export class KannaToolInputError extends Schema.TaggedError<KannaToolInputError>()(
  "@kanna/server/kanna-tools/KannaToolInputError",
  {
    chatId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The text of anything thrown, as the tools have always reported it. */
export const failureText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/**
 * The text a platform failure is reported with: the underlying node error's
 * own ("ENOENT: no such file or directory, open '…'"), which is what the
 * agent read when the tools called node directly.
 */
export const platformFailureText = (error: { readonly message: string; readonly cause?: unknown }): string =>
  error.cause instanceof Error ? error.cause.message : error.message

/** What a tool gets besides its arguments. Interrupting the call is the cancel: there is no signal. */
export interface KannaToolContext {
  readonly chatId: string
  readonly cwd: string
  readonly dataDir?: string
  /** Absent only where a runtime is built without a server behind it, as in tests. */
  readonly orchestration?: Orchestrator["Service"]
  /** Asks the user one question and waits for the answer. Only for a tool with `waitsForUser`. */
  readonly requestInput: (prompt: string) => Effect.Effect<string, KannaToolInputError>
}

/** The services a tool may use. The runtime provides them. */
export type KannaToolServices = FileSystem.FileSystem | FileSystemExtras | Machine

export interface KannaTool<A = any> {
  readonly name: string
  readonly description: string
  /** The JSON Schema every provider is given for the arguments. */
  readonly inputSchema: Record<string, unknown>
  readonly waitsForUser?: boolean
  readonly decode: (input: unknown) => Effect.Effect<A, KannaToolArgumentsError>
  readonly execute: (args: A, context: KannaToolContext) => Effect.Effect<KannaToolOutput, KannaToolFailure, KannaToolServices>
}

/**
 * A tool on Effect: its arguments as an Effect Schema (decoded before
 * `execute` runs, with zod's error text; see `kanna-tool-arguments.ts`) and
 * its body as an `Effect.fn`.
 */
export function defineKannaTool<S extends Schema.Decoder<unknown>>(definition: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly waitsForUser?: boolean
  readonly execute: (args: S["Type"], context: KannaToolContext) => Effect.Effect<KannaToolOutput, KannaToolFailure, KannaToolServices>
}): KannaTool<S["Type"]> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition.parameters),
    ...(definition.waitsForUser ? { waitsForUser: true } : {}),
    decode: decodeToolArguments(definition.name, definition.parameters),
    execute: definition.execute,
  }
}

/** The context a Promise tool gets: a signal for the cancel, and a Promise `requestInput`. */
export interface KannaToolPromiseContext {
  chatId: string
  cwd: string
  dataDir?: string
  signal: AbortSignal
  requestInput: (prompt: string) => Promise<string>
  orchestration?: Orchestrator["Service"]
}

/**
 * Compatibility for callers that still supply a zod schema and Promise
 * body. Built-in Kanna tools use native `KannaTool` definitions.
 */
export interface KannaToolDefinition {
  name: string
  description: string
  schema: z.ZodObject<z.ZodRawShape>
  waitsForUser?: boolean
  execute: (input: Record<string, unknown>, context: KannaToolPromiseContext) => Promise<KannaToolOutput>
}

export function toKannaTool(tool: KannaTool | KannaToolDefinition): KannaTool {
  return "decode" in tool ? tool : fromPromiseDefinition(tool)
}

function fromPromiseDefinition(definition: KannaToolDefinition): KannaTool<Record<string, unknown>> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema) as Record<string, unknown>,
    ...(definition.waitsForUser ? { waitsForUser: true } : {}),
    decode: Effect.fn("KannaTools.decodeArguments")(function* (input: unknown) {
      yield* Effect.annotateCurrentSpan("tool", definition.name)
      return yield* Effect.try({
        try: () => definition.schema.parse(input) as Record<string, unknown>,
        catch: (cause) => new KannaToolArgumentsError({ tool: definition.name, message: failureText(cause), cause }),
      })
    }),
    execute: Effect.fn("KannaTools.execute")(function* (args: Record<string, unknown>, context: KannaToolContext) {
      yield* Effect.annotateCurrentSpan("tool", definition.name)
      yield* Effect.annotateCurrentSpan("chatId", context.chatId)
      return yield* Effect.tryPromise({
        try: (signal) => definition.execute(args, {
          chatId: context.chatId,
          cwd: context.cwd,
          dataDir: context.dataDir,
          signal,
          orchestration: context.orchestration,
          requestInput: (prompt) => Effect.runPromise(context.requestInput(prompt), { signal }),
        }),
        catch: (cause) => new KannaToolCallError({ tool: definition.name, operation: "execute", message: failureText(cause), cause }),
      })
    }),
  }
}

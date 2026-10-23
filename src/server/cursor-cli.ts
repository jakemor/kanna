import { randomUUID } from "node:crypto"
import { Cause, Context, Effect, FileSystem, Layer, Match, Option, Queue, Schema, Stream, type Scope } from "effect"
import type { ContextWindowUsageSnapshot } from "../shared/types"
import { asNumber, asRecord, asString } from "../shared/json"
import { normalizeToolCall } from "../shared/tools"
import { collectCliOutput, lenient, pumpCliTurn, spawnCli, type SpawnCli } from "./cli-process"
import type { HarnessEvent, HarnessTurnEffect } from "./harness-types"
import type { KannaToolHost } from "./kanna-tools"
import { createCursorKannaTools, type CursorKannaToolsError } from "./cursor-kanna-tools"
import { HttpHost } from "./platform/http-host"
import { Machine } from "./platform/machine"
import type { CommandSpawnError } from "./process-utils"
import { timestamped } from "./transcript"

/**
 * Adapter for the Cursor CLI (`cursor-agent` binary).
 *
 * Unlike Claude (SDK) and Codex (persistent JSON-RPC `app-server`), Cursor runs
 * one headless process per turn:
 *
 *   cursor-agent -p --output-format stream-json --force --model <id> [--resume <session>]
 *
 * with the prompt written to stdin. It emits NDJSON on stdout. `--force` is required
 * in headless mode, otherwise the process blocks on a "Workspace Trust" prompt.
 * Auth is via the CURSOR_API_KEY environment variable (inherited from the parent).
 *
 * Stream event types (one JSON object per line):
 *   - { type: "system", subtype: "init", session_id, model, cwd, apiKeySource }
 *   - { type: "user", ... }                              (prompt echo — ignored)
 *   - { type: "assistant", message: { content: [{ type: "text", text }] } }
 *   - { type: "thinking", subtype: "delta"|"completed" } (reasoning — ignored)
 *   - { type: "tool_call", subtype: "started"|"completed", call_id, tool_call: { <name>ToolCall: {...} } }
 *   - { type: "result", subtype: "success", is_error, duration_ms, result, session_id, usage }
 */

export interface StartCursorTurnArgs {
  customTools?: KannaToolHost
  cwd: string
  content: string
  /** Concrete model id to spawn, e.g. "composer-2.5" or "composer-2.5-fast". */
  model: string
  /** Previous Cursor session id to resume, if any. */
  sessionToken: string | null
}

export interface CursorModelListEntry {
  id: string
  label: string
  isDefault: boolean
}

// `cursor-agent --list-models` renders for humans: ANSI erase/cursor-move
// sequences around a "Loading models…" spinner, then one line per model:
//   <id> - <label>  [(default)|(current)]
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g
const MODEL_LINE_PATTERN = /^(\S+) - (.*?)(?:\s+\((default|current)\))?$/

/** Parse `cursor-agent --list-models` output. Pure so it can be fixture-tested. */
export function parseCursorModelList(output: string): CursorModelListEntry[] {
  const entries: CursorModelListEntry[] = []
  for (const rawLine of output.replace(ANSI_ESCAPE_PATTERN, "").split("\n")) {
    const match = rawLine.trim().match(MODEL_LINE_PATTERN)
    if (!match) continue
    const [, id, label, marker] = match
    const trimmedLabel = label?.trim()
    if (!id || !trimmedLabel) continue
    entries.push({ id, label: trimmedLabel, isDefault: marker === "default" })
  }
  return entries
}

/**
 * Map Cursor's token usage into Kanna's context-window snapshot. Mirrors
 * `normalizeClaudeUsageSnapshot` in agent.ts. Cursor does not report a max
 * context window, so `maxTokens` is left undefined.
 */
export function normalizeCursorUsage(value: unknown): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const directInputTokens = asNumber(usage.inputTokens) ?? 0
  const cacheReadTokens = asNumber(usage.cacheReadTokens) ?? 0
  const cacheWriteTokens = asNumber(usage.cacheWriteTokens) ?? 0
  const outputTokens = asNumber(usage.outputTokens) ?? 0

  const inputTokens = directInputTokens + cacheReadTokens + cacheWriteTokens
  const usedTokens = inputTokens + outputTokens
  if (usedTokens <= 0) return null

  return {
    usedTokens,
    inputTokens,
    ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheReadTokens > 0 ? { lastCachedInputTokens: cacheReadTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    compactsAutomatically: false,
  }
}

/**
 * Translate a Cursor tool call into the Claude-style tool name + snake_case
 * argument keys that `normalizeToolCall` understands, so tools render natively
 * in the UI. Unknown tools fall through to `unknown_tool`.
 */
function translateCursorTool(
  rawName: string,
  args: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } {
  // Tool keys and argument names are taken from observed `cursor-agent` stream
  // output. Anything unmapped falls through to `unknown_tool`, which still renders.
  switch (rawName.toLowerCase().replace(/[^a-z]/g, "")) {
    case "shell":
      return { toolName: "Bash", input: { command: args.command ?? "", description: args.description } }
    case "read":
      return { toolName: "Read", input: { file_path: args.path ?? "" } }
    case "edit":
      // Cursor's edit emits the full new file content (`streamContent`) rather than
      // an old/new diff, so it maps cleanly onto Write.
      return { toolName: "Write", input: { file_path: args.path ?? "", content: args.streamContent ?? "" } }
    case "glob":
      return { toolName: "Glob", input: { pattern: args.globPattern ?? "" } }
    case "grep":
      return { toolName: "Grep", input: { pattern: args.pattern ?? "" } }
    case "updatetodos":
      return { toolName: "TodoWrite", input: { todos: Array.isArray(args.todos) ? args.todos : [] } }
    default:
      return { toolName: rawName, input: args }
  }
}

/**
 * Cursor nests tool calls under keys like "shellToolCall", "readToolCall".
 * Returns the raw tool name, its args, and the completed result (if present).
 */
function extractCursorTool(toolCall: unknown): {
  rawName: string
  args: Record<string, unknown>
  result?: unknown
} {
  const obj = asRecord(toolCall)
  if (obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith("ToolCall")) {
        const inner = asRecord(v)
        return {
          rawName: k === "mcpToolCall"
            ? String(inner?.name ?? inner?.toolName ?? asRecord(inner?.args)?.toolName ?? asRecord(inner?.args)?.name ?? "mcp")
            : k.slice(0, -"ToolCall".length),
          args: asRecord(inner?.args) ?? {},
          result: inner?.result,
        }
      }
    }
    // Fallback: { name, args }
    const name = asString(obj.name)
    if (name) {
      return { rawName: name, args: asRecord(obj.args) ?? {}, result: obj.result }
    }
  }
  return { rawName: "unknown", args: {} }
}

// One stdout line of `cursor-agent`, decoded conservatively: the event types
// Kanna reads, each with the fields it uses. Other types ("user" prompt echo,
// "thinking") and fields a newer CLI adds are ignored, not rejected.
const CursorTextBlock = Schema.Struct({ type: Schema.Literal("text"), text: lenient(Schema.String) })

const CursorEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: lenient(Schema.String),
    session_id: lenient(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    message: lenient(Schema.Struct({ content: lenient(Schema.Array(Schema.Unknown)) })),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    subtype: lenient(Schema.String),
    call_id: lenient(Schema.String),
    // Keyed by tool (`shellToolCall`, `readToolCall`, …): read by extractCursorTool.
    tool_call: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    is_error: Schema.optional(Schema.Unknown),
    duration_ms: lenient(Schema.Finite),
    result: lenient(Schema.String),
    usage: Schema.optional(Schema.Unknown),
  }),
])
type CursorEvent = typeof CursorEvent.Type

const decodeCursorEvent = Schema.decodeUnknownOption(Schema.fromJsonString(CursorEvent))
const decodeTextBlock = Schema.decodeUnknownOption(CursorTextBlock)

function extractAssistantText(content: ReadonlyArray<unknown> | undefined): string {
  return (content ?? [])
    .flatMap((item) => Option.toArray(decodeTextBlock(item)))
    .map((block) => block.text ?? "")
    .join("")
}

/**
 * Parse a single NDJSON line from `cursor-agent` into Kanna harness events.
 * Pure and side-effect free so it can be unit tested against captured fixtures.
 */
export function parseCursorLine(line: string, configuredModel: string): HarnessEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  const decoded = decodeCursorEvent(trimmed)
  if (Option.isNone(decoded)) return []
  return cursorEventToHarnessEvents(decoded.value, configuredModel, trimmed)
}

function cursorEventToHarnessEvents(event: CursorEvent, configuredModel: string, debugRaw: string): HarnessEvent[] {
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      system: (value): HarnessEvent[] => {
        if (value.subtype !== "init") return []
        const events: HarnessEvent[] = []
        if (value.session_id) events.push({ type: "session_token", sessionToken: value.session_id })
        events.push({
          type: "transcript",
          entry: timestamped({
            kind: "system_init",
            provider: "cursor",
            model: configuredModel,
            tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "TodoWrite"],
            agents: [],
            slashCommands: [],
            mcpServers: [],
            debugRaw,
          }),
        })
        return events
      },

      assistant: (value): HarnessEvent[] => {
        const text = extractAssistantText(value.message?.content)
        if (!text) return []
        return [{ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) }]
      },

      tool_call: (value): HarnessEvent[] => {
        const callId = value.call_id ?? randomUUID()
        const { rawName, args, result } = extractCursorTool(value.tool_call)

        if (value.subtype === "started") {
          const { toolName, input } = translateCursorTool(rawName, args)
          return [{
            type: "transcript",
            entry: timestamped({
              kind: "tool_call",
              tool: normalizeToolCall({ toolName, toolId: callId, input }),
            }),
          }]
        }

        if (value.subtype === "completed") {
          // Only flag an error when Cursor explicitly reports one. A missing/non-object
          // result (e.g. a bare string) is treated as success rather than a false error.
          const resultRecord = asRecord(result)
          const isError = Boolean(resultRecord && ("error" in resultRecord || "failure" in resultRecord))
          const content = resultRecord?.success ?? resultRecord?.error ?? resultRecord?.failure ?? result
          return [{
            type: "transcript",
            entry: timestamped({ kind: "tool_result", toolId: callId, content, isError }),
          }]
        }

        return []
      },

      result: (value): HarnessEvent[] => {
        const events: HarnessEvent[] = []
        const usage = normalizeCursorUsage(value.usage)
        if (usage) {
          events.push({ type: "transcript", entry: timestamped({ kind: "context_window_updated", usage }) })
        }
        const isError = Boolean(value.is_error)
        events.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: isError ? "error" : "success",
            isError,
            durationMs: value.duration_ms ?? 0,
            result: value.result ?? "",
          }),
        })
        return events
      },
    }),
  )
}

/**
 * The Cursor CLI's auth error says to run 'agent login', but the binary may be
 * installed as either `cursor-agent` or `agent` depending on version/setup
 * (and `agent` can even resolve to an unrelated CLI). Mention both spellings
 * so the instruction works regardless of how the user installed it.
 */
export function clarifyCursorAuthError(detail: string): string {
  return detail.replace(/'(?:cursor-)?agent login'/, "'cursor-agent login' (or 'agent login')")
}

export class CursorModelListError extends Schema.TaggedError<CursorModelListError>()(
  "@kanna/server/cursor-cli/CursorModelListError",
  {
    message: Schema.String,
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  },
) {}

export interface CursorCliOptions {
  /** Default: the real `cursor-agent`. Tests pass a fake (`cli-process.fake.ts`). */
  readonly spawnProcess?: SpawnCli
}

/**
 * The Cursor CLI (`cursor-agent`): a headless process per turn, and the
 * account's model list.
 */
export class CursorCli extends Context.Service<CursorCli, {
  /**
   * Spawns `cursor-agent` for one turn, in the caller's scope: closing the
   * scope kills the process and stops Kanna's tools for it. The turn's events
   * end after the process exits; an exit without a result (spawn failure,
   * auth error, bad model) ends them with an error result carrying stderr.
   */
  readonly startTurn: (
    args: StartCursorTurnArgs,
  ) => Effect.Effect<HarnessTurnEffect, CursorKannaToolsError, Scope.Scope>
  /**
   * Ask the CLI which models the account can use (`cursor-agent --list-models`).
   * Fails when the binary is missing, unauthenticated, or times out — callers
   * are expected to fall back to the static catalog.
   */
  readonly listModels: (
    timeoutMs?: number,
  ) => Effect.Effect<CursorModelListEntry[], CursorModelListError | CommandSpawnError>
}>()("@kanna/server/CursorCli") {
  static readonly layer = (options: CursorCliOptions = {}) => Layer.effect(this, makeCursorCli(options))
}

export const makeCursorCli = Effect.fn("CursorCli.make")(function* (options: CursorCliOptions = {}) {
  // Only these two: the whole context would carry the layer's Scope over the turn's.
  const kannaToolsContext = Context.pick(FileSystem.FileSystem, HttpHost)(yield* Effect.context<FileSystem.FileSystem | HttpHost>())
  const spawnProcess = options.spawnProcess ?? (yield* spawnCli("cursor-agent"))
  const machine = yield* Machine

  const listModels = Effect.fn("CursorCli.listModels")(function* (timeoutMs = 30_000) {
    // The model list is account-level, not workspace-level — spawn from HOME.
    const output = yield* spawnProcess({ cwd: machine.homeDirectory, argv: ["--list-models"] }).pipe(
      Effect.flatMap(collectCliOutput),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new CursorModelListError({
          message: `cursor-agent --list-models timed out after ${timeoutMs}ms`,
        })),
      }),
    )
    const models = parseCursorModelList(output.stdout)
    if (output.exitCode === 0 && models.length > 0) return models
    return yield* new CursorModelListError({
      message: clarifyCursorAuthError(output.stderr.trim())
        || `cursor-agent --list-models exited with code ${output.exitCode ?? "unknown"} without listing models`,
      exitCode: output.exitCode,
    })
  })

  const startTurn = Effect.fn("CursorCli.startTurn")(function* (args: StartCursorTurnArgs) {
    yield* Effect.annotateCurrentSpan("model", args.model)
    const argv = [
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--model",
      args.model,
    ]
    if (args.sessionToken) {
      argv.push("--resume", args.sessionToken)
    }

    // Ends the events if the scope closes before the process does.
    const queue = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
    yield* Effect.addFinalizer(() => Queue.end(queue))

    const customTools = args.customTools
      ? yield* createCursorKannaTools(args.customTools).pipe(Effect.provide(kannaToolsContext))
      : undefined
    if (customTools) argv.push("--plugin-dir", customTools.directory, "--approve-mcps")
    const closeTools = customTools?.close ?? Effect.void

    let sawResult = false
    const proc = yield* pumpCliTurn({
      // The prompt goes over stdin, which is then closed so the agent starts.
      spawn: spawnProcess({ cwd: args.cwd, argv, stdin: args.content }),
      onLine: (line) => Effect.forEach(parseCursorLine(line, args.model), (event) => {
        if (event.type === "transcript" && event.entry?.kind === "result") sawResult = true
        return Queue.offer(queue, event)
      }, { discard: true }),
      onExit: ({ code, stderr }) => Effect.gen(function* () {
        yield* closeTools
        if (!sawResult) {
          const detail = clarifyCursorAuthError(stderr.trim()) || `cursor-agent exited with code ${code ?? "unknown"}`
          yield* Queue.offer(queue, {
            type: "transcript",
            entry: timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: detail,
            }),
          })
        }
        yield* Queue.end(queue)
      }),
    })

    return {
      provider: "cursor",
      events: Stream.fromQueue(queue),
      interrupt: closeTools.pipe(
        Effect.andThen(Option.match(proc, { onNone: () => Effect.void, onSome: (child) => child.kill("SIGINT") })),
      ),
    } satisfies HarnessTurnEffect
  })

  return { startTurn, listModels } satisfies CursorCli["Service"]
})

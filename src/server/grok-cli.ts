import { randomUUID } from "node:crypto"
import path from "node:path"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Match, Option, Queue, Schema, Stream, type Scope } from "effect"
import type { ContextWindowUsageSnapshot, HarnessSkill, NormalizedToolCall, TodoItem } from "../shared/types"
import { asNumber, asRecord, asString } from "../shared/json"
import { normalizeToolCall } from "../shared/tools"
import { collectCliOutput, lenient, pumpCliTurn, spawnCli, type SpawnCli } from "./cli-process"
import type { HarnessEvent, HarnessToolRequest, HarnessTurnEffect } from "./harness-types"
import { Machine } from "./platform/machine"
import type { CommandSpawnError } from "./process-utils"
import { timestamped } from "./transcript"

/**
 * Adapter for the Grok Build CLI (`grok` binary).
 *
 * Same spawn-per-turn shape as Cursor, using Grok's headless streaming-json
 * (ACP session updates as NDJSON):
 *
 *   grok --output-format streaming-json --prompt-file <tmp> -m <id>
 *        [--reasoning-effort <effort>] [--permission-mode plan]
 *        [--always-approve] [--resume <session>] [--fork-session]
 *
 * `--always-approve` is required in headless mode the same way Cursor needs
 * `--force` — without it the process blocks on permission prompts Kanna cannot
 * answer over a one-shot stdio pipe. Plan mode swaps that for
 * `--permission-mode plan`.
 *
 * Stream event types (one JSON object per line):
 *   - { type: "available_commands", tools, commands }
 *   - { type: "text", data }
 *   - { type: "thought", data }                         (reasoning — ignored)
 *   - { type: "tool_call", toolCallId, toolName, rawInput, status }
 *   - { type: "tool_call_update", toolCallId, status, content, rawOutput }
 *   - { type: "usage", usage }
 *   - { type: "end", sessionId, stopReason, usage, ... }
 *
 * Auth is the grok CLI's own store (`~/.grok/auth.json`), inherited via env.
 */

export const GROK_CLI_CHAT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1"

export interface StartGrokTurnArgs {
  cwd: string
  content: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  /**
   * Plan mode only: parks the turn on the plan approval or question — see
   * startTurn. Succeeds once the user answers; fails when the turn is already gone.
   */
  onToolRequest?: (request: HarnessToolRequest) => Effect.Effect<unknown, unknown>
}

type InteractiveTool = HarnessToolRequest["tool"]

function isInteractiveTool(tool: NormalizedToolCall): tool is InteractiveTool {
  return tool.toolKind === "exit_plan_mode" || tool.toolKind === "ask_user_question"
}

export interface GrokModelListEntry {
  id: string
  label: string
  isDefault: boolean
}

export interface GrokAuthStatusParsed {
  loggedIn: boolean
  account: string | null
}

export interface GrokInspectSkill {
  name: string
  description: string
  path?: string
}

/** A value that decodes to `fallback` when it has another shape, rather than failing its parent. */
const orElse = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(fallback))))

const GrokMoneyValue = Schema.Union([Schema.Number, Schema.Struct({ val: lenient(Schema.Number) })])

const GrokBillingProductUsage = Schema.Struct({
  product: lenient(Schema.String),
  usagePercent: lenient(Schema.Number),
})
export type GrokBillingProductUsage = typeof GrokBillingProductUsage.Type

/**
 * cli-chat-proxy's `/billing?format=credits`, decoded conservatively: a field
 * of an unexpected shape reads as absent, and a body that is not an object at
 * all reads as `{}` (no usage windows).
 */
const GrokBilling = orElse(Schema.Struct({
  config: lenient(Schema.Struct({
    currentPeriod: lenient(Schema.Struct({
      type: lenient(Schema.String),
      start: lenient(Schema.String),
      end: lenient(Schema.String),
    })),
    creditUsagePercent: lenient(Schema.Number),
    onDemandCap: lenient(GrokMoneyValue),
    onDemandUsed: lenient(GrokMoneyValue),
    prepaidBalance: lenient(GrokMoneyValue),
    productUsage: lenient(Schema.Array(orElse(GrokBillingProductUsage, {}))),
    billingPeriodStart: lenient(Schema.String),
    billingPeriodEnd: lenient(Schema.String),
  })),
}), {})
export type GrokBillingRaw = typeof GrokBilling.Type

/** cli-chat-proxy's `/user?include=subscription`, decoded the same way. */
const GrokUser = orElse(Schema.Struct({
  email: lenient(Schema.NullOr(Schema.String)),
  subscriptionTier: lenient(Schema.NullOr(Schema.String)),
  hasGrokCodeAccess: lenient(Schema.Boolean),
}), {})
export type GrokUserRaw = typeof GrokUser.Type

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g
const MODEL_LINE_PATTERN = /^\s*[*+-]\s+(\S+)(?:\s+\(default\))?/i

export function stripGrokAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "")
}

export function parseGrokVersion(output: string): string | null {
  return /grok\s+(\d+\.\d+\.\d+\S*)/i.exec(output)?.[1] ?? /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

/** `grok models` — "You are logged in with grok.com." / not logged in. */
export function parseGrokAuthStatus(stdout: string): GrokAuthStatusParsed {
  const text = stripGrokAnsi(stdout)
  if (/not logged in|please (?:sign|log) in|authentication required|run `?grok login/i.test(text)) {
    return { loggedIn: false, account: null }
  }
  if (!/logged in/i.test(text)) return { loggedIn: false, account: null }
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0] ?? null
  const withAccount = /logged in (?:with|as)\s+(\S+)/i.exec(text)?.[1]?.replace(/[.,]$/, "") ?? null
  return { loggedIn: true, account: email ?? withAccount }
}

/** Parse `grok models` human output into picker rows. */
export function parseGrokModelList(output: string): GrokModelListEntry[] {
  const entries: GrokModelListEntry[] = []
  let defaultId: string | null = null
  for (const rawLine of stripGrokAnsi(output).split("\n")) {
    const defaultMatch = /^\s*Default model:\s+(\S+)/i.exec(rawLine.trim())
    if (defaultMatch?.[1]) {
      defaultId = defaultMatch[1]
      continue
    }
    const match = rawLine.match(MODEL_LINE_PATTERN)
    if (!match?.[1]) continue
    const id = match[1]
    const isDefault = /\(default\)/i.test(rawLine) || rawLine.trim().startsWith("*") || id === defaultId
    if (entries.some((entry) => entry.id === id)) continue
    entries.push({
      id,
      label: grokModelLabel(id),
      isDefault,
    })
  }
  if (defaultId) {
    for (const entry of entries) {
      if (entry.id === defaultId) entry.isDefault = true
    }
  }
  return entries
}

export function grokModelLabel(id: string): string {
  return id
    .replace(/^grok-/i, "Grok ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGrok\b/, "Grok")
}

/**
 * `grok login --device-auth` prints a URL (and often a one-time code), same
 * family as Codex device login.
 */
export function parseGrokDeviceLogin(text: string): { verificationUrl: string; userCode: string | null } | null {
  const url = /(https:\/\/(?:(?:www|auth)\.)?(?:grok\.com|x\.ai|auth\.x\.ai)\/\S*)/i.exec(text)?.[1] ?? null
  if (!url) return null
  const code = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/.exec(text)?.[1] ?? null
  return { verificationUrl: url.replace(/[.,)]+$/, ""), userCode: code }
}

export function grokSessionDir(home: string, cwd: string): string {
  return path.join(home, ".grok", "sessions", encodeURIComponent(cwd))
}

function unwrapVal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const record = asRecord(value)
  const inner = record?.val
  return typeof inner === "number" && Number.isFinite(inner) ? inner : null
}

function grokProductLabel(product: string): string {
  if (product === "GrokBuild") return "Grok Build"
  if (product === "GrokChat") return "Grok Chat"
  if (product === "GrokVoice") return "Grok Voice"
  return product.replace(/([a-z])([A-Z])/g, "$1 $2")
}

export function normalizeGrokUsage(value: unknown, maxTokens?: number): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const directInputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens) ?? 0
  const cacheReadTokens =
    asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cacheReadInputTokens) ?? 0
  const cacheWriteTokens =
    asNumber(usage.cache_creation_input_tokens) ?? asNumber(usage.cacheCreationInputTokens) ?? 0
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens) ?? 0
  const reasoningTokens = asNumber(usage.reasoning_tokens) ?? asNumber(usage.reasoningTokens)

  const inputTokens = directInputTokens + cacheReadTokens + cacheWriteTokens
  const usedTokens = inputTokens + outputTokens
  if (usedTokens <= 0) return null

  return {
    usedTokens,
    inputTokens,
    ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningOutputTokens: reasoningTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheReadTokens > 0 ? { lastCachedInputTokens: cacheReadTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { lastReasoningOutputTokens: reasoningTokens } : {}),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
    compactsAutomatically: true,
  }
}

function translateGrokTool(
  rawName: string,
  args: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } {
  const filePath = args.target_file ?? args.file_path ?? args.path ?? args.filePath ?? ""
  switch (rawName.toLowerCase().replace(/[^a-z]/g, "")) {
    case "runterminalcommand":
    case "runcommand":
    case "bash":
    case "shell":
      return {
        toolName: "Bash",
        input: {
          command: args.command ?? "",
          description: args.description,
          run_in_background: args.is_background ?? args.run_in_background,
        },
      }
    case "readfile":
    case "read":
      return { toolName: "Read", input: { file_path: filePath, offset: args.offset, limit: args.limit } }
    case "searchreplace":
    case "edit":
      return {
        toolName: "Edit",
        input: {
          file_path: filePath,
          old_string: args.old_string ?? args.oldString ?? "",
          new_string: args.new_string ?? args.newString ?? "",
          replace_all: args.replace_all,
        },
      }
    case "write":
    case "writefile":
      return { toolName: "Write", input: { file_path: filePath, content: args.content ?? args.contents ?? "" } }
    case "listdir":
    case "glob":
      return {
        toolName: "Glob",
        input: { pattern: args.glob_pattern ?? args.pattern ?? (filePath ? `${String(filePath).replace(/\/$/, "")}/*` : "*") },
      }
    case "grep":
    case "grepsearch":
      return {
        toolName: "Grep",
        input: {
          pattern: args.pattern ?? "",
          path: args.path,
          glob: args.glob,
          output_mode: args.output_mode,
          "-i": args["-i"] ?? args.i,
          "-C": args["-C"] ?? args.C,
          head_limit: args.head_limit,
        },
      }
    case "todowrite":
    case "updatetodos":
      return {
        toolName: "TodoWrite",
        input: {
          todos: normalizeGrokTodoItems(args.todos),
          merge: args.merge === true,
        },
      }
    case "websearch":
      return { toolName: "WebSearch", input: { query: args.query ?? args.search_term ?? "" } }
    case "webfetch":
      return { toolName: "WebFetch", input: { url: args.url ?? "" } }
    case "askuserquestion":
      return { toolName: "AskUserQuestion", input: { questions: Array.isArray(args.questions) ? args.questions : [] } }
    case "exitplanmode":
      return {
        toolName: "ExitPlanMode",
        input: { plan: args.plan ?? args.planContent, summary: args.summary },
      }
    case "spawnsubagent":
    case "task":
      return { toolName: "Task", input: args }
    default:
      return { toolName: rawName, input: args }
  }
}

function grokTodoStatus(value: unknown): TodoItem["status"] {
  const status = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "")
  if (status === "completed" || status === "complete" || status === "done") return "completed"
  if (status === "inprogress" || status === "running") return "in_progress"
  return "pending"
}

function grokTodoText(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

export function normalizeGrokTodoItems(value: unknown): TodoItem[] {
  const items = Array.isArray(value) ? value : []
  const todos: TodoItem[] = []
  for (const raw of items) {
    const item = asRecord(raw)
    if (!item) continue
    const content = grokTodoText(item, ["content", "text", "title", "description", "step", "label"])
    const activeForm = grokTodoText(item, ["activeForm", "active_form"]) || content
    const id = asString(item.id)
    todos.push({
      content,
      status: grokTodoStatus(item.status),
      activeForm,
      ...(id ? { id } : {}),
    })
  }
  return todos
}

function grokTodosFromPayload(value: unknown): { todos: TodoItem[]; merge: boolean } | null {
  const record = asRecord(value)
  if (!record) return null
  const rawInput = asRecord(record.rawInput) ?? record
  const rawOutput = asRecord(record.rawOutput)
  const updated = asRecord(rawOutput?.TodosUpdated) ?? asRecord(rawOutput?.todosUpdated)
  const lists = [
    rawInput.todos,
    updated?.todos,
    record.todos,
  ]
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue
    return {
      todos: normalizeGrokTodoItems(list),
      merge: rawInput.merge === true || record.merge === true,
    }
  }
  const stateTodos = asRecord(asRecord(updated?.state)?.todos)
  if (stateTodos && Object.keys(stateTodos).length > 0) {
    return {
      todos: normalizeGrokTodoItems(
        Object.entries(stateTodos).map(([id, item]) => ({ id, ...asRecord(item) })),
      ),
      merge: false,
    }
  }
  return null
}

export class GrokTodoTracker {
  private readonly todos = new Map<string, TodoItem & { id: string }>()

  apply(payload: { todos: TodoItem[]; merge: boolean }): TodoItem[] | null {
    if (!payload.merge) this.todos.clear()
    for (const [index, todo] of payload.todos.entries()) {
      const id = asString(todo.id) || String(index + 1)
      const previous = this.todos.get(id)
      const content = todo.content.trim() || previous?.content || ""
      const activeForm = todo.activeForm.trim() || content || previous?.activeForm || ""
      this.todos.set(id, {
        id,
        content,
        status: todo.status,
        activeForm,
      })
    }
    const merged = [...this.todos.values()].map(({ id: _id, ...todo }) => todo)
    if (!merged.some((todo) => todo.content.length > 0)) return null
    return merged
  }
}

function extractToolResultContent(value: unknown): unknown {
  const record = asRecord(value)
  if (!record) return value ?? ""
  const blocks = Array.isArray(record.content) ? record.content : null
  if (blocks) {
    const texts = blocks.map((block) => {
      const blockRecord = asRecord(block)
      const inner = asRecord(blockRecord?.content) ?? blockRecord
      if (inner?.type === "text" && typeof inner.text === "string") return inner.text
      if (typeof blockRecord?.text === "string") return blockRecord.text
      return ""
    }).filter(Boolean)
    if (texts.length > 0) return texts.join("")
  }
  if (typeof record.text === "string") return record.text
  return record.rawOutput ?? record.stdout ?? value
}

function grokToolDisplayNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "TodoWrite"]
  }
  const mapped = tools.map((tool) => {
    const name = typeof tool === "string" ? tool : ""
    return translateGrokTool(name, {}).toolName
  })
  return [...new Set(mapped.filter((name) => name && !name.includes("__") && !name.startsWith("kampala")))]
}

function grokSlashCommands(commands: unknown): string[] {
  if (!Array.isArray(commands)) return []
  return commands
    .map((command) => typeof command === "string" ? command : "")
    .filter((name) => name.length > 0 && !name.startsWith("._") && !name.includes(":"))
}

// One stdout line of `grok --output-format streaming-json`, decoded
// conservatively: the event types Kanna reads, each with the fields it uses.
// Other types ("thought") and fields a newer CLI adds are ignored, not
// rejected. Tool payloads (`rawInput`, `rawOutput`, `content`) are free-form
// per tool and read by the helpers above.
const GrokEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("available_commands"),
    tools: lenient(Schema.Array(Schema.Unknown)),
    commands: lenient(Schema.Array(Schema.Unknown)),
  }),
  Schema.Struct({ type: Schema.Literal("text"), data: lenient(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    toolCallId: lenient(Schema.String),
    call_id: lenient(Schema.String),
    toolName: lenient(Schema.String),
    title: lenient(Schema.String),
    rawInput: Schema.optional(Schema.Unknown),
    input: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_update"),
    toolCallId: lenient(Schema.String),
    call_id: lenient(Schema.String),
    status: lenient(Schema.String),
    content: Schema.optional(Schema.Unknown),
    rawOutput: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("usage"), usage: Schema.optional(Schema.Unknown) }),
  Schema.Struct({
    type: Schema.Literal("end"),
    sessionId: lenient(Schema.String),
    session_id: lenient(Schema.String),
    stopReason: lenient(Schema.String),
    stop_reason: lenient(Schema.String),
    error: lenient(Schema.String),
    usage: Schema.optional(Schema.Unknown),
  }),
])
type GrokEvent = typeof GrokEvent.Type

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const decodeGrokEvent = Schema.decodeUnknownOption(GrokEvent)

/**
 * Parse a single NDJSON line from `grok --output-format streaming-json`.
 * Text deltas are returned as assistant_text; the manager coalesces them.
 */
export function parseGrokLine(line: string, configuredModel: string): HarnessEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  const raw = decodeJsonObject(trimmed)
  if (Option.isNone(raw)) return []
  const event = decodeGrokEvent(raw.value)
  if (Option.isNone(event)) return []
  return grokEventToHarnessEvents(event.value, raw.value, configuredModel, trimmed)
}

/** `raw` is the whole line's object, for the tool-payload helpers that read across its fields. */
function grokEventToHarnessEvents(
  event: GrokEvent,
  raw: Record<string, unknown>,
  configuredModel: string,
  debugRaw: string,
): HarnessEvent[] {
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      available_commands: (value): HarnessEvent[] => [{
        type: "transcript",
        entry: timestamped({
          kind: "system_init",
          provider: "grok",
          model: configuredModel,
          tools: grokToolDisplayNames(value.tools),
          agents: [],
          slashCommands: grokSlashCommands(value.commands),
          mcpServers: [],
          debugRaw,
        }),
      }],

      text: (value): HarnessEvent[] => {
        const text = value.data ?? ""
        if (!text) return []
        return [{ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) }]
      },

      tool_call: (value): HarnessEvent[] => {
        const callId = value.toolCallId ?? value.call_id ?? randomUUID()
        const rawName = value.toolName ?? value.title ?? "unknown"
        const args = asRecord(value.rawInput) ?? asRecord(value.input) ?? {}
        const { toolName, input } = translateGrokTool(rawName, args)
        return [{
          type: "transcript",
          entry: timestamped({
            kind: "tool_call",
            tool: normalizeToolCall({ toolName, toolId: callId, input }),
          }),
        }]
      },

      tool_call_update: (value): HarnessEvent[] => {
        const events: HarnessEvent[] = []
        const callId = value.toolCallId ?? value.call_id
        const todoPayload = grokTodosFromPayload(raw)
        if (todoPayload && callId) {
          events.push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_call",
              tool: normalizeToolCall({
                toolName: "TodoWrite",
                toolId: callId,
                input: { todos: todoPayload.todos, merge: todoPayload.merge },
              }),
            }),
          })
        }
        const status = value.status
        const hasContent = Array.isArray(value.content) ? value.content.length > 0 : value.content != null
        if (status !== "completed" && status !== "failed" && status !== "error" && !hasContent && value.rawOutput == null) {
          return events
        }
        if (!callId) return events
        const isError = status === "failed" || status === "error"
        events.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_result",
            toolId: callId,
            content: extractToolResultContent(raw),
            isError,
          }),
        })
        return events
      },

      usage: (value): HarnessEvent[] => {
        const usage = normalizeGrokUsage(value.usage)
        if (!usage) return []
        return [{ type: "transcript", entry: timestamped({ kind: "context_window_updated", usage }) }]
      },

      end: (value): HarnessEvent[] => {
        const events: HarnessEvent[] = []
        const sessionId = value.sessionId ?? value.session_id
        if (sessionId) events.push({ type: "session_token", sessionToken: sessionId })
        const usage = normalizeGrokUsage(value.usage)
        if (usage) {
          events.push({
            type: "transcript",
            entry: timestamped({ kind: "context_window_updated", usage }),
          })
        }
        const stopReason = value.stopReason ?? value.stop_reason ?? ""
        const isError = /error|fail/i.test(stopReason) && stopReason !== "end_turn"
        events.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: isError ? "error" : "success",
            isError,
            durationMs: 0,
            result: isError ? (value.error ?? stopReason) : "",
          }),
        })
        return events
      },
    }),
  )
}

/** Coalesce streaming text deltas into one assistant_text entry at a time. */
export class GrokStreamCoalescer {
  private text = ""
  private sawInit = false
  private readonly todos = new GrokTodoTracker()

  push(events: HarnessEvent[]): HarnessEvent[] {
    const out: HarnessEvent[] = []
    for (const event of events) {
      if (event.type === "transcript" && event.entry?.kind === "assistant_text") {
        this.text += event.entry.text
        continue
      }
      if (event.type === "transcript" && event.entry?.kind === "system_init") {
        if (this.sawInit) continue
        this.sawInit = true
      }
      const flushed = this.flushText()
      if (flushed) out.push(flushed)
      const rewritten = this.rewriteTodoEvent(event)
      if (rewritten) out.push(rewritten)
    }
    return out
  }

  /**
   * Grok's later todo_write calls are merge patches: `{ id, status }` with no
   * title. Fold them onto the last full list so the Progress card keeps text.
   */
  private rewriteTodoEvent(event: HarnessEvent): HarnessEvent | null {
    if (event.type !== "transcript" || event.entry?.kind !== "tool_call") return event
    const tool = event.entry.tool
    if (tool.toolKind !== "todo_write") return event
    const merge = asRecord(tool.rawInput)?.merge === true || asRecord(tool.input)?.merge === true
    const merged = this.todos.apply({ todos: tool.input.todos ?? [], merge })
    if (!merged) return null
    return {
      ...event,
      entry: {
        ...event.entry,
        tool: {
          ...tool,
          input: { todos: merged },
        },
      },
    }
  }

  finish(): HarnessEvent[] {
    const flushed = this.flushText()
    return flushed ? [flushed] : []
  }

  private flushText(): HarnessEvent | null {
    if (!this.text) return null
    const text = this.text
    this.text = ""
    return { type: "transcript", entry: timestamped({ kind: "assistant_text", text }) }
  }
}

// `grok inspect --json`, decoded conservatively: a skill that isn't an object
// or has no string name is skipped; other fields are optional.
const GrokInspectSkill = Schema.Struct({
  name: Schema.String,
  description: lenient(Schema.String),
  source: lenient(Schema.Struct({ path: lenient(Schema.String) })),
})
const decodeGrokInspect = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  skills: lenient(Schema.Array(Schema.Unknown)),
})))
const decodeGrokInspectSkill = Schema.decodeUnknownOption(GrokInspectSkill)

export function parseGrokInspectSkills(output: string): HarnessSkill[] {
  const parsed = decodeGrokInspect(output)
  const skills = Option.isSome(parsed) ? parsed.value.skills ?? [] : []
  const result: HarnessSkill[] = []
  for (const skill of skills.flatMap((entry) => Option.toArray(decodeGrokInspectSkill(entry)))) {
    if (!skill.name || skill.name.startsWith("._")) continue
    const skillPath = skill.source?.path
    result.push({
      name: skill.name,
      description: skill.description ?? "",
      source: "skill",
      ...(skillPath ? { path: skillPath } : {}),
    })
  }
  return result
}

export function readGrokAuthTokenFromFile(payload: unknown): string | null {
  const record = asRecord(payload)
  if (!record) return null
  for (const value of Object.values(record)) {
    const entry = asRecord(value)
    const key = asString(entry?.key) ?? asString(entry?.access_token)
    if (key) return key
  }
  return null
}

export function grokProxyBaseUrl(env: Record<string, string | undefined>): string {
  const override = env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim()
  if (override) return override.replace(/\/$/, "")
  return GROK_CLI_CHAT_PROXY_BASE_URL
}

export function moneyVal(value: unknown): number | null {
  return unwrapVal(value)
}

export function grokProductUsageWindows(raw: GrokBillingRaw): Array<{ id: string; label: string; usedPercent: number | null; resetsAt: string | null }> {
  const config = raw.config
  const resetsAt = config?.currentPeriod?.end ?? config?.billingPeriodEnd ?? null
  const products = config?.productUsage ?? []
  const windows: Array<{ id: string; label: string; usedPercent: number | null; resetsAt: string | null }> = []
  if (typeof config?.creditUsagePercent === "number") {
    windows.push({
      id: "credits",
      label: "Weekly · All products",
      usedPercent: config.creditUsagePercent,
      resetsAt,
    })
  }
  for (const product of products) {
    const id = product.product?.trim()
    if (!id) continue
    windows.push({
      id,
      label: `Weekly · ${grokProductLabel(id)}`,
      usedPercent: typeof product.usagePercent === "number" ? product.usagePercent : null,
      resetsAt,
    })
  }
  return windows
}

export class GrokModelListError extends Schema.TaggedError<GrokModelListError>()(
  "@kanna/server/grok-cli/GrokModelListError",
  {
    message: Schema.String,
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  },
) {}

export class GrokPromptFileError extends Schema.TaggedError<GrokPromptFileError>()(
  "@kanna/server/grok-cli/GrokPromptFileError",
  {
    operation: Schema.Literals(["make-directory", "write"]),
    cwd: Schema.String,
    filePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export interface GrokCliOptions {
  /** Default: the real `grok`. Tests pass a fake (`cli-process.fake.ts`). */
  readonly spawnProcess?: SpawnCli
}

/**
 * The Grok Build CLI (`grok`): a headless process per turn, the account's
 * model list, and the skills it would load for a project.
 */
export class GrokCli extends Context.Service<GrokCli, {
  /**
   * Spawns `grok` for one turn, in the caller's scope: closing the scope kills
   * the process and removes the prompt file. The turn's events end after the
   * process exits (or, in plan mode, once the user answers — see below); an
   * exit without a result ends them with an error result carrying stderr.
   */
  readonly startTurn: (args: StartGrokTurnArgs) => Effect.Effect<HarnessTurnEffect, GrokPromptFileError, Scope.Scope>
  /** `grok models`. Fails when grok is missing, signed out, or times out; callers keep the static catalog. */
  readonly listModels: (timeoutMs?: number) => Effect.Effect<GrokModelListEntry[], GrokModelListError | CommandSpawnError>
  /** `grok inspect --json`: the skills grok would load in `cwd`. Empty when grok can't say. */
  readonly listSkills: (args?: { readonly cwd: string; readonly timeoutMs?: number }) => Effect.Effect<HarnessSkill[]>
}>()("@kanna/server/GrokCli") {
  static readonly layer = (options: GrokCliOptions = {}) => Layer.effect(this, makeGrokCli(options))
}

export const makeGrokCli = Effect.fn("GrokCli.make")(function* (options: GrokCliOptions = {}) {
  const fs = yield* FileSystem.FileSystem
  const spawnProcess = options.spawnProcess ?? (yield* spawnCli("grok"))
  const machine = yield* Machine

  const listModels = Effect.fn("GrokCli.listModels")(function* (timeoutMs = 30_000) {
    const output = yield* spawnProcess({ cwd: machine.homeDirectory, argv: ["models"] }).pipe(
      Effect.flatMap(collectCliOutput),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new GrokModelListError({ message: `grok models timed out after ${timeoutMs}ms` })),
      }),
    )
    const models = parseGrokModelList(output.stdout)
    if (output.exitCode === 0 && models.length > 0) return models
    return yield* new GrokModelListError({
      message: output.stderr.trim() || `grok models exited with code ${output.exitCode ?? "unknown"} without listing models`,
      exitCode: output.exitCode,
    })
  })

  const listSkills = Effect.fn("GrokCli.listSkills")(function* (
    args: { readonly cwd: string; readonly timeoutMs?: number } = { cwd: machine.workingDirectory },
  ) {
    return yield* spawnProcess({ cwd: args.cwd, argv: ["inspect", "--json"] }).pipe(
      Effect.flatMap(collectCliOutput),
      // Whatever it printed by the time it exited, whatever the code.
      Effect.map((output) => parseGrokInspectSkills(output.stdout)),
      Effect.scoped,
      Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed<HarnessSkill[]>([])),
      Effect.timeoutOrElse({ duration: args.timeoutMs ?? 20_000, orElse: () => Effect.succeed<HarnessSkill[]>([]) }),
    )
  })

  const startTurn = Effect.fn("GrokCli.startTurn")(function* (args: StartGrokTurnArgs) {
    yield* Effect.annotateCurrentSpan("model", args.model)
    // A failed removal is left behind, as before: it is a temp directory.
    const removePromptDir = (directory: string) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)
    const promptDir = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "kanna-grok-" }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(new GrokPromptFileError({ operation: "make-directory", cwd: args.cwd, cause }))),
      ),
      removePromptDir,
    )
    const promptFile = path.join(promptDir, "prompt.txt")
    yield* fs.writeFileString(promptFile, args.content).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new GrokPromptFileError({ operation: "write", cwd: args.cwd, filePath: promptFile, cause }))),
    )

    const argv = [
      "--output-format", "streaming-json",
      "--prompt-file", promptFile,
      "--cwd", args.cwd,
      "-m", args.model,
    ]
    if (args.effort) argv.push("--reasoning-effort", args.effort)
    if (args.planMode) {
      argv.push("--permission-mode", "plan")
    } else {
      argv.push("--always-approve")
    }
    if (args.sessionToken) {
      argv.push("--resume", args.sessionToken)
      if (args.forkSession) argv.push("--fork-session")
    }

    // Ends the events if the scope closes before the process does.
    const queue = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
    yield* Effect.addFinalizer(() => Queue.end(queue))
    const coalescer = new GrokStreamCoalescer()

    let sawResult = false

    // Headless plan mode has no channel back to the CLI: stdin is closed, so
    // an ExitPlanMode or AskUserQuestion call can only be recorded, never
    // answered. Like Codex's plan turns, the answer goes in a follow-up turn
    // instead. The turn's own success result is held back so the turn stays
    // active, and at the end it parks on the last such call, which puts the
    // chat in waiting_for_user with the approval or question card live. The
    // CLI's own result for that call (it had no one to ask) is dropped, or the
    // card would render as already answered. The agent's respondTool then
    // queues the follow-up that resumes this session.
    const deferToUser = args.planMode && args.onToolRequest ? args.onToolRequest : null
    let awaitingUser: InteractiveTool | null = null
    let heldResult: HarnessEvent | null = null

    const emit = (event: HarnessEvent) => Effect.suspend(() => {
      const entry = event.type === "transcript" ? event.entry : undefined
      if (deferToUser && entry) {
        if (entry.kind === "tool_call" && isInteractiveTool(entry.tool)) {
          awaitingUser = entry.tool
        } else if (entry.kind === "tool_result" && awaitingUser && entry.toolId === awaitingUser.toolId) {
          return Effect.void
        } else if (entry.kind === "result" && awaitingUser && !entry.isError) {
          sawResult = true
          heldResult = event
          return Effect.void
        }
      }
      if (entry?.kind === "result") sawResult = true
      return Queue.offer(queue, event).pipe(Effect.asVoid)
    })
    const emitAll = (events: HarnessEvent[]) => Effect.forEach(events, emit, { discard: true })

    const finalize = Effect.fn("GrokCli.finishTurn")(function* (exit: { readonly code: number | null; readonly stderr: string }) {
      yield* removePromptDir(promptDir)
      yield* emitAll(coalescer.finish())
      const held = heldResult
      if (deferToUser && awaitingUser && held) {
        // Succeeds once the user answers. It fails if the turn was already
        // gone, and then the held result closes the turn the ordinary way.
        const answered = yield* Effect.exit(deferToUser({ tool: awaitingUser }))
        if (Exit.isFailure(answered)) yield* Queue.offer(queue, held)
        yield* Queue.end(queue)
        return
      }
      if (held) yield* Queue.offer(queue, held)
      if (!sawResult) {
        const detail = exit.stderr.trim() || `grok exited with code ${exit.code ?? "unknown"}`
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
    })

    const proc = yield* pumpCliTurn({
      spawn: spawnProcess({ cwd: args.cwd, argv }),
      onLine: (line) => emitAll(coalescer.push(parseGrokLine(line, args.model))),
      onExit: finalize,
    })

    return {
      provider: "grok",
      events: Stream.fromQueue(queue),
      interrupt: Option.match(proc, { onNone: () => Effect.void, onSome: (child) => child.kill("SIGINT") }),
    } satisfies HarnessTurnEffect
  })

  return { startTurn, listModels, listSkills } satisfies GrokCli["Service"]
})

export class GrokUsageError extends Schema.TaggedError<GrokUsageError>()(
  "@kanna/server/grok-cli/GrokUsageError",
  {
    /** What the usage card shows after "Failed to read Grok usage: ". */
    message: Schema.String,
    url: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

const decodeAuthFile = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** The grok CLI's sign-in token, or null when it is signed out or the file can't be read. */
export const readGrokAuthToken = Effect.fn("GrokCli.readAuthToken")(function* (filePath?: string) {
  const fs = yield* FileSystem.FileSystem
  const authPath = filePath ?? path.join((yield* Machine).homeDirectory, ".grok", "auth.json")
  return yield* fs.readFileString(authPath).pipe(
    Effect.flatMap(decodeAuthFile),
    Effect.map(readGrokAuthTokenFromFile),
    Effect.catchTag("PlatformError", () => Effect.succeed(null)),
    Effect.catchTag("SchemaError", () => Effect.succeed(null)),
  )
})

const decodeGrokBilling = Schema.decodeUnknownEffect(GrokBilling)
const decodeGrokUser = Schema.decodeUnknownEffect(GrokUser)

const usageErrorMessage =(cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/**
 * Grok Build billing and subscription from cli-chat-proxy, with the CLI's
 * own token. Null when grok is signed out.
 */
export const fetchGrokAccountUsage = Effect.fn("GrokCli.fetchAccountUsage")(function* (args: {
  token?: string | null
  fetchFn?: typeof fetch
  baseUrl?: string
} = {}) {
  const token = args.token ?? (yield* readGrokAuthToken())
  if (!token) return null
  const fetchFn = args.fetchFn ?? fetch
  const base = (args.baseUrl ?? grokProxyBaseUrl((yield* Machine).env.snapshot())).replace(/\/$/, "")
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" }

  const get = (url: string) => Effect.tryPromise({
    try: (signal) => fetchFn(url, { headers, signal }),
    catch: (cause) => new GrokUsageError({ message: usageErrorMessage(cause), url, cause }),
  })
  const readBody = <A>(url: string, response: Response, decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
    Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (cause) => new GrokUsageError({ message: usageErrorMessage(cause), url, status: response.status, cause }),
    }).pipe(
      // The schemas fall back rather than fail; a failure here is a bug in them.
      Effect.flatMap((body) => decode(body).pipe(Effect.orDie)),
    )

  const billingUrl = `${base}/billing?format=credits`
  const userUrl = `${base}/user?include=subscription`
  const [billingResponse, userResponse] = yield* Effect.all([get(billingUrl), get(userUrl)], { concurrency: 2 })
  if (!billingResponse.ok) {
    return yield* new GrokUsageError({
      message: `Grok billing request failed (${billingResponse.status}).`,
      url: billingUrl,
      status: billingResponse.status,
      cause: null,
    })
  }
  const billing = yield* readBody(billingUrl, billingResponse, decodeGrokBilling)
  const user = userResponse.ok ? yield* readBody(userUrl, userResponse, decodeGrokUser) : {}
  return { billing, user } satisfies { billing: GrokBillingRaw; user: GrokUserRaw }
})

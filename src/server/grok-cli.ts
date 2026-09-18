import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { ContextWindowUsageSnapshot, HarnessSkill, TodoItem } from "../shared/types"
import { asNumber, asRecord, asString } from "../shared/json"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { AsyncQueue } from "./async-queue"
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

export interface GrokChildProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: "close", listener: (code: number | null) => void): unknown
  once(event: "error", listener: (err: Error) => void): unknown
}

export type SpawnGrokAgent = (args: { cwd: string; argv: string[] }) => GrokChildProcess

export interface StartGrokTurnArgs {
  cwd: string
  content: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
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

export interface GrokBillingProductUsage {
  product?: string
  usagePercent?: number
}

export interface GrokBillingRaw {
  config?: {
    currentPeriod?: { type?: string; start?: string; end?: string }
    creditUsagePercent?: number
    onDemandCap?: { val?: number } | number
    onDemandUsed?: { val?: number } | number
    prepaidBalance?: { val?: number } | number
    productUsage?: GrokBillingProductUsage[]
    billingPeriodStart?: string
    billingPeriodEnd?: string
  }
}

export interface GrokUserRaw {
  email?: string | null
  subscriptionTier?: string | null
  hasGrokCodeAccess?: boolean
}

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

/**
 * Parse a single NDJSON line from `grok --output-format streaming-json`.
 * Text deltas are returned as assistant_text; the manager coalesces them.
 */
export function parseGrokLine(line: string, configuredModel: string): HarnessEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let value: Record<string, unknown> | null
  try {
    value = asRecord(JSON.parse(trimmed))
  } catch {
    return []
  }
  if (!value) return []

  const type = asString(value.type)
  const debugRaw = trimmed

  switch (type) {
    case "available_commands": {
      return [{
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
      }]
    }

    case "text": {
      const text = asString(value.data) ?? ""
      if (!text) return []
      return [{ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) }]
    }

    case "tool_call": {
      const callId = asString(value.toolCallId) ?? asString(value.call_id) ?? randomUUID()
      const rawName = asString(value.toolName) ?? asString(value.title) ?? "unknown"
      const args = asRecord(value.rawInput) ?? asRecord(value.input) ?? {}
      const { toolName, input } = translateGrokTool(rawName, args)
      return [{
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: normalizeToolCall({ toolName, toolId: callId, input }),
        }),
      }]
    }

    case "tool_call_update": {
      const events: HarnessEvent[] = []
      const callId = asString(value.toolCallId) ?? asString(value.call_id)
      const todoPayload = grokTodosFromPayload(value)
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
      const status = asString(value.status)
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
          content: extractToolResultContent(value),
          isError,
        }),
      })
      return events
    }

    case "usage": {
      const usage = normalizeGrokUsage(value.usage)
      if (!usage) return []
      return [{ type: "transcript", entry: timestamped({ kind: "context_window_updated", usage }) }]
    }

    case "end": {
      const events: HarnessEvent[] = []
      const sessionId = asString(value.sessionId) ?? asString(value.session_id)
      if (sessionId) events.push({ type: "session_token", sessionToken: sessionId })
      const usage = normalizeGrokUsage(value.usage)
      if (usage) {
        events.push({
          type: "transcript",
          entry: timestamped({ kind: "context_window_updated", usage }),
        })
      }
      const stopReason = asString(value.stopReason) ?? asString(value.stop_reason) ?? ""
      const isError = /error|fail/i.test(stopReason) && stopReason !== "end_turn"
      events.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: isError ? "error" : "success",
          isError,
          durationMs: 0,
          result: isError ? (asString(value.error) ?? stopReason) : "",
        }),
      })
      return events
    }

    default:
      return []
  }
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

export function parseGrokInspectSkills(output: string): HarnessSkill[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  const record = asRecord(parsed)
  const skills = Array.isArray(record?.skills) ? record.skills : []
  const result: HarnessSkill[] = []
  for (const skill of skills) {
    const skillRecord = asRecord(skill)
    const name = asString(skillRecord?.name)
    if (!name || name.startsWith("._")) continue
    const source = asRecord(skillRecord?.source)
    const skillPath = asString(source?.path)
    result.push({
      name,
      description: asString(skillRecord?.description) ?? "",
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

export function grokProxyBaseUrl(): string {
  const override = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim()
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

export class GrokCliManager {
  private readonly spawnProcess: SpawnGrokAgent

  constructor(args: { spawnProcess?: SpawnGrokAgent } = {}) {
    this.spawnProcess =
      args.spawnProcess ??
      (({ cwd, argv }) =>
        spawn("grok", argv, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }) as unknown as GrokChildProcess)
  }

  async listModels(timeoutMs = 30_000): Promise<GrokModelListEntry[]> {
    const child = this.spawnProcess({ cwd: homedir(), argv: ["models"] })
    return await new Promise<GrokModelListEntry[]>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let settled = false
      const settle = (complete: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        complete()
      }
      const timeout = setTimeout(() => {
        settle(() => reject(new Error(`grok models timed out after ${timeoutMs}ms`)))
        try { child.kill() } catch { /* gone */ }
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString() })
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString() })
      child.once("error", (err) => settle(() => reject(err)))
      child.once("close", (code) => settle(() => {
        const models = parseGrokModelList(stdout)
        if (code === 0 && models.length > 0) {
          resolve(models)
          return
        }
        reject(new Error(
          stderr.trim() || `grok models exited with code ${code ?? "unknown"} without listing models`,
        ))
      }))
      child.stdin?.end()
    })
  }

  async listSkills(args: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }): Promise<HarnessSkill[]> {
    const timeoutMs = args.timeoutMs ?? 20_000
    const child = this.spawnProcess({ cwd: args.cwd, argv: ["inspect", "--json"] })
    return await new Promise<HarnessSkill[]>((resolve) => {
      let stdout = ""
      let settled = false
      const settle = (skills: HarnessSkill[]) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(skills)
      }
      const timeout = setTimeout(() => {
        try { child.kill() } catch { /* gone */ }
        settle([])
      }, timeoutMs)
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString() })
      child.once("error", () => settle([]))
      child.once("close", () => settle(parseGrokInspectSkills(stdout)))
      child.stdin?.end()
    })
  }

  async startTurn(args: StartGrokTurnArgs): Promise<HarnessTurn> {
    const promptDir = await mkdtemp(path.join(tmpdir(), "kanna-grok-"))
    const promptFile = path.join(promptDir, "prompt.txt")
    await writeFile(promptFile, args.content, "utf8")

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

    const child = this.spawnProcess({ cwd: args.cwd, argv })
    const queue = new AsyncQueue<HarnessEvent>()
    const coalescer = new GrokStreamCoalescer()

    let sawResult = false
    let finished = false
    let stderr = ""

    const cleanupPrompt = () => {
      void rm(promptDir, { recursive: true, force: true }).catch(() => undefined)
    }

    const finalize = (code: number | null) => {
      if (finished) return
      finished = true
      cleanupPrompt()
      for (const event of coalescer.finish()) queue.push(event)
      if (!sawResult) {
        const detail = stderr.trim() || `grok exited with code ${code ?? "unknown"}`
        queue.push({
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
      queue.finish()
    }

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on("line", (line) => {
        for (const event of coalescer.push(parseGrokLine(line, args.model))) {
          if (event.type === "transcript" && event.entry?.kind === "result") {
            sawResult = true
          }
          queue.push(event)
        }
      })
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })
    }

    child.once("error", (err) => {
      stderr += `\n${err.message}`
      finalize(null)
    })
    child.once("close", (code) => finalize(code))
    child.stdin?.end()

    return {
      provider: "grok",
      stream: queue,
      interrupt: async () => {
        try { child.kill("SIGINT") } catch { /* gone */ }
      },
      close: () => {
        try { child.kill() } catch { /* gone */ }
        cleanupPrompt()
      },
    }
  }
}

export async function readGrokAuthToken(filePath = path.join(homedir(), ".grok", "auth.json")): Promise<string | null> {
  try {
    const text = await readFile(filePath, "utf8")
    return readGrokAuthTokenFromFile(JSON.parse(text))
  } catch {
    return null
  }
}

export async function fetchGrokAccountUsage(args: {
  token?: string | null
  fetchFn?: typeof fetch
  baseUrl?: string
} = {}): Promise<{ billing: GrokBillingRaw; user: GrokUserRaw } | null> {
  const token = args.token ?? await readGrokAuthToken()
  if (!token) return null
  const fetchFn = args.fetchFn ?? fetch
  const base = (args.baseUrl ?? grokProxyBaseUrl()).replace(/\/$/, "")
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" }
  const [billingResponse, userResponse] = await Promise.all([
    fetchFn(`${base}/billing?format=credits`, { headers }),
    fetchFn(`${base}/user?include=subscription`, { headers }),
  ])
  if (!billingResponse.ok) {
    throw new Error(`Grok billing request failed (${billingResponse.status}).`)
  }
  const billing = await billingResponse.json() as GrokBillingRaw
  let user: GrokUserRaw = {}
  if (userResponse.ok) {
    user = await userResponse.json() as GrokUserRaw
  }
  return { billing, user }
}

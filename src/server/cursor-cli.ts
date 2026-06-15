import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { ContextWindowUsageSnapshot } from "../shared/types"
import { asNumber, asRecord, asString } from "../shared/json"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { AsyncQueue } from "./async-queue"
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

// Minimal child-process surface so tests can inject a fake without rebuilding ChildProcess.
export interface CursorChildProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: "close", listener: (code: number | null) => void): unknown
  once(event: "error", listener: (err: Error) => void): unknown
}

export type SpawnCursorAgent = (args: { cwd: string; argv: string[] }) => CursorChildProcess

export interface StartCursorTurnArgs {
  cwd: string
  content: string
  /** Concrete model id to spawn, e.g. "composer-2.5" or "composer-2.5-fast". */
  model: string
  /** Previous Cursor session id to resume, if any. */
  sessionToken: string | null
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
          rawName: k.slice(0, -"ToolCall".length),
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

function extractAssistantText(message: unknown): string {
  const content = asRecord(message)?.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((item): item is Record<string, unknown> => asRecord(item)?.type === "text")
    .map((item) => asString(item.text) ?? "")
    .join("")
}

/**
 * Parse a single NDJSON line from `cursor-agent` into Kanna harness events.
 * Pure and side-effect free so it can be unit tested against captured fixtures.
 */
export function parseCursorLine(line: string, configuredModel: string): HarnessEvent[] {
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
    case "system": {
      if (asString(value.subtype) !== "init") return []
      const events: HarnessEvent[] = []
      const sessionId = asString(value.session_id)
      if (sessionId) events.push({ type: "session_token", sessionToken: sessionId })
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
    }

    case "assistant": {
      const text = extractAssistantText(value.message)
      if (!text) return []
      return [{ type: "transcript", entry: timestamped({ kind: "assistant_text", text, debugRaw }) }]
    }

    case "tool_call": {
      const subtype = asString(value.subtype)
      const callId = asString(value.call_id) ?? randomUUID()
      const { rawName, args, result } = extractCursorTool(value.tool_call)

      if (subtype === "started") {
        const { toolName, input } = translateCursorTool(rawName, args)
        return [
          {
            type: "transcript",
            entry: timestamped({
              kind: "tool_call",
              tool: normalizeToolCall({ toolName, toolId: callId, input }),
              debugRaw,
            }),
          },
        ]
      }

      if (subtype === "completed") {
        const resultRecord = asRecord(result)
        const success = resultRecord && "success" in resultRecord
        const isError = Boolean(resultRecord && ("error" in resultRecord || "failure" in resultRecord))
        const content = resultRecord
          ? (resultRecord.success ?? resultRecord.error ?? resultRecord.failure ?? result)
          : result
        return [
          {
            type: "transcript",
            entry: timestamped({
              kind: "tool_result",
              toolId: callId,
              content,
              isError: isError || !success,
              debugRaw,
            }),
          },
        ]
      }

      return []
    }

    case "result": {
      const events: HarnessEvent[] = []
      const usage = normalizeCursorUsage(value.usage)
      if (usage) {
        events.push({
          type: "transcript",
          entry: timestamped({ kind: "context_window_updated", usage }),
        })
      }
      const isError = Boolean(value.is_error)
      events.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: isError ? "error" : "success",
          isError,
          durationMs: asNumber(value.duration_ms) ?? 0,
          result: asString(value.result) ?? "",
          debugRaw,
        }),
      })
      return events
    }

    // "user" (prompt echo), "thinking" (reasoning), and unknown types are dropped —
    // Kanna already records the user prompt and has no reasoning transcript kind.
    default:
      return []
  }
}

export class CursorCliManager {
  private readonly spawnProcess: SpawnCursorAgent

  constructor(args: { spawnProcess?: SpawnCursorAgent } = {}) {
    this.spawnProcess =
      args.spawnProcess ??
      (({ cwd, argv }) =>
        spawn("cursor-agent", argv, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }) as unknown as CursorChildProcess)
  }

  async startTurn(args: StartCursorTurnArgs): Promise<HarnessTurn> {
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

    const child = this.spawnProcess({ cwd: args.cwd, argv })
    const queue = new AsyncQueue<HarnessEvent>()

    let sawResult = false
    let finished = false
    let stderr = ""

    const finalize = (code: number | null) => {
      if (finished) return
      finished = true
      if (!sawResult) {
        const detail = stderr.trim() || `cursor-agent exited with code ${code ?? "unknown"}`
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
        for (const event of parseCursorLine(line, args.model)) {
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

    // Send the prompt over stdin and close it so the agent starts.
    if (child.stdin) {
      child.stdin.end(args.content)
    }

    return {
      provider: "cursor",
      stream: queue,
      interrupt: async () => {
        try {
          child.kill("SIGINT")
        } catch {
          // process already gone
        }
      },
      close: () => {
        try {
          child.kill()
        } catch {
          // process already gone
        }
      },
    }
  }
}

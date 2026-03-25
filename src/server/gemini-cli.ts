import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { HarnessEvent, HarnessTurn } from "./harness-types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartGeminiTurnArgs {
  content: string
  localPath: string
  model: string
  sessionToken: string | null
}

/** Shape of each JSONL line emitted by `gemini --output-format stream-json`. */
interface GeminiStreamEvent {
  type: "init" | "message" | "tool_use" | "tool_result" | "error" | "result"
  [key: string]: unknown
}

const GEMINI_STDIO_NOISE = new Set([
  "YOLO mode is enabled. All tool calls will be automatically approved.",
  "Loaded cached credentials.",
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now(),
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function parseJsonLine(line: string): GeminiStreamEvent | null {
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as GeminiStreamEvent
    }
    return null
  } catch {
    return null
  }
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseObjectPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Ignore invalid JSON payloads and fall back to an empty record.
    }
  }
  return {}
}

function extractResultMessage(event: GeminiStreamEvent): string {
  const directMessage = typeof event.message === "string" ? event.message.trim() : ""
  if (directMessage) return directMessage

  const errorText = stringifyPayload(event.error).trim()
  if (errorText) return errorText

  const detailsText = stringifyPayload(event.details).trim()
  if (detailsText) return detailsText

  return "Turn failed"
}

function normalizeDiagnosticLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || GEMINI_STDIO_NOISE.has(trimmed)) return null
  return trimmed
}

// ---------------------------------------------------------------------------
// Event normalisation — maps Gemini stream-json events to TranscriptEntry[]
// ---------------------------------------------------------------------------

function normalizeGeminiStreamEvent(event: GeminiStreamEvent, model: string): {
  entries: TranscriptEntry[]
  sessionId?: string
  /** assistant text delta to accumulate (emitted as one entry on result) */
  textDelta?: string
} {
  const debugRaw = JSON.stringify(event)

  switch (event.type) {
    case "init": {
      // Actual field is session_id (snake_case)
      const sessionId = typeof event.session_id === "string" ? event.session_id : undefined
      const eventModel = typeof event.model === "string" ? event.model : model
      return {
        sessionId,
        entries: [
          timestamped({
            kind: "system_init",
            provider: "gemini",
            model: eventModel,
            tools: [],
            agents: [],
            slashCommands: [],
            mcpServers: [],
            debugRaw,
          }),
        ],
      }
    }

    case "message": {
      const role = typeof event.role === "string" ? event.role : "assistant"
      const content = typeof event.content === "string" ? event.content : ""
      // All assistant messages come with delta:true (streaming chunks).
      // Accumulate them so we can emit one complete entry at result time.
      if (role === "assistant" && content) {
        return { entries: [], textDelta: content }
      }
      return { entries: [] }
    }

    case "tool_use": {
      // Actual fields: tool_name, tool_id, parameters
      const toolName = typeof event.tool_name === "string"
        ? event.tool_name
        : typeof event.name === "string"
          ? event.name
          : "unknown"
      const toolId = typeof event.tool_id === "string" ? event.tool_id : randomUUID()
      const args = parseObjectPayload(event.parameters ?? event.args)

      if (toolName === "codebase_investigator" || toolName === "cli_help") {
        const tool = normalizeToolCall({
          toolName,
          toolId,
          input: {
            ...args,
            subagent_type: toolName,
          },
        })

        return {
          entries: [
            timestamped({
              kind: "tool_call",
              tool,
              debugRaw,
            }),
          ],
        }
      }

      const mapped = mapGeminiToolName(toolName)
      const tool = normalizeToolCall({ toolName: mapped, toolId, input: args })

      return {
        entries: [
          timestamped({
            kind: "tool_call",
            tool,
            debugRaw,
          }),
        ],
      }
    }

    case "tool_result": {
      // Actual fields: tool_id, status, output, error
      const toolId = typeof event.tool_id === "string" ? event.tool_id : randomUUID()
      const output = stringifyPayload(event.output)
      const errorText = stringifyPayload(event.error)
      const isError = event.status === "error"
      return {
        entries: [
          timestamped({
            kind: "tool_result",
            toolId,
            content: isError ? errorText || output : output,
            isError,
            debugRaw,
          }),
        ],
      }
    }

    case "error": {
      const message = typeof event.message === "string" ? event.message : "Unknown error"
      return {
        entries: [
          timestamped({
            kind: "status",
            status: `Error: ${message}`,
            debugRaw,
          }),
        ],
      }
    }

    case "result": {
      // Actual fields: status ('success'|'error'), stats.duration_ms
      const success = event.status === "success"
      const stats = (event.stats && typeof event.stats === "object" ? event.stats : {}) as Record<string, unknown>
      const durationMs = typeof stats.duration_ms === "number" ? stats.duration_ms : 0

      return {
        entries: [
          timestamped({
            kind: "result",
            subtype: success ? "success" : "error",
            isError: !success,
            durationMs,
            result: success ? "Turn completed" : extractResultMessage(event),
            costUsd: undefined,
          }),
        ],
      }
    }

    default:
      return { entries: [] }
  }
}

/**
 * Maps Gemini CLI tool names to the tool names that `normalizeToolCall()` expects.
 * Names sourced from @google/gemini-cli-core ALL_BUILTIN_TOOL_NAMES.
 */
function mapGeminiToolName(geminiName: string): string {
  switch (geminiName) {
    case "read_file":
      return "Read"
    case "read_many_files":
      return "Read"
    case "write_file":
      return "Write"
    case "replace":           // Gemini's edit/replace tool
      return "Edit"
    case "run_shell_command":
      return "Bash"
    case "google_web_search":
      return "WebSearch"
    case "web_fetch":
      return "WebFetch"
    case "glob":
      return "Glob"
    case "grep_search":
      return "Grep"
    case "list_directory":
    case "list_directory_legacy": // legacy alias
      return "LS"
    default:
      return geminiName
  }
}

// ---------------------------------------------------------------------------
// AsyncQueue — minimal async-iterable queue (same pattern as codex-app-server)
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  push(value: T) {
    if (this.done) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
      return
    }
    this.values.push(value)
  }

  finish() {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

// ---------------------------------------------------------------------------
// GeminiCliManager
// ---------------------------------------------------------------------------

export class GeminiCliManager {
  private activeProcesses = new Map<string, ChildProcess>()
  private readonly systemSettingsPath: string

  constructor() {
    this.systemSettingsPath = join(tmpdir(), `kanna-gemini-settings-${process.pid}.json`)
    writeFileSync(this.systemSettingsPath, JSON.stringify({
      agents: {
        overrides: {
          codebase_investigator: {
            enabled: false,
          },
        },
      },
    }))
  }

  /**
   * Start a new turn by spawning `gemini` in headless mode with stream-json output.
   * Returns a HarnessTurn compatible with AgentCoordinator.runTurn().
   */
  async startTurn(args: StartGeminiTurnArgs): Promise<HarnessTurn> {
    const cliArgs = [
      "-p", args.content,
      "--output-format", "stream-json",
      "--model", args.model,
      "--approval-mode", "yolo",
    ]

    // Resume previous session if we have a token
    if (args.sessionToken) {
      cliArgs.push("--resume", args.sessionToken)
    }

    const child = spawn("gemini", cliArgs, {
      cwd: args.localPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: this.systemSettingsPath,
      },
    })

    const queue = new AsyncQueue<HarnessEvent>()
    let sessionId: string | null = null
    const stderrChunks: string[] = []
    let assistantTextAccum = ""
    let sawFinalResult = false
    let lastDiagnosticMessage: string | null = null

    // Track the process for interrupt/close
    const processId = randomUUID()
    this.activeProcesses.set(processId, child)

    // Read stderr for diagnostics
    if (child.stderr) {
      const stderrRl = createInterface({ input: child.stderr })
      stderrRl.on("line", (line: string) => {
        stderrChunks.push(`${line}\n`)
        const diagnostic = normalizeDiagnosticLine(line)
        if (!diagnostic) return
        lastDiagnosticMessage = diagnostic
        queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "status",
            status: diagnostic,
          }),
        })
      })
    }

    // Parse stdout line-by-line as JSONL
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })

      rl.on("line", (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return

        const event = parseJsonLine(trimmed)
        if (!event) return

        const result = normalizeGeminiStreamEvent(event, args.model)

        // Capture session ID for resume capability
        if (result.sessionId) {
          sessionId = result.sessionId
          queue.push({ type: "session_token", sessionToken: sessionId })
        }

        // Accumulate assistant text deltas — Gemini streams all text as delta:true chunks
        if (result.textDelta) {
          assistantTextAccum += result.textDelta
        }

        // Before emitting the result entry, flush the accumulated assistant text
        if (event.type === "result" && assistantTextAccum) {
          queue.push({
            type: "transcript",
            entry: timestamped({ kind: "assistant_text", text: assistantTextAccum }),
          })
          assistantTextAccum = ""
        }

        if (event.type === "result") {
          sawFinalResult = true
        }

        for (const entry of result.entries) {
          queue.push({ type: "transcript", entry })
        }
      })

      rl.on("close", () => {
        // Flush any remaining accumulated text if process ends without a result event
        if (assistantTextAccum) {
          queue.push({
            type: "transcript",
            entry: timestamped({ kind: "assistant_text", text: assistantTextAccum }),
          })
          assistantTextAccum = ""
        }
      })
    }

    // Handle process exit
    child.on("close", (code) => {
      this.activeProcesses.delete(processId)

      // If we haven't received a "result" event, synthesise one from the exit code
      if (!sawFinalResult && code !== 0 && code !== null) {
        const errorMessage = stderrChunks.join("").trim() || lastDiagnosticMessage || `Gemini CLI exited with code ${code}`
        queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: errorMessage,
          }),
        })
      }

      queue.finish()
    })

    child.on("error", (error) => {
      this.activeProcesses.delete(processId)
      queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: error.message.includes("ENOENT")
            ? "Gemini CLI not found. Install it with: npm install -g @google/gemini-cli"
            : `Gemini CLI error: ${error.message}`,
        }),
      })
      queue.finish()
    })

    return {
      provider: "gemini",
      stream: queue,
      interrupt: async () => {
        if (!child.killed) {
          child.kill("SIGINT")
        }
      },
      close: () => {
        if (!child.killed) {
          child.kill("SIGTERM")
        }
        this.activeProcesses.delete(processId)
      },
    }
  }

  /** Stop all active Gemini processes (e.g. on server shutdown). */
  stopAll() {
    for (const [id, child] of this.activeProcesses) {
      if (!child.killed) {
        child.kill("SIGTERM")
      }
      this.activeProcesses.delete(id)
    }
  }
}

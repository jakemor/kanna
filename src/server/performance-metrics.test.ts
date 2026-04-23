import { describe, test } from "bun:test"
import { query, type Query } from "@anthropic-ai/claude-agent-sdk"
import { fallbackTitleFromMessage, generateTitleForChatDetailed } from "./generate-title"
import { QuickResponseAdapter } from "./quick-response"
import { CodexAppServerManager } from "./codex-app-server"

interface MetricResult {
  name: string
  duration: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  success: boolean
  error?: string
}

interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
}

const metrics: MetricResult[] = []

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatTokens(input?: number, output?: number): string {
  if (!input && !output) return "N/A"
  const parts = []
  if (input) parts.push(`in:${input}`)
  if (output) parts.push(`out:${output}`)
  return parts.join(" | ")
}

function printMetricsTable() {
  console.log("\n" + "=".repeat(100))
  console.log("📊 PERFORMANCE METRICS REPORT")
  console.log("=".repeat(100))

  const maxNameLength = Math.max(...metrics.map((m) => m.name.length), 10)
  const header = [
    "Feature".padEnd(maxNameLength),
    "Time".padEnd(12),
    "Tokens (in | out)".padEnd(28),
    "Status".padEnd(8),
  ].join(" | ")

  console.log(header)
  console.log("-".repeat(100))

  let totalTime = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0

  metrics.forEach((m) => {
    totalTime += m.duration
    if (m.inputTokens) totalInputTokens += m.inputTokens
    if (m.outputTokens) totalOutputTokens += m.outputTokens

    const status = m.success ? "✓ PASS" : "✗ FAIL"
    const tokenStr = formatTokens(m.inputTokens, m.outputTokens)
    const row = [
      m.name.padEnd(maxNameLength),
      formatDuration(m.duration).padEnd(12),
      tokenStr.padEnd(28),
      status.padEnd(8),
    ].join(" | ")

    console.log(row)
  })

  console.log("-".repeat(100))
  const totalTokenStr = formatTokens(
    totalInputTokens || undefined,
    totalOutputTokens || undefined
  )
  console.log(
    [
      "TOTAL".padEnd(maxNameLength),
      formatDuration(totalTime).padEnd(12),
      totalTokenStr.padEnd(28),
      "".padEnd(8),
    ].join(" | ")
  )
  console.log("=".repeat(100) + "\n")
}

function extractTokensFromMessage(message: unknown): TokenUsage {
  if (!message || typeof message !== "object") return {}
  const record = message as Record<string, unknown>

  if (record.usage && typeof record.usage === "object") {
    const usage = record.usage as Record<string, unknown>
    return {
      input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    }
  }

  if (record.message && typeof record.message === "object") {
    const msg = record.message as Record<string, unknown>
    if (msg.usage && typeof msg.usage === "object") {
      const usage = msg.usage as Record<string, unknown>
      return {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
      }
    }
  }

  return {}
}

async function runClaudeStructuredWithMetrics(
  prompt: string,
  schema: unknown
): Promise<{ success: boolean; inputTokens?: number; outputTokens?: number }> {
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  const q = query({
    prompt,
    options: {
      cwd: process.cwd(),
      model: "claude-haiku-4-5-20251001",
      tools: [],
      systemPrompt: "You are a helpful assistant.",
      effort: "low",
      permissionMode: "bypassPermissions",
      outputFormat: {
        type: "json_schema",
        schema,
      },
      env: { ...process.env },
    },
  })

  try {
    for await (const message of q) {
      const usage = extractTokensFromMessage(message)
      if (usage.input_tokens) inputTokens = usage.input_tokens
      if (usage.output_tokens) outputTokens = usage.output_tokens
    }
    return { success: true, inputTokens, outputTokens }
  } catch {
    return { success: false, inputTokens, outputTokens }
  } finally {
    try {
      q.close()
    } catch {}
  }
}

describe("performance metrics showcase", () => {
  test("title generation from message", async () => {
    const testMessage =
      "I need help implementing a caching layer for my REST API to improve performance"

    const start = performance.now()

    try {
      const result = await generateTitleForChatDetailed(testMessage, process.cwd(), new QuickResponseAdapter({}))
      const duration = performance.now() - start
      const isReasonable = result.title !== fallbackTitleFromMessage(testMessage)

      metrics.push({
        name: "Title Generation",
        duration,
        success: isReasonable && !result.usedFallback,
      })
    } catch (error) {
      const duration = performance.now() - start
      metrics.push({
        name: "Title Generation",
        duration,
        success: false,
        error: String(error),
      })
    }
  }, 30_000)

  test("json schema structured output", async () => {
    const start = performance.now()
    const schema = {
      type: "object",
      properties: {
        category: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["category", "priority"],
    }

    try {
      const result = await runClaudeStructuredWithMetrics(
        "User wants to build a mobile app with TypeScript and React Native. Categorize this request.",
        schema
      )

      const duration = performance.now() - start
      metrics.push({
        name: "Structured Output",
        duration,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        success: result.success,
      })
    } catch (error) {
      const duration = performance.now() - start
      metrics.push({
        name: "Structured Output",
        duration,
        success: false,
        error: String(error),
      })
    }
  }, 30_000)

  test("codex server integration", async () => {
    const start = performance.now()

    try {
      const manager = new CodexAppServerManager()
      const isRunning = await manager.ensureServerRunning()
      const duration = performance.now() - start

      metrics.push({
        name: "Codex Server Init",
        duration,
        success: isRunning,
      })
    } catch (error) {
      const duration = performance.now() - start
      metrics.push({
        name: "Codex Server Init",
        duration,
        success: false,
        error: String(error),
      })
    }
  }, 30_000)

  test("print final metrics report", async () => {
    printMetricsTable()
  })
})

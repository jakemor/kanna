import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { processTranscriptMessages } from "../client/lib/parseTranscript"
import type { TranscriptEntry } from "../shared/types"
import { normalizeClaudeStreamMessage } from "./agent"

/**
 * Replays a real recorded Claude Agent SDK turn (Read + Bash + text; see
 * scripts/record-claude-fixture.ts) through the full transcript pipeline:
 * raw SDK messages → normalizeClaudeStreamMessage (server) →
 * processTranscriptMessages (client hydration). Live turns can't run in CI,
 * so this fixture is the regression net for the streaming pipeline — in
 * particular the debugRaw trim (raw JSON only on system_init/tool_result)
 * against real wire shapes rather than hand-written ones.
 *
 * Re-record with: bun run ./scripts/record-claude-fixture.ts
 */

const FIXTURE_PATH = path.join(import.meta.dir, "__fixtures__/claude-turn.jsonl")

function loadRawMessages(): Array<Record<string, unknown>> {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function normalizeTurn(rawMessages: Array<Record<string, unknown>>): TranscriptEntry[] {
  return rawMessages.flatMap((message) => normalizeClaudeStreamMessage(message))
}

describe("recorded Claude turn replay", () => {
  const rawMessages = loadRawMessages()
  const entries = normalizeTurn(rawMessages)

  test("the fixture is a real multi-tool turn", () => {
    // If a re-recording produced a degenerate turn (no tools, an errored
    // result), fail loudly instead of silently weakening the suite.
    expect(rawMessages.length).toBeGreaterThanOrEqual(8)
    const init = rawMessages.find((message) => message.type === "system" && message.subtype === "init")
    expect(init).toBeDefined()

    const toolCalls = entries.filter((entry) => entry.kind === "tool_call")
    const toolNames = toolCalls.map((entry) => entry.kind === "tool_call" ? entry.tool.toolName : "")
    expect(toolNames).toContain("Read")
    expect(toolNames).toContain("Bash")

    const results = entries.filter((entry) => entry.kind === "result")
    expect(results).toHaveLength(1)
    if (results[0]?.kind !== "result") throw new Error("unexpected entry")
    expect(results[0].isError).toBe(false)
  })

  test("normalization stamps debugRaw on exactly system_init and tool_result entries", () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      const debugRaw = (entry as { debugRaw?: string }).debugRaw
      if (entry.kind === "system_init" || entry.kind === "tool_result") {
        expect(debugRaw).toBeString()
        // The stamp must round-trip to the raw SDK message so the client can
        // re-parse it (raw JSON view / tool_use_result extraction).
        expect(rawMessages).toContainEqual(JSON.parse(debugRaw as string))
      } else {
        expect(entry).not.toHaveProperty("debugRaw")
      }
    }
  })

  test("every tool call from the real turn gets its result joined by toolId", () => {
    const toolCallIds = entries
      .filter((entry) => entry.kind === "tool_call")
      .map((entry) => (entry.kind === "tool_call" ? entry.tool.toolId : ""))
    const toolResultIds = entries
      .filter((entry) => entry.kind === "tool_result")
      .map((entry) => (entry.kind === "tool_result" ? entry.toolId : ""))

    expect(toolCallIds.length).toBeGreaterThanOrEqual(2)
    for (const toolId of toolCallIds) {
      expect(toolResultIds).toContain(toolId)
    }
  })

  test("non-transcript SDK messages normalize to nothing instead of unknown entries", () => {
    const nonTranscript = rawMessages.filter((message) =>
      message.type === "rate_limit_event" ||
      (message.type === "system" && message.subtype === "thinking_tokens")
    )
    expect(nonTranscript.length).toBeGreaterThan(0)
    for (const message of nonTranscript) {
      expect(normalizeClaudeStreamMessage(message)).toEqual([])
    }
  })

  test("the client hydration pipeline renders the whole turn", () => {
    const messages = processTranscriptMessages(entries)

    // Every hydrated message kind must be renderable — an "unknown" here means
    // the server emitted an entry kind the client doesn't handle.
    expect(messages.map((message) => message.kind)).not.toContain("unknown")

    const systemInit = messages.find((message) => message.kind === "system_init")
    if (systemInit?.kind !== "system_init") throw new Error("missing system_init")
    expect(systemInit.debugRaw).toBeString()
    expect(systemInit.model).not.toBe("unknown")
    expect(systemInit.tools.length).toBeGreaterThan(0)

    const toolMessages = messages.filter((message) => message.kind === "tool")
    expect(toolMessages.length).toBeGreaterThanOrEqual(2)
    for (const message of toolMessages) {
      if (message.kind !== "tool") continue
      // Real results hydrated onto the calls — the UI shows these inline.
      expect(message.result).toBeDefined()
      expect(message.isError).toBe(false)
    }

    const textMessages = messages.filter((message) => message.kind === "assistant_text")
    expect(textMessages.length).toBeGreaterThanOrEqual(1)

    const resultMessage = messages.find((message) => message.kind === "result")
    if (resultMessage?.kind !== "result") throw new Error("missing result")
    expect(resultMessage.success).toBe(true)
  })
})

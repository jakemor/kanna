import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import {
  applyThreadEstimate,
  estimateCurrentThreadTokens,
  mergeUsageSnapshots,
  reconstructClaudeUsage,
  reconstructCodexUsageFromFile,
} from "./usage"

function transcriptEntry(overrides: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: 1,
    ...overrides,
  } as TranscriptEntry
}

describe("usage reconstruction", () => {
  test("dedupes repeated Claude usage records that share the same raw message", () => {
    const debugRaw = JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      message: {
        usage: {
          input_tokens: 1200,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100,
          output_tokens: 80,
        },
      },
    })

    const snapshot = reconstructClaudeUsage([
      transcriptEntry({ kind: "assistant_text", text: "hello", debugRaw, messageId: "assistant-1", createdAt: 10 }),
      transcriptEntry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
        debugRaw,
        messageId: "assistant-1",
        createdAt: 11,
      }),
    ])

    expect(snapshot?.threadTokens).toBe(8)
    expect(snapshot?.lastTurnTokens).toBe(1680)
    expect(snapshot?.inputTokens).toBe(1200)
    expect(snapshot?.cachedInputTokens).toBe(400)
    expect(snapshot?.outputTokens).toBe(80)
  })

  test("extracts Claude context window from result modelUsage", () => {
    const snapshot = reconstructClaudeUsage([
      transcriptEntry({
        kind: "system_init",
        provider: "claude",
        model: "sonnet",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        createdAt: 1,
      }),
      transcriptEntry({
        kind: "user_prompt",
        content: "A".repeat(4000),
        createdAt: 2,
      }),
      transcriptEntry({
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 12,
        result: "done",
        createdAt: 20,
        debugRaw: JSON.stringify({
          type: "result",
          uuid: "result-1",
          usage: {
            input_tokens: 2000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 100,
            output_tokens: 250,
          },
          modelUsage: {
            "claude-sonnet": {
              contextWindow: 200000,
            },
          },
        }),
      }),
    ])

    expect(snapshot?.threadTokens).toBeGreaterThan(900)
    expect(snapshot?.contextWindowTokens).toBe(200000)
    expect(snapshot?.contextUsedPercent).not.toBeNull()
  })

  test("falls back to Claude model family context window when usage metadata omits it", () => {
    const snapshot = reconstructClaudeUsage([
      transcriptEntry({
        kind: "system_init",
        provider: "claude",
        model: "sonnet",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        createdAt: 1,
      }),
      transcriptEntry({
        kind: "assistant_text",
        text: "B".repeat(2000),
        createdAt: 2,
        debugRaw: JSON.stringify({
          type: "assistant",
          uuid: "assistant-2",
          message: {
            usage: {
              input_tokens: 1000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 100,
            },
          },
        }),
      }),
    ])

    expect(snapshot?.contextWindowTokens).toBe(200000)
  })

  test("reconstructs Codex usage from persisted token_count records", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-codex-usage-"))
    const sessionsDir = path.join(root, ".codex", "sessions", "2026", "03", "21")
    const sessionFile = path.join(sessionsDir, "rollout-thread-1.jsonl")
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(sessionFile, [
      JSON.stringify({
        timestamp: "2026-03-21T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "thread-1", cwd: "/tmp/project" },
      }),
      JSON.stringify({
        timestamp: "2026-03-21T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 3000,
              output_tokens: 900,
              reasoning_output_tokens: 200,
              total_tokens: 16100,
            },
            last_token_usage: {
              total_tokens: 4200,
            },
            model_context_window: 258400,
          },
          rate_limits: {
            primary: {
              used_percent: 82,
              resets_at: 1773838096,
            },
          },
        },
      }),
    ].join("\n"))

    try {
      const snapshot = reconstructCodexUsageFromFile("thread-1", path.join(root, ".codex", "sessions"))
      expect(snapshot?.threadTokens).toBeNull()
      expect(snapshot?.lastTurnTokens).toBe(4200)
      expect(snapshot?.contextWindowTokens).toBe(258400)
      expect(snapshot?.sessionLimitUsedPercent).toBe(82)
      expect(snapshot?.warnings).toContain("rate_warning")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("merges reconstructed and live usage snapshots", () => {
    const merged = mergeUsageSnapshots(
      {
        provider: "claude",
        threadTokens: 2000,
        contextWindowTokens: 10000,
        contextUsedPercent: 20,
        lastTurnTokens: 2000,
        inputTokens: 1500,
        outputTokens: 500,
        cachedInputTokens: 0,
        reasoningOutputTokens: null,
        sessionLimitUsedPercent: null,
        rateLimitResetAt: null,
        source: "reconstructed",
        updatedAt: 1,
        warnings: [],
      },
      {
        provider: "claude",
        threadTokens: null,
        contextWindowTokens: null,
        contextUsedPercent: null,
        lastTurnTokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
        sessionLimitUsedPercent: 91,
        rateLimitResetAt: 999,
        source: "live",
        updatedAt: 2,
        warnings: [],
      }
    )

    expect(merged?.threadTokens).toBe(2000)
    expect(merged?.sessionLimitUsedPercent).toBe(91)
    expect(merged?.warnings).toContain("rate_critical")
  })

  test("estimates current thread size from the transcript and applies it to usage snapshots", () => {
    const messages = [
      transcriptEntry({ kind: "user_prompt", content: "A".repeat(800), createdAt: 1 }),
      transcriptEntry({ kind: "assistant_text", text: "B".repeat(1200), createdAt: 2 }),
    ]

    const estimated = estimateCurrentThreadTokens(messages)
    expect(estimated).toBeGreaterThan(400)

    const snapshot = applyThreadEstimate({
      provider: "codex",
      threadTokens: null,
      contextWindowTokens: 10000,
      contextUsedPercent: null,
      lastTurnTokens: 3000,
      inputTokens: 2800,
      outputTokens: 200,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      sessionLimitUsedPercent: 10,
      rateLimitResetAt: null,
      source: "reconstructed",
      updatedAt: 10,
      warnings: [],
    }, messages)

    expect(snapshot?.threadTokens).toBe(estimated)
    expect(snapshot?.contextUsedPercent).toBeGreaterThan(1)
  })
})

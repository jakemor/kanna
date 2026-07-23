import { describe, expect, test } from "bun:test"
import type { TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import { timestamped } from "./transcript"
import {
  buildHandoffContext,
  buildHandoffMessageContent,
  HANDOFF_CHAR_BUDGET,
  HANDOFF_TOKEN_BUDGET,
  renderToolResultContent,
} from "./handoff"

const TRANSCRIPT_PATH = "/tmp/transcripts/chat-1.jsonl"

function userPrompt(content: string) {
  return timestamped({ kind: "user_prompt", content })
}

function assistantText(text: string) {
  return timestamped({ kind: "assistant_text", text })
}

function toolCall(toolName: string, input: Record<string, unknown>) {
  return timestamped({
    kind: "tool_call",
    tool: normalizeToolCall({ toolName, toolId: `tool-${toolName}`, input }),
  })
}

function toolResult(content: unknown) {
  return timestamped({ kind: "tool_result", toolId: "tool-x", content })
}

function build(entries: TranscriptEntry[], charBudget?: number) {
  return buildHandoffContext({
    entries,
    fromProvider: "claude",
    toProvider: "codex",
    transcriptPath: TRANSCRIPT_PATH,
    charBudget,
  })
}

describe("buildHandoffContext", () => {
  test("renders a plain-text transcript wrapped in handoff tags", () => {
    const context = build([
      userPrompt("fix the login bug"),
      assistantText("Looking at it now."),
      toolCall("Read", { file_path: "src/login.ts" }),
      toolResult("export function login() {}"),
      assistantText("Fixed."),
    ])

    expect(context).not.toBeNull()
    const text = context!.text
    expect(text).toStartWith("<system-message>")
    expect(text).toEndWith("</system-message>")
    expect(text).toContain("<handoff_transcript>")
    expect(text).toContain("</handoff_transcript>")
    expect(text).toContain("--- user ---\nfix the login bug")
    expect(text).toContain("--- assistant ---\nLooking at it now.")
    expect(text).toContain("--- assistant tool call: Read ---")
    expect(text).toContain("--- tool result ---\nexport function login() {}")
    // Points the new harness at the full JSONL for elided/omitted content.
    expect(text).toContain(TRANSCRIPT_PATH)
    // Provider labels, not raw ids.
    expect(text).toContain("(Claude Code)")
    expect(context!.stats.includedEntries).toBe(5)
    expect(context!.stats.elidedToolResults).toBe(0)
  })

  test("skips plumbing entries, hidden entries, and successful results", () => {
    const context = build([
      timestamped({ kind: "system_init", provider: "claude", model: "m", tools: [], agents: [], slashCommands: [], mcpServers: [] }),
      userPrompt("hello"),
      timestamped({ kind: "status", status: "compacting" }),
      timestamped({ kind: "context_window_updated", usage: { usedTokens: 10, compactsAutomatically: false } }),
      timestamped({ kind: "user_prompt", content: "secret steering", hidden: true }),
      assistantText("hi"),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 1, result: "hi" }),
    ])

    const text = context!.text
    expect(text).not.toContain("system_init")
    expect(text).not.toContain("compacting")
    expect(text).not.toContain("secret steering")
    expect(text).not.toContain("--- turn ended with error ---")
    expect(context!.stats.includedEntries).toBe(2)
  })

  test("keeps error results and prior handoff boundaries as markers", () => {
    const context = build([
      userPrompt("do it"),
      timestamped({ kind: "handoff_boundary", fromProvider: "codex", toProvider: "claude" }),
      timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 1, result: "boom" }),
    ])

    const text = context!.text
    expect(text).toContain("--- conversation handed off from Codex to Claude Code ---")
    expect(text).toContain("--- turn ended with error ---\nboom")
  })

  test("session_restore reason swaps the preamble and renders restore boundaries", () => {
    const context = buildHandoffContext({
      entries: [
        userPrompt("earlier question"),
        assistantText("earlier answer"),
        timestamped({ kind: "session_restored", provider: "claude" }),
      ],
      fromProvider: "claude",
      toProvider: "claude",
      transcriptPath: TRANSCRIPT_PATH,
      reason: "session_restore",
    })

    const text = context!.text
    // Restore preamble, not the "handed off from another agent" one.
    expect(text).toContain("restored from Kanna's saved transcript")
    expect(text).not.toContain("handed off to you from another coding agent")
    // The restore boundary renders its own marker.
    expect(text).toContain("--- conversation restored from saved transcript (previous native session unavailable) ---")
    // The shared transcript body + JSONL pointer are unchanged.
    expect(text).toContain("<handoff_transcript>")
    expect(text).toContain("--- user ---\nearlier question")
    expect(text).toContain(TRANSCRIPT_PATH)
  })

  test("returns null when there is nothing worth handing off", () => {
    expect(build([])).toBeNull()
    expect(build([
      timestamped({ kind: "system_init", provider: "claude", model: "m", tools: [], agents: [], slashCommands: [], mcpServers: [] }),
      timestamped({ kind: "status", status: "thinking" }),
    ])).toBeNull()
  })

  test("elides large tool results outside the recent window, keeping recent ones verbatim", () => {
    const bigOldResult = "x".repeat(60_000)
    const bigRecentResult = "y".repeat(60_000)
    const entries = [
      userPrompt("start"),
      toolCall("Read", { file_path: "old.ts" }),
      toolResult(bigOldResult),
      // Filler so the old result falls outside the 100k-char recent window.
      assistantText("z".repeat(90_000)),
      toolCall("Read", { file_path: "new.ts" }),
      toolResult(bigRecentResult),
      userPrompt("continue"),
    ]

    const context = build(entries)!
    expect(context.text).not.toContain(bigOldResult)
    expect(context.text).toContain("tool result elided (~15000 tokens)")
    // The elide marker names the entry so the harness can find it in the JSONL.
    expect(context.text).toContain(entries[2]!._id)
    expect(context.text).toContain(bigRecentResult)
    expect(context.stats.elidedToolResults).toBe(1)
  })

  test("drops older turns on user-prompt boundaries when over budget", () => {
    const entries = [
      userPrompt("turn one"),
      assistantText("a".repeat(3_000)),
      userPrompt("turn two"),
      assistantText("b".repeat(3_000)),
      userPrompt("turn three"),
      assistantText("done"),
    ]

    const context = build(entries, 5_000)!
    const text = context.text
    expect(text).not.toContain("turn one")
    // The cut snaps forward to a user prompt, so turn two's assistant text
    // is never included without its prompt.
    expect(text).toContain("--- user ---\nturn two")
    expect(text).toContain("--- user ---\nturn three")
    expect(text).toContain("earlier entries omitted for length")
    expect(text).toContain(TRANSCRIPT_PATH)
  })

  test("never includes a tool result without its call when a single turn exceeds the budget", () => {
    const entries = [
      userPrompt("giant turn"),
      toolCall("Bash", { command: "make" }),
      toolResult("c".repeat(5_000)),
      assistantText("done with the giant turn"),
    ]

    const context = build(entries, 3_000)
    if (context) {
      // If the tool result survives the cut, its call must too.
      const hasResult = context.text.includes("--- tool result ---")
      const hasCall = context.text.includes("--- assistant tool call: Bash ---")
      expect(!hasResult || hasCall).toBe(true)
    }
  })

  test("stats estimate tokens at roughly chars/4 under the 100k budget", () => {
    const context = build([
      userPrompt("hello"),
      assistantText("world"),
    ])!
    expect(context.stats.approxTokens).toBe(Math.round(context.text.length / 4))
    expect(HANDOFF_CHAR_BUDGET).toBe(HANDOFF_TOKEN_BUDGET * 4)
  })
})

describe("renderToolResultContent", () => {
  test("strings pass through without JSON escaping", () => {
    expect(renderToolResultContent("line one\nline two")).toBe("line one\nline two")
  })

  test("claude content-block arrays render their text verbatim", () => {
    expect(renderToolResultContent([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond")
  })

  test("structured content falls back to compact JSON", () => {
    expect(renderToolResultContent({ ok: true })).toBe("{\"ok\":true}")
    expect(renderToolResultContent(null)).toBe("")
  })
})

describe("buildHandoffMessageContent", () => {
  test("handoff leads for normal prompts", () => {
    const combined = buildHandoffMessageContent("<handoff/>", "continue please")
    expect(combined).toBe("<handoff/>\n\ncontinue please")
  })

  test("handoff trails slash invocations so harnesses still expand them", () => {
    const combined = buildHandoffMessageContent("<handoff/>", "/review the diff")
    expect(combined).toBe("/review the diff\n\n<handoff/>")
  })

  test("empty content returns just the handoff", () => {
    expect(buildHandoffMessageContent("<handoff/>", "  ")).toBe("<handoff/>")
  })
})

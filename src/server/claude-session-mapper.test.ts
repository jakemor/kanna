import { describe, expect, test } from "bun:test"
import { mapClaudeRecordsToEntries } from "./claude-session-mapper"
import type { ClaudeSessionRecord } from "./claude-session-types"

describe("mapClaudeRecordsToEntries", () => {
  const baseTs = "2026-04-20T10:00:00.000Z"

  test("user message → user_prompt entry", () => {
    const records: ClaudeSessionRecord[] = [
      { type: "user", uuid: "u1", timestamp: baseTs, message: { role: "user", content: "hello" } },
    ]
    const entries = mapClaudeRecordsToEntries(records)
    expect(entries.length).toBe(1)
    expect(entries[0].kind).toBe("user_prompt")
    if (entries[0].kind === "user_prompt") {
      expect(entries[0].content).toBe("hello")
    }
  })

  test("assistant text → assistant_text entry", () => {
    const records: ClaudeSessionRecord[] = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: baseTs,
        message: { role: "assistant", id: "m1", content: [{ type: "text", text: "hi" }] },
      },
    ]
    const entries = mapClaudeRecordsToEntries(records)
    expect(entries.length).toBe(1)
    expect(entries[0].kind).toBe("assistant_text")
    if (entries[0].kind === "assistant_text") {
      expect(entries[0].text).toBe("hi")
    }
  })

  test("assistant tool_use → tool_call entry with normalized Bash tool", () => {
    const records: ClaudeSessionRecord[] = [
      {
        type: "assistant",
        uuid: "a2",
        timestamp: baseTs,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
        },
      },
    ]
    const entries = mapClaudeRecordsToEntries(records)
    expect(entries.length).toBe(1)
    expect(entries[0].kind).toBe("tool_call")
    if (entries[0].kind === "tool_call") {
      expect(entries[0].tool.toolKind).toBe("bash")
      expect(entries[0].tool.toolId).toBe("tu-1")
    }
  })

  test("user tool_result → tool_result entry", () => {
    const records: ClaudeSessionRecord[] = [
      {
        type: "user",
        uuid: "u1",
        timestamp: baseTs,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file1\nfile2" }],
        },
      },
    ]
    const entries = mapClaudeRecordsToEntries(records)
    expect(entries.length).toBe(1)
    expect(entries[0].kind).toBe("tool_result")
    if (entries[0].kind === "tool_result") {
      expect(entries[0].toolId).toBe("tu-1")
      expect(entries[0].content).toBe("file1\nfile2")
    }
  })

  test("skips summary and system records", () => {
    const records: ClaudeSessionRecord[] = [
      { type: "summary", summary: "x" },
      { type: "system", content: "y" },
      { type: "user", uuid: "u1", timestamp: baseTs, message: { role: "user", content: "hi" } },
    ]
    const entries = mapClaudeRecordsToEntries(records)
    expect(entries.length).toBe(1)
  })
})

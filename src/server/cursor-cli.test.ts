import { describe, expect, test } from "bun:test"
import { normalizeCursorUsage, parseCursorLine } from "./cursor-cli"
import type { HarnessEvent } from "./harness-types"

function transcriptEntries(events: HarnessEvent[]) {
  return events.flatMap((event) => (event.type === "transcript" && event.entry ? [event.entry] : []))
}

describe("parseCursorLine", () => {
  test("init emits a session token and a cursor system_init entry", () => {
    const line = `{"type":"system","subtype":"init","apiKeySource":"env","cwd":"/repo","session_id":"sess-1","model":"Composer 2.5 Fast","permissionMode":"default"}`
    const events = parseCursorLine(line, "composer-2.5-fast")

    expect(events[0]).toEqual({ type: "session_token", sessionToken: "sess-1" })
    const [entry] = transcriptEntries(events)
    expect(entry.kind).toBe("system_init")
    if (entry.kind === "system_init") {
      expect(entry.provider).toBe("cursor")
      // Uses the configured model id rather than the display label from the event.
      expect(entry.model).toBe("composer-2.5-fast")
    }
  })

  test("assistant text becomes an assistant_text entry", () => {
    const line = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I found the bug"}]},"session_id":"sess-1"}`
    const [entry] = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entry.kind).toBe("assistant_text")
    if (entry.kind === "assistant_text") {
      expect(entry.text).toBe("I found the bug")
    }
  })

  test("started shell tool call maps to a Bash tool call", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"c-1","tool_call":{"shellToolCall":{"args":{"command":"ls -la","description":"List files"}}},"session_id":"sess-1"}`
    const [entry] = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entry.kind).toBe("tool_call")
    if (entry.kind === "tool_call") {
      expect(entry.tool.toolKind).toBe("bash")
      expect(entry.tool.toolId).toBe("c-1")
      if (entry.tool.toolKind === "bash") {
        expect(entry.tool.input.command).toBe("ls -la")
      }
    }
  })

  test("started read tool call maps to a Read tool call with file path", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"c-2","tool_call":{"readToolCall":{"args":{"path":"/repo/note.txt"}}},"session_id":"sess-1"}`
    const [entry] = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entry.kind).toBe("tool_call")
    if (entry.kind === "tool_call" && entry.tool.toolKind === "read_file") {
      expect(entry.tool.input.filePath).toBe("/repo/note.txt")
    }
  })

  test("started edit tool call maps Cursor's path/streamContent onto Write", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"c-3","tool_call":{"editToolCall":{"args":{"path":"/repo/calc.py","streamContent":"def add(a, b):\\n    return a + b\\n"}}},"session_id":"sess-1"}`
    const [entry] = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entry.kind).toBe("tool_call")
    if (entry.kind === "tool_call" && entry.tool.toolKind === "write_file") {
      expect(entry.tool.input.filePath).toBe("/repo/calc.py")
      expect(entry.tool.input.content).toContain("def add")
    }
  })

  test("started glob/grep/updateTodos tool calls map onto Glob/Grep/TodoWrite", () => {
    const glob = transcriptEntries(parseCursorLine(
      `{"type":"tool_call","subtype":"started","call_id":"g-1","tool_call":{"globToolCall":{"args":{"targetDirectory":"/repo","globPattern":"**/*.py"}}},"session_id":"s"}`,
      "composer-2.5",
    ))[0]
    if (glob.kind === "tool_call" && glob.tool.toolKind === "glob") {
      expect(glob.tool.input.pattern).toBe("**/*.py")
    }

    const grep = transcriptEntries(parseCursorLine(
      `{"type":"tool_call","subtype":"started","call_id":"g-2","tool_call":{"grepToolCall":{"args":{"pattern":"def add","path":"/repo"}}},"session_id":"s"}`,
      "composer-2.5",
    ))[0]
    if (grep.kind === "tool_call" && grep.tool.toolKind === "grep") {
      expect(grep.tool.input.pattern).toBe("def add")
    }

    const todo = transcriptEntries(parseCursorLine(
      `{"type":"tool_call","subtype":"started","call_id":"t-1","tool_call":{"updateTodosToolCall":{"args":{"todos":[{"content":"step","status":"pending"}]}}},"session_id":"s"}`,
      "composer-2.5",
    ))[0]
    if (todo.kind === "tool_call" && todo.tool.toolKind === "todo_write") {
      expect(Array.isArray(todo.tool.input.todos)).toBe(true)
    }
  })

  test("completed tool call becomes a tool_result keyed by call id", () => {
    const line = `{"type":"tool_call","subtype":"completed","call_id":"c-2","tool_call":{"readToolCall":{"args":{"path":"/repo/note.txt"},"result":{"success":{"content":"hello world\\n","isEmpty":false}}}},"session_id":"sess-1"}`
    const [entry] = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entry.kind).toBe("tool_result")
    if (entry.kind === "tool_result") {
      expect(entry.toolId).toBe("c-2")
      expect(entry.isError).toBe(false)
      expect(entry.content).toEqual({ content: "hello world\n", isEmpty: false })
    }
  })

  test("result emits a context-window update and a success result", () => {
    const line = `{"type":"result","subtype":"success","duration_ms":15609,"is_error":false,"result":"Done","session_id":"sess-1","usage":{"inputTokens":17640,"outputTokens":138,"cacheReadTokens":27968,"cacheWriteTokens":0}}`
    const entries = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    const kinds = entries.map((entry) => entry.kind)
    expect(kinds).toContain("context_window_updated")
    expect(kinds).toContain("result")

    const result = entries.find((entry) => entry.kind === "result")
    if (result?.kind === "result") {
      expect(result.isError).toBe(false)
      expect(result.subtype).toBe("success")
      expect(result.result).toBe("Done")
      expect(result.durationMs).toBe(15609)
    }
  })

  test("error result is surfaced as an error result entry", () => {
    const line = `{"type":"result","subtype":"error","is_error":true,"result":"boom","session_id":"sess-1"}`
    const result = transcriptEntries(parseCursorLine(line, "composer-2.5")).find((entry) => entry.kind === "result")
    if (result?.kind === "result") {
      expect(result.isError).toBe(true)
      expect(result.subtype).toBe("error")
    }
  })

  test("prompt echo, reasoning, and malformed lines produce no entries", () => {
    expect(parseCursorLine(`{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}`, "composer-2.5")).toEqual([])
    expect(parseCursorLine(`{"type":"thinking","subtype":"delta"}`, "composer-2.5")).toEqual([])
    expect(parseCursorLine("not json", "composer-2.5")).toEqual([])
    expect(parseCursorLine("", "composer-2.5")).toEqual([])
  })
})

describe("normalizeCursorUsage", () => {
  test("sums direct + cache tokens into the context window snapshot", () => {
    const usage = normalizeCursorUsage({
      inputTokens: 17640,
      outputTokens: 138,
      cacheReadTokens: 27968,
      cacheWriteTokens: 0,
    })
    expect(usage).not.toBeNull()
    expect(usage?.inputTokens).toBe(17640 + 27968)
    expect(usage?.cachedInputTokens).toBe(27968)
    expect(usage?.outputTokens).toBe(138)
    expect(usage?.usedTokens).toBe(17640 + 27968 + 138)
  })

  test("returns null when there is no usage", () => {
    expect(normalizeCursorUsage(undefined)).toBeNull()
    expect(normalizeCursorUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })
})

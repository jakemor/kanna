import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { clarifyCursorAuthError, CursorCliManager, normalizeCursorUsage, parseCursorLine, parseCursorModelList, type CursorChildProcess } from "./cursor-cli"
import type { HarnessEvent } from "./harness-types"

function transcriptEntries(events: HarnessEvent[]) {
  return events.flatMap((event) => (event.type === "transcript" && event.entry ? [event.entry] : []))
}

function firstEntry(line: string, model = "composer-2.5") {
  return transcriptEntries(parseCursorLine(line, model))[0]
}

describe("parseCursorLine", () => {
  test("init emits a session token and a cursor system_init entry", () => {
    const events = parseCursorLine(
      `{"type":"system","subtype":"init","apiKeySource":"env","cwd":"/repo","session_id":"sess-1","model":"Composer 2.5 Fast"}`,
      "composer-2.5-fast",
    )
    expect(events[0]).toEqual({ type: "session_token", sessionToken: "sess-1" })
    // Uses the configured model id, not the display label ("Composer 2.5 Fast") from the event.
    expect(transcriptEntries(events)[0]).toMatchObject({
      kind: "system_init",
      provider: "cursor",
      model: "composer-2.5-fast",
    })
  })

  test("assistant text becomes an assistant_text entry", () => {
    const line = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I found the bug"}]},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({ kind: "assistant_text", text: "I found the bug" })
  })

  test("shell tool call maps onto Bash", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"c-1","tool_call":{"shellToolCall":{"args":{"command":"ls -la","description":"List files"}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "bash", toolId: "c-1", input: { command: "ls -la" } },
    })
  })

  test("read tool call maps onto Read with the file path", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"c-2","tool_call":{"readToolCall":{"args":{"path":"/repo/note.txt"}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "read_file", input: { filePath: "/repo/note.txt" } },
    })
  })

  test("edit tool call maps Cursor's path/streamContent onto Write", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"c-3","tool_call":{"editToolCall":{"args":{"path":"/repo/calc.py","streamContent":"def add(a, b):\\n    return a + b\\n"}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "write_file", input: { filePath: "/repo/calc.py", content: expect.stringContaining("def add") } },
    })
  })

  test("glob / grep / updateTodos map onto Glob / Grep / TodoWrite", () => {
    expect(firstEntry(`{"type":"tool_call","subtype":"started","call_id":"g-1","tool_call":{"globToolCall":{"args":{"targetDirectory":"/repo","globPattern":"**/*.py"}}},"session_id":"s"}`))
      .toMatchObject({ kind: "tool_call", tool: { toolKind: "glob", input: { pattern: "**/*.py" } } })

    expect(firstEntry(`{"type":"tool_call","subtype":"started","call_id":"g-2","tool_call":{"grepToolCall":{"args":{"pattern":"def add","path":"/repo"}}},"session_id":"s"}`))
      .toMatchObject({ kind: "tool_call", tool: { toolKind: "grep", input: { pattern: "def add" } } })

    expect(firstEntry(`{"type":"tool_call","subtype":"started","call_id":"t-1","tool_call":{"updateTodosToolCall":{"args":{"todos":[{"content":"step","status":"pending"}]}}},"session_id":"s"}`))
      .toMatchObject({ kind: "tool_call", tool: { toolKind: "todo_write", input: { todos: [{ content: "step", status: "pending" }] } } })
  })

  test("an unmapped tool falls through to unknown_tool rather than being dropped", () => {
    const line = `{"type":"tool_call","subtype":"started","call_id":"u-1","tool_call":{"mysteryToolCall":{"args":{"foo":"bar"}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({ kind: "tool_call", tool: { toolKind: "unknown_tool" } })
  })

  test("completed tool call becomes a tool_result keyed by call id", () => {
    const line = `{"type":"tool_call","subtype":"completed","call_id":"c-2","tool_call":{"readToolCall":{"args":{"path":"/repo/note.txt"},"result":{"success":{"content":"hello world\\n","isEmpty":false}}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_result",
      toolId: "c-2",
      isError: false,
      content: { content: "hello world\n", isEmpty: false },
    })
  })

  test("a failed tool call is flagged as an error result", () => {
    const line = `{"type":"tool_call","subtype":"completed","call_id":"c-9","tool_call":{"shellToolCall":{"args":{"command":"nope"},"result":{"error":{"message":"boom"}}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({ kind: "tool_result", toolId: "c-9", isError: true })
  })

  test("a completed tool with no structured result is not a false-positive error", () => {
    const line = `{"type":"tool_call","subtype":"completed","call_id":"c-7","tool_call":{"shellToolCall":{"args":{"command":"ls"}}},"session_id":"s"}`
    expect(firstEntry(line)).toMatchObject({ kind: "tool_result", toolId: "c-7", isError: false })
  })

  test("result emits a context-window update followed by a success result", () => {
    const line = `{"type":"result","subtype":"success","duration_ms":15609,"is_error":false,"result":"Done","session_id":"s","usage":{"inputTokens":17640,"outputTokens":138,"cacheReadTokens":27968,"cacheWriteTokens":0}}`
    const entries = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entries.map((entry) => entry.kind)).toEqual(["context_window_updated", "result"])
    expect(entries[1]).toMatchObject({ kind: "result", isError: false, subtype: "success", result: "Done", durationMs: 15609 })
  })

  test("error result is surfaced as an error result entry", () => {
    const line = `{"type":"result","subtype":"error","is_error":true,"result":"boom","session_id":"s"}`
    const entries = transcriptEntries(parseCursorLine(line, "composer-2.5"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "result", isError: true, subtype: "error", result: "boom" })
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
    const usage = normalizeCursorUsage({ inputTokens: 17640, outputTokens: 138, cacheReadTokens: 27968, cacheWriteTokens: 0 })
    expect(usage).toMatchObject({
      inputTokens: 17640 + 27968,
      cachedInputTokens: 27968,
      outputTokens: 138,
      usedTokens: 17640 + 27968 + 138,
    })
  })

  test("returns null when there is no usage", () => {
    expect(normalizeCursorUsage(undefined)).toBeNull()
    expect(normalizeCursorUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })
})

// Exercises the injectable `spawnProcess` seam: argv/stdin/resume wiring, stdout
// stream -> events, and the "process ended without a result" error synthesis.
function makeFakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let onClose: ((code: number | null) => void) | undefined
  const child = {
    stdin,
    stdout,
    stderr,
    kill: () => true,
    once(event: "close" | "error", listener: (arg: never) => void) {
      if (event === "close") onClose = listener as unknown as (code: number | null) => void
      return child
    },
  } as unknown as CursorChildProcess
  return { child, stdin, stdout, stderr, close: (code: number | null) => onClose?.(code) }
}

describe("CursorCliManager.startTurn", () => {
  test("passes --force/--model/--resume and writes the prompt to stdin", async () => {
    const fake = makeFakeChild()
    let captured: { cwd: string; argv: string[] } | undefined
    const manager = new CursorCliManager({ spawnProcess: (args) => { captured = args; return fake.child } })

    const stdinText = new Promise<string>((resolve) => {
      let data = ""
      fake.stdin.on("data", (chunk) => { data += chunk.toString() })
      fake.stdin.on("end", () => resolve(data))
    })

    const turn = await manager.startTurn({ cwd: "/repo", content: "fix the bug", model: "composer-2.5-fast", sessionToken: "sess-9" })

    expect(turn.provider).toBe("cursor")
    expect(captured?.cwd).toBe("/repo")
    expect(captured?.argv).toEqual([
      "-p", "--output-format", "stream-json", "--force", "--model", "composer-2.5-fast", "--resume", "sess-9",
    ])
    expect(await stdinText).toBe("fix the bug")
  })

  test("omits --resume when there is no session token", async () => {
    const fake = makeFakeChild()
    let captured: { cwd: string; argv: string[] } | undefined
    const manager = new CursorCliManager({ spawnProcess: (args) => { captured = args; return fake.child } })
    await manager.startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })
    expect(captured?.argv).not.toContain("--resume")
  })

  test("parses stdout NDJSON into events without synthesizing an error", async () => {
    const fake = makeFakeChild()
    const manager = new CursorCliManager({ spawnProcess: () => fake.child })
    const turn = await manager.startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })
    const iter = turn.stream[Symbol.asyncIterator]()

    fake.stdout.write(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}]},"session_id":"s"}\n`)
    fake.stdout.write(`{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s"}\n`)

    // The consumer awaits each event as it is pushed, so this is deterministic without timers.
    expect((await iter.next()).value).toMatchObject({ type: "transcript", entry: { kind: "assistant_text", text: "hi there" } })
    expect((await iter.next()).value).toMatchObject({ type: "transcript", entry: { kind: "result", isError: false } })

    fake.stdout.end()
    fake.close(0)
    expect((await iter.next()).done).toBe(true)
  })

  test("synthesizes an error result (with stderr) when the process ends without one", async () => {
    const fake = makeFakeChild()
    const manager = new CursorCliManager({ spawnProcess: () => fake.child })
    const turn = await manager.startTurn({ cwd: "/repo", content: "hi", model: "bad-model", sessionToken: null })
    const iter = turn.stream[Symbol.asyncIterator]()

    // Awaiting stderr's "end" guarantees the manager's "data" handler ran first.
    fake.stderr.end("Cannot use this model: bad-model")
    await new Promise<void>((resolve) => fake.stderr.once("end", resolve))
    fake.stdout.end()
    fake.close(1)

    expect((await iter.next()).value).toMatchObject({
      type: "transcript",
      entry: { kind: "result", isError: true, subtype: "error", result: expect.stringContaining("Cannot use this model") },
    })
    expect((await iter.next()).done).toBe(true)
  })
})

describe("parseCursorModelList", () => {
  test("parses ids, labels, and default/current markers from the ANSI-decorated output", () => {
    const output = [
      "[2K[GLoading models…",
      "[2K[1A[2K[GAvailable models",
      "",
      "auto - Auto  (default)",
      "composer-2.5 - Composer 2.5  (current)",
      "composer-2.5-fast - Composer 2.5 Fast",
      "claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)",
    ].join("\n")

    expect(parseCursorModelList(output)).toEqual([
      { id: "auto", label: "Auto", isDefault: true },
      { id: "composer-2.5", label: "Composer 2.5", isDefault: false },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast", isDefault: false },
      // A trailing parenthetical that isn't (default)/(current) stays in the label.
      { id: "claude-fable-5-thinking-high", label: "Fable 5 1M Thinking (NO ZDR)", isDefault: false },
    ])
  })

  test("returns no entries for empty or error output", () => {
    expect(parseCursorModelList("")).toEqual([])
    expect(parseCursorModelList("Error: Authentication required. Please run 'agent login' first.")).toEqual([])
  })
})

describe("CursorCliManager.listModels", () => {
  test("spawns --list-models and resolves the parsed entries", async () => {
    const fake = makeFakeChild()
    let captured: { cwd: string; argv: string[] } | undefined
    const manager = new CursorCliManager({ spawnProcess: (args) => { captured = args; return fake.child } })

    const listing = manager.listModels()
    fake.stdout.end("auto - Auto  (default)\ncomposer-2.5 - Composer 2.5  (current)\n")
    await new Promise<void>((resolve) => fake.stdout.once("end", resolve))
    fake.close(0)

    expect(await listing).toEqual([
      { id: "auto", label: "Auto", isDefault: true },
      { id: "composer-2.5", label: "Composer 2.5", isDefault: false },
    ])
    expect(captured?.argv).toEqual(["--list-models"])
  })

  test("rejects with clarified stderr when the CLI exits without models", async () => {
    const fake = makeFakeChild()
    const manager = new CursorCliManager({ spawnProcess: () => fake.child })

    const listing = manager.listModels()
    fake.stderr.end("Error: Authentication required. Please run 'agent login' first.")
    await new Promise<void>((resolve) => fake.stderr.once("end", resolve))
    fake.stdout.end()
    fake.close(1)

    await expect(listing).rejects.toThrow("'cursor-agent login' (or 'agent login')")
  })
})

describe("clarifyCursorAuthError", () => {
  test("mentions both binary names for the CLI's 'agent login' auth error", () => {
    expect(
      clarifyCursorAuthError(
        "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
      ),
    ).toBe(
      "Error: Authentication required. Please run 'cursor-agent login' (or 'agent login') first, or set CURSOR_API_KEY environment variable.",
    )
  })

  test("handles older CLIs that already say 'cursor-agent login'", () => {
    expect(clarifyCursorAuthError("Please run 'cursor-agent login' first")).toBe(
      "Please run 'cursor-agent login' (or 'agent login') first",
    )
  })

  test("leaves unrelated stderr untouched", () => {
    expect(clarifyCursorAuthError("Cannot use this model: bad-model")).toBe("Cannot use this model: bad-model")
  })
})

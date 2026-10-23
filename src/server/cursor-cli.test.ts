import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Result, Scope, Stream } from "effect"
import { makeFakeCli, scriptedCli, type FakeCli } from "./cli-process.fake"
import { clarifyCursorAuthError, makeCursorCli, normalizeCursorUsage, parseCursorLine, parseCursorModelList } from "./cursor-cli"
import { runTest } from "./effect/testing"
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
    expect(parseCursorLine(`["system"]`, "composer-2.5")).toEqual([])
  })

  test("a newer CLI's unknown event types and extra or retyped fields are tolerated", () => {
    expect(parseCursorLine(`{"type":"interaction_query","subtype":"x"}`, "composer-2.5")).toEqual([])
    const entries = transcriptEntries(parseCursorLine(
      `{"type":"result","is_error":false,"duration_ms":"slow","result":{"text":"Done"},"request_id":"r-1","session_id":"s"}`,
      "composer-2.5",
    ))
    expect(entries).toEqual([expect.objectContaining({ kind: "result", isError: false, durationMs: 0, result: "" })])
    expect(firstEntry(`{"type":"assistant","message":{"content":[{"type":"image"},{"type":"text","text":"ok","citations":[]},"junk"]}}`))
      .toMatchObject({ kind: "assistant_text", text: "ok" })
    expect(parseCursorLine(`{"type":"system","subtype":"init","session_id":42}`, "composer-2.5").map((event) => event.type))
      .toEqual(["transcript"])
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
const cursorWith = (fake: FakeCli) => makeCursorCli({ spawnProcess: fake.spawn })

describe("CursorCli.startTurn", () => {
  test("passes --force/--model/--resume and writes the prompt to stdin", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const cursor = yield* cursorWith(fake)

    const turn = yield* cursor.startTurn({ cwd: "/repo", content: "fix the bug", model: "composer-2.5-fast", sessionToken: "sess-9" })

    expect(turn.provider).toBe("cursor")
    expect(fake.spawns[0]?.cwd).toBe("/repo")
    expect(fake.spawns[0]?.argv).toEqual([
      "-p", "--output-format", "stream-json", "--force", "--model", "composer-2.5-fast", "--resume", "sess-9",
    ])
    expect(fake.spawns[0]?.stdin).toBe("fix the bug")
  })))

  test("omits --resume when there is no session token", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })
    expect(fake.spawns[0]?.argv).not.toContain("--resume")
  })))

  test("parses stdout NDJSON into events without synthesizing an error", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const turn = yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })

    // A line split across two chunks still parses as one.
    yield* fake.writeStdout(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text",`)
    yield* fake.writeStdout(`"text":"hi there"}]},"session_id":"s"}\n`)
    yield* fake.writeStdout(`{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s"}\n`)
    yield* fake.exit(0)

    const events = yield* Stream.runCollect(turn.events)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "transcript", entry: { kind: "assistant_text", text: "hi there" } })
    expect(events[1]).toMatchObject({ type: "transcript", entry: { kind: "result", isError: false } })
  })))

  test("streams each event as its line arrives, before the process exits", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const turn = yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })

    yield* fake.writeStdout(`{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}\n`)
    const [first] = yield* Stream.runCollect(turn.events.pipe(Stream.take(1)))
    expect(first).toMatchObject({ entry: { kind: "assistant_text", text: "first" } })
    yield* fake.exit(0)
  })))

  test("synthesizes an error result (with stderr) when the process ends without one", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const turn = yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "bad-model", sessionToken: null })

    yield* fake.writeStderr("Cannot use this model: bad-model")
    yield* fake.exit(1)

    const events = yield* Stream.runCollect(turn.events)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "transcript",
      entry: { kind: "result", isError: true, subtype: "error", result: expect.stringContaining("Cannot use this model") },
    })
  })))

  test("a CLI that can't start ends the turn with the spawn error as its result", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli({ spawnError: `Executable not found in $PATH: "cursor-agent"` })
    const turn = yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })

    const events = yield* Stream.runCollect(turn.events)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      entry: { kind: "result", isError: true, result: `Executable not found in $PATH: "cursor-agent"` },
    })
    yield* turn.interrupt
  })))

  test("interrupt sends SIGINT and the turn ends once the process does", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const turn = yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null })

    yield* turn.interrupt
    expect(fake.kills).toEqual(["SIGINT"])
    const events = yield* Stream.runCollect(turn.events)
    expect(events.map((event) => event.entry?.kind)).toEqual(["result"])
    expect(events[0]).toMatchObject({ entry: { isError: true, result: "cursor-agent exited with code unknown" } })
  })))

  test("closing the turn's scope kills the process and ends the events", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const scope = yield* Scope.make()
    const turn = yield* (yield* cursorWith(fake)).startTurn({ cwd: "/repo", content: "hi", model: "composer-2.5", sessionToken: null }).pipe(
      Scope.provide(scope),
    )
    yield* fake.writeStdout(`{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n`)
    expect(yield* Stream.runCollect(turn.events.pipe(Stream.take(1)))).toHaveLength(1)
    // A reader waiting on the next event when the turn is closed sees the end.
    const reading = yield* Stream.runCollect(turn.events).pipe(Effect.forkChild)
    yield* Effect.yieldNow

    yield* Scope.close(scope, Exit.void)
    expect(fake.released()).toBe(true)
    expect(yield* Fiber.join(reading)).toEqual([])
  })))
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

describe("CursorCli.listModels", () => {
  test("spawns --list-models and resolves the parsed entries", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli("auto - Auto  (default)\ncomposer-2.5 - Composer 2.5  (current)\n", 0)
    const models = yield* (yield* cursorWith(fake)).listModels()

    expect(models).toEqual([
      { id: "auto", label: "Auto", isDefault: true },
      { id: "composer-2.5", label: "Composer 2.5", isDefault: false },
    ])
    expect(fake.spawns[0]?.argv).toEqual(["--list-models"])
    expect(fake.released()).toBe(true)
  })))

  test("fails with clarified stderr when the CLI exits without models", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli("", 1, "Error: Authentication required. Please run 'agent login' first.")
    const result = yield* Effect.result((yield* cursorWith(fake)).listModels())

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/cursor-cli/CursorModelListError")
      expect(result.failure.message).toContain("'cursor-agent login' (or 'agent login')")
    }
  })))

  test("times out, killing the CLI", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const result = yield* Effect.result((yield* cursorWith(fake)).listModels(10))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.message).toBe("cursor-agent --list-models timed out after 10ms")
    }
    expect(fake.released()).toBe(true)
  })))

  test("a missing CLI fails with the spawn error", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli({ spawnError: "Executable not found" })
    const result = yield* Effect.result((yield* cursorWith(fake)).listModels())
    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/process-utils/CommandSpawnError")
  })))
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

describe("Cursor shared tools", () => {
  test("loads a private MCP plugin and closes it when the process exits", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const turn = yield* (yield* cursorWith(fake)).startTurn({
      cwd: "/repo", content: "Test tools", model: "composer-2.5", sessionToken: null,
      customTools: { execute: async () => ({ content: [{ type: "text", text: "ok" }] }) },
    })
    const argv = fake.spawns[0]?.argv ?? []
    const pluginPath = argv[argv.indexOf("--plugin-dir") + 1]!
    expect(pluginPath).not.toStartWith("/repo")
    const { config, plugin } = yield* Effect.promise(async () => ({
      config: await Bun.file(`${pluginPath}/mcp.json`).json(),
      plugin: await Bun.file(`${pluginPath}/.cursor-plugin/plugin.json`).json(),
    }))
    expect(plugin.name).toBe("kanna-tools")
    expect(config.mcpServers.kanna.url).toStartWith("http://127.0.0.1:")
    expect(argv).toContain("--approve-mcps")
    expect((yield* Effect.promise(() => fetch(config.mcpServers.kanna.url))).status).toBe(401)

    yield* fake.exit(0)
    yield* Stream.runDrain(turn.events)
    const after = yield* Effect.promise(() => fetch(config.mcpServers.kanna.url).then(() => "reachable", () => "closed"))
    expect(after).toBe("closed")
    expect(yield* Effect.promise(() => Bun.file(`${pluginPath}/mcp.json`).exists())).toBe(false)
  })))

  test("closing the turn's scope closes the plugin too", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const scope = yield* Scope.make()
    yield* (yield* cursorWith(fake)).startTurn({
      cwd: "/repo", content: "Test tools", model: "composer-2.5", sessionToken: null,
      customTools: { execute: async () => ({ content: [] }) },
    }).pipe(Scope.provide(scope))
    const argv = fake.spawns[0]?.argv ?? []
    const pluginPath = argv[argv.indexOf("--plugin-dir") + 1]!
    expect(yield* Effect.promise(() => Bun.file(`${pluginPath}/mcp.json`).exists())).toBe(true)

    yield* Scope.close(scope, Exit.void)
    expect(yield* Effect.promise(() => Bun.file(`${pluginPath}/mcp.json`).exists())).toBe(false)
  })))

  test("preserves the MCP tool name from Cursor's nested args", () => {
    const entry = firstEntry(JSON.stringify({
      type: "tool_call", subtype: "started", call_id: "cursor-input",
      tool_call: { mcpToolCall: { args: { providerIdentifier: "plugin-kanna-tools-kanna", toolName: "show_visualization", args: { prompt: "Value" } } } },
    }))
    expect(entry).toMatchObject({ kind: "tool_call", tool: { toolName: "show_visualization" } })
  })
})

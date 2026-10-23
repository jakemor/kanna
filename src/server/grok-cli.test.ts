import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Result, Scope, Stream } from "effect"
import { makeFakeCli, scriptedCli, type FakeCli } from "./cli-process.fake"
import { runTest } from "./effect/testing"
import {
  fetchGrokAccountUsage,
  makeGrokCli,
  moneyVal,
  readGrokAuthToken,
  GrokStreamCoalescer,
  GrokTodoTracker,
  grokModelLabel,
  normalizeGrokTodoItems,
  grokProductUsageWindows,
  grokSessionDir,
  normalizeGrokUsage,
  parseGrokAuthStatus,
  parseGrokDeviceLogin,
  parseGrokInspectSkills,
  parseGrokLine,
  parseGrokModelList,
  parseGrokVersion,
  readGrokAuthTokenFromFile,
} from "./grok-cli"
import type { HarnessEvent, HarnessToolRequest } from "./harness-types"

function transcriptEntries(events: HarnessEvent[]) {
  return events.flatMap((event) => (event.type === "transcript" && event.entry ? [event.entry] : []))
}

function firstEntry(line: string, model = "grok-4.6") {
  return transcriptEntries(parseGrokLine(line, model))[0]
}

describe("parseGrokLine", () => {
  test("available_commands emits a grok system_init entry", () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: "available_commands",
        tools: ["run_terminal_command", "read_file", "grep"],
        commands: ["compact", "skill-foo"],
      }),
      "grok-4.6",
    )
    expect(transcriptEntries(events)[0]).toMatchObject({
      kind: "system_init",
      provider: "grok",
      model: "grok-4.6",
      tools: ["Bash", "Read", "Grep"],
    })
  })

  test("text becomes an assistant_text entry", () => {
    expect(firstEntry(`{"type":"text","data":"PONG"}`)).toMatchObject({
      kind: "assistant_text",
      text: "PONG",
    })
  })

  test("thoughts are dropped", () => {
    expect(parseGrokLine(`{"type":"thought","data":"hmm"}`, "grok-4.6")).toEqual([])
  })

  test("a newer grok's unknown event types and extra or retyped fields are tolerated", () => {
    expect(parseGrokLine(`{"type":"plan_update","entries":[]}`, "grok-4.6")).toEqual([])
    expect(parseGrokLine(`[{"type":"text","data":"x"}]`, "grok-4.6")).toEqual([])
    expect(firstEntry(`{"type":"text","data":"PONG","index":3,"meta":{"a":1}}`)).toMatchObject({ kind: "assistant_text", text: "PONG" })
    expect(parseGrokLine(`{"type":"text","data":{"text":"PONG"}}`, "grok-4.6")).toEqual([])
    // A non-string id falls back to a generated one, as before; a non-string name to the title.
    expect(firstEntry(`{"type":"tool_call","toolCallId":7,"toolName":null,"title":"grep","rawInput":{"pattern":"x"}}`))
      .toMatchObject({ kind: "tool_call", tool: { toolKind: "grep", toolId: expect.any(String) } })
    const events = parseGrokLine(`{"type":"end","stopReason":5,"sessionId":"s","usage":"n/a","durationMs":12}`, "grok-4.6")
    expect(events[0]).toEqual({ type: "session_token", sessionToken: "s" })
    expect(transcriptEntries(events)).toEqual([expect.objectContaining({ kind: "result", isError: false })])
  })

  test("a tool result with no text keeps the whole update as its content", () => {
    const entry = firstEntry(`{"type":"tool_call_update","toolCallId":"c-1","status":"completed","extra":"kept"}`)
    expect(entry).toMatchObject({
      kind: "tool_result",
      content: { type: "tool_call_update", toolCallId: "c-1", status: "completed", extra: "kept" },
    })
  })

  test("grep tool call maps onto Grep", () => {
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "call-1",
      title: "grep",
      toolName: "grep",
      status: "pending",
      rawInput: { pattern: "PONG", path: "/tmp" },
    })
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "grep", toolId: "call-1", input: { pattern: "PONG" } },
    })
  })

  test("read_file maps target_file onto Read", () => {
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "c-2",
      toolName: "read_file",
      rawInput: { target_file: "/repo/note.txt" },
    })
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "read_file", input: { filePath: "/repo/note.txt" } },
    })
  })

  test("search_replace maps onto Edit", () => {
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "c-3",
      toolName: "search_replace",
      rawInput: { path: "/repo/a.ts", old_string: "a", new_string: "b" },
    })
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "edit_file", input: { filePath: "/repo/a.ts", oldString: "a", newString: "b" } },
    })
  })

  test("run_terminal_command maps onto Bash", () => {
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "c-4",
      toolName: "run_terminal_command",
      rawInput: { command: "ls -la" },
    })
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "bash", input: { command: "ls -la" } },
    })
  })

  test("exit_plan_mode maps onto ExitPlanMode", () => {
    const line = JSON.stringify({
      type: "tool_call",
      toolCallId: "c-5",
      toolName: "exit_plan_mode",
      rawInput: { plan: "# Plan" },
    })
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "exit_plan_mode" },
    })
  })

  test("completed tool_call_update becomes a tool_result", () => {
    const line = JSON.stringify({
      type: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "found 0 matches" } }],
    })
    expect(firstEntry(line)).toMatchObject({
      kind: "tool_result",
      toolId: "call-1",
      isError: false,
      content: "found 0 matches",
    })
  })

  test("failed tool_call_update is flagged as an error", () => {
    const line = JSON.stringify({
      type: "tool_call_update",
      toolCallId: "call-9",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    })
    expect(firstEntry(line)).toMatchObject({ kind: "tool_result", toolId: "call-9", isError: true })
  })

  test("pending tool_call_update with no content is ignored", () => {
    expect(parseGrokLine(
      JSON.stringify({ type: "tool_call_update", toolCallId: "c", status: null, content: [] }),
      "grok-4.6",
    )).toEqual([])
  })

  test("end emits session token, usage, and a success result", () => {
    const line = JSON.stringify({
      type: "end",
      stopReason: "end_turn",
      sessionId: "sess-1",
      usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
    })
    const events = parseGrokLine(line, "grok-4.6")
    expect(events[0]).toEqual({ type: "session_token", sessionToken: "sess-1" })
    expect(transcriptEntries(events).map((entry) => entry.kind)).toEqual(["context_window_updated", "result"])
    expect(transcriptEntries(events)[1]).toMatchObject({ kind: "result", isError: false, subtype: "success" })
  })

  test("malformed lines produce no entries", () => {
    expect(parseGrokLine("not json", "grok-4.6")).toEqual([])
    expect(parseGrokLine("", "grok-4.6")).toEqual([])
  })
})

describe("Grok todos", () => {
  test("fills activeForm from content so in-progress rows have a title", () => {
    expect(normalizeGrokTodoItems([
      { id: "1", content: "Spec the copy skill", status: "in_progress" },
      { id: "2", text: "Read the pages", status: "pending" },
    ])).toEqual([
      { content: "Spec the copy skill", status: "in_progress", activeForm: "Spec the copy skill", id: "1" },
      { content: "Read the pages", status: "pending", activeForm: "Read the pages", id: "2" },
    ])
  })

  test("merge patches keep titles from the last full list", () => {
    const tracker = new GrokTodoTracker()
    expect(tracker.apply({
      merge: false,
      todos: normalizeGrokTodoItems([
        { id: "1", content: "Spec the copy skill", status: "in_progress" },
        { id: "2", content: "Read the pages", status: "pending" },
      ]),
    })).toEqual([
      { content: "Spec the copy skill", status: "in_progress", activeForm: "Spec the copy skill" },
      { content: "Read the pages", status: "pending", activeForm: "Read the pages" },
    ])
    expect(tracker.apply({
      merge: true,
      todos: normalizeGrokTodoItems([
        { id: "1", status: "completed" },
        { id: "2", status: "in_progress" },
      ]),
    })).toEqual([
      { content: "Spec the copy skill", status: "completed", activeForm: "Spec the copy skill" },
      { content: "Read the pages", status: "in_progress", activeForm: "Read the pages" },
    ])
  })

  test("status-only todo_write events do not replace the Progress card with blank rows", () => {
    const coalescer = new GrokStreamCoalescer()
    const first = coalescer.push(parseGrokLine(JSON.stringify({
      type: "tool_call",
      toolCallId: "t-1",
      toolName: "todo_write",
      rawInput: {
        merge: false,
        todos: [
          { id: "1", content: "Spec the copy skill", status: "in_progress" },
          { id: "2", content: "Read the pages", status: "pending" },
        ],
      },
    }), "grok-4.6"))
    expect(transcriptEntries(first)[0]).toMatchObject({
      kind: "tool_call",
      tool: {
        toolKind: "todo_write",
        input: {
          todos: [
            { content: "Spec the copy skill", status: "in_progress" },
            { content: "Read the pages", status: "pending" },
          ],
        },
      },
    })

    const merged = coalescer.push(parseGrokLine(JSON.stringify({
      type: "tool_call",
      toolCallId: "t-2",
      toolName: "todo_write",
      rawInput: {
        merge: true,
        todos: [
          { id: "1", status: "completed" },
          { id: "2", status: "in_progress" },
        ],
      },
    }), "grok-4.6"))
    expect(transcriptEntries(merged)[0]).toMatchObject({
      kind: "tool_call",
      tool: {
        toolKind: "todo_write",
        input: {
          todos: [
            { content: "Spec the copy skill", status: "completed" },
            { content: "Read the pages", status: "in_progress", activeForm: "Read the pages" },
          ],
        },
      },
    })
  })
})

describe("GrokStreamCoalescer", () => {
  test("joins consecutive text deltas and drops duplicate available_commands", () => {
    const coalescer = new GrokStreamCoalescer()
    const first = coalescer.push(parseGrokLine(
      `{"type":"available_commands","tools":["grep"],"commands":[]}`,
      "grok-4.6",
    ))
    expect(transcriptEntries(first)[0]?.kind).toBe("system_init")
    expect(coalescer.push(parseGrokLine(
      `{"type":"available_commands","tools":["grep"],"commands":[]}`,
      "grok-4.6",
    ))).toEqual([])
    expect(coalescer.push(parseGrokLine(`{"type":"text","data":"PO"}`, "grok-4.6"))).toEqual([])
    expect(coalescer.push(parseGrokLine(`{"type":"text","data":"NG"}`, "grok-4.6"))).toEqual([])
    const flushed = coalescer.push(parseGrokLine(
      `{"type":"end","stopReason":"end_turn","sessionId":"s"}`,
      "grok-4.6",
    ))
    expect(transcriptEntries(flushed)[0]).toMatchObject({ kind: "assistant_text", text: "PONG" })
  })
})

describe("normalizeGrokUsage", () => {
  test("sums direct + cache tokens into the context window snapshot", () => {
    const usage = normalizeGrokUsage({
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
      reasoning_tokens: 2,
    }, 500_000)
    expect(usage).toMatchObject({
      inputTokens: 123,
      outputTokens: 5,
      cachedInputTokens: 20,
      usedTokens: 128,
      maxTokens: 500_000,
      compactsAutomatically: true,
    })
  })
})

describe("parseGrokModelList / auth / version", () => {
  test("parses grok models human output", () => {
    const models = parseGrokModelList(`
You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`)
    expect(models).toEqual([
      { id: "grok-4.6", label: "Grok 4.6", isDefault: true },
      { id: "grok-4.5", label: "Grok 4.5", isDefault: false },
    ])
  })

  test("detects logged-in vs signed-out status", () => {
    expect(parseGrokAuthStatus("You are logged in with grok.com.")).toEqual({
      loggedIn: true,
      account: "grok.com",
    })
    expect(parseGrokAuthStatus("Logged in as jane@x.ai")).toMatchObject({
      loggedIn: true,
      account: "jane@x.ai",
    })
    expect(parseGrokAuthStatus("Not logged in. Run `grok login`.")).toEqual({
      loggedIn: false,
      account: null,
    })
  })

  test("parses grok version strings", () => {
    expect(parseGrokVersion("grok 1.0.13 (5e9a58528b76)")).toBe("1.0.13")
  })

  test("parses device-auth login output", () => {
    expect(parseGrokDeviceLogin("Open this URL to sign in:\nhttps://auth.x.ai/device/verify\nEnter code ABCD-EFGH")).toEqual({
      verificationUrl: "https://auth.x.ai/device/verify",
      userCode: "ABCD-EFGH",
    })
  })

  test("grokModelLabel spaces the family version", () => {
    expect(grokModelLabel("grok-4.6")).toBe("Grok 4.6")
  })
})

describe("inspect skills / auth token / billing windows", () => {
  test("parseGrokInspectSkills reads inspect --json skill rows", () => {
    const skills = parseGrokInspectSkills(JSON.stringify({
      skills: [
        { name: "outpost", description: "Find creators", source: { type: "user", path: "/home/.grok/skills/outpost/SKILL.md" }, userInvocable: true },
        { name: "._hidden", description: "skip" },
      ],
    }))
    expect(skills).toEqual([
      { name: "outpost", description: "Find creators", source: "skill", path: "/home/.grok/skills/outpost/SKILL.md" },
    ])
  })

  test("readGrokAuthTokenFromFile picks the nested key", () => {
    expect(readGrokAuthTokenFromFile({
      "https://auth.x.ai::abc": { key: "tok-1", refresh_token: "r" },
    })).toBe("tok-1")
  })

  test("grokProductUsageWindows maps overall + per-product lanes", () => {
    const windows = grokProductUsageWindows({
      config: {
        currentPeriod: { end: "2026-09-12T00:00:00Z" },
        creditUsagePercent: 6,
        productUsage: [
          { product: "GrokBuild", usagePercent: 4 },
          { product: "GrokChat", usagePercent: 1 },
        ],
      },
    })
    expect(windows.map((window) => window.id)).toEqual(["credits", "GrokBuild", "GrokChat"])
    expect(windows[1]).toMatchObject({ label: "Weekly · Grok Build", usedPercent: 4, resetsAt: "2026-09-12T00:00:00Z" })
  })

  test("grokSessionDir URL-encodes the cwd", () => {
    expect(grokSessionDir("/home", "/tmp/proj")).toBe("/home/.grok/sessions/%2Ftmp%2Fproj")
  })
})

const grokWith = (fake: FakeCli) => makeGrokCli({ spawnProcess: fake.spawn })

describe("GrokCli.startTurn", () => {
  test("spawns grok with streaming-json, prompt-file, model, and always-approve", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli(`{"type":"text","data":"hi"}\n{"type":"end","stopReason":"end_turn","sessionId":"sess-9"}\n`)
    const turn = yield* (yield* grokWith(fake)).startTurn({
      cwd: "/tmp/proj",
      content: "hello",
      model: "grok-4.6",
      effort: "high",
      planMode: false,
      sessionToken: "sess-old",
      forkSession: true,
    })
    const argv = fake.spawns[0]?.argv ?? []
    const promptFile = argv[argv.indexOf("--prompt-file") + 1]!
    expect(yield* Effect.promise(() => Bun.file(promptFile).text())).toBe("hello")
    const events = yield* Stream.runCollect(turn.events)

    expect(fake.spawns[0]?.cwd).toBe("/tmp/proj")
    expect(argv).toEqual(expect.arrayContaining([
      "--output-format", "streaming-json",
      "--prompt-file", expect.any(String),
      "--cwd", "/tmp/proj",
      "-m", "grok-4.6",
      "--reasoning-effort", "high",
      "--always-approve",
      "--resume", "sess-old",
      "--fork-session",
    ]))
    expect(argv).not.toContain("--permission-mode")
    expect(events.some((event) => event.type === "session_token" && event.sessionToken === "sess-9")).toBe(true)
    expect(transcriptEntries(events).some((entry) => entry.kind === "assistant_text" && entry.text === "hi")).toBe(true)
    // The prompt file goes once the process has exited.
    expect(yield* Effect.promise(() => Bun.file(promptFile).exists())).toBe(false)
  })))

  test("plan mode uses --permission-mode plan instead of --always-approve", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli(`{"type":"end","stopReason":"end_turn","sessionId":"s"}\n`)
    const turn = yield* (yield* grokWith(fake)).startTurn({
      cwd: "/tmp",
      content: "plan this",
      model: "grok-4.6",
      planMode: true,
      sessionToken: null,
      forkSession: false,
    })
    yield* Stream.runDrain(turn.events)
    expect(fake.spawns[0]?.argv).toEqual(expect.arrayContaining(["--permission-mode", "plan"]))
    expect(fake.spawns[0]?.argv).not.toContain("--always-approve")
  })))

  test("coalesces text deltas into one assistant_text entry", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli([
      `{"type":"text","data":"Hel"}`,
      `{"type":"text","data":"lo"}`,
      `{"type":"end","stopReason":"end_turn"}`,
    ].join("\n"))
    const turn = yield* (yield* grokWith(fake)).startTurn({
      cwd: "/tmp", content: "hi", model: "grok-4.6", planMode: false, sessionToken: null, forkSession: false,
    })
    const entries = transcriptEntries(yield* Stream.runCollect(turn.events))
    expect(entries.map((entry) => entry.kind)).toEqual(["assistant_text", "result"])
    expect(entries[0]).toMatchObject({ text: "Hello" })
  })))

  test("an exit without a result ends the turn with stderr as an error result", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli("", 1, "Error: not logged in\n")
    const turn = yield* (yield* grokWith(fake)).startTurn({
      cwd: "/tmp", content: "hi", model: "grok-4.6", planMode: false, sessionToken: null, forkSession: false,
    })
    const entries = transcriptEntries(yield* Stream.runCollect(turn.events))
    expect(entries).toEqual([expect.objectContaining({ kind: "result", isError: true, result: "Error: not logged in" })])
  })))

  test("a grok that can't start ends the turn with the spawn error", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli({ spawnError: `Executable not found in $PATH: "grok"` })
    const turn = yield* (yield* grokWith(fake)).startTurn({
      cwd: "/tmp", content: "hi", model: "grok-4.6", planMode: false, sessionToken: null, forkSession: false,
    })
    const entries = transcriptEntries(yield* Stream.runCollect(turn.events))
    expect(entries).toEqual([expect.objectContaining({ kind: "result", isError: true, result: `Executable not found in $PATH: "grok"` })])
    yield* turn.interrupt
  })))

  test("interrupt sends SIGINT; closing the scope kills grok and removes the prompt file", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const scope = yield* Scope.make()
    const turn = yield* (yield* grokWith(fake)).startTurn({
      cwd: "/tmp", content: "hi", model: "grok-4.6", planMode: false, sessionToken: null, forkSession: false,
    }).pipe(Scope.provide(scope))
    const argv = fake.spawns[0]?.argv ?? []
    const promptFile = argv[argv.indexOf("--prompt-file") + 1]!
    expect(yield* Effect.promise(() => Bun.file(promptFile).exists())).toBe(true)

    yield* turn.interrupt
    expect(fake.kills).toEqual(["SIGINT"])
    const entries = transcriptEntries(yield* Stream.runCollect(turn.events))
    expect(entries).toEqual([expect.objectContaining({ kind: "result", isError: true, result: "grok exited with code unknown" })])

    yield* Scope.close(scope, Exit.void)
    expect(fake.released()).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(promptFile).exists())).toBe(false)
  })))

  describe("plan mode approval", () => {
    // ExitPlanMode as headless grok reports it: the call, its failed result
    // (nobody to ask), then a normal end of turn.
    const PLAN_LINES = [
      `{"type":"tool_call","toolCallId":"plan-1","toolName":"ExitPlanMode","rawInput":{"plan":"1. Add README"},"status":"pending"}`,
      `{"type":"tool_call_update","toolCallId":"plan-1","status":"failed","content":"no user to approve"}`,
      `{"type":"end","stopReason":"end_turn","sessionId":"sess-plan"}`,
    ].map((line) => `${line}\n`).join("")

    const startArgs = { cwd: "/tmp", content: "plan this", model: "grok-4.6", sessionToken: null, forkSession: false }

    test("parks on the plan: no CLI result for it and no end result until the user answers", () => runTest(Effect.gen(function* () {
      const answer = yield* Deferred.make<unknown>()
      const requested = yield* Deferred.make<HarnessToolRequest>()
      const fake = yield* scriptedCli(PLAN_LINES)
      const turn = yield* (yield* grokWith(fake)).startTurn({
        ...startArgs,
        planMode: true,
        onToolRequest: (request) => Deferred.succeed(requested, request).pipe(Effect.andThen(Deferred.await(answer))),
      })
      const events: HarnessEvent[] = []
      const drained = yield* Stream.runForEach(turn.events, (event) => Effect.sync(() => { events.push(event) })).pipe(
        Effect.forkChild,
      )

      const request = yield* Deferred.await(requested)
      expect(request.tool.toolKind).toBe("exit_plan_mode")
      expect(request.tool.toolId).toBe("plan-1")
      yield* Effect.yieldNow
      const entries = transcriptEntries(events)
      expect(entries.some((entry) => entry.kind === "tool_call" && entry.tool.toolKind === "exit_plan_mode")).toBe(true)
      expect(entries.some((entry) => entry.kind === "tool_result")).toBe(false)
      expect(entries.some((entry) => entry.kind === "result")).toBe(false)
      // The session id still lands, so the follow-up turn can resume it.
      expect(events.some((event) => event.type === "session_token" && event.sessionToken === "sess-plan")).toBe(true)

      yield* Deferred.succeed(answer, { confirmed: true })
      yield* Fiber.join(drained)
      expect(transcriptEntries(events).some((entry) => entry.kind === "result")).toBe(false)
    })))

    test("a failed request (turn already gone) closes with the held result", () => runTest(Effect.gen(function* () {
      const fake = yield* scriptedCli(PLAN_LINES)
      const turn = yield* (yield* grokWith(fake)).startTurn({
        ...startArgs,
        planMode: true,
        onToolRequest: () => Effect.fail(new Error("Chat turn ended")),
      })
      const events = yield* Stream.runCollect(turn.events)
      expect(transcriptEntries(events).filter((entry) => entry.kind === "result")).toHaveLength(1)
    })))

    test("outside plan mode the stream passes through untouched", () => runTest(Effect.gen(function* () {
      let asked = false
      const fake = yield* scriptedCli(PLAN_LINES)
      const turn = yield* (yield* grokWith(fake)).startTurn({
        ...startArgs,
        planMode: false,
        onToolRequest: () => Effect.sync(() => { asked = true }),
      })
      const entries = transcriptEntries(yield* Stream.runCollect(turn.events))
      expect(asked).toBe(false)
      expect(entries.some((entry) => entry.kind === "tool_result")).toBe(true)
      expect(entries.some((entry) => entry.kind === "result")).toBe(true)
    })))
  })
})

describe("GrokCli.listModels", () => {
  test("spawns `grok models` from HOME and parses the list", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli("You are logged in with grok.com.\nDefault model: grok-build\n  * grok-build (default)\n  - grok-4.6\n")
    const models = yield* (yield* grokWith(fake)).listModels()
    expect(fake.spawns[0]).toMatchObject({ argv: ["models"], cwd: homedir() })
    expect(models.map((model) => model.id)).toEqual(["grok-build", "grok-4.6"])
    expect(models[0]?.isDefault).toBe(true)
  })))

  test("fails with stderr when grok lists nothing", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli("", 1, "Not logged in. Run grok login.\n")
    const result = yield* Effect.result((yield* grokWith(fake)).listModels())
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/grok-cli/GrokModelListError")
      expect(result.failure.message).toBe("Not logged in. Run grok login.")
    }
  })))

  test("times out, killing grok", () => runTest(Effect.gen(function* () {
    const fake = yield* makeFakeCli()
    const result = yield* Effect.result((yield* grokWith(fake)).listModels(10))
    expect(Result.isFailure(result) && result.failure.message).toBe("grok models timed out after 10ms")
    expect(fake.released()).toBe(true)
  })))
})

describe("GrokCli.listSkills", () => {
  test("parses `grok inspect --json` in the project", () => runTest(Effect.gen(function* () {
    const fake = yield* scriptedCli(JSON.stringify({ skills: [{ name: "outpost", description: "Find creators" }] }))
    const skills = yield* (yield* grokWith(fake)).listSkills({ cwd: "/repo" })
    expect(fake.spawns[0]).toMatchObject({ argv: ["inspect", "--json"], cwd: "/repo" })
    expect(skills).toEqual([{ name: "outpost", description: "Find creators", source: "skill" }])
  })))

  test("is empty when grok is missing or hangs", () => runTest(Effect.gen(function* () {
    const missing = yield* makeFakeCli({ spawnError: "Executable not found" })
    expect(yield* (yield* grokWith(missing)).listSkills({ cwd: "/repo" })).toEqual([])
    const hung = yield* makeFakeCli()
    expect(yield* (yield* grokWith(hung)).listSkills({ cwd: "/repo", timeoutMs: 10 })).toEqual([])
    expect(hung.released()).toBe(true)
  })))
})

describe("fetchGrokAccountUsage", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  test("reads billing and user with the token, tolerating odd fields", () => runTest(Effect.gen(function* () {
    const requests: Array<{ url: string; auth: string | null }> = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") })
      return url.includes("/billing")
        ? jsonResponse({ config: { creditUsagePercent: 6, productUsage: [{ product: "GrokBuild", usagePercent: 4 }, "junk"], onDemandCap: { val: 50 }, extra: true } })
        : jsonResponse({ subscriptionTier: "SuperGrok", email: 7 })
    }) as typeof fetch
    const usage = yield* fetchGrokAccountUsage({ token: "tok", fetchFn, baseUrl: "https://proxy.test/v1/" })

    expect(requests.map((request) => request.url).sort()).toEqual([
      "https://proxy.test/v1/billing?format=credits",
      "https://proxy.test/v1/user?include=subscription",
    ])
    expect(requests.every((request) => request.auth === "Bearer tok")).toBe(true)
    expect(usage?.user).toEqual({ subscriptionTier: "SuperGrok" })
    expect(grokProductUsageWindows(usage!.billing).map((window) => window.id)).toEqual(["credits", "GrokBuild"])
    expect(moneyVal(usage!.billing.config?.onDemandCap)).toBe(50)
  })))

  test("fails with the status when billing is refused", () => runTest(Effect.gen(function* () {
    const fetchFn = (async () => jsonResponse({}, 401)) as unknown as typeof fetch
    const result = yield* Effect.result(fetchGrokAccountUsage({ token: "tok", fetchFn, baseUrl: "https://proxy.test" }))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/grok-cli/GrokUsageError")
      expect(result.failure.message).toBe("Grok billing request failed (401).")
      expect(result.failure.status).toBe(401)
    }
  })))

  test("is null when grok has no saved sign-in", () => runTest(Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "kanna-grok-auth-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(dir, { recursive: true, force: true })))
    expect(yield* readGrokAuthToken(path.join(dir, "missing.json"))).toBeNull()
    yield* Effect.promise(() => Bun.write(path.join(dir, "bad.json"), "{not json"))
    expect(yield* readGrokAuthToken(path.join(dir, "bad.json"))).toBeNull()
    yield* Effect.promise(() => Bun.write(path.join(dir, "auth.json"), JSON.stringify({ "https://auth.x.ai::a": { key: "tok-1" } })))
    expect(yield* readGrokAuthToken(path.join(dir, "auth.json"))).toBe("tok-1")
  })))
})

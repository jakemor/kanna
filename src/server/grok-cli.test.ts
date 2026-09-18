import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import {
  GrokCliManager,
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
  type GrokChildProcess,
} from "./grok-cli"
import type { HarnessEvent } from "./harness-types"

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

describe("GrokCliManager.startTurn", () => {
  test("spawns grok with streaming-json, prompt-file, model, and always-approve", async () => {
    const argvCalls: string[][] = []
    const manager = new GrokCliManager({
      spawnProcess: ({ argv }) => {
        argvCalls.push(argv)
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const stdin = new PassThrough()
        const listeners: Record<string, Array<(code: number | null) => void>> = { close: [], error: [] }
        queueMicrotask(() => {
          stdout.write(`{"type":"text","data":"hi"}\n`)
          stdout.write(`{"type":"end","stopReason":"end_turn","sessionId":"sess-9"}\n`)
          stdout.end()
          for (const listener of listeners.close) listener(0)
        })
        return {
          stdin,
          stdout,
          stderr,
          kill: () => true,
          once: (event: "close" | "error", listener: (code: number | null) => void) => {
            listeners[event].push(listener)
            return undefined
          },
        } as unknown as GrokChildProcess
      },
    })

    const turn = await manager.startTurn({
      cwd: "/tmp/proj",
      content: "hello",
      model: "grok-4.6",
      effort: "high",
      planMode: false,
      sessionToken: "sess-old",
      forkSession: true,
    })
    const events: HarnessEvent[] = []
    for await (const event of turn.stream) events.push(event)

    expect(argvCalls[0]).toEqual(expect.arrayContaining([
      "--output-format", "streaming-json",
      "--prompt-file", expect.any(String),
      "--cwd", "/tmp/proj",
      "-m", "grok-4.6",
      "--reasoning-effort", "high",
      "--always-approve",
      "--resume", "sess-old",
      "--fork-session",
    ]))
    expect(argvCalls[0]).not.toContain("--permission-mode")
    expect(events.some((event) => event.type === "session_token" && event.sessionToken === "sess-9")).toBe(true)
    expect(transcriptEntries(events).some((entry) => entry.kind === "assistant_text" && entry.text === "hi")).toBe(true)
  })

  test("plan mode uses --permission-mode plan instead of --always-approve", async () => {
    let argv: string[] = []
    const manager = new GrokCliManager({
      spawnProcess: ({ argv: next }) => {
        argv = next
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        queueMicrotask(() => {
          stdout.write(`{"type":"end","stopReason":"end_turn","sessionId":"s"}\n`)
          stdout.end()
        })
        return {
          stdin: new PassThrough(),
          stdout,
          stderr,
          kill: () => true,
          once: (event: "close" | "error", listener: (code: number | null) => void) => {
            if (event === "close") queueMicrotask(() => listener(0))
            return undefined
          },
        } as unknown as GrokChildProcess
      },
    })
    const turn = await manager.startTurn({
      cwd: "/tmp",
      content: "plan this",
      model: "grok-4.6",
      planMode: true,
      sessionToken: null,
      forkSession: false,
    })
    for await (const _event of turn.stream) { /* drain */ }
    expect(argv).toEqual(expect.arrayContaining(["--permission-mode", "plan"]))
    expect(argv).not.toContain("--always-approve")
  })
})

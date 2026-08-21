import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  AcpTurnTranslator,
  OpenCodeAcpManager,
  parseOpenCodeAuthList,
  parseOpenCodeModelList,
  parseOpenCodeVersion,
  translateOpenCodeTool,
} from "./opencode-acp"

// Every `session/update` payload below is verbatim from a real `opencode acp`
// v1.18.8 turn ("read notes.txt, write greeting.txt, run ls"), so the
// translation is tested against the wire rather than against the spec.

class FakeAcpProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: any[] = []
  killed = false

  constructor(private readonly onMessage?: (message: any, child: FakeAcpProcess) => void) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.messages.push(message)
        this.onMessage?.(message, this)
      }
    })
  }

  kill() {
    this.killed = true
  }

  reply(id: unknown, result: unknown) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
  }

  replyError(id: unknown, message: string) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } })}\n`)
  }

  update(sessionId: string, update: unknown) {
    this.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })}\n`
    )
  }

  request(id: unknown, method: string, params: unknown) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  }
}

const SESSION_ID = "ses_057a824d8ffeDkZ5dYxzXArhGO"

const CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opencode/big-pickle",
    options: [
      { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
      { value: "opencode/north-mini-code-free", name: "OpenCode Zen/North Mini Code Free" },
    ],
  },
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }],
  },
]

/** Answers the handshake the way the real binary does. */
function handshakeResponder(extra?: (message: any, child: FakeAcpProcess) => void) {
  return (message: any, child: FakeAcpProcess) => {
    switch (message.method) {
      case "initialize":
        child.reply(message.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "OpenCode", version: "1.18.8" },
        })
        return
      case "session/new":
        child.reply(message.id, { sessionId: SESSION_ID, configOptions: CONFIG_OPTIONS })
        return
      case "session/set_config_option":
        child.reply(message.id, { configOptions: CONFIG_OPTIONS })
        return
      default:
        extra?.(message, child)
    }
  }
}

async function collect(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) items.push(item)
  return items
}

function entries(events: any[]) {
  return events.filter((event) => event.type === "transcript").map((event) => event.entry)
}

describe("translateOpenCodeTool", () => {
  test("maps opencode tool names onto Kanna's canonical tools", () => {
    expect(translateOpenCodeTool("read", "read", { filePath: "/a/notes.txt" })).toEqual({
      toolName: "Read",
      input: { file_path: "/a/notes.txt" },
    })
    expect(translateOpenCodeTool("bash", "execute", { command: "ls", workdir: "/a" })).toEqual({
      toolName: "Bash",
      input: { command: "ls", description: undefined },
    })
    expect(translateOpenCodeTool("edit", "edit", { filePath: "/a", oldString: "x", newString: "y" })).toEqual({
      toolName: "Edit",
      input: { file_path: "/a", old_string: "x", new_string: "y" },
    })
  })

  test("falls back to the ACP kind for tools it does not know by name", () => {
    expect(translateOpenCodeTool("some_mcp_thing", "execute", { command: "make" })).toEqual({
      toolName: "Bash",
      input: { command: "make", description: undefined },
    })
    // No name match and no useful kind: passes through, rendering as unknown_tool.
    expect(translateOpenCodeTool("weird", "other", { a: 1 })).toEqual({
      toolName: "weird",
      input: { a: 1 },
    })
  })
})

describe("AcpTurnTranslator", () => {
  test("coalesces streamed message chunks into one assistant_text entry", () => {
    const translator = new AcpTurnTranslator()
    const events = [
      ...translator.handleUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "Created " },
      }),
      ...translator.handleUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "`greeting.txt`." },
      }),
    ]
    expect(events).toEqual([])
    expect(entries(translator.flushText())).toEqual([
      expect.objectContaining({ kind: "assistant_text", text: "Created `greeting.txt`." }),
    ])
  })

  test("flushes the previous message when the message id changes", () => {
    const translator = new AcpTurnTranslator()
    translator.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_1",
      content: { type: "text", text: "first" },
    })
    const flushed = translator.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_2",
      content: { type: "text", text: "second" },
    })
    expect(entries(flushed)).toEqual([expect.objectContaining({ kind: "assistant_text", text: "first" })])
    expect(entries(translator.flushText())).toEqual([
      expect.objectContaining({ kind: "assistant_text", text: "second" }),
    ])
  })

  test("drops reasoning and the echoed user prompt", () => {
    const translator = new AcpTurnTranslator()
    expect(
      translator.handleUpdate({
        sessionUpdate: "agent_thought_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "Let me read notes.txt first." },
      })
    ).toEqual([])
    expect(
      translator.handleUpdate({
        sessionUpdate: "user_message_chunk",
        messageId: "msg_0",
        content: { type: "text", text: "Read notes.txt" },
      })
    ).toEqual([])
  })

  test("emits a tool_call once arguments arrive, then its result", () => {
    const translator = new AcpTurnTranslator()

    // Frame 1: names the tool, but rawInput is still empty.
    expect(
      translator.handleUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "read",
        kind: "read",
        status: "pending",
        locations: [],
        rawInput: {},
      })
    ).toEqual([])

    // Frame 2: arguments land, and the title has already been relabeled.
    const started = entries(
      translator.handleUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "in_progress",
        kind: "read",
        title: "notes.txt",
        locations: [{ path: "/a/notes.txt" }],
        rawInput: { filePath: "/a/notes.txt" },
      })
    )
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      kind: "tool_call",
      tool: { toolKind: "read_file", toolName: "Read", toolId: "call_1", input: { filePath: "/a/notes.txt" } },
    })

    const finished = entries(
      translator.handleUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        title: "notes.txt",
        content: [{ type: "content", content: { type: "text", text: "hello world" } }],
      })
    )
    expect(finished).toEqual([
      expect.objectContaining({ kind: "tool_result", toolId: "call_1", content: "hello world", isError: false }),
    ])
  })

  test("emits a tool_call exactly once even when arguments repeat across frames", () => {
    const translator = new AcpTurnTranslator()
    const frame = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "call_bash",
      status: "in_progress" as const,
      kind: "execute",
      title: "ls",
      rawInput: { command: "ls", workdir: "/a" },
    }
    expect(entries(translator.handleUpdate({ ...frame, sessionUpdate: "tool_call" }))).toHaveLength(1)

    expect(entries(translator.handleUpdate(frame))).toHaveLength(0)
    expect(entries(translator.handleUpdate(frame))).toHaveLength(0)
  })

  test("waits for the real arguments when a pending frame carries partial input", () => {
    const translator = new AcpTurnTranslator()

    // Real opencode bash frames: the pending one announces only the cwd.
    expect(
      entries(
        translator.handleUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call_bash",
          title: "bash",
          kind: "execute",
          status: "pending",
          locations: [{ path: "/repo" }],
          rawInput: { cwd: "/repo" },
        })
      )
    ).toEqual([])

    const started = entries(
      translator.handleUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_bash",
        status: "in_progress",
        kind: "execute",
        title: "ls",
        rawInput: { command: "ls", workdir: "/repo" },
      })
    )
    expect(started[0]).toMatchObject({
      kind: "tool_call",
      tool: { toolName: "Bash", toolKind: "bash", input: { command: "ls" } },
    })
  })

  test("marks failed tool calls as errors", () => {
    const translator = new AcpTurnTranslator()
    const events = entries(
      translator.handleUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_x",
        title: "bash",
        kind: "execute",
        status: "failed",
        rawInput: { command: "false" },
        content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
      })
    )
    // A call that fails before any in_progress frame still gets both entries.
    expect(events.map((entry) => entry.kind)).toEqual(["tool_call", "tool_result"])
    expect(events[1]).toMatchObject({ isError: true, content: "exit 1" })
  })

  test("orders text emitted before a tool call above it", () => {
    const translator = new AcpTurnTranslator()
    translator.handleUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_1",
      content: { type: "text", text: "Reading the file." },
    })
    const events = entries(
      translator.handleUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        title: "read",
        kind: "read",
        status: "in_progress",
        rawInput: { filePath: "/a" },
      })
    )
    expect(events.map((entry) => entry.kind)).toEqual(["assistant_text", "tool_call"])
  })

  test("maps usage_update onto the context window, including the window size", () => {
    const translator = new AcpTurnTranslator()
    const events = entries(
      translator.handleUpdate({
        sessionUpdate: "usage_update",
        used: 8446,
        size: 200000,
        cost: { amount: 0, currency: "USD" },
      })
    )
    expect(events).toEqual([
      expect.objectContaining({
        kind: "context_window_updated",
        usage: expect.objectContaining({ usedTokens: 8446, maxTokens: 200000 }),
      }),
    ])
  })

  test("renders an ACP plan as a todo list", () => {
    const translator = new AcpTurnTranslator()
    const events = entries(
      translator.handleUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "Read notes.txt", status: "completed", priority: "high" },
          { content: "Write greeting.txt", status: "in_progress", priority: "medium" },
        ],
      })
    )
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      tool: {
        toolKind: "todo_write",
        input: {
          todos: [
            { content: "Read notes.txt", status: "completed" },
            { content: "Write greeting.txt", status: "in_progress" },
          ],
        },
      },
    })
  })
})

describe("OpenCodeAcpManager", () => {
  test("handshakes, opens a session, and applies model + mode", async () => {
    const child = new FakeAcpProcess(handshakeResponder())
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })

    const started = await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/north-mini-code-free",
      planMode: true,
      sessionToken: null,
    })

    expect(started).toEqual({ sessionToken: SESSION_ID, resumeFellBack: false })

    const initialize = child.messages.find((message) => message.method === "initialize")
    expect(initialize.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    const configs = child.messages.filter((message) => message.method === "session/set_config_option")
    expect(configs.map((message) => message.params)).toEqual([
      { sessionId: SESSION_ID, configId: "model", value: "opencode/north-mini-code-free" },
      { sessionId: SESSION_ID, configId: "mode", value: "plan" },
    ])
    manager.stopAll()
  })

  test("reports the model the session confirmed, not the one requested", async () => {
    // The agent rejects the requested id and stays on its current model.
    const child = new FakeAcpProcess(
      handshakeResponder((message, process) => {
        if (message.method === "session/set_config_option" && message.params.configId === "model") {
          process.replyError(message.id, "unknown model")
        }
      })
    )
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "anthropic/claude-sonnet-5",
      planMode: false,
      sessionToken: null,
    })

    // session/new advertised currentValue "opencode/big-pickle".
    expect(manager.getSessionModel("chat-1")).toBe("opencode/big-pickle")

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "hi",
      model: "anthropic/claude-sonnet-5",
    })
    const collected = collect(turn.stream)
    await turn.interrupt()
    const events = await collected
    expect(entries(events)[0]).toMatchObject({ kind: "system_init", model: "opencode/big-pickle" })
    manager.stopAll()
  })

  test("resumes an existing session instead of replaying it with session/load", async () => {
    const child = new FakeAcpProcess(
      handshakeResponder((message, process) => {
        if (message.method === "session/resume") {
          process.reply(message.id, { configOptions: CONFIG_OPTIONS })
        }
      })
    )
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })

    const started = await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/big-pickle",
      planMode: false,
      sessionToken: SESSION_ID,
    })

    expect(started).toEqual({ sessionToken: SESSION_ID, resumeFellBack: false })
    expect(child.messages.some((message) => message.method === "session/load")).toBe(false)
    expect(child.messages.some((message) => message.method === "session/new")).toBe(false)
    manager.stopAll()
  })

  test("falls back to a fresh session when resume fails, and reports it", async () => {
    const child = new FakeAcpProcess(
      handshakeResponder((message, process) => {
        if (message.method === "session/resume") {
          process.replyError(message.id, "session not found")
        }
      })
    )
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })

    const started = await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/big-pickle",
      planMode: false,
      sessionToken: "ses_gone",
    })

    expect(started).toEqual({ sessionToken: SESSION_ID, resumeFellBack: true })
    manager.stopAll()
  })

  test("streams a full turn as transcript entries", async () => {
    const child = new FakeAcpProcess(
      handshakeResponder((message, process) => {
        if (message.method !== "session/prompt") return
        process.update(SESSION_ID, {
          sessionUpdate: "agent_thought_chunk",
          messageId: "msg_a",
          content: { type: "text", text: "Let me read notes.txt first." },
        })
        process.update(SESSION_ID, {
          sessionUpdate: "tool_call",
          toolCallId: "call_read",
          title: "read",
          kind: "read",
          status: "pending",
          locations: [],
          rawInput: {},
        })
        process.update(SESSION_ID, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_read",
          status: "in_progress",
          kind: "read",
          title: "read",
          rawInput: { filePath: "/repo/notes.txt" },
        })
        process.update(SESSION_ID, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_read",
          status: "completed",
          title: "notes.txt",
          content: [{ type: "content", content: { type: "text", text: "hello world" } }],
        })
        process.update(SESSION_ID, {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_b",
          content: { type: "text", text: "It says " },
        })
        process.update(SESSION_ID, {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_b",
          content: { type: "text", text: "hello world." },
        })
        process.update(SESSION_ID, { sessionUpdate: "usage_update", used: 8446, size: 200000 })
        process.reply(message.id, { stopReason: "end_turn" })
      })
    )
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/big-pickle",
      planMode: false,
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      content: "read notes.txt",
      model: "opencode/big-pickle",
    })
    const events = await collect(turn.stream)

    expect(events[0]).toEqual({ type: "session_token", sessionToken: SESSION_ID })
    expect(entries(events).map((entry) => entry.kind)).toEqual([
      "system_init",
      "tool_call",
      "tool_result",
      "context_window_updated",
      "assistant_text",
      "result",
    ])
    expect(entries(events).at(-2)).toMatchObject({ text: "It says hello world." })
    expect(entries(events).at(-1)).toMatchObject({ kind: "result", subtype: "success", isError: false })
    manager.stopAll()
  })

  test("auto-approves permission requests with the broadest offered option", async () => {
    const child = new FakeAcpProcess(
      handshakeResponder((message, process) => {
        if (message.method !== "session/prompt") return
        process.request(99, "session/request_permission", {
          sessionId: SESSION_ID,
          toolCall: { toolCallId: "call_bash", title: "bash" },
          options: [
            { optionId: "reject", kind: "reject_once", name: "No" },
            { optionId: "once", kind: "allow_once", name: "Yes" },
            { optionId: "always", kind: "allow_always", name: "Always" },
          ],
        })
        process.reply(message.id, { stopReason: "end_turn" })
      })
    )
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/big-pickle",
      planMode: false,
      sessionToken: null,
    })
    const turn = await manager.startTurn({ chatId: "chat-1", content: "run ls", model: "opencode/big-pickle" })
    await collect(turn.stream)

    const answer = child.messages.find((message) => message.id === 99)
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "always" } })
    manager.stopAll()
  })

  test("interrupt cancels the session and closes the stream", async () => {
    const child = new FakeAcpProcess(handshakeResponder())
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/big-pickle",
      planMode: false,
      sessionToken: null,
    })

    const turn = await manager.startTurn({ chatId: "chat-1", content: "count to 500", model: "opencode/big-pickle" })
    const collected = collect(turn.stream)
    await turn.interrupt()
    await collected

    const cancel = child.messages.find((message) => message.method === "session/cancel")
    expect(cancel.params).toEqual({ sessionId: SESSION_ID })
    manager.stopAll()
  })

  test("surfaces a crashed process as an errored result", async () => {
    const child = new FakeAcpProcess(handshakeResponder())
    const manager = new OpenCodeAcpManager({ spawnProcess: () => child as any })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/repo",
      model: "opencode/big-pickle",
      planMode: false,
      sessionToken: null,
    })
    const turn = await manager.startTurn({ chatId: "chat-1", content: "hi", model: "opencode/big-pickle" })
    const collected = collect(turn.stream)
    child.stderr.write("opencode: fatal\n")
    await Bun.sleep(5)
    child.emit("close", 1)
    const events = await collected

    expect(entries(events).at(-1)).toMatchObject({
      kind: "result",
      subtype: "error",
      isError: true,
      result: "opencode: fatal",
    })
    manager.stopAll()
  })
})

describe("parseOpenCodeAuthList", () => {
  // Verbatim `opencode auth list` output (v1.18.8).
  test("reads connected providers out of the box-drawn list", () => {
    expect(
      parseOpenCodeAuthList(
        [
          "\u250c  Credentials /home/u/.local/share/opencode/auth.json",
          "\u2502",
          "\u25cf  Anthropic api",
          "\u25cf  OpenCode Zen api",
          "\u2502",
          "\u2514  2 credentials",
        ].join("\n")
      )
    ).toEqual({ providers: ["Anthropic", "OpenCode Zen"] })
  })

  test("reports no providers for a fresh install", () => {
    expect(
      parseOpenCodeAuthList(
        ["\u250c  Credentials /home/u/.local/share/opencode/auth.json", "\u2502", "\u2514  0 credentials"].join("\n")
      )
    ).toEqual({ providers: [] })
  })
})

describe("parseOpenCodeVersion", () => {
  test("reads the bare version the CLI prints", () => {
    expect(parseOpenCodeVersion("1.18.8")).toBe("1.18.8")
    expect(parseOpenCodeVersion("")).toBeNull()
  })
})

describe("parseOpenCodeModelList", () => {
  test("takes the label and context window from `--verbose` model JSON", () => {
    // Trimmed from real `opencode models --verbose` output.
    const output = [
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "providerID": "opencode",',
      '  "name": "Big Pickle",',
      '  "cost": { "input": 0, "output": 0 },',
      '  "limit": { "context": 200000, "output": 32000 }',
      "}",
      "anthropic/claude-sonnet-5",
      "{",
      '  "id": "claude-sonnet-5",',
      '  "name": "Claude Sonnet 5",',
      '  "limit": { "context": 1000000 }',
      "}",
    ].join("\n")

    expect(parseOpenCodeModelList(output)).toEqual([
      { id: "opencode/big-pickle", label: "Big Pickle", contextWindowTokens: 200000 },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", contextWindowTokens: 1000000 },
    ])
  })

  test("parses `opencode models` output and derives labels", () => {
    expect(
      parseOpenCodeModelList(
        [
          "opencode/big-pickle",
          "opencode/north-mini-code-free",
          "anthropic/claude-sonnet-5",
          "",
          "opencode/big-pickle",
        ].join("\n")
      )
    ).toEqual([
      { id: "opencode/big-pickle", label: "Big Pickle" },
      { id: "opencode/north-mini-code-free", label: "North Mini Code Free" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
    ])
  })

  test("ignores banner and status lines", () => {
    expect(parseOpenCodeModelList("Loading models...\n  \nopencode/big-pickle\n")).toEqual([
      { id: "opencode/big-pickle", label: "Big Pickle" },
    ])
  })
})

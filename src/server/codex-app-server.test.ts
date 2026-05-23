import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAppServerManager, type CodexSessionScope } from "./codex-app-server"

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: unknown[] = []
  killed = false

  constructor(
    private readonly onMessage?: (message: any, process: FakeCodexProcess) => void
  ) {
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
    this.emit("close", 0)
  }

  writeServerMessage(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  writeStderr(message: string) {
    this.stderr.write(`${message}\n`)
  }

  closeWithCode(code: number) {
    this.emit("close", code)
  }
}

async function collectStream(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

describe("CodexAppServerManager", () => {
  test("initializes app-server and starts a fresh thread", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    expect(process.messages).toHaveLength(3)
    expect((process.messages[0] as any).method).toBe("initialize")
    expect((process.messages[1] as any).method).toBe("initialized")
    expect((process.messages[2] as any).method).toBe("thread/start")
  })

  test("falls back to thread/start when thread/resume is recoverably missing", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/resume") {
        child.writeServerMessage({
          id: message.id,
          error: { message: "thread/resume failed: thread not found" },
        })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-2" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: "missing-thread",
    })

    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
    ])
  })

  test("forks a thread when a pending fork session token is provided", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/fork") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-fork-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const sessionToken = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
      pendingForkSessionToken: "thread-source",
    })

    expect(sessionToken).toBe("thread-fork-1")
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/fork",
    ])
  })

  test("maps fast mode and reasoning into app-server params", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      serviceTier: "fast",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      effort: "xhigh",
      serviceTier: "fast",
      content: "Run pwd",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await collectStream(turn.stream)

    const threadStart = process.messages.find((message: any) => message.method === "thread/start") as
      | { method: "thread/start"; params: { serviceTier?: string } }
      | undefined
    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as
      | { method: "turn/start"; params: { effort?: string; serviceTier?: string; collaborationMode?: { settings?: { reasoning_effort?: string | null } } } }
      | undefined

    expect(threadStart?.params.serviceTier).toBe("fast")
    expect(turnStart?.params.effort).toBe("xhigh")
    expect(turnStart?.params.serviceTier).toBe("fast")
    expect(turnStart?.params.collaborationMode?.settings?.reasoning_effort).toBeNull()
  })

  test("maps thread token usage updates into context window transcript entries", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-usage" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-usage", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-usage",
            turnId: "turn-usage",
            tokenUsage: {
              total: {
                inputTokens: 11_833,
                cachedInputTokens: 3456,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 11_839,
              },
              last: {
                inputTokens: 120,
                cachedInputTokens: 0,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 126,
              },
              modelContextWindow: 258_400,
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-usage",
            turn: { id: "turn-usage", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Hello",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const usageEvent = events.find((event) => event.type === "transcript" && event.entry.kind === "context_window_updated")

    expect(usageEvent).toBeDefined()
    if (!usageEvent || usageEvent.type !== "transcript" || usageEvent.entry.kind !== "context_window_updated") {
      throw new Error("missing usage event")
    }

    expect(usageEvent.entry.usage).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      compactsAutomatically: true,
    })
  })

  test("generateStructured returns the final assistant JSON and stops the transient session", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-structured" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-structured", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-structured",
            turnId: "turn-structured",
            item: {
              type: "agentMessage",
              id: "msg-structured",
              text: "{\"title\":\"Codex title\"}",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-structured",
            turn: { id: "turn-structured", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const result = await manager.generateStructured({
      cwd: "/tmp/project",
      prompt: "Return JSON",
    })

    expect(result).toBe("{\"title\":\"Codex title\"}")
    expect(process.killed).toBe(true)
    expect((process.messages.find((message: any) => message.method === "thread/start") as any)?.params.model).toBe("gpt-5.5")
    expect((process.messages.find((message: any) => message.method === "turn/start") as any)?.params.model).toBe("gpt-5.5")
  })

  test("maps command execution and agent output into the shared transcript stream", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "/bin/zsh -lc pwd",
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "/bin/zsh -lc pwd",
              status: "completed",
              aggregatedOutput: "/tmp/project\n",
              exitCode: 0,
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "/tmp/project",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Run pwd",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(events[0]).toEqual({ type: "session_token", sessionToken: "thread-1" })
    expect(transcriptKinds).toEqual(["system_init", "tool_call", "tool_result", "assistant_text", "result"])
  })

  test("emits only a compact boundary when Codex reports thread compaction", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "thread/compacted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "/compact",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(transcriptKinds).toEqual(["system_init", "compact_boundary", "result"])
    expect(transcriptKinds).not.toContain("context_cleared")
  })

  test("maps fileChange updates into edit_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "edit a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("edit_file")
    expect(toolCall.entry.tool.toolName).toBe("Edit")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      oldString: "old line",
      newString: "new line",
    })
  })

  test("maps fileChange adds into write_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
              ],
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("write_file")
    expect(toolCall.entry.tool.toolName).toBe("Write")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld",
    })
  })

  test("maps plain-text fileChange adds into write_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "hello\nworld\n",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("write_file")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld\n",
    })
  })

  test("maps plain-text fileChange deletes into delete_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "delete",
                    move_path: null,
                  },
                  diff: "hello\nworld\n",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "delete a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("delete_file")
    expect(toolCall.entry.tool.toolName).toBe("Delete")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld\n",
    })
  })

  test("splits multi-change fileChange items into multiple tool calls and results", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/one.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
                {
                  path: "/tmp/project/two.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "change multiple files",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")

    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)

    expect(toolCalls[0]?.entry.kind).toBe("tool_call")
    expect(toolCalls[1]?.entry.kind).toBe("tool_call")
    if (toolCalls[0]?.entry.kind !== "tool_call" || toolCalls[1]?.entry.kind !== "tool_call") {
      throw new Error("missing tool calls")
    }

    expect(toolCalls[0].entry.tool.toolKind).toBe("write_file")
    expect(toolCalls[0].entry.tool.toolId).toBe("call-1:change:0")
    expect(toolCalls[0].entry.tool.input).toEqual({
      filePath: "/tmp/project/one.md",
      content: "hello\nworld",
    })

    expect(toolCalls[1].entry.tool.toolKind).toBe("edit_file")
    expect(toolCalls[1].entry.tool.toolId).toBe("call-1:change:1")
    expect(toolCalls[1].entry.tool.input).toEqual({
      filePath: "/tmp/project/two.md",
      oldString: "old line",
      newString: "new line",
    })

    expect(toolResults[0]?.entry.kind).toBe("tool_result")
    expect(toolResults[1]?.entry.kind).toBe("tool_result")
    if (toolResults[0]?.entry.kind !== "tool_result" || toolResults[1]?.entry.kind !== "tool_result") {
      throw new Error("missing tool results")
    }

    expect(toolResults[0].entry.toolId).toBe("call-1:change:0")
    expect(toolResults[1].entry.toolId).toBe("call-1:change:1")
  })

  test("maps plan updates into TodoWrite and synthesizes ExitPlanMode on successful plan turns", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: "Plan the work",
            plan: [
              { step: "Inspect repo", status: "completed" },
              { step: "Implement changes", status: "inProgress" },
            ],
          },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "plan",
              id: "plan-1",
              text: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/plan/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "plan-1",
            delta: "## Plan\n\n- [x] Inspect repo\n- [ ] Implement changes",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      onToolRequest: async () => ({ confirmed: true }),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
      .map((event) => event.entry.tool)

    expect(toolCalls[0]?.toolKind).toBe("todo_write")
    expect(toolCalls[1]?.toolKind).toBe("exit_plan_mode")
    if (!toolCalls[1] || toolCalls[1].toolKind !== "exit_plan_mode") {
      throw new Error("missing ExitPlanMode tool")
    }
    expect(toolCalls[1].input.summary).toBe("Plan the work")
    expect(toolCalls[1].input.plan).toContain("## Plan")
  })

  test("maps collab agent tool calls into subagent_task", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "agent-1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "thread-1",
              receiverThreadIds: ["thread-2"],
              prompt: "Inspect tests",
              agentsStates: {
                "thread-2": { status: "running", message: "Inspecting" },
              },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "spawn an agent",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("subagent_task")
    expect(toolCall.entry.tool.input).toEqual({ subagentType: "spawnAgent" })
  })

  test("uses the completed webSearch query when the started item is empty", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "webSearch",
              id: "ws-1",
              query: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "webSearch",
              id: "ws-1",
              query: "jake mor",
              action: {
                type: "search",
                query: "jake mor",
                queries: ["jake mor"],
              },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "search",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCalls).toHaveLength(1)
    const toolCall = toolCalls[0]
    if (toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("web_search")
    expect(toolCall.entry.tool.input).toEqual({ query: "jake mor" })
  })

  test("responds to unsupported dynamic tool requests with a generic tool error", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "dyn-1",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            tool: "custom_tool",
            arguments: { value: 1 },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "call tool",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResult = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_result")
    const response = process.messages.find((message: any) => message.id === "dyn-1")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("unknown_tool")
    expect(toolCall.entry.tool.toolName).toBe("custom_tool")
    expect(toolResult?.entry.kind).toBe("tool_result")
    expect(response).toEqual({
      id: "dyn-1",
      result: {
        contentItems: [{ type: "inputText", text: "Unsupported dynamic tool call: custom_tool" }],
        success: false,
      },
    })
  })

  test("answers requestUserInput requests with the official JSON-RPC result payload", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "runtime",
                header: "Runtime",
                question: "Which runtime?",
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: async () => ({
        questions: [{
          id: "runtime",
          question: "Which runtime?",
        }],
        answers: {
          runtime: "bun",
        },
      }),
    })

    const events = await collectStream(turn.stream)
    const askEntry = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(askEntry?.entry.tool.toolKind).toBe("ask_user_question")

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          runtime: {
            answers: ["bun"],
          },
        },
      },
    })
  })

  test("falls back to question text when requestUserInput answers are keyed by prompt text", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "favorite_color",
                header: "Color",
                question: "What is your favorite color right now?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "Red", description: null },
                  { label: "Blue", description: null },
                ],
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: async () => ({
        questions: [{
          id: "favorite_color",
          question: "What is your favorite color right now?",
        }],
        answers: {
          "What is your favorite color right now?": "Red",
        },
      }),
    })

    await collectStream(turn.stream)

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          favorite_color: {
            answers: ["Red"],
          },
        },
      },
    })
  })

  test("infers multi-select Codex questions from prompt text and returns multiple answers", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "runtimes",
                header: "Runtime",
                question: "Select all runtimes that apply",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "bun", description: null },
                  { label: "node", description: null },
                ],
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: async ({ tool }) => {
        expect(tool.toolKind).toBe("ask_user_question")
        if (tool.toolKind !== "ask_user_question") {
          return {}
        }

        expect(tool.input.questions[0]?.multiSelect).toBe(true)

        return {
          questions: [{
            id: "runtimes",
            question: "Select all runtimes that apply",
            multiSelect: true,
          }],
          answers: {
            runtimes: ["bun", "node"],
          },
        }
      },
    })

    await collectStream(turn.stream)

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          runtimes: {
            answers: ["bun", "node"],
          },
        },
      },
    })
  })

  test("sends approval decisions back to the app-server", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-1",
            command: "rm -rf .",
            cwd: "/tmp/project",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "approve something",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => "accept",
    })

    await collectStream(turn.stream)

    const response = process.messages.find((message: any) => message.id === "approval-1")
    expect(response).toEqual({
      id: "approval-1",
      result: {
        decision: "accept",
      },
    })
  })

  test("interrupt sends turn/interrupt for the active turn", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      } else if (message.method === "turn/interrupt") {
        child.writeServerMessage({ id: message.id, result: {} })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "wait",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await turn.interrupt()

    const interruptRequest = process.messages.find((message: any) => message.method === "turn/interrupt") as
      | { id: string; method: "turn/interrupt"; params: { threadId: string; turnId: string } }
      | undefined
    expect(interruptRequest).toBeDefined()
    if (!interruptRequest) throw new Error("missing interrupt request")
    expect(interruptRequest).toEqual({
      id: interruptRequest.id,
      method: "turn/interrupt",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    })
  })

  test("interrupt clears a pending exit-plan wait so a new turn can start immediately", async () => {
    let resolveToolRequest!: (value: unknown) => void

    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        if (message.params.input[0]?.text === "make a plan") {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-plan", status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/plan/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-plan",
              explanation: "Plan the work",
              plan: [{ step: "Inspect repo", status: "completed" }],
            },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-plan", status: "completed", error: null },
            },
          })
        } else {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-next", status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-next", status: "completed", error: null },
            },
          })
        }
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      onToolRequest: async () => await new Promise((resolve) => {
        resolveToolRequest = resolve
      }),
    })

    const iterator = turn.stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await iterator.next()
    await turn.interrupt()

    const nextTurn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "continue",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await collectStream(nextTurn.stream)
    resolveToolRequest({})
  })

  test("emits an error result when the app-server exits mid-turn", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeStderr("fatal: app-server crashed")
        child.closeWithCode(1)
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "crash",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const resultEvent = events.find((event) => event.type === "transcript" && event.entry.kind === "result")
    expect(resultEvent?.entry.subtype).toBe("error")
    expect(resultEvent?.entry.result).toContain("fatal: app-server crashed")
  })

  test("renders imageGeneration item as tool_call/tool_result", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-img" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-img", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-img",
            turnId: "turn-img",
            item: {
              type: "imageGeneration",
              id: "ig-1",
              status: "inProgress",
              revisedPrompt: "A tom and jerry cartoon",
              result: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-img",
            turnId: "turn-img",
            item: {
              type: "imageGeneration",
              id: "ig-1",
              status: "completed",
              revisedPrompt: "A tom and jerry cartoon",
              result: "ig_07031bcd.png",
              savedPath: "/Users/x/.codex/generated_images/019e/ig_07031bcd.png",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-img",
            turn: { id: "turn-img", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })

    await manager.startSession({
      chatId: "chat-img",
      cwd: "/tmp/project",
      projectId: "proj-img",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-img",
      model: "gpt-5.4",
      content: "draw tom and jerry",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")

    expect(toolCalls).toHaveLength(1)
    expect(toolResults).toHaveLength(1)

    const call = toolCalls[0]
    if (call.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(call.entry.tool.toolName).toBe("ImageGeneration")
    expect(call.entry.tool.toolKind).toBe("image_generation")
    expect(call.entry.tool.toolId).toBe("ig-1")

    const result = toolResults[0]
    if (result.entry.kind !== "tool_result") throw new Error("missing tool result")
    expect(result.entry.toolId).toBe("ig-1")
    const content = result.entry.content as { contentUrl: string; relativePath: string; fileName: string }
    expect(content.fileName).toBe("ig_07031bcd.png")
    expect(content.relativePath).toBe("/Users/x/.codex/generated_images/019e/ig_07031bcd.png")
    // Codex stores generated images at absolute paths outside the project; the URL
    // must route through /api/local-file rather than the project-files endpoint,
    // which rejects absolute paths and produces a malformed double-slash URL.
    expect(content.contentUrl).toBe(
      "/api/local-file?path=%2FUsers%2Fx%2F.codex%2Fgenerated_images%2F019e%2Fig_07031bcd.png",
    )
  })

  test("renders dynamicToolCall ImageGeneration with deferred call emission and project URL", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-dig" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-dig", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-dig",
            turnId: "turn-dig",
            item: {
              type: "dynamicToolCall",
              id: "dig-1",
              tool: "ImageGeneration",
              arguments: { revisedPrompt: null, status: "in_progress" },
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-dig",
            turnId: "turn-dig",
            item: {
              type: "dynamicToolCall",
              id: "dig-1",
              tool: "ImageGeneration",
              arguments: { revisedPrompt: "Tom chasing Jerry through a kitchen", status: "completed" },
              status: "completed",
              success: true,
              contentItems: [
                { type: "inputText", text: "generated_images/019e/ig_abc.png" },
              ],
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-dig",
            turn: { id: "turn-dig", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })

    await manager.startSession({
      chatId: "chat-dig",
      cwd: "/tmp/project",
      projectId: "proj-dig",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-dig",
      model: "gpt-5.4",
      content: "draw tom and jerry",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")

    expect(toolCalls).toHaveLength(1)
    expect(toolResults).toHaveLength(1)

    const call = toolCalls[0]
    if (call.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(call.entry.tool.toolKind).toBe("image_generation")
    expect(call.entry.tool.toolName).toBe("ImageGeneration")
    // Input is the COMPLETED args (revisedPrompt populated), not the in_progress placeholder.
    const input = call.entry.tool.input as { revisedPrompt: string | null; status: string | undefined }
    expect(input.revisedPrompt).toBe("Tom chasing Jerry through a kitchen")
    expect(input.status).toBe("completed")

    const result = toolResults[0]
    if (result.entry.kind !== "tool_result") throw new Error("missing tool result")
    const content = result.entry.content as { contentUrl: string; relativePath: string; fileName: string }
    expect(content.relativePath).toBe("generated_images/019e/ig_abc.png")
    expect(content.fileName).toBe("ig_abc.png")
    expect(content.contentUrl).toBe("/api/projects/proj-dig/files/generated_images/019e/ig_abc.png/content")
  })

  test("relocates ImageGeneration absolute path outside project into .kanna/outputs", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "kanna-codex-project-"))
    const externalRoot = mkdtempSync(join(tmpdir(), "kanna-codex-external-"))
    const externalImage = join(externalRoot, "ig_xyz.png")
    writeFileSync(externalImage, "fake-png-bytes")

    try {
      const process = new FakeCodexProcess((message, child) => {
        if (message.method === "initialize") {
          child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
        } else if (message.method === "thread/start") {
          child.writeServerMessage({
            id: message.id,
            result: { thread: { id: "thread-ext" }, model: "gpt-5.4", reasoningEffort: "high" },
          })
        } else if (message.method === "turn/start") {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-ext", status: "inProgress", error: null } },
          })
          child.writeServerMessage({
            method: "item/completed",
            params: {
              threadId: "thread-ext",
              turnId: "turn-ext",
              item: {
                type: "dynamicToolCall",
                id: "dig-ext",
                tool: "ImageGeneration",
                arguments: { revisedPrompt: "cat", status: "completed" },
                status: "completed",
                success: true,
                contentItems: [
                  { type: "inputText", text: externalImage },
                ],
              },
            },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-ext",
              turn: { id: "turn-ext", status: "completed", error: null },
            },
          })
        }
      })

      const manager = new CodexAppServerManager({ spawnProcess: () => process as never })

      await manager.startSession({
        chatId: "chat-ext",
        cwd: projectRoot,
        projectId: "proj-ext",
        model: "gpt-5.4",
        sessionToken: null,
      })

      const turn = await manager.startTurn({
        chatId: "chat-ext",
        model: "gpt-5.4",
        content: "draw cat",
        planMode: false,
        onToolRequest: async () => ({}),
      })

      const events = await collectStream(turn.stream)
      const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")
      expect(toolResults).toHaveLength(1)

      const result = toolResults[0]
      if (result.entry.kind !== "tool_result") throw new Error("missing tool result")
      const content = result.entry.content as { contentUrl: string; relativePath: string; fileName: string }
      expect(content.relativePath).toBe(".kanna/outputs/ig_xyz.png")
      expect(content.fileName).toBe("ig_xyz.png")
      expect(content.contentUrl).toBe("/api/projects/proj-ext/files/.kanna/outputs/ig_xyz.png/content")

      const copiedAbs = join(projectRoot, ".kanna/outputs/ig_xyz.png")
      expect(existsSync(copiedAbs)).toBe(true)
      expect(readFileSync(copiedAbs, "utf8")).toBe("fake-png-bytes")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
      rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  test("marks ImageGeneration result as error when projectId is missing", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-noproj" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-noproj", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-noproj",
            turnId: "turn-noproj",
            item: {
              type: "dynamicToolCall",
              id: "dig-np",
              tool: "ImageGeneration",
              arguments: { revisedPrompt: "no project case", status: "completed" },
              status: "completed",
              success: true,
              contentItems: [
                { type: "inputText", text: "generated_images/np.png" },
              ],
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-noproj",
            turn: { id: "turn-noproj", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })

    await manager.startSession({
      chatId: "chat-noproj",
      cwd: "/tmp/project",
      projectId: null,
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-noproj",
      model: "gpt-5.4",
      content: "draw something",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")
    expect(toolResults).toHaveLength(1)
    const result = toolResults[0]
    if (result.entry.kind !== "tool_result") throw new Error("missing tool result")
    expect(result.entry.isError).toBe(true)
    const content = result.entry.content as { contentUrl: string; relativePath: string; fileName: string }
    expect(content.contentUrl).toBe("")
    expect(content.relativePath).toBe("generated_images/np.png")
  })

  test("emits placeholder tool_call for unknown ThreadItem types", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-unk" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-unk", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-unk",
            turnId: "turn-unk",
            item: {
              type: "futureMysteryTool",
              id: "fm-1",
              detail: "totally new",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-unk",
            turnId: "turn-unk",
            item: {
              type: "futureMysteryTool",
              id: "fm-1",
              detail: "totally new",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-unk",
            turn: { id: "turn-unk", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-unk",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-unk",
      model: "gpt-5.4",
      content: "do something",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")

    expect(toolCalls).toHaveLength(1)
    const call = toolCalls[0]
    if (call.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(call.entry.tool.toolKind).toBe("unknown_tool")
    expect(call.entry.tool.toolName).toBe("FutureMysteryTool")
    expect(call.entry.tool.toolId).toBe("fm-1")

    expect(toolResults).toHaveLength(1)
    const result = toolResults[0]
    if (result.entry.kind !== "tool_result") throw new Error("missing tool result")
    expect(result.entry.toolId).toBe("fm-1")
  })

  test("suppresses empty agentMessage so the turn does not finish silently with no text", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-empty" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-empty", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-empty",
            turnId: "turn-empty",
            item: {
              type: "agentMessage",
              id: "am-1",
              text: "",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-empty",
            turn: { id: "turn-empty", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-empty",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-empty",
      model: "gpt-5.4",
      content: "hi",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const assistantTexts = events.filter(
      (event) => event.type === "transcript" && event.entry.kind === "assistant_text"
    )
    expect(assistantTexts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Helpers for scope-keyed session tests
// ---------------------------------------------------------------------------

function makeFakeSpawn() {
  let counter = 0
  return () => {
    const id = ++counter
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: `thread-${id}` }, model: "gpt-5", reasoningEffort: "high" },
        })
      }
    })
    return process as never
  }
}

describe("CodexAppServerManager — scope-keyed sessions", () => {
  test("startSession with different scopes creates parallel sessions for same chat", async () => {
    const manager = new CodexAppServerManager({ spawnProcess: makeFakeSpawn() })
    await manager.startSession({ chatId: "c1", scope: "main", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    await manager.startSession({ chatId: "c1", scope: "sub:r1", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    await manager.startSession({ chatId: "c1", scope: "sub:r2", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    expect(manager.activeSessionCount()).toBe(3)
    manager.stopSession("c1", "sub:r1")
    expect(manager.activeSessionCount()).toBe(2)
    manager.stopSession("c1", "main")
    expect(manager.activeSessionCount()).toBe(1)
  })

  test("startSession without scope defaults to main (back-compat)", async () => {
    const manager = new CodexAppServerManager({ spawnProcess: makeFakeSpawn() })
    await manager.startSession({ chatId: "c1", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    expect(manager.hasSession("c1", "main")).toBe(true)
    expect(manager.hasSession("c1", "sub:nope")).toBe(false)
  })

  test("stopAll terminates every scoped session, not just main", async () => {
    const manager = new CodexAppServerManager({ spawnProcess: makeFakeSpawn() })
    await manager.startSession({ chatId: "c1", scope: "main", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    await manager.startSession({ chatId: "c1", scope: "sub:r1", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    await manager.startSession({ chatId: "c2", scope: "sub:r2", cwd: "/tmp", model: "gpt-5", sessionToken: null })
    expect(manager.activeSessionCount()).toBe(3)
    manager.stopAll()
    expect(manager.activeSessionCount()).toBe(0)
  })

  test("startSession with empty sub: scope throws", async () => {
    const manager = new CodexAppServerManager({ spawnProcess: makeFakeSpawn() })
    const badScope = "sub:" as unknown as CodexSessionScope
    let err: unknown = null
    try {
      await manager.startSession({ chatId: "c1", scope: badScope, cwd: "/tmp", model: "gpt-5", sessionToken: null })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/empty sub-id/)
  })
})

describe("CodexAppServerManager developer_instructions", () => {
  function makeProcessAndStart(): { process: FakeCodexProcess; manager: CodexAppServerManager } {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-di" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-di", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-di",
            turn: { id: "turn-di", status: "completed", error: null },
          },
        })
      }
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    return { process, manager }
  }

  type TurnStartMessage = {
    method: "turn/start"
    params: {
      collaborationMode?: { settings?: { developer_instructions?: string | null } }
    }
  }

  function lastTurnStart(process: FakeCodexProcess): TurnStartMessage | undefined {
    return process.messages.find((m: any) => m.method === "turn/start") as TurnStartMessage | undefined
  }

  test("forwards developer_instructions verbatim on turn/start", async () => {
    const { process, manager } = makeProcessAndStart()
    await manager.startSession({
      chatId: "chat-di",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      serviceTier: "fast",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-di",
      model: "gpt-5.5",
      content: "go",
      planMode: false,
      developerInstructions: "Prefer pumped-go.",
      onToolRequest: async () => ({}),
    })
    await collectStream(turn.stream)
    expect(lastTurnStart(process)?.params.collaborationMode?.settings?.developer_instructions).toBe("Prefer pumped-go.")
  })

  test("sends null when developerInstructions omitted", async () => {
    const { process, manager } = makeProcessAndStart()
    await manager.startSession({
      chatId: "chat-di",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      serviceTier: "fast",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-di",
      model: "gpt-5.5",
      content: "go",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    await collectStream(turn.stream)
    expect(lastTurnStart(process)?.params.collaborationMode?.settings?.developer_instructions).toBeNull()
  })

  test("sends null when developerInstructions is whitespace-only", async () => {
    const { process, manager } = makeProcessAndStart()
    await manager.startSession({
      chatId: "chat-di",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      serviceTier: "fast",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-di",
      model: "gpt-5.5",
      content: "go",
      planMode: false,
      developerInstructions: "   \n  ",
      onToolRequest: async () => ({}),
    })
    await collectStream(turn.stream)
    expect(lastTurnStart(process)?.params.collaborationMode?.settings?.developer_instructions).toBeNull()
  })

  test("trims surrounding whitespace before forwarding", async () => {
    const { process, manager } = makeProcessAndStart()
    await manager.startSession({
      chatId: "chat-di",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      serviceTier: "fast",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-di",
      model: "gpt-5.5",
      content: "go",
      planMode: false,
      developerInstructions: "  Be concise.  \n",
      onToolRequest: async () => ({}),
    })
    await collectStream(turn.stream)
    expect(lastTurnStart(process)?.params.collaborationMode?.settings?.developer_instructions).toBe("Be concise.")
  })
})

import { describe, expect, test } from "bun:test"
import {
  AgentCoordinator,
  buildAttachmentHintText,
  buildPromptText,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeStreamMessage,
  normalizeClaudeUsageSnapshot,
} from "./agent"
import type { HarnessTurn } from "./harness-types"
import type { ChatAttachment, SlashCommand, TranscriptEntry } from "../shared/types"

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(entry: T): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...entry,
  } as TranscriptEntry
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  close() {
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }
        if (this.closed) {
          return { done: true, value: undefined as never }
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

describe("normalizeClaudeStreamMessage", () => {
  test("normalizes assistant tool calls", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "pwd",
              timeout: 1000,
            },
          },
        ],
      },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("tool_call")
    if (entries[0]?.kind !== "tool_call") throw new Error("unexpected entry")
    expect(entries[0].tool.toolKind).toBe("bash")
  })

  test("normalizes result messages", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 3210,
      result: "done",
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("result")
    if (entries[0]?.kind !== "result") throw new Error("unexpected entry")
    expect(entries[0].durationMs).toBe(3210)
  })

  test("normalizes Claude usage snapshots from SDK usage payloads", () => {
    const snapshot = normalizeClaudeUsageSnapshot({
      input_tokens: 4,
      cache_creation_input_tokens: 2715,
      cache_read_input_tokens: 21144,
      output_tokens: 679,
      tool_uses: 2,
      duration_ms: 654,
    }, 200_000)

    expect(snapshot).toEqual({
      usedTokens: 24_542,
      inputTokens: 23_863,
      cachedInputTokens: 21_144,
      outputTokens: 679,
      lastUsedTokens: 24_542,
      lastInputTokens: 23_863,
      lastCachedInputTokens: 21_144,
      lastOutputTokens: 679,
      toolUses: 2,
      durationMs: 654,
      maxTokens: 200_000,
      compactsAutomatically: false,
    })
  })

  test("reads the max Claude context window from modelUsage", () => {
    expect(maxClaudeContextWindowFromModelUsage({
      "claude-opus-4-6": {
        contextWindow: 200_000,
      },
      "claude-opus-4-6[1m]": {
        contextWindow: 1_000_000,
      },
    })).toBe(1_000_000)
  })
})

describe("attachment prompt helpers", () => {
  test("appends a structured attachment hint block for all attachment kinds", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "image-1",
        kind: "image",
        displayName: "shot.png",
        absolutePath: "/tmp/project/.kanna/uploads/shot.png",
        relativePath: "./.kanna/uploads/shot.png",
        contentUrl: "/api/projects/project-1/uploads/shot.png/content",
        mimeType: "image/png",
        size: 512,
      },
      {
        id: "file-1",
        kind: "file",
        displayName: "spec.pdf",
        absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
        relativePath: "./.kanna/uploads/spec.pdf",
        contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]

    const prompt = buildPromptText("Review these", attachments)
    expect(prompt).toContain("<kanna-attachments>")
    expect(prompt).toContain('path="/tmp/project/.kanna/uploads/shot.png"')
    expect(prompt).toContain('project_path="./.kanna/uploads/spec.pdf"')
  })

  test("supports attachment-only prompts", () => {
    const attachments: ChatAttachment[] = [{
      id: "file-1",
      kind: "file",
      displayName: "todo.txt",
      absolutePath: "/tmp/project/.kanna/uploads/todo.txt",
      relativePath: "./.kanna/uploads/todo.txt",
      contentUrl: "/api/projects/project-1/uploads/todo.txt/content",
      mimeType: "text/plain",
      size: 32,
    }]

    expect(buildPromptText("", attachments)).toContain("Please inspect the attached files.")
  })

  test("escapes xml attribute values for attachment hint markup", () => {
    const hint = buildAttachmentHintText([{
      id: "file-1",
      kind: "file",
      displayName: "\"report\" <draft>.txt",
      absolutePath: "/tmp/project/.kanna/uploads/report.txt",
      relativePath: "./.kanna/uploads/report.txt",
      contentUrl: "/api/projects/project-1/uploads/report.txt/content",
      mimeType: "text/plain",
      size: 64,
    }])

    expect(hint).toContain("&quot;report&quot; &lt;draft&gt;.txt")
  })
})

describe("AgentCoordinator codex integration", () => {
  test("generates a chat title in the background on the first user message", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return {
          title: "Generated title",
          usedFallback: false,
          failureMessage: null,
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    expect(store.chat.title).toBe("first message")
    releaseTitle()
    await waitFor(() => store.chat.title === "Generated title")
    expect(store.messages[0]?.kind).toBe("user_prompt")
  })

  test("does not overwrite a manual rename when background title generation finishes later", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return {
          title: "Generated title",
          usedFallback: false,
          failureMessage: null,
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    await store.renameChat("chat-1", "Manual title")
    releaseTitle()
    await waitFor(() => store.turnFinishedCount === 1)

    expect(store.chat.title).toBe("Manual title")
  })

  test("reports provider failure without a second rename after the optimistic title", async () => {
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const backgroundErrors: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => ({
        title: "first message",
        usedFallback: true,
        failureMessage: "claude failed conversation title generation: Not authenticated",
      }),
    })
    coordinator.setBackgroundErrorReporter((message) => {
      backgroundErrors.push(message)
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    expect(store.chat.title).toBe("first message")
    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.title).toBe("first message")
    expect(backgroundErrors).toEqual([
      "[title-generation] chat chat-1 failed provider title generation: claude failed conversation title generation: Not authenticated",
    ])
  })

  test("binds codex provider and reuses the session token on later turns", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.provider).toBe("codex")
    expect(store.chat.sessionToken).toBe("thread-1")
    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null }])

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      content: "second",
    })

    await waitFor(() => store.turnFinishedCount === 2)
    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null },
      { chatId: "chat-1", sessionToken: "thread-1" },
    ])
  })

  test("maps codex model options into session and turn settings", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null; serviceTier?: string }> = []
    const turnCalls: Array<{ effort?: string; serviceTier?: string }> = []

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null; serviceTier?: string }) {
        sessionCalls.push({
          chatId: args.chatId,
          sessionToken: args.sessionToken,
          serviceTier: args.serviceTier,
        })
      },
      async startTurn(args: { effort?: string; serviceTier?: string }): Promise<HarnessTurn> {
        turnCalls.push({
          effort: args.effort,
          serviceTier: args.serviceTier,
        })

        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "opt in",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null, serviceTier: "fast" }])
    expect(turnCalls).toEqual([{ effort: "xhigh", serviceTier: "fast" }])
  })

  test("approving synthetic codex ExitPlanMode starts a hidden follow-up turn and can clear context", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []
    let turnCount = 0

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(args: {
        content: string
        planMode: boolean
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })
        turnCount += 1

        async function* firstStream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "exit_plan_mode",
                toolName: "ExitPlanMode",
                toolId: "exit-1",
                input: {
                  plan: "## Plan\n\n- [ ] Ship it",
                  summary: "Plan summary",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-1",
              input: {
                plan: "## Plan\n\n- [ ] Ship it",
                summary: "Plan summary",
              },
            },
          })
        }

        async function* secondStream() {
          yield { type: "session_token" as const, sessionToken: "thread-2" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: turnCount === 1 ? firstStream() : secondStream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "plan this",
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "exit-1",
      result: {
        confirmed: true,
        clearContext: true,
        message: "Use the fast path",
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startTurnCalls).toEqual([
      { content: "plan this", planMode: true },
      { content: "Proceed with the approved plan. Additional guidance: Use the fast path", planMode: false },
    ])
    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null },
      { chatId: "chat-1", sessionToken: null },
    ])
    expect(store.messages.filter((entry) => entry.kind === "user_prompt")).toHaveLength(1)
    expect(store.messages.some((entry) => entry.kind === "context_cleared")).toBe(true)
    expect(store.chat.sessionToken).toBe("thread-2")
  })

  test("cancelling a waiting ask-user-question records a discarded tool result", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: {
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          void args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "ask_user_question",
              toolName: "AskUserQuestion",
              toolId: "question-1",
              input: {
                questions: [{ question: "Provider?" }],
              },
            },
          })
          await interrupted
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            releaseInterrupt()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "ask me something",
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "ask_user_question")
    await coordinator.cancel("chat-1")

    const discardedResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "question-1")
    expect(discardedResult).toBeDefined()
    if (!discardedResult || discardedResult.kind !== "tool_result") {
      throw new Error("missing discarded ask-user-question result")
    }
    expect(discardedResult.content).toEqual({ discarded: true, answers: {} })
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)
  })

  test("UI unblocks immediately when result arrives even if stream stays open", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Produce the result event
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 120_000,
              result: "done",
            }),
          }
          // Stream stays open (simulates background tasks still running)
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {
            resolveStream?.()
          },
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "run something with a background task",
    })

    // Wait for the result message to be persisted
    await waitFor(() => store.messages.some((entry) => entry.kind === "result"))

    // The active turn should be removed even though the stream is still open.
    // This is the key assertion: the UI should show idle (not "Running...")
    // so the user can send new messages without hitting stop.
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(store.turnFinishedCount).toBe(1)

    // The stream is still open, so it should be draining
    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(true)

    // Clean up the hanging stream
    resolveStream()

    // After the stream closes, draining should stop
    await waitFor(() => !coordinator.getDrainingChatIds().has("chat-1"))
  })

  test("stopDraining closes the stream and removes from draining set", async () => {
    let resolveStream!: () => void
    let streamClosed = false

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {
            streamClosed = true
            resolveStream?.()
          },
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getDrainingChatIds().has("chat-1"))

    await coordinator.stopDraining("chat-1")

    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(false)
    expect(streamClosed).toBe(true)
  })

  test("cancel immediately removes active turn so UI shows idle", async () => {
    let resolveInterrupt!: () => void
    const interruptCalled = new Promise<void>((resolve) => {
      resolveInterrupt = resolve
    })
    // interrupt() that hangs until we resolve it — simulating a slow SDK
    let interruptDone = false

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Stream that never ends (simulates the SDK hanging)
          await new Promise(() => {})
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveInterrupt()
            // Hang to simulate a slow interrupt
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                interruptDone = true
                resolve()
              }, 100)
            })
          },
          close: () => {},
        }
      },
    }

    const stateChanges: number[] = []
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {
        stateChanges.push(Date.now())
      },
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "do something",
    })

    // Wait for the turn to be running
    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    // Cancel — this should immediately remove from active turns
    const cancelPromise = coordinator.cancel("chat-1")

    // The turn should be removed from activeTurns immediately,
    // BEFORE interrupt() resolves
    await interruptCalled
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(interruptDone).toBe(false) // interrupt is still in progress

    await cancelPromise

    // Verify only one "interrupted" message was appended
    const interruptedMessages = store.messages.filter((entry) => entry.kind === "interrupted")
    expect(interruptedMessages).toHaveLength(1)
  })

  test("concurrent cancel calls only produce a single interrupted message", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveStream()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    // Fire multiple cancel calls concurrently (simulating repeated stop button clicks)
    await Promise.all([
      coordinator.cancel("chat-1"),
      coordinator.cancel("chat-1"),
      coordinator.cancel("chat-1"),
    ])

    // Only one "interrupted" message should exist
    const interruptedMessages = store.messages.filter((entry) => entry.kind === "interrupted")
    expect(interruptedMessages).toHaveLength(1)
  })

  test("runTurn stops processing events after cancel", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Wait for cancel, then yield another event that should be ignored
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
          // This event arrives after cancel — should not be processed
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "assistant_text",
              text: "this should be ignored after cancel",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveStream()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    const messageCountBefore = store.messages.filter((entry) => entry.kind === "assistant_text").length
    await coordinator.cancel("chat-1")

    // Give the stream time to yield the extra event
    await new Promise((resolve) => setTimeout(resolve, 50))

    const postCancelTextMessages = store.messages.filter((entry) => entry.kind === "assistant_text")
    expect(postCancelTextMessages.length).toBe(messageCountBefore)
  })

  test("cancelling a waiting codex exit-plan prompt discards it without starting a follow-up turn", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const startTurnCalls: string[] = []

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: {
        content: string
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push(args.content)

        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "exit_plan_mode",
                toolName: "ExitPlanMode",
                toolId: "exit-1",
                input: {
                  plan: "## Plan",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-1",
              input: {
                plan: "## Plan",
              },
            },
          })
          await interrupted
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            releaseInterrupt()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "plan this",
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")
    await coordinator.cancel("chat-1")

    const discardedResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")
    expect(discardedResult).toBeDefined()
    if (!discardedResult || discardedResult.kind !== "tool_result") {
      throw new Error("missing discarded exit-plan result")
    }
    expect(discardedResult.content).toEqual({ discarded: true })
    expect(startTurnCalls).toEqual(["plan this"])
  })
})

describe("AgentCoordinator claude integration", () => {
  test("reuses a persistent Claude session across turns", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{ model: string; planMode: boolean; sessionToken: string | null }> = []
    const prompts: string[] = []

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          model: args.model,
          planMode: args.planMode,
          sessionToken: args.sessionToken,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
          sendPrompt: async (content: string) => {
            prompts.push(content)
            if (prompts.length === 1) {
              events.push({ type: "session_token" as const, sessionToken: "claude-session-1" })
              events.push({
                type: "transcript" as const,
                entry: timestamped({
                  kind: "system_init",
                  provider: "claude",
                  model: "claude-opus-4-1",
                  tools: [],
                  agents: [],
                  slashCommands: [],
                  mcpServers: [],
                }),
              })
            }
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "start background task",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "check task output",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toHaveLength(1)
    expect(startSessionCalls[0]?.planMode).toBe(false)
    expect(startSessionCalls[0]?.sessionToken).toBeNull()
    expect(prompts).toEqual(["start background task", "check task output"])
    expect(store.chat.sessionToken).toBe("claude-session-1")

    events.close()
  })

  test("loads supported commands when a fresh Claude session starts", async () => {
    const events = new AsyncEventQueue<any>()
    const commandsFromSDK: SlashCommand[] = [
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
      { name: "help", description: "Show help", argumentHint: "" },
    ]

    const store = createFakeStore()
    const stateChanges: Array<string | undefined> = []
    let releaseCommands: (value: SlashCommand[]) => void
    const commandsReady = new Promise<SlashCommand[]>((resolve) => {
      releaseCommands = resolve
    })
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: (chatId) => { stateChanges.push(chatId) },
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        getSupportedCommands: () => commandsReady,
        sendPrompt: async () => {
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "hello",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)
    // Let any pending coordinator state emits flush before we capture the
    // baseline so the post-release growth strictly reflects the commands-
    // loaded emit.
    await new Promise((r) => setTimeout(r, 50))

    const stateChangesBeforeLoad = stateChanges.length
    releaseCommands!(commandsFromSDK)

    await waitFor(() => store.commandsLoaded.length === 1)

    expect(store.commandsLoaded[0].chatId).toBe("chat-1")
    expect(store.commandsLoaded[0].commands).toEqual(commandsFromSDK)
    // Coordinator must nudge subscribers after persisting commands so freshly
    // loaded slash commands reach the client.
    await waitFor(() => stateChanges.length > stateChangesBeforeLoad)

    events.close()
  })

  test("Claude final results clear running state without using draining mode", async () => {
    const events = new AsyncEventQueue<any>()

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        getSupportedCommands: async () => [],
        sendPrompt: async () => {
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "claude",
              model: "claude-opus-4-1",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          })
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "run something",
      model: "claude-opus-4-1",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(false)

    events.close()
  })

  test("Claude steer interrupts the active run and immediately sends the steered message", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    await store.enqueueMessage("chat-1", {
      id: "queued-1",
      content: "queued follow up",
      attachments: [],
      provider: "claude",
      model: "claude-opus-4-1",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        getSupportedCommands: async () => [],
        sendPrompt: async (content: string) => {
          prompts.push(content)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first prompt",
      model: "claude-opus-4-1",
    })

    expect(prompts).toEqual(["first prompt"])
    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-1",
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toEqual("first prompt")
    expect(prompts[1]).toContain("queued follow up")
    expect(prompts[1]).toContain("<system-message>")
    expect(prompts[1]).toContain("</system-message>")
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)

    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "interrupted",
      }),
    })
    expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")

    events.close()
  })
})

describe("AgentCoordinator.ensureSlashCommandsLoaded", () => {
  test("starts an ephemeral Claude session to load commands for a chat without a turn", async () => {
    const store = createFakeStore()
    const stateChanges: Array<string | undefined> = []
    const commands: SlashCommand[] = [
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
    ]
    let startCount = 0
    let closeCount = 0
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: (chatId) => { stateChanges.push(chatId) },
      startClaudeSession: async () => {
        startCount += 1
        return {
          provider: "claude",
          stream: new AsyncEventQueue<any>(),
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => { closeCount += 1 },
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => commands,
          sendPrompt: async () => {},
        }
      },
    })

    await coordinator.ensureSlashCommandsLoaded("chat-1")

    expect(startCount).toBe(1)
    expect(closeCount).toBe(1)
    expect(store.commandsLoaded).toHaveLength(1)
    expect(store.commandsLoaded[0].commands).toEqual(commands)
    expect(stateChanges).toContain("chat-1")
  })

  test("skips when commands already loaded for the chat", async () => {
    const store = createFakeStore()
    store.chat.slashCommands = [
      { name: "help", description: "", argumentHint: "" },
    ]
    let startCount = 0
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        startCount += 1
        return {
          provider: "claude",
          stream: new AsyncEventQueue<any>(),
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
          sendPrompt: async () => {},
        }
      },
    })

    await coordinator.ensureSlashCommandsLoaded("chat-1")

    expect(startCount).toBe(0)
    expect(store.commandsLoaded).toHaveLength(0)
  })

  test("skips chats whose provider is codex", async () => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    let startCount = 0
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        startCount += 1
        return {
          provider: "claude",
          stream: new AsyncEventQueue<any>(),
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
          sendPrompt: async () => {},
        }
      },
    })

    await coordinator.ensureSlashCommandsLoaded("chat-1")

    expect(startCount).toBe(0)
    expect(store.commandsLoaded).toHaveLength(0)
  })

  test("dedupes concurrent calls via in-flight guard", async () => {
    const store = createFakeStore()
    let releaseCommands: (value: SlashCommand[]) => void
    const commandsReady = new Promise<SlashCommand[]>((resolve) => {
      releaseCommands = resolve
    })
    let startCount = 0
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        startCount += 1
        return {
          provider: "claude",
          stream: new AsyncEventQueue<any>(),
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: () => commandsReady,
          sendPrompt: async () => {},
        }
      },
    })

    const p1 = coordinator.ensureSlashCommandsLoaded("chat-1")
    const p2 = coordinator.ensureSlashCommandsLoaded("chat-1")

    await new Promise((r) => setTimeout(r, 20))
    releaseCommands!([{ name: "plan", description: "", argumentHint: "" }])

    await Promise.all([p1, p2])

    expect(startCount).toBe(1)
    expect(store.commandsLoaded).toHaveLength(1)
  })
})

function createFakeStore() {
  const chat = {
    id: "chat-1",
    projectId: "project-1",
    title: "New Chat",
    provider: null as "claude" | "codex" | null,
    planMode: false,
    sessionToken: null as string | null,
    slashCommands: undefined as SlashCommand[] | undefined,
  }
  const project = {
    id: "project-1",
    localPath: "/tmp/project",
  }
  return {
    chat,
    turnFinishedCount: 0,
    messages: [] as TranscriptEntry[],
    queuedMessages: [] as any[],
    commandsLoaded: [] as Array<{ chatId: string; commands: SlashCommand[] }>,
    async recordSessionCommandsLoaded(chatId: string, commands: SlashCommand[]) {
      this.commandsLoaded.push({ chatId, commands })
      chat.slashCommands = commands
    },
    requireChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getChat(chatId: string) {
      if (chatId !== "chat-1") return null
      return chat
    },
    getProject(projectId: string) {
      expect(projectId).toBe("project-1")
      return project
    },
    getMessages() {
      return this.messages
    },
    async setChatProvider(_chatId: string, provider: "claude" | "codex") {
      chat.provider = provider
    },
    async setPlanMode(_chatId: string, planMode: boolean) {
      chat.planMode = planMode
    },
    async renameChat(_chatId: string, title: string) {
      chat.title = title
    },
    async appendMessage(_chatId: string, entry: TranscriptEntry) {
      this.messages.push(entry)
    },
    async recordTurnStarted() {},
    async recordTurnFinished() {
      this.turnFinishedCount += 1
    },
    async recordTurnFailed() {
      throw new Error("Did not expect turn failure")
    },
    async recordTurnCancelled() {},
    async setSessionToken(_chatId: string, sessionToken: string | null) {
      chat.sessionToken = sessionToken
    },
    async createChat() {
      return chat
    },
    async enqueueMessage(_chatId: string, message: any) {
      const queuedMessage = {
        id: message.id ?? crypto.randomUUID(),
        content: message.content,
        attachments: message.attachments ?? [],
        createdAt: message.createdAt ?? Date.now(),
        provider: message.provider,
        model: message.model,
        modelOptions: message.modelOptions,
        planMode: message.planMode,
      }
      this.queuedMessages.push(queuedMessage)
      return queuedMessage
    },
    getQueuedMessages() {
      return [...this.queuedMessages]
    },
    getQueuedMessage(_chatId: string, queuedMessageId: string) {
      return this.queuedMessages.find((entry) => entry.id === queuedMessageId) ?? null
    },
    async removeQueuedMessage(_chatId: string, queuedMessageId: string) {
      this.queuedMessages = this.queuedMessages.filter((entry) => entry.id !== queuedMessageId)
    },
  }
}

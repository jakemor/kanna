import { describe, expect, test } from "bun:test"
import { AgentCoordinator, normalizeClaudeStreamMessage } from "./agent"
import type { HarnessTurn } from "./harness-types"
import { DEFAULT_CURSOR_MODEL } from "../shared/types"
import type { TranscriptEntry } from "../shared/types"

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
})

describe("AgentCoordinator codex integration", () => {
  test("generates a chat title in the background on the first user message", async () => {
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
      generateTitle: async () => "Generated title",
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "first message" },
      model: "gpt-5.4",
    })

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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return "Generated title"
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "first message" },
      model: "gpt-5.4",
    })

    await store.renameChat("chat-1", "Manual title")
    releaseTitle()
    await waitFor(() => store.turnFinishedCount === 1)

    expect(store.chat.title).toBe("Manual title")
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "first" },
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.provider).toBe("codex")
    expect(store.chat.sessionToken).toBe("thread-1")
    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null }])

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      message: { text: "second" },
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "opt in" },
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

  test("maps cursor model options into Cursor ACP turn settings", async () => {
    const startTurnCalls: Array<{ model: string; planMode: boolean; sessionToken: string | null }> = []
    const fakeCursorManager = {
      async startTurn(args: {
        model: string
        planMode: boolean
        sessionToken: string | null
      }): Promise<HarnessTurn> {
        startTurnCalls.push({
          model: args.model,
          planMode: args.planMode,
          sessionToken: args.sessionToken,
        })

        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "cursor-session-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "cursor",
              model: DEFAULT_CURSOR_MODEL,
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
          provider: "cursor",
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
      attachmentsDir: "/tmp/kanna-attachments",
      cursorManager: fakeCursorManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "cursor",
      message: { text: "cursor turn" },
      model: DEFAULT_CURSOR_MODEL,
      modelOptions: {
        cursor: {},
      },
      planMode: true,
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startTurnCalls).toEqual([{
      model: DEFAULT_CURSOR_MODEL,
      planMode: true,
      sessionToken: null,
    }])
    expect(store.chat.provider).toBe("cursor")
    expect(store.chat.sessionToken).toBe("cursor-session-1")
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "plan this" },
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

  test("approving a Cursor create-plan prompt starts a hidden follow-up turn", async () => {
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []
    let turnCount = 0

    const fakeCursorManager = {
      async startTurn(args: {
        content: string
        planMode: boolean
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })
        turnCount += 1

        async function* firstStream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "cursor",
              model: DEFAULT_CURSOR_MODEL,
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
                toolId: "exit-cursor-1",
                input: {
                  plan: "## Cursor Plan",
                  summary: "Update input shell styling",
                },
                rawInput: {
                  source: "cursor/create_plan",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-cursor-1",
              input: {
                plan: "## Cursor Plan",
                summary: "Update input shell styling",
              },
              rawInput: {
                source: "cursor/create_plan",
              },
            },
          })
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

        async function* secondStream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "cursor",
              model: DEFAULT_CURSOR_MODEL,
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
          provider: "cursor",
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
      attachmentsDir: "/tmp/kanna-attachments",
      cursorManager: fakeCursorManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "cursor",
      message: { text: "plan this" },
      model: DEFAULT_CURSOR_MODEL,
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "exit-cursor-1",
      result: {
        confirmed: true,
        message: "Then implement it cleanly",
      },
    })

    await waitFor(() => startTurnCalls.length === 2)

    expect(startTurnCalls).toEqual([
      { content: "plan this", planMode: true },
      { content: "Proceed with the approved plan. Additional guidance: Then implement it cleanly", planMode: false },
    ])
  })

  test("renders Cursor todo updates as TodoWrite tool calls", async () => {
    const fakeCursorManager = {
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "cursor",
              model: DEFAULT_CURSOR_MODEL,
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
                toolKind: "todo_write",
                toolName: "TodoWrite",
                toolId: "todo-1",
                input: {
                  todos: [
                    { content: "Inspect file", status: "completed", activeForm: "Inspect file" },
                    { content: "Edit file", status: "in_progress", activeForm: "Edit file" },
                    { content: "Verify file", status: "pending", activeForm: "Verify file" },
                  ],
                },
              },
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
          provider: "cursor",
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
      attachmentsDir: "/tmp/kanna-attachments",
      cursorManager: fakeCursorManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "cursor",
      message: { text: "do work" },
      model: DEFAULT_CURSOR_MODEL,
    })

    await waitFor(() => store.turnFinishedCount === 1)

    const todoCall = store.messages.find((entry) => entry.kind === "tool_call" && entry.tool.toolKind === "todo_write")
    expect(todoCall).toBeDefined()
    if (!todoCall || todoCall.kind !== "tool_call" || todoCall.tool.toolKind !== "todo_write") {
      throw new Error("missing TodoWrite tool call")
    }

    expect(todoCall.tool.input.todos.map((todo) => todo.status)).toEqual(["completed", "in_progress", "pending"])
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "ask me something" },
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "plan this" },
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

  test("shutdown preserves a waiting Gemini exit-plan prompt for restart recovery", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })

    const fakeGeminiManager = {
      async startTurn(args: {
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "gemini",
              model: "auto-gemini-2.5",
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
          provider: "gemini",
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
      attachmentsDir: "/tmp/kanna-attachments",
      geminiManager: fakeGeminiManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "gemini",
      message: { text: "plan this" },
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")
    await coordinator.shutdown("chat-1")

    expect(coordinator.getPendingTool("chat-1")).toEqual({
      toolUseId: "exit-1",
      toolKind: "exit_plan_mode",
    })
    expect(store.messages.some((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")).toBe(false)
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(false)
  })

  test("shutdown preserves a waiting ask-user-question prompt for restart recovery", async () => {
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
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "ask_user_question",
                toolName: "AskUserQuestion",
                toolId: "question-1",
                input: {
                  questions: [{ id: "provider", question: "Provider?" }],
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "ask_user_question",
              toolName: "AskUserQuestion",
              toolId: "question-1",
              input: {
                questions: [{ id: "provider", question: "Provider?" }],
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "ask me later" },
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "ask_user_question")
    await coordinator.shutdown("chat-1")

    expect(coordinator.getPendingTool("chat-1")).toEqual({
      toolUseId: "question-1",
      toolKind: "ask_user_question",
    })
    expect(store.messages.some((entry) => entry.kind === "tool_result" && entry.toolId === "question-1")).toBe(false)
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(false)
  })

  test("shutdown preserves a waiting codex exit-plan prompt for restart recovery", async () => {
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
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      message: { text: "plan this" },
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")
    await coordinator.shutdown("chat-1")

    expect(coordinator.getPendingTool("chat-1")).toEqual({
      toolUseId: "exit-1",
      toolKind: "exit_plan_mode",
    })
    expect(store.messages.some((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")).toBe(false)
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(false)
  })

  test("approving a recovered Gemini exit-plan prompt starts a follow-up turn", async () => {
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []

    const fakeGeminiManager = {
      async startTurn(args: {
        content: string
        planMode: boolean
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })

        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "gemini",
              model: "auto-gemini-2.5",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "session_token" as const,
            sessionToken: "gemini-thread-2",
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
          provider: "gemini",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    store.chat.provider = "gemini"
    store.chat.planMode = true
    store.chat.sessionToken = "gemini-thread-1"
    store.messages.push(timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "exit_plan_mode",
        toolName: "ExitPlanMode",
        toolId: "exit-1",
        input: {
          plan: "## Saved plan",
        },
      },
    }))

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      attachmentsDir: "/tmp/kanna-attachments",
      geminiManager: fakeGeminiManager as never,
    })

    expect(coordinator.getChatPendingTool("chat-1")).toEqual({
      toolUseId: "exit-1",
      toolKind: "exit_plan_mode",
      source: "recovered",
    })

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "exit-1",
      result: {
        confirmed: true,
        message: "Use the fast path",
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startTurnCalls).toEqual([
      {
        content: "Proceed with the approved plan. Additional guidance: Use the fast path",
        planMode: false,
      },
    ])
    expect(store.messages.some((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")).toBe(true)
    expect(store.chat.sessionToken).toBe("gemini-thread-2")
  })

  test("answering a recovered ask-user-question prompt starts a follow-up turn", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(args: {
        content: string
        planMode: boolean
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })

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
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    store.messages.push(timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "ask_user_question",
        toolName: "AskUserQuestion",
        toolId: "question-1",
        input: {
          questions: [{ id: "provider", question: "Provider?" }],
        },
      },
    }))

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    expect(coordinator.getChatPendingTool("chat-1")).toEqual({
      toolUseId: "question-1",
      toolKind: "ask_user_question",
      source: "recovered",
    })

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "question-1",
      result: {
        answers: {
          provider: ["Codex"],
        },
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: "thread-1" }])
    expect(startTurnCalls).toHaveLength(1)
    expect(startTurnCalls[0]?.planMode).toBe(false)
    expect(startTurnCalls[0]?.content).toContain("The app restarted while you were waiting for user input.")
    expect(startTurnCalls[0]?.content).toContain("- Provider?: Codex")

    const toolResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "question-1")
    expect(toolResult).toBeDefined()
    if (!toolResult || toolResult.kind !== "tool_result") {
      throw new Error("missing recovered ask-user-question result")
    }
    expect(toolResult.content).toEqual({
      answers: {
        provider: ["Codex"],
      },
    })
  })

  test("approving a recovered codex exit-plan prompt starts a follow-up turn", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(args: {
        content: string
        planMode: boolean
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })

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
    store.chat.provider = "codex"
    store.chat.planMode = true
    store.chat.sessionToken = "thread-1"
    store.messages.push(timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "exit_plan_mode",
        toolName: "ExitPlanMode",
        toolId: "exit-1",
        input: {
          plan: "## Saved plan",
        },
      },
    }))

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      attachmentsDir: "/tmp/kanna-attachments",
      codexManager: fakeCodexManager as never,
    })

    expect(coordinator.getChatPendingTool("chat-1")).toEqual({
      toolUseId: "exit-1",
      toolKind: "exit_plan_mode",
      source: "recovered",
    })

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "exit-1",
      result: {
        confirmed: true,
        message: "Use the fast path",
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: "thread-1" }])
    expect(startTurnCalls).toEqual([
      {
        content: "Proceed with the approved plan. Additional guidance: Use the fast path",
        planMode: false,
      },
    ])
    expect(store.messages.some((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")).toBe(true)
  })
})

function createFakeStore() {
  const chat = {
    id: "chat-1",
    projectId: "project-1",
    title: "New Chat",
    provider: null as "claude" | "codex" | "gemini" | "cursor" | null,
    planMode: false,
    sessionToken: null as string | null,
  }
  const project = {
    id: "project-1",
    localPath: "/tmp/project",
  }
  return {
    chat,
    turnFinishedCount: 0,
    messages: [] as TranscriptEntry[],
    requireChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getProject(projectId: string) {
      expect(projectId).toBe("project-1")
      return project
    },
    getChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getMessages() {
      return this.messages
    },
    state: {
      chatsById: new Map([["chat-1", chat]]),
    },
    async setChatProvider(_chatId: string, provider: "claude" | "codex" | "gemini" | "cursor") {
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
  }
}

import { describe, expect, test } from "bun:test"
import { AgentCoordinator, buildAttachmentHintText, buildPromptText, normalizeClaudeStreamMessage } from "./agent"
import type { HarnessTurn } from "./harness-types"
import type { ChatAttachment, TranscriptEntry } from "../shared/types"

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
      generateTitle: async () => "Generated title",
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
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
      content: "first message",
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

function createFakeStore() {
  const chat = {
    id: "chat-1",
    projectId: "project-1",
    title: "New Chat",
    provider: null as "claude" | "codex" | null,
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
  }
}

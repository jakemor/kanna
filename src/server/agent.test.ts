import { describe, expect, test } from "bun:test"
import {
  AgentCoordinator,
  buildAttachmentHintText,
  buildConcurrentAgentsNotice,
  buildPromptText,
  buildSteeredMessageContent,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeContextUsage,
  normalizeClaudeStreamMessage,
  normalizeClaudeUsageSnapshot,
} from "./agent"
import type { HarnessTurn } from "./harness-types"
import type { ChatAttachment, TranscriptEntry } from "../shared/types"
import type { SessionArtifactStatus } from "./session-artifacts"
import { timestamped } from "./transcript"

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

  test("normalizes Claude getContextUsage responses", () => {
    expect(normalizeClaudeContextUsage({
      totalTokens: 87_312,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 43.7,
      categories: [],
    })).toEqual({
      usedTokens: 87_312,
      maxTokens: 200_000,
    })

    expect(normalizeClaudeContextUsage({ totalTokens: 12_345 })).toEqual({ usedTokens: 12_345 })
    expect(normalizeClaudeContextUsage({ totalTokens: 0, maxTokens: 200_000 })).toBeNull()
    expect(normalizeClaudeContextUsage(null)).toBeNull()
    expect(normalizeClaudeContextUsage("nope")).toBeNull()
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

  // debugRaw contract: raw SDK JSON is stamped ONLY where the client reads it
  // (KannaTranscript's first-system-message raw view and parseTranscript's
  // tool_use_result extraction). Stamping more doubles transcript size; stamping
  // less breaks those two read paths. This test pins the exact set.
  test("stamps debugRaw on exactly system_init and tool_result entries", () => {
    const systemInit = {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-opus-4-8",
      tools: ["Bash"],
      agents: [],
      slash_commands: [],
      mcp_servers: [],
    }
    const assistant = {
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          { type: "text", text: "Running it now." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
    }
    const toolResult = {
      type: "user",
      uuid: "msg-2",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "/tmp", is_error: false },
        ],
      },
      tool_use_result: { stdout: "/tmp" },
    }
    const result = { type: "result", subtype: "success", is_error: false, duration_ms: 10, result: "done" }
    const status = { type: "system", subtype: "status", status: "compacting" }
    const compactBoundary = { type: "system", subtype: "compact_boundary" }

    const stamped = [
      ...normalizeClaudeStreamMessage(systemInit),
      ...normalizeClaudeStreamMessage(toolResult),
    ]
    const unstamped = [
      ...normalizeClaudeStreamMessage(assistant),
      ...normalizeClaudeStreamMessage(result),
      ...normalizeClaudeStreamMessage(status),
      ...normalizeClaudeStreamMessage(compactBoundary),
    ]

    expect(stamped.map((entry) => entry.kind)).toEqual(["system_init", "tool_result"])
    for (const entry of stamped) {
      expect((entry as { debugRaw?: string }).debugRaw).toBeString()
    }
    // The stamped payload must round-trip to the exact raw SDK message: the
    // client JSON.parses it to pull tool_use_result.
    const parsedToolResultRaw = JSON.parse((stamped[1] as { debugRaw: string }).debugRaw)
    expect(parsedToolResultRaw).toEqual(toolResult)
    expect(parsedToolResultRaw.tool_use_result).toEqual({ stdout: "/tmp" })

    expect(unstamped.map((entry) => entry.kind)).toEqual(["assistant_text", "tool_call", "result", "status", "compact_boundary"])
    for (const entry of unstamped) {
      expect(entry).not.toHaveProperty("debugRaw")
    }
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

describe("buildSteeredMessageContent", () => {
  test("prepends the steer block for plain messages", () => {
    const content = buildSteeredMessageContent("please also fix the tests")
    expect(content.startsWith("<system-message>")).toBe(true)
    expect(content.endsWith("please also fix the tests")).toBe(true)
  })

  test("appends the steer block for slash invocations so harness expansion still fires", () => {
    // claude gates slash dispatch on trim().startsWith("/") and pi on
    // startsWith("/") — a leading steer block would turn the command into
    // literal text.
    const content = buildSteeredMessageContent("/code-review src/server")
    expect(content.startsWith("/code-review src/server")).toBe(true)
    expect(content.endsWith("</system-message>")).toBe(true)
  })

  test("returns just the steer block for empty content", () => {
    expect(buildSteeredMessageContent("  ").startsWith("<system-message>")).toBe(true)
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
    // Model the real manager's warm-session early return: once a chat has a
    // live session, later startSession calls (including the coordinator's
    // health-check preflight) no-op instead of re-resuming.
    const openSessions = new Set<string>()
    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null; pendingForkSessionToken?: string | null }) {
        if (openSessions.has(args.chatId) && !args.pendingForkSessionToken) return
        openSessions.add(args.chatId)
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
        return { sessionToken: "thread-1", resumeFellBack: false }
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
    // The warm app-server session is reused across turns — no fresh resume on
    // the second turn — and the resumed token is retained.
    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null }])
    expect(store.chat.sessionToken).toBe("thread-1")
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
  test("tracks analytics for new chats, queued messages, and forks", async () => {
    const events = new AsyncEventQueue<any>()
    const analyticsEvents: string[] = []
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "session-1"

    const coordinator = new AgentCoordinator({
      store: store as never,
      analytics: {
        track: (eventName: string) => {
          analyticsEvents.push(eventName)
        },
        trackLaunch: () => {},
      },
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
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
      projectId: "project-1",
      provider: "claude",
      content: "first message",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.enqueue({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "queued message",
    })

    await coordinator.forkChat("chat-1")

    expect(analyticsEvents).toEqual([
      "chat_created",
      "message_sent",
      "message_sent",
      "chat_created",
    ])

    events.close()
  })

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

  test("passes Claude fast mode as a service tier and toggles it mid-session", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{ serviceTier?: string }> = []
    const fastModeCalls: boolean[] = []

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({ serviceTier: args.serviceTier })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          setFastMode: async (fastMode: boolean) => {
            fastModeCalls.push(fastMode)
          },
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
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "go fast",
      model: "claude-opus-4-8",
      modelOptions: { claude: { fastMode: true } },
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "back to standard",
      model: "claude-opus-4-8",
      modelOptions: { claude: { fastMode: false } },
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toEqual([{ serviceTier: "fast" }])
    expect(fastModeCalls).toEqual([false])

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
    // The steer block is wire-only: the transcript keeps the user's typed
    // text verbatim, with the steered flag driving the UI affordance.
    const steeredEntry = store.messages.find(
      (entry) => entry.kind === "user_prompt" && entry.steered
    ) as Extract<TranscriptEntry, { kind: "user_prompt" }> | undefined
    expect(steeredEntry?.content).toBe("queued follow up")
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

  test("escape mid-turn does not surface the SDK's interrupt error result", async () => {
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
        sendPrompt: async () => {},
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "do something slow",
      model: "claude-opus-4-1",
    })

    await coordinator.cancel("chat-1")
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)

    // The SDK reports the interrupt as an error result with no text.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "",
      }),
    })
    // A later, genuine error result (after the cancel settled) still surfaces.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "real failure",
      }),
    })

    await waitFor(() =>
      store.messages.some((entry) => entry.kind === "result" && entry.result === "real failure")
    )
    const errorResults = store.messages.filter((entry) => entry.kind === "result" && entry.isError)
    expect(errorResults).toHaveLength(1)

    events.close()
  })

  test("force-sending a queued message does not surface the cancelled prompt's error result", async () => {
    const events = new AsyncEventQueue<any>()
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
        sendPrompt: async () => {},
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first prompt",
      model: "claude-opus-4-1",
    })

    // Force send: cancels the active prompt and immediately sends the queued
    // one, which clears suppressResume before the interrupt error lands.
    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-1",
    })

    // SDK reports the interrupt of prompt 1 as an empty error result.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "",
      }),
    })
    // The steered prompt (seq 2) then completes normally.
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

    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.messages.some((entry) => entry.kind === "result" && entry.isError)).toBe(false)
    expect(store.messages.some((entry) => entry.kind === "result" && entry.result === "done")).toBe(true)

    events.close()
  })

  test("uses Claude forkSession when starting a forked chat", async () => {
    const startSessionCalls: Array<{ sessionToken: string | null; forkSession: boolean }> = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.pendingForkSessionToken = "claude-parent-1"

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {
            events.push({ type: "session_token" as const, sessionToken: "claude-fork-1" })
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
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "branch this",
      model: "claude-opus-4-1",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-parent-1",
      forkSession: true,
    }])
    expect(store.chat.pendingForkSessionToken).toBeNull()
    events.close()
  })
})

describe("buildConcurrentAgentsNotice", () => {
  test("returns null when no other chats are running", () => {
    expect(buildConcurrentAgentsNotice([])).toBeNull()
  })

  test("lists each chat title with its transcript path inside one system-message block", () => {
    const notice = buildConcurrentAgentsNotice([
      { title: "Chat One", transcriptPath: "/tmp/transcripts/one.jsonl" },
      { title: "Chat Two", transcriptPath: "/tmp/transcripts/two.jsonl" },
    ])
    expect(notice?.startsWith("<system-message>")).toBe(true)
    expect(notice?.endsWith("</system-message>")).toBe(true)
    expect(notice).toContain("there are other agents working in the current directory")
    expect(notice).toContain("Chat One: /tmp/transcripts/one.jsonl")
    expect(notice).toContain("Chat Two: /tmp/transcripts/two.jsonl")
  })
})

describe("concurrent agents notice injection", () => {
  function createTwoChatCoordinator(store: ReturnType<typeof createFakeStore>) {
    const queues: AsyncEventQueue<any>[] = []
    const prompts: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        const events = new AsyncEventQueue<any>()
        queues.push(events)
        return {
          provider: "claude" as const,
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
          },
        }
      },
    })
    return { coordinator, prompts, close: () => queues.forEach((queue) => queue.close()) }
  }

  test("appends the notice to the wire prompt when another chat runs in the same directory", async () => {
    const store = createFakeStore({
      chats: [
        createFakeChat("chat-1", "project-1", "Fix login bug"),
        createFakeChat("chat-2", "project-1", "Chat Two"),
      ],
      projects: [{ id: "project-1", localPath: "/tmp/project" }],
    })
    const { coordinator, prompts, close } = createTwoChatCoordinator(store)

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first prompt", model: "claude-opus-4-1" })
    await coordinator.send({ type: "chat.send", chatId: "chat-2", provider: "claude", content: "second prompt", model: "claude-opus-4-1" })

    expect(prompts).toHaveLength(2)
    // chat-1 started alone — no notice.
    expect(prompts[0]).toBe("first prompt")
    // chat-2 started while chat-1 was running in the same directory.
    expect(prompts[1]?.startsWith("second prompt")).toBe(true)
    expect(prompts[1]).toContain("there are other agents working in the current directory")
    expect(prompts[1]).toContain("Fix login bug: /tmp/transcripts/chat-1.jsonl")
    expect(prompts[1]).not.toContain("Chat Two:")

    // The transcript keeps the user's typed text verbatim — wire-only injection.
    const userPrompts = store.messages.filter((entry) => entry.kind === "user_prompt")
    expect(userPrompts.map((entry) => (entry as { content: string }).content)).toEqual([
      "first prompt",
      "second prompt",
    ])

    close()
  })

  test("does not append the notice when the other running chat is in a different directory", async () => {
    const store = createFakeStore({
      chats: [
        createFakeChat("chat-1", "project-1", "Chat One"),
        createFakeChat("chat-2", "project-2", "Chat Two"),
      ],
      projects: [
        { id: "project-1", localPath: "/tmp/project-a" },
        { id: "project-2", localPath: "/tmp/project-b" },
      ],
    })
    const { coordinator, prompts, close } = createTwoChatCoordinator(store)

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first prompt", model: "claude-opus-4-1" })
    await coordinator.send({ type: "chat.send", chatId: "chat-2", provider: "claude", content: "second prompt", model: "claude-opus-4-1" })

    expect(prompts).toEqual(["first prompt", "second prompt"])

    close()
  })
})

describe("mid-conversation provider switch", () => {
  function createSwitchFixture() {
    const chat = createFakeChat("chat-1", "project-1", "Fix login bug")
    chat.provider = "claude"
    chat.sessionToken = "claude-session-1"
    chat.pendingForkSessionToken = "claude-fork-1"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "fix the login bug" }),
      timestamped({ kind: "assistant_text", text: "Fixed it." }),
    )

    const sentContents: string[] = []
    const stoppedCodexSessions: string[] = []
    const fakeCodexManager = {
      async startSession() {
        return { sessionToken: "codex-thread-1", resumeFellBack: false }
      },
      stopSession(chatId: string) {
        stoppedCodexSessions.push(chatId)
      },
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        sentContents.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }),
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

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    return { store, coordinator, sentContents, stoppedCodexSessions }
  }

  test("switching clears the session, marks a boundary, and prepends the handoff on the wire only", async () => {
    const { store, coordinator, sentContents, stoppedCodexSessions } = createSwitchFixture()

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "keep going with codex",
      model: "gpt-5.4",
    })

    // Fresh native session on the new harness; the old one is never resumed.
    expect(store.chat.provider).toBe("codex")
    expect(store.chat.sessionToken).toBeNull()
    expect(store.chat.pendingForkSessionToken).toBeNull()
    expect(stoppedCodexSessions).toEqual(["chat-1"])

    // Boundary entry precedes the new user prompt and records the switch.
    const boundaryIndex = store.messages.findIndex((entry) => entry.kind === "handoff_boundary")
    const promptIndex = store.messages.findIndex(
      (entry) => entry.kind === "user_prompt" && (entry as { content: string }).content === "keep going with codex"
    )
    expect(boundaryIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(boundaryIndex)
    const boundary = store.messages[boundaryIndex] as Extract<TranscriptEntry, { kind: "handoff_boundary" }>
    expect(boundary.fromProvider).toBe("claude")
    expect(boundary.toProvider).toBe("codex")
    expect(boundary.stats?.includedEntries).toBe(2)

    // Wire content leads with the handoff transcript and ends with the
    // user's prompt; the persisted prompt entry stays verbatim.
    expect(sentContents).toHaveLength(1)
    expect(sentContents[0]).toContain("<handoff_transcript>")
    expect(sentContents[0]).toContain("fix the login bug")
    expect(sentContents[0]?.endsWith("keep going with codex")).toBe(true)
    expect((store.messages[promptIndex] as { content: string }).content).toBe("keep going with codex")
  })

  test("sending with the chat's current provider does not hand off", async () => {
    const { store, coordinator, sentContents } = createSwitchFixture()

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "keep going with codex",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "same harness again",
      model: "gpt-5.4",
    })

    const boundaries = store.messages.filter((entry) => entry.kind === "handoff_boundary")
    expect(boundaries).toHaveLength(1)
    expect(sentContents[1]).toBe("same harness again")
  })
})

describe("session restore on lost native session", () => {
  function createClaudeRestoreFixture(artifactStatus: SessionArtifactStatus) {
    const chat = createFakeChat("chat-1", "project-1", "Old conversation")
    chat.provider = "claude"
    chat.sessionToken = "claude-session-old"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "earlier question" }),
      timestamped({ kind: "assistant_text", text: "earlier answer" }),
    )

    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    const startSessionCalls: Array<{ sessionToken: string | null; forkSession: boolean }> = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      checkSessionArtifact: () => artifactStatus,
      startClaudeSession: async (args) => {
        startSessionCalls.push({ sessionToken: args.sessionToken, forkSession: args.forkSession })
        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-session-new" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
            })
          },
        }
      },
    })

    return { store, coordinator, events, prompts, startSessionCalls }
  }

  test("rebuilds context and marks a boundary when the Claude session file is gone", async () => {
    const { store, coordinator, events, prompts, startSessionCalls } = createClaudeRestoreFixture("missing")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "continue please",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    // Boundary precedes the new user prompt and records the provider + stats.
    const boundaryIndex = store.messages.findIndex((entry) => entry.kind === "session_restored")
    const promptIndex = store.messages.findIndex(
      (entry) => entry.kind === "user_prompt" && (entry as { content: string }).content === "continue please"
    )
    expect(boundaryIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(boundaryIndex)
    const boundary = store.messages[boundaryIndex] as Extract<TranscriptEntry, { kind: "session_restored" }>
    expect(boundary.provider).toBe("claude")
    expect(boundary.stats?.includedEntries).toBe(2)

    // Stale token cleared; a fresh session is started (no resume, no fork).
    expect(startSessionCalls).toEqual([{ sessionToken: null, forkSession: false }])

    // Wire leads with the rebuilt transcript + restore preamble and ends with
    // the user's verbatim prompt.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("<handoff_transcript>")
    expect(prompts[0]).toContain("restored from Kanna's saved transcript")
    expect(prompts[0]).toContain("earlier question")
    expect(prompts[0]?.endsWith("continue please")).toBe(true)
    expect((store.messages[promptIndex] as { content: string }).content).toBe("continue please")

    events.close()
  })

  test("does not restore when the session artifact status is unknown", async () => {
    const { store, coordinator, events, prompts, startSessionCalls } = createClaudeRestoreFixture("unknown")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "continue please",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(store.messages.some((entry) => entry.kind === "session_restored")).toBe(false)
    // Normal resume with the existing token; prompt is not wrapped in a transcript.
    expect(startSessionCalls).toEqual([{ sessionToken: "claude-session-old", forkSession: false }])
    expect(prompts[0]).toBe("continue please")

    events.close()
  })

  test("marks a boundary once when codex resume falls back to a fresh thread", async () => {
    const chat = createFakeChat("chat-1", "project-1", "Old codex conversation")
    chat.provider = "codex"
    chat.sessionToken = "codex-thread-old"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "earlier question" }),
      timestamped({ kind: "assistant_text", text: "earlier answer" }),
    )

    const sentContents: string[] = []
    let resumeFellBack = true
    const fakeCodexManager = {
      async startSession() {
        return { sessionToken: "codex-thread-new", resumeFellBack }
      },
      stopSession() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        sentContents.push(args.content)
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "codex-thread-new" }
          yield {
            type: "transcript" as const,
            entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }),
          }
        }
        return { provider: "codex", stream: stream(), interrupt: async () => {}, close: () => {} }
      },
    }

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "continue please",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    const boundaryIndex = store.messages.findIndex((entry) => entry.kind === "session_restored")
    const promptIndex = store.messages.findIndex(
      (entry) => entry.kind === "user_prompt" && (entry as { content: string }).content === "continue please"
    )
    expect(boundaryIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(boundaryIndex)
    expect((store.messages[boundaryIndex] as Extract<TranscriptEntry, { kind: "session_restored" }>).provider).toBe("codex")
    expect(sentContents[0]).toContain("<handoff_transcript>")
    expect(sentContents[0]?.endsWith("continue please")).toBe(true)

    // Live session on the follow-up turn: resume succeeds, so no second boundary.
    resumeFellBack = false
    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "and again",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(store.messages.filter((entry) => entry.kind === "session_restored")).toHaveLength(1)
    expect(sentContents[1]).toBe("and again")
  })
})

function createFakeChat(id: string, projectId: string, title = "New Chat") {
  return {
    id,
    projectId,
    title,
    provider: null as "claude" | "codex" | null,
    planMode: false,
    sessionToken: null as string | null,
    pendingForkSessionToken: null as string | null,
  }
}

function createFakeStore(options?: {
  chats?: ReturnType<typeof createFakeChat>[]
  projects?: { id: string; localPath: string }[]
}) {
  const chats = options?.chats ?? [createFakeChat("chat-1", "project-1")]
  const projects = options?.projects ?? [{ id: "project-1", localPath: "/tmp/project" }]
  const chatsById = new Map(chats.map((entry) => [entry.id, entry]))
  const projectsById = new Map(projects.map((entry) => [entry.id, entry]))
  const chat = chats[0]!
  function requireChat(chatId: string) {
    const found = chatsById.get(chatId)
    if (!found) throw new Error(`Chat not found: ${chatId}`)
    return found
  }
  return {
    chat,
    turnFinishedCount: 0,
    messages: [] as TranscriptEntry[],
    queuedMessages: [] as any[],
    requireChat,
    getChat(chatId: string) {
      return chatsById.get(chatId) ?? null
    },
    getProject(projectId: string) {
      return projectsById.get(projectId) ?? null
    },
    getTranscriptPath(chatId: string) {
      return `/tmp/transcripts/${chatId}.jsonl`
    },
    getMessages() {
      return this.messages
    },
    async setChatProvider(chatId: string, provider: "claude" | "codex") {
      requireChat(chatId).provider = provider
    },
    async setPlanMode(chatId: string, planMode: boolean) {
      requireChat(chatId).planMode = planMode
    },
    async renameChat(chatId: string, title: string) {
      requireChat(chatId).title = title
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
    async setSessionToken(chatId: string, sessionToken: string | null) {
      requireChat(chatId).sessionToken = sessionToken
    },
    async setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null) {
      requireChat(chatId).pendingForkSessionToken = pendingForkSessionToken
    },
    async createChat() {
      return chat
    },
    async forkChat() {
      return {
        ...chat,
        id: "chat-fork-1",
        title: "Fork: New Chat",
        sessionToken: null,
        pendingForkSessionToken: chat.sessionToken ?? chat.pendingForkSessionToken,
      }
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

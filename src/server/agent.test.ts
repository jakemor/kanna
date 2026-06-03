import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AgentCoordinator,
  buildAttachmentHintText,
  buildCanUseTool,
  buildPromptText,
  buildUserMcpServers,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeStreamMessage,
  normalizeClaudeUsageSnapshot,
  parseConfiguredContextWindowFromModelId,
  resolveFinalTurnUsage,
} from "./agent"
import { EventStore } from "./event-store"
import { createToolCallbackService } from "./tool-callback"
import type { ToolCallbackService } from "./tool-callback"
import type { ChatPermissionPolicy } from "../shared/permission-policy"
import { POLICY_DEFAULT } from "../shared/permission-policy"
import type { HarnessTurn } from "./harness-types"
import type { ChatAttachment, McpServerConfig, SlashCommand, TranscriptEntry } from "../shared/types"
import type { AutoContinueEvent } from "./auto-continue/events"
import type { WorkflowRegistry } from "./workflow-registry"
import type { WorkflowRunSummary, WorkflowStatus } from "../shared/workflow-types"
import { AsyncEventQueue } from "./test-helpers/async-event-queue"
import { waitFor } from "./test-helpers/wait-for"

/**
 * Minimal in-memory WorkflowRegistry whose snapshot reflects a per-chat
 * status map. Only `snapshot` is exercised by the idle/budget guards; the
 * rest are inert stubs to satisfy the interface.
 */
function makeFakeWorkflowRegistry(statusByChat: Map<string, WorkflowStatus>): WorkflowRegistry {
  return {
    register: () => {},
    unregister: () => {},
    snapshot: (chatId: string): WorkflowRunSummary[] => {
      const status = statusByChat.get(chatId)
      if (!status) return []
      return [{ runId: `run-${chatId}`, status, phases: [], agents: [] }]
    },
    getRun: () => null,
    subscribe: () => () => {},
  }
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(entry: T): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...entry,
  } as TranscriptEntry
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

  test("turn_duration surfaces pendingWorkflowCount onto the synthesized result", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "system",
      subtype: "turn_duration",
      durationMs: 214278,
      pendingWorkflowCount: 1,
    })
    expect(entries).toHaveLength(1)
    if (entries[0]?.kind !== "result") throw new Error("unexpected entry")
    expect(entries[0].pendingWorkflowCount).toBe(1)
  })

  test("turn_duration without pendingWorkflowCount leaves it undefined", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "system",
      subtype: "turn_duration",
      durationMs: 100,
    })
    if (entries[0]?.kind !== "result") throw new Error("unexpected entry")
    expect(entries[0].pendingWorkflowCount).toBeUndefined()
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

  describe("parseConfiguredContextWindowFromModelId", () => {
    test("returns 1_000_000 for [1m] suffix", () => {
      expect(parseConfiguredContextWindowFromModelId("claude-opus-4-6[1m]")).toBe(1_000_000)
      expect(parseConfiguredContextWindowFromModelId("claude-sonnet-4-7[1m]")).toBe(1_000_000)
    })

    test("returns undefined without [1m] suffix so SDK-reported value wins", () => {
      expect(parseConfiguredContextWindowFromModelId("claude-opus-4-6")).toBeUndefined()
      expect(parseConfiguredContextWindowFromModelId("claude-sonnet-4-7")).toBeUndefined()
    })
  })

  describe("resolveFinalTurnUsage", () => {
    test("keeps usedTokens at the live per-request size and routes cumulative to totalProcessedTokens", () => {
      const live = normalizeClaudeUsageSnapshot({
        input_tokens: 4,
        cache_read_input_tokens: 150_000,
        output_tokens: 800,
      })
      const cumulative = normalizeClaudeUsageSnapshot({
        input_tokens: 4,
        cache_read_input_tokens: 4_596_128,
        output_tokens: 28_107,
      })
      const final = resolveFinalTurnUsage(live, cumulative, 1_000_000)
      expect(final?.usedTokens).toBe(150_804)
      expect(final?.totalProcessedTokens).toBe(4_624_239)
      expect(final?.maxTokens).toBe(1_000_000)
    })

    test("returns null when no per-assistant snapshot exists so cumulative result.usage never leaks into usedTokens", () => {
      // Compact/system turns carry no `assistant` usage; SDK `result.usage` is
      // cumulative (sums cache reads per tool round-trip). Emitting it as
      // usedTokens previously inflated the proactive-compact input to millions
      // and forced a second, spurious compact.
      const cumulative = normalizeClaudeUsageSnapshot({
        input_tokens: 4,
        cache_read_input_tokens: 4_596_128,
        output_tokens: 28_107,
      })
      expect(cumulative?.usedTokens).toBeGreaterThan(1_000_000)
      expect(resolveFinalTurnUsage(null, cumulative, 1_000_000)).toBeNull()
    })

    test("returns null when neither snapshot is available", () => {
      expect(resolveFinalTurnUsage(null, null, 1_000_000)).toBeNull()
    })

    test("omits totalProcessedTokens when cumulative does not exceed the live snapshot", () => {
      const live = normalizeClaudeUsageSnapshot({
        input_tokens: 10,
        cache_read_input_tokens: 5_000,
        output_tokens: 200,
      })
      const final = resolveFinalTurnUsage(live, live, 200_000)
      expect(final?.usedTokens).toBe(5_210)
      expect(final?.totalProcessedTokens).toBeUndefined()
      expect(final?.maxTokens).toBe(200_000)
    })
  })

  describe("API error synthetic messages", () => {
    test("emits api_error entry when isApiErrorMessage is set", () => {
      const entries = normalizeClaudeStreamMessage({
        type: "assistant",
        uuid: "msg-err-1",
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        request_id: "req_abc123",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check status.claude.com.",
            },
          ],
        },
      })
      expect(entries).toHaveLength(1)
      const entry = entries[0]
      expect(entry.kind).toBe("api_error")
      if (entry.kind !== "api_error") throw new Error("expected api_error")
      expect(entry.status).toBe(529)
      expect(entry.text).toContain("API Error: 529 Overloaded")
      expect(entry.requestId).toBe("req_abc123")
    })

    test("parses status from text when apiErrorStatus is missing", () => {
      const entries = normalizeClaudeStreamMessage({
        type: "assistant",
        uuid: "msg-err-2",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: 429 Rate limit exceeded." }],
        },
      })
      expect(entries).toHaveLength(1)
      const entry = entries[0]
      expect(entry.kind).toBe("api_error")
      if (entry.kind !== "api_error") throw new Error("expected api_error")
      expect(entry.status).toBe(429)
    })

    test("regular assistant text is unaffected", () => {
      const entries = normalizeClaudeStreamMessage({
        type: "assistant",
        uuid: "msg-ok-1",
        message: {
          model: "claude-opus-4",
          content: [{ type: "text", text: "Hello from the model." }],
        },
      })
      expect(entries).toHaveLength(1)
      expect(entries[0].kind).toBe("assistant_text")
    })
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

  test("renders kind=\"mention\" attachments", () => {
    const hint = buildAttachmentHintText([{
      id: "m1",
      kind: "mention",
      displayName: "src/agent.ts",
      absolutePath: "/tmp/project/src/agent.ts",
      relativePath: "./src/agent.ts",
      contentUrl: "",
      mimeType: "",
      size: 0,
    }])
    expect(hint).toContain("kind=\"mention\"")
    expect(hint).toContain("path=\"/tmp/project/src/agent.ts\"")
    expect(hint).toContain("project_path=\"./src/agent.ts\"")
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

  test("cancel() drains the queue: a follow-up queued message auto-starts after stop", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const startTurnCalls: string[] = []

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
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
          if (startTurnCalls.length === 1) {
            // First turn hangs until interrupted by cancel().
            await interrupted
            return
          }
          // Second turn (auto-started from the queue) completes immediately.
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "ok",
            }),
          }
        }
        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => { releaseInterrupt() },
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
      content: "first prompt",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    await coordinator.enqueue({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "queued follow up",
    })
    expect(store.queuedMessages).toHaveLength(1)

    await coordinator.cancel("chat-1")

    // The queued message must have been consumed and started as the second turn.
    await waitFor(() => startTurnCalls.length === 2)
    expect(startTurnCalls).toEqual(["first prompt", "queued follow up"])
    expect(store.queuedMessages).toHaveLength(0)
  })
})

describe("AgentCoordinator claude integration", () => {
  test("tracks analytics for new chats, queued messages, and forks", async () => {
    const events = new AsyncEventQueue<any>()
    const analyticsEvents: string[] = []
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "session-1"
    store.chat.sessionTokensByProvider = { claude: "session-1" }

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
        getSupportedCommands: async () => [],
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

  test("closes idle Claude sessions and resumes from the stored session token on the next turn", async () => {
    const startSessionCalls: Array<{ sessionToken: string | null }> = []
    const prompts: string[] = []
    let closeCount = 0

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      claudeSessionLifecycle: { idleMs: 10, maxResidentSessions: 4, sweepIntervalMs: 0 },
      startClaudeSession: async (args) => {
        startSessionCalls.push({ sessionToken: args.sessionToken })
        const events = new AsyncEventQueue<any>()
        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {
            closeCount += 1
            events.close()
          },
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
          sendPrompt: async (content: string) => {
            prompts.push(content)
            if (prompts.length === 1) {
              events.push({ type: "session_token" as const, sessionToken: "claude-session-1" })
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
      content: "first",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    const session = coordinator.claudeSessions.get("chat-1") as any
    session.lastUsedAt = 0
    ;(coordinator as any).sweepIdleClaudeSessions(100)

    expect(coordinator.claudeSessions.has("chat-1")).toBe(false)
    expect(closeCount).toBe(1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "second",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toEqual([
      { sessionToken: null },
      { sessionToken: "claude-session-1" },
    ])
    expect(prompts).toEqual(["first", "second"])

    coordinator.dispose()
  })

  test("LRU lifecycle eviction keeps the protected Claude session", () => {
    const store = createFakeStore()
    const closed: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      claudeSessionLifecycle: { idleMs: 10_000, maxResidentSessions: 2, sweepIntervalMs: 0 },
      startClaudeSession: async () => {
        throw new Error("not used")
      },
    })

    function put(chatId: string, lastUsedAt: number) {
      const events = new AsyncEventQueue<any>()
      coordinator.claudeSessions.set(chatId, {
        id: `state-${chatId}`,
        chatId,
        session: {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {
            closed.push(chatId)
            events.close()
          },
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        },
        localPath: "/tmp/project",
        additionalDirectories: [],
        model: "claude-opus-4-1",
        planMode: false,
        sessionToken: null,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        activeTokenId: null,
        lastUsedAt,
      } as any)
    }

    put("chat-old", 1)
    put("chat-mid", 2)
    put("chat-new", 3)

    ;(coordinator as any).enforceClaudeSessionBudget("chat-new")

    expect(closed).toEqual(["chat-old"])
    expect([...coordinator.claudeSessions.keys()].sort()).toEqual(["chat-mid", "chat-new"])

    coordinator.dispose()
  })

  test("does not reap an idle Claude session while it hosts a running workflow", () => {
    const store = createFakeStore()
    const closed: string[] = []
    const runningByChat = new Map<string, WorkflowStatus>([["chat-wf", "running"]])
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      claudeSessionLifecycle: { idleMs: 10, maxResidentSessions: 4, sweepIntervalMs: 0 },
      startClaudeSession: async () => {
        throw new Error("not used")
      },
      workflowRegistry: makeFakeWorkflowRegistry(runningByChat),
    })

    function put(chatId: string) {
      const events = new AsyncEventQueue<any>()
      coordinator.claudeSessions.set(chatId, {
        id: `state-${chatId}`,
        chatId,
        session: {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => { closed.push(chatId); events.close() },
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        },
        localPath: "/tmp/project",
        additionalDirectories: [],
        model: "claude-opus-4-1",
        planMode: false,
        sessionToken: null,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        activeTokenId: null,
        lastUsedAt: 0,
      } as any)
    }

    put("chat-wf")
    put("chat-plain")

    ;(coordinator as any).sweepIdleClaudeSessions(100)

    // chat-plain has no live workflow → reaped; chat-wf is protected.
    expect(closed).toEqual(["chat-plain"])
    expect(coordinator.claudeSessions.has("chat-wf")).toBe(true)

    // Once the run is no longer running, the next sweep reaps it.
    runningByChat.set("chat-wf", "completed")
    ;(coordinator as any).sweepIdleClaudeSessions(200)
    expect(closed).toEqual(["chat-plain", "chat-wf"])

    coordinator.dispose()
  })

  test("budget eviction skips a session hosting a running workflow", () => {
    const store = createFakeStore()
    const closed: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      claudeSessionLifecycle: { idleMs: 10_000, maxResidentSessions: 2, sweepIntervalMs: 0 },
      startClaudeSession: async () => {
        throw new Error("not used")
      },
      workflowRegistry: makeFakeWorkflowRegistry(new Map([["chat-old", "running"]])),
    })

    function put(chatId: string, lastUsedAt: number) {
      const events = new AsyncEventQueue<any>()
      coordinator.claudeSessions.set(chatId, {
        id: `state-${chatId}`,
        chatId,
        session: {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => { closed.push(chatId); events.close() },
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        },
        localPath: "/tmp/project",
        additionalDirectories: [],
        model: "claude-opus-4-1",
        planMode: false,
        sessionToken: null,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        activeTokenId: null,
        lastUsedAt,
      } as any)
    }

    // chat-old is the LRU candidate but hosts a running workflow, so the
    // enforcer must skip it and evict the next-oldest plain session instead.
    put("chat-old", 1)
    put("chat-mid", 2)
    put("chat-new", 3)

    ;(coordinator as any).enforceClaudeSessionBudget("chat-new")

    expect(closed).toEqual(["chat-mid"])
    expect([...coordinator.claudeSessions.keys()].sort()).toEqual(["chat-new", "chat-old"])

    coordinator.dispose()
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

  test("Claude steer + result without echoed cancel still clears running state", async () => {
    // Repro: sometimes the underlying SDK closes its stream cleanly on cancel
    // and never emits a `result.subtype=cancelled` (which would map to an
    // `interrupted` entry). When the next prompt's `result` arrives the
    // session.pendingPromptSeqs queue still holds the orphaned cancelled seq,
    // so the FIFO shift returns the wrong seq and `activeTurns` is never
    // cleared — leaving the UI stuck on "Running...".
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    await store.enqueueMessage("chat-1", {
      id: "queued-1",
      content: "follow up",
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
          if (prompts.length === 1) {
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

    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-1",
    })

    expect(prompts).toHaveLength(2)

    // SDK never echoes a cancelled result for the first prompt — only the
    // result for the steered second prompt arrives.
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

    await waitFor(() => !coordinator.getActiveStatuses().has("chat-1"))
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)

    events.close()
  })

  test("uses Claude forkSession when starting a forked chat", async () => {
    const startSessionCalls: Array<{ sessionToken: string | null; forkSession: boolean }> = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.pendingForkSessionToken = { provider: "claude", token: "claude-parent-1" }

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
          getSupportedCommands: async () => [],
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

  test("primer injected when switching codex with no prior codex token", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionTokensByProvider = { claude: "claude-tok" }
    // Existing assistant reply so primer has content.
    store.messages.push(timestamped({ kind: "user_prompt", content: "first" }))
    store.messages.push(timestamped({ kind: "assistant_text", text: "first-reply" }))

    const turnContent: string[] = []
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: { content: string }) {
        turnContent.push(args.content)
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "codex-tok" }
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
          provider: "codex" as const,
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

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "continue please",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(turnContent.length).toBe(1)
    expect(turnContent[0]).toContain("BEGIN PRIOR CONVERSATION")
    expect(turnContent[0]).toContain("first-reply")
    expect(turnContent[0].endsWith("continue please")).toBe(true)
    expect(store.chat.sessionTokensByProvider.codex).toBe("codex-tok")
    expect(store.chat.sessionTokensByProvider.claude).toBe("claude-tok")
    events.close()
  })

  test("no primer when target provider already has a token", async () => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionTokensByProvider = { codex: "codex-tok" }
    store.messages.push(timestamped({ kind: "user_prompt", content: "first" }))
    store.messages.push(timestamped({ kind: "assistant_text", text: "first-reply" }))

    const turnContent: string[] = []
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: { content: string }) {
        turnContent.push(args.content)
        async function* stream() {
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
          provider: "codex" as const,
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

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "hi",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(turnContent).toEqual(["hi"])
  })

  test("pendingForkSessionToken ignored when switching to a different provider", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionTokensByProvider = { claude: "claude-tok" }
    store.chat.pendingForkSessionToken = { provider: "claude", token: "claude-fork" }
    store.messages.push(timestamped({ kind: "user_prompt", content: "first" }))
    store.messages.push(timestamped({ kind: "assistant_text", text: "first-reply" }))

    const sessionCalls: Array<{ sessionToken: string | null; pendingForkSessionToken: string | null }> = []
    const fakeCodexManager = {
      async startSession(args: { sessionToken: string | null; pendingForkSessionToken: string | null }) {
        sessionCalls.push({ sessionToken: args.sessionToken, pendingForkSessionToken: args.pendingForkSessionToken })
      },
      async startTurn() {
        async function* stream() {
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
          provider: "codex" as const,
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

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "switch over",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(sessionCalls).toEqual([{ sessionToken: null, pendingForkSessionToken: null }])
    expect(store.chat.pendingForkSessionToken).toEqual({ provider: "claude", token: "claude-fork" })
  })

  test("send() injects /compact ahead of the user's message when usage crosses the auto-compact threshold", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "sess-huge"
    store.chat.sessionTokensByProvider = { claude: "sess-huge" }
    // Seed a usage snapshot that sits above the auto-compact threshold so
    // the next send() must inject /compact first.
    store.messages.push(timestamped({
      kind: "context_window_updated",
      usage: { usedTokens: 180_000, maxTokens: 200_000, compactsAutomatically: false },
    }))

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
          // Emit a successful result so the turn ends and any queued message
          // (the user's real prompt) dequeues + runs.
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: prompts.length === 1 ? "compacted" : "done",
            }),
          })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "now refactor the auth module",
      model: "claude-opus-4-7",
    })

    await waitFor(() => prompts.length >= 2, 2000)

    expect(prompts[0]).toBe("/compact")
    expect(prompts[1]).toBe("now refactor the auth module")
    // User's original prompt was queued during compact, then dequeued by
    // maybeStartNextQueuedMessage after /compact succeeded.
    expect(store.queuedMessages.length).toBe(0)

    events.close()
  })

  test("send() does NOT inject /compact when usage is below threshold", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    store.chat.provider = "claude"
    store.messages.push(timestamped({
      kind: "context_window_updated",
      usage: { usedTokens: 50_000, maxTokens: 200_000, compactsAutomatically: false },
    }))

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
      model: "claude-opus-4-7",
    })

    await waitFor(() => store.turnFinishedCount === 1, 2000)

    expect(prompts).toEqual(["hello"])
    events.close()
  })

  test("send() does NOT inject /compact when the persisted failure breaker is tripped", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    store.chat.provider = "claude"
    // Usage is above the auto-compact threshold, so the ONLY thing that can
    // suppress injection is the persisted circuit breaker on the chat record
    // (mirrors a doomed chat whose breaker survived a server restart).
    store.chat.compactFailureCount = 3
    store.messages.push(timestamped({
      kind: "context_window_updated",
      usage: { usedTokens: 180_000, maxTokens: 200_000, compactsAutomatically: false },
    }))

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
      model: "claude-opus-4-7",
    })

    await waitFor(() => store.turnFinishedCount === 1, 2000)

    expect(prompts).toEqual(["hello"])
    events.close()
  })

  test("send() does NOT recursively compact when user's content is itself a slash command", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    store.chat.provider = "claude"
    store.messages.push(timestamped({
      kind: "context_window_updated",
      usage: { usedTokens: 180_000, maxTokens: 200_000, compactsAutomatically: false },
    }))

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
      content: "/clear",
      model: "claude-opus-4-7",
    })

    await waitFor(() => store.turnFinishedCount === 1, 2000)

    expect(prompts).toEqual(["/clear"])
    events.close()
  })

  test("dequeue() refuses to remove queued message while proactive compact is running", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    let releaseCompact!: () => void
    const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve })

    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionTokensByProvider = { claude: "sess-huge" }
    store.messages.push(timestamped({
      kind: "context_window_updated",
      usage: { usedTokens: 180_000, maxTokens: 200_000, compactsAutomatically: false },
    }))

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
          const pushResult = () => events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: content === "/compact" ? "compacted" : "done",
            }),
          })
          // Hold the /compact turn open so we can probe dequeue() mid-flight.
          // sendPrompt must still resolve so startTurnForChat returns; defer
          // the result event until release.
          if (content === "/compact") {
            void compactGate.then(pushResult)
            return
          }
          pushResult()
        },
      }),
    })

    const sendResult = await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "user's real prompt",
      model: "claude-opus-4-7",
    })

    expect(sendResult).toMatchObject({ queued: true })
    expect(store.queuedMessages.length).toBe(1)
    const queuedId = store.queuedMessages[0].id

    await expect(
      coordinator.dequeue({
        type: "message.dequeue",
        chatId: "chat-1",
        queuedMessageId: queuedId,
      })
    ).rejects.toThrow(/compact is running/)

    // Queued message must survive the rejected dequeue.
    expect(store.queuedMessages.length).toBe(1)

    releaseCompact()
    await waitFor(() => prompts.length >= 2, 2000)
    expect(prompts).toEqual(["/compact", "user's real prompt"])
    expect(store.queuedMessages.length).toBe(0)

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
    sessionTokensByProvider: {} as Partial<Record<"claude" | "codex", string | null>>,
    slashCommands: undefined as SlashCommand[] | undefined,
    pendingForkSessionToken: null as { provider: "claude" | "codex"; token: string } | null,
    compactFailureCount: 0,
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
    async setCompactFailureCount(_chatId: string, count: number) {
      chat.compactFailureCount = count
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
    turnFailedCount: 0,
    turnFailures: [] as Array<{ chatId: string; reason: string }>,
    async recordTurnFailed(chatId: string, reason: string) {
      this.turnFailedCount += 1
      this.turnFailures.push({ chatId, reason })
    },
    async recordTurnCancelled() {},
    autoContinueEvents: [] as AutoContinueEvent[],
    async appendAutoContinueEvent(event: AutoContinueEvent) {
      this.autoContinueEvents.push(event)
    },
    getAutoContinueEvents(chatId: string) {
      return this.autoContinueEvents.filter((e) => e.chatId === chatId)
    },
    listAutoContinueChats() {
      return [...new Set(this.autoContinueEvents.map((e) => e.chatId))]
    },
    async setSessionToken(_chatId: string, sessionToken: string | null) {
      chat.sessionToken = sessionToken
    },
    async setSessionTokenForProvider(_chatId: string, provider: "claude" | "codex", sessionToken: string | null) {
      chat.sessionTokensByProvider = { ...chat.sessionTokensByProvider, [provider]: sessionToken }
      chat.sessionToken = sessionToken
    },
    async setPendingForkSessionToken(_chatId: string, value: { provider: "claude" | "codex"; token: string } | null) {
      chat.pendingForkSessionToken = value
    },
    async createChat() {
      return chat
    },
    async forkChat() {
      const pending = chat.provider
        ? (chat.sessionTokensByProvider[chat.provider] ?? null)
        : null
      return {
        ...chat,
        id: "chat-fork-1",
        title: "Fork: New Chat",
        sessionTokensByProvider: {},
        pendingForkSessionToken: pending && chat.provider
          ? { provider: chat.provider, token: pending }
          : chat.pendingForkSessionToken,
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
        autoContinue: message.autoContinue,
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
    subagentEvents: [] as any[],
    subagentRuns: new Map<string, any>(),
    async appendSubagentEvent(event: any) {
      this.subagentEvents.push(event)
      const map = this.subagentRuns
      switch (event.type) {
        case "subagent_run_started":
          map.set(event.runId, {
            runId: event.runId,
            chatId: event.chatId,
            subagentId: event.subagentId,
            subagentName: event.subagentName,
            provider: event.provider,
            model: event.model,
            status: "running",
            parentUserMessageId: event.parentUserMessageId,
            parentRunId: event.parentRunId,
            depth: event.depth,
            startedAt: event.timestamp,
            finishedAt: null,
            finalText: null,
            error: null,
            usage: null,
          })
          break
        case "subagent_message_delta": {
          const run = map.get(event.runId)
          if (run) run.finalText = (run.finalText ?? "") + event.content
          break
        }
        case "subagent_run_completed": {
          const run = map.get(event.runId)
          if (run) {
            run.status = "completed"
            run.finishedAt = event.timestamp
            run.finalText = event.finalContent
            run.usage = event.usage ?? null
          }
          break
        }
        case "subagent_run_failed": {
          const run = map.get(event.runId)
          if (run) {
            run.status = "failed"
            run.finishedAt = event.timestamp
            run.error = event.error
          }
          break
        }
        case "subagent_run_cancelled": {
          const run = map.get(event.runId)
          if (run) {
            run.status = "cancelled"
            run.finishedAt = event.timestamp
          }
          break
        }
      }
    },
    getSubagentRuns() {
      return Object.fromEntries(this.subagentRuns.entries())
    },
    *runningSubagentRuns() {
      // Empty stub — fake store has no subagent runs; recoverInterruptedRuns is a no-op.
    },
  }
}

function makeLimitError() {
  const err = new Error(
    JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error" },
    })
  ) as Error & { status?: number; headers?: Record<string, string> }
  err.status = 429
  err.headers = {
    "anthropic-ratelimit-unified-reset": new Date(5_000).toISOString(),
    "x-anthropic-timezone": "Asia/Saigon",
  }
  return err
}

describe("AgentCoordinator rate-limit detection (manual mode)", () => {
  test("emits auto_continue_proposed when Claude throws a rate-limit error and autoResumeOnRateLimit is false", async () => {
    const store = createFakeStore()
    const limitErr = makeLimitError()
    const events = new AsyncEventQueue<any>()

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getAutoResumePreference: () => false,
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
          // Throw after sendPrompt is called — activeTurns is already set by this point
          events.throw(limitErr)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "hello",
      model: "claude-opus-4-5",
      autoResumeOnRateLimit: false,
    })

    await waitFor(() => store.getAutoContinueEvents("chat-1").length >= 1 && store.turnFailedCount >= 1)

    const acEvents = store.getAutoContinueEvents("chat-1")
    expect(acEvents).toHaveLength(1)
    expect(acEvents[0].kind).toBe("auto_continue_proposed")
    if (acEvents[0].kind === "auto_continue_proposed") {
      expect(acEvents[0].tz).toBe("Asia/Saigon")
    }
    expect(store.turnFailures.some((f) => f.reason === "rate_limit")).toBe(true)
  })

  test("auto-resume on: emits auto_continue_accepted directly with source=auto_setting", async () => {
    const store = createFakeStore()
    const limitErr = makeLimitError()
    const events = new AsyncEventQueue<any>()

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getAutoResumePreference: () => true,
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
          events.throw(limitErr)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "hello",
      model: "claude-opus-4-5",
      autoResumeOnRateLimit: true,
    })

    await waitFor(() => store.getAutoContinueEvents("chat-1").length >= 1 && store.turnFailedCount >= 1)

    const acEvents = store.getAutoContinueEvents("chat-1")
    expect(acEvents).toHaveLength(1)
    expect(acEvents[0].kind).toBe("auto_continue_accepted")
    if (acEvents[0].kind === "auto_continue_accepted") {
      expect(acEvents[0].source).toBe("auto_setting")
    }
    expect(store.turnFailures.some((f) => f.reason === "rate_limit")).toBe(true)
  })
})

describe("AgentCoordinator auto-continue firing", () => {
  test("firing enqueues a 'continue' user message carrying autoContinue metadata", async () => {
    const store = createFakeStore()
    const limitErr = makeLimitError()
    const events = new AsyncEventQueue<any>()

    // FakeClock lets us manually advance time to trigger armed schedules.
    class FakeClock {
      private currentTime = 0
      private readonly timers = new Map<number, { fn: () => void; fireAt: number }>()
      private nextId = 1

      now() { return this.currentTime }

      setTimeout(fn: () => void, delayMs: number): number {
        const id = this.nextId++
        this.timers.set(id, { fn, fireAt: this.currentTime + delayMs })
        return id
      }

      clearTimeout(id: number) { this.timers.delete(id) }

      advance(ms: number) {
        this.currentTime += ms
        for (const [id, timer] of [...this.timers.entries()]) {
          if (timer.fireAt <= this.currentTime) {
            this.timers.delete(id)
            timer.fn()
          }
        }
      }
    }

    const clock = new FakeClock()

    let coordinator!: AgentCoordinator
    const { ScheduleManager: SM } = await import("./auto-continue/schedule-manager")
    const scheduleManager = new SM({
      clock,
      fire: async (chatId, scheduleId) => {
        await coordinator.fireAutoContinue(chatId, scheduleId)
      },
    })

    coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getAutoResumePreference: () => true,
      scheduleManager,
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
          events.throw(limitErr)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "hello",
      model: "claude-opus-4-5",
      autoResumeOnRateLimit: true,
    })

    // Wait for auto_continue_accepted to be stored (Task 12 already handles this).
    await waitFor(() => store.getAutoContinueEvents("chat-1").length >= 1 && store.turnFailedCount >= 1)

    const acceptedEvent = store.getAutoContinueEvents("chat-1")[0]
    expect(acceptedEvent.kind).toBe("auto_continue_accepted")

    // The limit error header sets resetAt = new Date(5_000).toISOString() → 5000 ms from epoch.
    // Advancing the clock past that fires the schedule.
    clock.advance(10_000)

    // Wait for the fired event AND the "continue" user_prompt to both appear.
    await waitFor(
      () =>
        store.getAutoContinueEvents("chat-1").some((e) => e.kind === "auto_continue_fired") &&
        store.messages.some((m) => m.kind === "user_prompt" && m.content === "continue")
    )

    const acEvents = store.getAutoContinueEvents("chat-1")
    const firedEvent = acEvents.find((e) => e.kind === "auto_continue_fired")
    expect(firedEvent).toBeDefined()
    if (firedEvent?.kind === "auto_continue_fired") {
      expect(firedEvent.scheduleId).toBe(acceptedEvent.scheduleId)
    }

    // Exactly one "continue" user_prompt with autoContinue metadata.
    const userPrompts = store.messages.filter(
      (m) => m.kind === "user_prompt" && m.content === "continue"
    )
    expect(userPrompts).toHaveLength(1)
    if (userPrompts[0].kind === "user_prompt") {
      expect(userPrompts[0].autoContinue?.scheduleId).toBe(acceptedEvent.scheduleId)
    }
  })
})

describe("AgentCoordinator.scheduleAgentWakeup", () => {
  test("arms an agent_wakeup schedule carrying the prompt and a future scheduledAt", async () => {
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => { throw new Error("not needed") },
    })

    const before = Date.now()
    const scheduleId = await coordinator.scheduleAgentWakeup({
      chatId: "chat-1",
      delayMs: 1_500,
      prompt: "resume the sweep",
      source: "agent_wakeup",
    })
    expect(scheduleId).not.toBeNull()

    const events = store.getAutoContinueEvents("chat-1")
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe("auto_continue_accepted")
    if (ev.kind === "auto_continue_accepted") {
      expect(ev.source).toBe("agent_wakeup")
      expect(ev.prompt).toBe("resume the sweep")
      expect(ev.scheduledAt).toBeGreaterThanOrEqual(before + 1_500)
    }
  })

  test("runaway-loop cap: returns null past maxAgentWakes; a real user message resets the chain", async () => {
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      maxAgentWakes: 2,
      startClaudeSession: async () => { throw new Error("not needed") },
    })

    const wake = () => coordinator.scheduleAgentWakeup({
      chatId: "chat-1", delayMs: 1_000, prompt: "again", source: "agent_wakeup",
    })

    expect(await wake()).not.toBeNull()
    expect(await wake()).not.toBeNull()
    expect(await wake()).toBeNull() // capped

    // A real (non-auto-continue) user send resets the chain.
    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "human back in the loop",
      model: "claude-opus-4-5",
    }).catch(() => {}) // provider start throws in this minimal harness; the reset happens at enqueue

    expect(await wake()).not.toBeNull() // chain reset → armed again
  })
})

describe("AgentCoordinator pending-workflow harvest wake", () => {
  type ArmFn = (chatId: string, entry: { kind: string; pendingWorkflowCount?: number }) => Promise<void>
  const makeCoord = (store: ReturnType<typeof createFakeStore>) =>
    new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => { throw new Error("not needed") },
    })

  test("arms a pending_workflow wake when a result carries pendingWorkflowCount > 0", async () => {
    const store = createFakeStore()
    const coordinator = makeCoord(store)
    await (coordinator as unknown as { maybeArmPendingWorkflowWake: ArmFn })
      .maybeArmPendingWorkflowWake("chat-1", { kind: "result", pendingWorkflowCount: 2 })

    const events = store.getAutoContinueEvents("chat-1")
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("auto_continue_accepted")
    if (events[0].kind === "auto_continue_accepted") {
      expect(events[0].source).toBe("pending_workflow")
      expect(events[0].prompt).toContain("background Workflow")
    }
  })

  test("no-op when pendingWorkflowCount is 0 / absent", async () => {
    const store = createFakeStore()
    const coordinator = makeCoord(store)
    const arm = (coordinator as unknown as { maybeArmPendingWorkflowWake: ArmFn }).maybeArmPendingWorkflowWake.bind(coordinator)
    await arm("chat-1", { kind: "result", pendingWorkflowCount: 0 })
    await arm("chat-1", { kind: "result" })
    expect(store.getAutoContinueEvents("chat-1")).toHaveLength(0)
  })

  test("no-op when a schedule is already live (no double-arm)", async () => {
    const store = createFakeStore()
    const coordinator = makeCoord(store)
    // Seed a live scheduled wake.
    await store.appendAutoContinueEvent({
      v: 3, kind: "auto_continue_accepted", timestamp: Date.now(), chatId: "chat-1",
      scheduleId: "live-1", scheduledAt: Date.now() + 10_000, tz: "system",
      source: "agent_wakeup", resetAt: Date.now() + 10_000, detectedAt: Date.now(), prompt: "x",
    })
    await (coordinator as unknown as { maybeArmPendingWorkflowWake: ArmFn })
      .maybeArmPendingWorkflowWake("chat-1", { kind: "result", pendingWorkflowCount: 1 })
    // Still only the seeded event — no second arm.
    expect(store.getAutoContinueEvents("chat-1")).toHaveLength(1)
  })
})

describe("AgentCoordinator.fireAutoContinue prompt replay", () => {
  test("replays the agent_wakeup schedule's prompt instead of the literal 'continue'", async () => {
    const store = { ...createFakeStore(), getQueuedMessages: () => [] }
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => { throw new Error("not needed") },
    })

    const scheduleId = "wake-1"
    const acceptedEvent: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_accepted",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      scheduledAt: Date.now() + 1_000,
      tz: "system",
      source: "agent_wakeup",
      resetAt: Date.now() + 1_000,
      detectedAt: Date.now(),
      prompt: "harvest the workflow results",
    }
    await store.appendAutoContinueEvent(acceptedEvent)

    await coordinator.fireAutoContinue("chat-1", scheduleId)

    const enqueued = store.queuedMessages.filter((m) => m.autoContinue?.scheduleId === scheduleId)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].content).toBe("harvest the workflow results")
  })
})

// ── AgentCoordinator: acceptAutoContinue / rescheduleAutoContinue / cancelAutoContinue / listLiveSchedules ──

// Minimal coordinator factory for Task 14 auto-continue tests; intentionally omits
// codexManager and generateTitle — do not use for tests that need provider flows.
function makeCoordinatorWithStore(extraStoreFields: Partial<ReturnType<typeof createFakeStore>> = {}) {
  const store = { ...createFakeStore(), ...extraStoreFields }
  const coordinator = new AgentCoordinator({
    store: store as never,
    onStateChange: () => {},
    getAutoResumePreference: () => false,
    startClaudeSession: async () => { throw new Error("not needed") },
  })
  return { store, coordinator }
}

describe("AgentCoordinator.acceptAutoContinue", () => {
  test("happy path: appends auto_continue_accepted with source 'user' for a proposed schedule", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    // Seed a proposed event
    const scheduleId = "sched-1"
    const proposedEvent: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    }
    store.autoContinueEvents.push(proposedEvent)

    const future = Date.now() + 60_000
    await coordinator.acceptAutoContinue("chat-1", scheduleId, future)

    const appended = store.autoContinueEvents.filter((e) => e.kind === "auto_continue_accepted")
    expect(appended).toHaveLength(1)
    expect(appended[0]!.kind).toBe("auto_continue_accepted")
    if (appended[0]!.kind === "auto_continue_accepted") {
      expect(appended[0]!.source).toBe("user")
      expect(appended[0]!.scheduledAt).toBe(future)
    }
  })

  test("guard: rejects when schedule state is not 'proposed'", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-cancel"
    // Seed a proposed + cancelled event so state = "cancelled"
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    })
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_cancelled",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      reason: "user",
    })

    await expect(
      coordinator.acceptAutoContinue("chat-1", scheduleId, Date.now() + 60_000)
    ).rejects.toThrow("Schedule not pending")
  })

  test("guard: rejects when scheduledAt is in the past (time guard)", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-past"
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    })

    await expect(
      coordinator.acceptAutoContinue("chat-1", scheduleId, Date.now() - 1)
    ).rejects.toThrow("scheduledAt must be in the future")
  })
})

describe("AgentCoordinator.rescheduleAutoContinue", () => {
  test("happy path: appends auto_continue_rescheduled for a scheduled schedule", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-sched"
    // Seed proposed + accepted = state "scheduled"
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    })
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_accepted",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      scheduledAt: Date.now() + 30_000,
      tz: "UTC",
      source: "user",
      resetAt: Date.now() + 10_000,
      detectedAt: Date.now(),
    })

    const newTime = Date.now() + 120_000
    await coordinator.rescheduleAutoContinue("chat-1", scheduleId, newTime)

    const appended = store.autoContinueEvents.filter((e) => e.kind === "auto_continue_rescheduled")
    expect(appended).toHaveLength(1)
    if (appended[0]!.kind === "auto_continue_rescheduled") {
      expect(appended[0]!.scheduledAt).toBe(newTime)
    }
  })

  test("guard: rejects when schedule state is not 'scheduled'", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-prop"
    // Proposed only = state "proposed"
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    })

    await expect(
      coordinator.rescheduleAutoContinue("chat-1", scheduleId, Date.now() + 60_000)
    ).rejects.toThrow("Schedule not active")
  })

  test("guard: rejects when scheduledAt is in the past (time guard)", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-ts"
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    })
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_accepted",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      scheduledAt: Date.now() + 30_000,
      tz: "UTC",
      source: "user",
      resetAt: Date.now() + 10_000,
      detectedAt: Date.now(),
    })

    await expect(
      coordinator.rescheduleAutoContinue("chat-1", scheduleId, Date.now() - 1)
    ).rejects.toThrow("scheduledAt must be in the future")
  })
})

describe("AgentCoordinator.cancelAutoContinue", () => {
  test("happy path: appends auto_continue_cancelled with given reason for a live schedule", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-live"
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,
      detectedAt: Date.now(),
      resetAt: Date.now() + 10_000,
      tz: "UTC",

    })

    await coordinator.cancelAutoContinue("chat-1", scheduleId, "user")

    const appended = store.autoContinueEvents.filter((e) => e.kind === "auto_continue_cancelled")
    expect(appended).toHaveLength(1)
    if (appended[0]!.kind === "auto_continue_cancelled") {
      expect(appended[0]!.reason).toBe("user")
    }
  })

  test("guard: silently no-ops when schedule state is outside proposed|scheduled (does not throw, no event appended)", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    const scheduleId = "sched-fired"
    // Seed a fired schedule
    store.autoContinueEvents.push({
      v: 3,
      kind: "auto_continue_fired",
      timestamp: Date.now(),
      chatId: "chat-1",
      scheduleId,

    })

    // Should not throw
    await coordinator.cancelAutoContinue("chat-1", scheduleId, "user")

    // No cancelled event appended
    const cancelled = store.autoContinueEvents.filter((e) => e.kind === "auto_continue_cancelled")
    expect(cancelled).toHaveLength(0)
  })
})

describe("AgentCoordinator.listLiveSchedules", () => {
  test("returns scheduleIds for proposed and scheduled states only", async () => {
    const { store, coordinator } = makeCoordinatorWithStore()
    // proposed
    store.autoContinueEvents.push({
      v: 3, kind: "auto_continue_proposed", timestamp: Date.now(),
      chatId: "chat-1", scheduleId: "sched-proposed",
      detectedAt: Date.now(), resetAt: Date.now() + 10_000, tz: "UTC",
    })
    // scheduled
    store.autoContinueEvents.push({
      v: 3, kind: "auto_continue_proposed", timestamp: Date.now(),
      chatId: "chat-1", scheduleId: "sched-scheduled",
      detectedAt: Date.now(), resetAt: Date.now() + 10_000, tz: "UTC",
    })
    store.autoContinueEvents.push({
      v: 3, kind: "auto_continue_accepted", timestamp: Date.now(),
      chatId: "chat-1", scheduleId: "sched-scheduled",
      scheduledAt: Date.now() + 30_000, tz: "UTC", source: "user",
      resetAt: Date.now() + 10_000, detectedAt: Date.now(),
    })
    // fired (should not appear)
    store.autoContinueEvents.push({
      v: 3, kind: "auto_continue_fired", timestamp: Date.now(),
      chatId: "chat-1", scheduleId: "sched-fired",
    })

    const live = coordinator.listLiveSchedules("chat-1")
    expect(live.sort()).toEqual(["sched-proposed", "sched-scheduled"].sort())
  })
})

describe("AgentCoordinator subagent mention gating", () => {
  function makeSubagentRecord(over: { id: string; name: string }) {
    return {
      id: over.id,
      name: over.name,
      provider: "claude" as const,
      model: "claude-opus-4-7",
      modelOptions: { reasoningEffort: "medium", contextWindow: "1m" } as never,
      systemPrompt: "test",
      contextScope: "previous-assistant-reply" as const,
      createdAt: 1,
      updatedAt: 1,
    }
  }

  test("delegateRun for unknown subagent emits UNKNOWN_SUBAGENT and never starts a primary turn", async () => {
    const store = createFakeStore()
    const startTurnCalls: unknown[] = []
    const fakeCodexManager = {
      async startSession() { startTurnCalls.push("session") },
      async startTurn(): Promise<HarnessTurn> { startTurnCalls.push("turn"); throw new Error("primary should not start") },
    }
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      getSubagents: () => [],
    })

    const outcome = await coordinator.getSubagentOrchestrator().delegateRun({
      chatId: "chat-1",
      parentUserMessageId: "umsg-1",
      parentRunId: null,
      parentSubagentId: null,
      ancestorSubagentIds: [],
      depth: 0,
      subagentId: "sa-missing",
      prompt: "ignored",
    })

    expect(outcome.status).toBe("failed")
    if (outcome.status !== "failed") throw new Error("unreachable")
    expect(outcome.errorCode).toBe("UNKNOWN_SUBAGENT")
    expect(startTurnCalls).toEqual([])
    const runs = Object.values(store.getSubagentRuns()) as Array<{ status: string; error: { code: string } | null }>
    expect(runs).toHaveLength(1)
    expect(runs[0].error?.code).toBe("UNKNOWN_SUBAGENT")
  })

  test("subagent AskUserQuestion forwards via subagent_tool_pending and respondSubagentTool resolves it", async () => {
    const store = createFakeStore()
    let toolRequestPromise: Promise<unknown> | null = null

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getSubagents: () => [makeSubagentRecord({ id: "sa-1", name: "alpha" })],
      getAppSettingsSnapshot: () => ({ claudeAuth: { authenticated: true } }),
      startClaudeSession: async (args) => {
        const toolRequest = {
          tool: {
            kind: "tool" as const,
            toolKind: "ask_user_question" as const,
            toolName: "AskUserQuestion",
            toolId: "t1",
            input: { questions: [{ id: "q1", question: "color?" }] },
            rawInput: { questions: [{ id: "q1", question: "color?" }] },
          },
        }
        // Capture the promise — do NOT await; stream will block until it resolves
        toolRequestPromise = args.onToolRequest(toolRequest)
        async function* stream() {
          const result = await toolRequestPromise!
          yield {
            type: "transcript" as const,
            entry: timestamped({ kind: "assistant_text", text: JSON.stringify(result) }),
          }
        }
        return {
          provider: "claude" as const,
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        }
      },
    })

    void coordinator.getSubagentOrchestrator().delegateRun({
      chatId: "chat-1",
      parentUserMessageId: "umsg-1",
      parentRunId: null,
      parentSubagentId: null,
      ancestorSubagentIds: [],
      depth: 0,
      subagentId: "sa-1",
      prompt: "go",
    })

    // Wait for the pending tool event to be appended by the orchestrator
    await waitFor(() => store.subagentEvents.some((e: any) => e.type === "subagent_tool_pending"))

    // The promise must still be pending (not yet resolved)
    let resolvedEarly = false
    void toolRequestPromise!.then(() => { resolvedEarly = true })
    await Promise.resolve() // flush microtasks
    expect(resolvedEarly).toBe(false)

    // Verify appendSubagentEvent was called with the correct pending event
    const pendingEvent = store.subagentEvents.find((e: any) => e.type === "subagent_tool_pending")
    expect(pendingEvent).toMatchObject({
      type: "subagent_tool_pending",
      chatId: "chat-1",
      toolUseId: "t1",
      toolKind: "ask_user_question",
      input: { questions: [{ id: "q1", question: "color?" }] },
    })

    // Get the runId from the run_started event (getSubagentRuns has it keyed by runId)
    const runId = Object.keys(store.getSubagentRuns())[0]
    expect(runId).toBeDefined()

    // Resolve via respondSubagentTool
    await coordinator.respondSubagentTool({
      type: "chat.respondSubagentTool",
      chatId: "chat-1",
      runId: runId!,
      toolUseId: "t1",
      result: { answers: { q1: ["red"] } },
    })

    const resolved = await toolRequestPromise!
    expect(resolved).toEqual({ answers: { q1: ["red"] } })

    await waitFor(() => Object.values(store.getSubagentRuns()).some((r: any) => r.status === "completed"))
    const runs = Object.values(store.getSubagentRuns()) as Array<{ status: string }>
    expect(runs[0]?.status).toBe("completed")
  }, 10_000)

  test("subagent ExitPlanMode forwards via subagent_tool_pending and respondSubagentTool resolves it", async () => {
    const store = createFakeStore()
    let toolRequestPromise: Promise<unknown> | null = null

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getSubagents: () => [makeSubagentRecord({ id: "sa-1", name: "alpha" })],
      getAppSettingsSnapshot: () => ({ claudeAuth: { authenticated: true } }),
      startClaudeSession: async (args) => {
        const toolRequest = {
          tool: {
            kind: "tool" as const,
            toolKind: "exit_plan_mode" as const,
            toolName: "ExitPlanMode",
            toolId: "t1",
            input: { plan: "do X" },
            rawInput: { plan: "do X" },
          },
        }
        // Capture the promise — do NOT await; stream will block until it resolves
        toolRequestPromise = args.onToolRequest(toolRequest)
        async function* stream() {
          const result = await toolRequestPromise!
          yield {
            type: "transcript" as const,
            entry: timestamped({ kind: "assistant_text", text: JSON.stringify(result) }),
          }
        }
        return {
          provider: "claude" as const,
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        }
      },
    })

    void coordinator.getSubagentOrchestrator().delegateRun({
      chatId: "chat-1",
      parentUserMessageId: "umsg-1",
      parentRunId: null,
      parentSubagentId: null,
      ancestorSubagentIds: [],
      depth: 0,
      subagentId: "sa-1",
      prompt: "go",
    })

    // Wait for the pending tool event to be appended by the orchestrator
    await waitFor(() => store.subagentEvents.some((e: any) => e.type === "subagent_tool_pending"))

    // The promise must still be pending (not yet resolved)
    let resolvedEarly = false
    void toolRequestPromise!.then(() => { resolvedEarly = true })
    await Promise.resolve() // flush microtasks
    expect(resolvedEarly).toBe(false)

    // Verify appendSubagentEvent was called with the correct pending event
    const pendingEvent = store.subagentEvents.find((e: any) => e.type === "subagent_tool_pending")
    expect(pendingEvent).toMatchObject({
      type: "subagent_tool_pending",
      chatId: "chat-1",
      toolUseId: "t1",
      toolKind: "exit_plan_mode",
      input: { plan: "do X" },
    })

    // Get the runId from the run_started event (getSubagentRuns has it keyed by runId)
    const runId = Object.keys(store.getSubagentRuns())[0]
    expect(runId).toBeDefined()

    // Resolve via respondSubagentTool with confirmed:true
    await coordinator.respondSubagentTool({
      type: "chat.respondSubagentTool",
      chatId: "chat-1",
      runId: runId!,
      toolUseId: "t1",
      result: { confirmed: true },
    })

    const resolved = await toolRequestPromise!
    expect(resolved).toEqual({ confirmed: true })

    await waitFor(() => Object.values(store.getSubagentRuns()).some((r: any) => r.status === "completed"))
    const runs = Object.values(store.getSubagentRuns()) as Array<{ status: string }>
    expect(runs[0]?.status).toBe("completed")
  }, 10_000)

  test("cancel(chatId) rejects pending subagent canUseTool Promises so the session does not hang", async () => {
    const store = createFakeStore()
    let toolRequestPromise: Promise<unknown> | null = null

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getSubagents: () => [makeSubagentRecord({ id: "sa-1", name: "alpha" })],
      getAppSettingsSnapshot: () => ({ claudeAuth: { authenticated: true } }),
      startClaudeSession: async (args) => {
        const toolRequest = {
          tool: {
            kind: "tool" as const,
            toolKind: "ask_user_question" as const,
            toolName: "AskUserQuestion",
            toolId: "t1",
            input: { questions: [{ id: "q1", question: "still there?" }] },
            rawInput: { questions: [{ id: "q1", question: "still there?" }] },
          },
        }
        toolRequestPromise = args.onToolRequest(toolRequest)
        async function* stream() {
          // Block until the resolver Promise settles (resolves OR rejects).
          // Without the cancel-rejection fix, this awaits forever and the
          // test times out instead of asserting the rejection.
          try {
            await toolRequestPromise!
          } catch {
            // Expected on cancel; surface as a result so the stream closes
            // cleanly and the harness can shut down.
          }
          yield { type: "transcript" as const, entry: timestamped({ kind: "result", subtype: "success" as const }) }
        }
        return {
          provider: "claude" as const,
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        }
      },
    })

    void coordinator.getSubagentOrchestrator().delegateRun({
      chatId: "chat-1",
      parentUserMessageId: "umsg-1",
      parentRunId: null,
      parentSubagentId: null,
      ancestorSubagentIds: [],
      depth: 0,
      subagentId: "sa-1",
      prompt: "go",
    })
    await waitFor(() => store.subagentEvents.some((e: any) => e.type === "subagent_tool_pending"))

    // Sanity: the Promise must be pending before cancel.
    let settledEarly = false
    void toolRequestPromise!.then(() => { settledEarly = true }, () => { settledEarly = true })
    await Promise.resolve()
    expect(settledEarly).toBe(false)

    // Cancel the chat. Without the fix this leaves the resolver in the map
    // forever and the SDK's canUseTool Promise hangs — wedging the session.
    await coordinator.cancel("chat-1")

    // The pending Promise must reject (or resolve to a sentinel) so the
    // SDK harness can unwind.
    await expect(toolRequestPromise!).rejects.toThrow()
  }, 10_000)

  test("respondSubagentTool is idempotent when no resolver is pending", async () => {
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      getSubagents: () => [],
      getAppSettingsSnapshot: () => ({ claudeAuth: { authenticated: true } }),
    })
    // No prior pending — must not throw.
    await coordinator.respondSubagentTool({
      type: "chat.respondSubagentTool",
      chatId: "chat-1",
      runId: "missing-run",
      toolUseId: "t1",
      result: { answers: {} },
    })
  })

  test("cancelSubagentRun aborts a running subagent and broadcasts state change", async () => {
    const store = createFakeStore()
    const emits: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: (chatId) => { if (chatId) emits.push(chatId) },
      getSubagents: () => [makeSubagentRecord({ id: "sa-1", name: "alpha" })],
      getAppSettingsSnapshot: () => ({ claudeAuth: { authenticated: true } }),
      startClaudeSession: async () => {
        async function* stream() {
          // Block indefinitely; the orchestrator's abort race resolves the
          // run via USER_CANCELLED once cancelSubagentRun fires.
          await new Promise<void>(() => {})
          yield { type: "transcript" as const, entry: timestamped({ kind: "result", subtype: "success" as const }) }
        }
        return {
          provider: "claude" as const,
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        }
      },
    })

    void coordinator.getSubagentOrchestrator().delegateRun({
      chatId: "chat-1",
      parentUserMessageId: "umsg-1",
      parentRunId: null,
      parentSubagentId: null,
      ancestorSubagentIds: [],
      depth: 0,
      subagentId: "sa-1",
      prompt: "go",
    })
    await waitFor(() => store.subagentEvents.some((e: any) => e.type === "subagent_run_started"))
    const runId = Object.keys(store.getSubagentRuns())[0]!

    await coordinator.cancelSubagentRun({
      type: "chat.cancelSubagentRun",
      chatId: "chat-1",
      runId,
    })
    await waitFor(() => store.subagentEvents.some((e: any) =>
      e.type === "subagent_run_failed" && e.runId === runId && e.error.code === "USER_CANCELLED",
    ))
    // emitStateChange fires from onRunTerminal hook.
    expect(emits).toContain("chat-1")
  }, 10_000)
})

// ── canUseTool routing tests ───────────────────────────────────────────────────

describe("buildCanUseTool", () => {
  test("flag off: AskUserQuestion uses legacy onToolRequest path", async () => {
    delete process.env.KANNA_MCP_TOOL_CALLBACKS

    let onToolRequestCallCount = 0
    let toolCallbackSubmitCallCount = 0

    const stubOnToolRequest = async (_req: any) => {
      onToolRequestCallCount++
      return { answers: { q1: "legacy-answer" } }
    }

    const stubToolCallback: ToolCallbackService = {
      submit: async () => {
        toolCallbackSubmitCallCount++
        return { status: "answered" as const, decision: { kind: "allow" as const, payload: { answers: { q1: "cb-answer" } } } }
      },
      answer: async () => {},
      cancel: async () => {},
      cancelAllForChat: async () => {},
      recoverOnStartup: async () => {},
    }

    const canUseTool = buildCanUseTool({
      localPath: "/tmp/test",
      chatId: "chat-1",
      sessionToken: "sess-1",
      onToolRequest: stubOnToolRequest,
      toolCallback: stubToolCallback,
    })

    const result = await canUseTool(
      "AskUserQuestion",
      { questions: [{ id: "q1", question: "What color?" }] },
      { toolUseID: "tool-use-1", signal: new AbortController().signal },
    )

    // Legacy path must be taken: onToolRequest called once, toolCallback NOT called
    expect(onToolRequestCallCount).toBe(1)
    expect(toolCallbackSubmitCallCount).toBe(0)
    expect(result.behavior).toBe("allow")
    if (result.behavior === "allow") {
      expect((result.updatedInput as any).answers).toEqual({ q1: "legacy-answer" })
    }
  })

  test("flag on + toolCallback present: AskUserQuestion routes through toolCallback.submit", async () => {
    process.env.KANNA_MCP_TOOL_CALLBACKS = "1"
    try {
      let onToolRequestCallCount = 0
      let toolCallbackSubmitCallCount = 0

      const stubOnToolRequest = async (_req: any) => {
        onToolRequestCallCount++
        return { answers: { q1: "legacy-answer" } }
      }

      const stubToolCallback: ToolCallbackService = {
        submit: async () => {
          toolCallbackSubmitCallCount++
          return {
            status: "answered" as const,
            decision: {
              kind: "answer" as const,
              payload: { questions: [{ id: "q1", question: "What color?" }], answers: { q1: ["blue"] } },
            },
          }
        },
        answer: async () => {},
        cancel: async () => {},
        cancelAllForChat: async () => {},
        recoverOnStartup: async () => {},
      }

      const canUseTool = buildCanUseTool({
        localPath: "/tmp/test",
        chatId: "chat-1",
        sessionToken: "sess-1",
        onToolRequest: stubOnToolRequest,
        toolCallback: stubToolCallback,
      })

      const result = await canUseTool(
        "AskUserQuestion",
        { questions: [{ id: "q1", question: "What color?" }] },
        { toolUseID: "tool-use-2", signal: new AbortController().signal },
      )

      // Flag-on path: toolCallback called once, legacy onToolRequest NOT called
      expect(toolCallbackSubmitCallCount).toBe(1)
      expect(onToolRequestCallCount).toBe(0)
      expect(result.behavior).toBe("allow")
      if (result.behavior === "allow") {
        expect((result.updatedInput as any).answers).toEqual({ q1: ["blue"] })
      }
    } finally {
      delete process.env.KANNA_MCP_TOOL_CALLBACKS
    }
  })

  test("flag on + toolCallback present: toolCallback deny returns deny behavior", async () => {
    process.env.KANNA_MCP_TOOL_CALLBACKS = "1"
    try {
      const stubToolCallback: ToolCallbackService = {
        submit: async () => ({
          status: "answered" as const,
          decision: { kind: "deny" as const, reason: "not allowed by policy" },
        }),
        answer: async () => {},
        cancel: async () => {},
        cancelAllForChat: async () => {},
        recoverOnStartup: async () => {},
      }

      const canUseTool = buildCanUseTool({
        localPath: "/tmp/test",
        chatId: "chat-1",
        sessionToken: "sess-1",
        onToolRequest: async () => ({}),
        toolCallback: stubToolCallback,
      })

      const result = await canUseTool(
        "AskUserQuestion",
        { questions: [{ id: "q1", question: "Proceed?" }] },
        { toolUseID: "tool-use-3", signal: new AbortController().signal },
      )

      expect(result.behavior).toBe("deny")
      if (result.behavior === "deny") {
        expect(result.message).toBe("not allowed by policy")
      }
    } finally {
      delete process.env.KANNA_MCP_TOOL_CALLBACKS
    }
  })

  test("flag on but toolCallback absent: falls back to legacy onToolRequest", async () => {
    process.env.KANNA_MCP_TOOL_CALLBACKS = "1"
    try {
      let onToolRequestCallCount = 0

      const canUseTool = buildCanUseTool({
        localPath: "/tmp/test",
        chatId: "chat-1",
        sessionToken: "sess-1",
        onToolRequest: async (_req: any) => {
          onToolRequestCallCount++
          return { answers: { q1: "fallback-answer" } }
        },
        // toolCallback intentionally omitted
      })

      await canUseTool(
        "AskUserQuestion",
        { questions: [{ id: "q1", question: "Hello?" }] },
        { toolUseID: "tool-use-4", signal: new AbortController().signal },
      )

      expect(onToolRequestCallCount).toBe(1)
    } finally {
      delete process.env.KANNA_MCP_TOOL_CALLBACKS
    }
  })

  test("non-AskUserQuestion tool is always allowed regardless of flag", async () => {
    process.env.KANNA_MCP_TOOL_CALLBACKS = "1"
    try {
      let onToolRequestCallCount = 0

      const canUseTool = buildCanUseTool({
        localPath: "/tmp/test",
        chatId: "chat-1",
        sessionToken: "sess-1",
        onToolRequest: async () => { onToolRequestCallCount++; return null },
      })

      const result = await canUseTool("Bash", { command: "ls" }, { toolUseID: "tool-use-5", signal: new AbortController().signal })

      expect(result.behavior).toBe("allow")
      expect(onToolRequestCallCount).toBe(0)
    } finally {
      delete process.env.KANNA_MCP_TOOL_CALLBACKS
    }
  })

  test("E2E: KANNA_MCP_TOOL_CALLBACKS=1 — AskUserQuestion routes through tool-callback and SDK receives updated input via answer", async () => {
    process.env.KANNA_MCP_TOOL_CALLBACKS = "1"
    try {
      // Real EventStore + real ToolCallbackService + real buildCanUseTool.
      const tempDir = await mkdtemp(path.join(tmpdir(), "kanna-e2e-"))
      const store = new EventStore(tempDir)
      await store.initialize()
      const svc = createToolCallbackService({
        store,
        serverSecret: "e2e-secret",
        now: () => 1_000,
      })

      const canUseTool = buildCanUseTool({
        localPath: "/tmp/project",
        chatId: "c-1",
        sessionToken: "s-1",
        // Legacy callback should NOT fire on flag-on path.
        onToolRequest: async () => { throw new Error("legacy path called unexpectedly") },
        toolCallback: svc,
        chatPolicy: POLICY_DEFAULT,
      })

      const askUserQuestionInput = {
        questions: [{
          text: "Pick option",
          header: "Pick",
          options: [
            { label: "a", description: "" },
            { label: "b", description: "" },
          ],
          multiSelect: false,
        }],
      }

      // Kick off the canUseTool call (pending, awaits external answer).
      const resultPromise = canUseTool("AskUserQuestion", askUserQuestionInput, {
        toolUseID: "tu-e2e",
        suggestions: [],
        signal: new AbortController().signal,
      } as any)

      // Find the pending record and answer it.
      const pending = store.listPendingToolRequests("c-1")
      expect(pending).toHaveLength(1)
      await svc.answer(pending[0].id, {
        kind: "answer",
        payload: { answers: { "Pick option": "a" } },
      })

      const result = await resultPromise
      expect(result.behavior).toBe("allow")
      const updatedInput = (result as Extract<typeof result, { behavior: "allow" }>).updatedInput as Record<string, unknown>
      expect(updatedInput.answers).toEqual({ "Pick option": "a" })

      await rm(tempDir, { recursive: true, force: true })
    } finally {
      delete process.env.KANNA_MCP_TOOL_CALLBACKS
    }
  })
})

// ── AgentCoordinator.chatPolicy plumbing ──────────────────────────────────────

describe("AgentCoordinator chatPolicy plumbing", () => {
  test("plumbs chatPolicy through to startClaudeSession", async () => {
    const events = new AsyncEventQueue<any>()
    let received: any = null

    const customPolicy: ChatPermissionPolicy = {
      ...POLICY_DEFAULT,
      defaultAction: "auto-deny",
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      chatPolicy: customPolicy,
      startClaudeSession: async (args) => {
        received = args
        return {
          provider: "claude" as const,
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
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
          setModel: async () => {},
          setPermissionMode: async () => {},
          getSupportedCommands: async () => [],
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "hello",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(received?.chatPolicy?.defaultAction).toBe("auto-deny")

    events.close()
  })
})

// ── AgentCoordinator PTY driver selection ──────────────────────────────────────

describe("AgentCoordinator PTY driver selection", () => {
  test("AgentCoordinator selects PTY driver when KANNA_CLAUDE_DRIVER=pty", async () => {
    process.env.KANNA_CLAUDE_DRIVER = "pty"
    try {
      const events = new AsyncEventQueue<any>()
      let sdkCalls = 0
      let ptyCalls = 0

      const fakeSession = {
        provider: "claude" as const,
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
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
        setModel: async () => {},
        setPermissionMode: async () => {},
        getSupportedCommands: async () => [],
      }

      const store = createFakeStore()
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        startClaudeSession: async (_args) => {
          sdkCalls++
          return fakeSession
        },
        startClaudeSessionPTY: async (_args) => {
          ptyCalls++
          return fakeSession
        },
      })

      await coordinator.send({
        type: "chat.send",
        chatId: "chat-1",
        provider: "claude",
        content: "hello",
        model: "claude-opus-4-1",
      })
      await waitFor(() => store.turnFinishedCount === 1)

      expect(ptyCalls).toBe(1)
      expect(sdkCalls).toBe(0)

      events.close()
    } finally {
      delete process.env.KANNA_CLAUDE_DRIVER
    }
  })
})

// ── Late tool request (SDK self-resume) regression ─────────────────────────────

describe("AgentCoordinator late tool request", () => {
  test("onToolRequest fired after result event re-promotes activeTurn instead of throwing", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    let capturedOnToolRequest: ((request: any) => Promise<unknown>) | null = null

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        capturedOnToolRequest = args.onToolRequest
        return {
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
                model: "claude-opus-4-7",
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
                durationMs: 100,
                result: "",
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
      content: "hello",
      model: "claude-opus-4-7",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(coordinator.activeTurns.has("chat-1")).toBe(false)
    expect(capturedOnToolRequest).not.toBeNull()

    const lateRequest = {
      tool: {
        kind: "tool" as const,
        toolKind: "ask_user_question" as const,
        toolName: "AskUserQuestion",
        toolId: "t-late",
        input: {
          questions: [
            {
              text: "Merge?",
              header: "merge",
              options: [
                { label: "yes", description: "merge it" },
                { label: "no", description: "hold" },
              ],
              multiSelect: false,
            },
          ],
        },
        rawInput: {
          questions: [
            {
              text: "Merge?",
              header: "merge",
              options: [
                { label: "yes", description: "merge it" },
                { label: "no", description: "hold" },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    }

    const lateRequestPromise = capturedOnToolRequest!(lateRequest)
    let rejected = false
    void lateRequestPromise.catch(() => {
      rejected = true
    })

    await waitFor(() => coordinator.activeTurns.get("chat-1")?.pendingTool?.toolUseId === "t-late")
    expect(rejected).toBe(false)
    expect(coordinator.activeTurns.get("chat-1")?.status).toBe("waiting_for_user")

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "t-late",
      result: { answers: { 0: ["yes"] } },
    })

    const resolved = await lateRequestPromise
    expect(resolved).toEqual({ answers: { 0: ["yes"] } })

    events.close()
  })
})

describe("AgentCoordinator turn-start failure recording", () => {
  test("records turn_failed and clears activeTurn when startClaudeSession throws", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    const consoleError = console.error
    console.error = () => {}
    try {
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        startClaudeSession: async () => {
          throw new Error("simulated spawn failure")
        },
      })

      await expect(
        coordinator.send({
          type: "chat.send",
          chatId: "chat-1",
          provider: "claude",
          content: "hi",
        }),
      ).rejects.toThrow(/simulated spawn failure/)

      expect(store.turnFailedCount).toBe(1)
      expect(store.turnFailures[0]?.chatId).toBe("chat-1")
      expect(store.turnFailures[0]?.reason).toContain("simulated spawn failure")
      expect(store.messages[0]?.kind).toBe("user_prompt")
    } finally {
      console.error = consoleError
    }
  })
})

describe("buildUserMcpServers", () => {
  test("maps stdio entry to SDK shape", () => {
    const cfg: McpServerConfig = {
      id: "1", name: "fs", enabled: true,
      createdAt: "", updatedAt: "", lastTest: { status: "untested" },
      transport: "stdio", command: "/bin/ls", args: [], env: { A: "1" },
    }
    expect(buildUserMcpServers([cfg])).toEqual({
      fs: { type: "stdio", command: "/bin/ls", args: [], env: { A: "1" } },
    })
  })

  test("stdio with cwd includes cwd", () => {
    const cfg: McpServerConfig = {
      id: "1", name: "fs", enabled: true,
      createdAt: "", updatedAt: "", lastTest: { status: "untested" },
      transport: "stdio", command: "/bin/ls", args: [], env: {}, cwd: "/tmp",
    }
    expect(buildUserMcpServers([cfg]).fs).toMatchObject({ cwd: "/tmp" })
  })

  test("maps http entry", () => {
    const cfg: McpServerConfig = {
      id: "1", name: "remote", enabled: true,
      createdAt: "", updatedAt: "", lastTest: { status: "untested" },
      transport: "http", url: "https://example.com/mcp", headers: { K: "v" },
    }
    expect(buildUserMcpServers([cfg]).remote).toEqual({
      type: "http", url: "https://example.com/mcp", headers: { K: "v" },
    })
  })

  test("maps sse and ws entries", () => {
    const cfgs: McpServerConfig[] = [
      { id: "s", name: "events", enabled: true, createdAt: "", updatedAt: "", lastTest: { status: "untested" },
        transport: "sse", url: "https://e.com/sse", headers: {} },
      { id: "w", name: "wsx", enabled: true, createdAt: "", updatedAt: "", lastTest: { status: "untested" },
        transport: "ws", url: "wss://e.com/ws", headers: {} },
    ]
    const out = buildUserMcpServers(cfgs)
    expect(out.events.type).toBe("sse")
    expect(out.wsx.type).toBe("ws")
  })

  test("filters disabled entries", () => {
    const cfg: McpServerConfig = {
      id: "1", name: "fs", enabled: false,
      createdAt: "", updatedAt: "", lastTest: { status: "untested" },
      transport: "stdio", command: "x", args: [], env: {},
    }
    expect(buildUserMcpServers([cfg])).toEqual({})
  })

  test("filters 'kanna' name collision", () => {
    const cfg: McpServerConfig = {
      id: "1", name: "kanna", enabled: true,
      createdAt: "", updatedAt: "", lastTest: { status: "untested" },
      transport: "stdio", command: "x", args: [], env: {},
    }
    expect(buildUserMcpServers([cfg])).toEqual({})
  })
})

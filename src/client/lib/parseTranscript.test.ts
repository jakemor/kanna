import { describe, expect, test } from "bun:test"
import { processTranscriptMessages } from "./parseTranscript"
import { getLatestToolIds } from "../app/derived"
import type { TranscriptEntry } from "../../shared/types"

function entry(partial: Omit<TranscriptEntry, "_id" | "createdAt">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...partial,
  } as TranscriptEntry
}

describe("processTranscriptMessages", () => {
  test("hydrates tool results onto prior tool calls", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: "/Users/jake/Projects/kanna\n",
      }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toBe("/Users/jake/Projects/kanna\n")
  })

  test("hydrates ask-user-question results with typed answers", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-2",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("hydrates discarded prompt tool results", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-3",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { discarded: true },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ discarded: true })
  })

  test("preserves attachments on hydrated user prompts", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "user_prompt",
        content: "Please inspect these.",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec.pdf",
          absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
          relativePath: "./.kanna/uploads/spec.pdf",
          contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
          mimeType: "application/pdf",
          size: 1234,
        }],
      }),
    ])

    expect(messages[0]?.kind).toBe("user_prompt")
    if (messages[0]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[0].attachments).toHaveLength(1)
    expect(messages[0].attachments?.[0]?.relativePath).toBe("./.kanna/uploads/spec.pdf")
  })

  test("preserves context window update entries", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "context_window_updated",
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          compactsAutomatically: true,
        },
      }),
    ])

    expect(messages[0]?.kind).toBe("context_window_updated")
    if (messages[0]?.kind !== "context_window_updated") throw new Error("unexpected message")
    expect(messages[0].usage.maxTokens).toBe(258_400)
    expect(messages[0].usage.compactsAutomatically).toBe(true)
  })

  test("hydrates session_restored boundaries with their provider", () => {
    const messages = processTranscriptMessages([
      entry({ kind: "session_restored", provider: "claude" }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("session_restored")
    if (messages[0]?.kind !== "session_restored") throw new Error("unexpected message")
    expect(messages[0].provider).toBe("claude")
  })

  test("preserves structured Claude ask-user-question results when a later echoed tool result arrives", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-3",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: "User has answered your questions: \"Provider?\"=\"Codex\".",
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: {
            questions: [{ question: "Provider?" }],
            answers: { "Provider?": "Codex" },
          },
        }),
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  // debugRaw format compatibility: the server now stamps debugRaw only on
  // system_init and tool_result entries (agent.ts), but transcripts written
  // before that trim stamp it on every entry. Both must hydrate identically.
  test("hydrates trimmed-format and legacy fully-stamped transcripts identically", () => {
    // `resultEntryId` points at the tool_result entry, whose `_id` is
    // generated per fixture, so it varies between the two shapes by design.
    const stripIds = (messages: ReturnType<typeof processTranscriptMessages>) =>
      messages.map(({ id, timestamp, ...rest }) => {
        const { resultEntryId, ...withoutResultEntryId } = rest as typeof rest & { resultEntryId?: string }
        return withoutResultEntryId
      })

    const baseEntries: Array<Omit<TranscriptEntry, "_id" | "createdAt">> = [
      {
        kind: "system_init",
        provider: "claude",
        model: "claude-opus-4-8",
        tools: ["Bash"],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        debugRaw: JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" }),
      },
      { kind: "assistant_text", text: "On it." },
      {
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-9",
          input: { plan: "## Plan" },
        },
      },
      {
        kind: "tool_result",
        toolId: "tool-9",
        content: "User approved the plan.",
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: { plan: "## Plan", isAgent: false },
        }),
      },
      { kind: "result", subtype: "success", isError: false, durationMs: 12, result: "done" },
    ] as never

    // Legacy format: every entry carries debugRaw (the full raw SDK message).
    const legacyEntries = baseEntries.map((partial) => entry({
      ...partial,
      debugRaw: (partial as { debugRaw?: string }).debugRaw ?? JSON.stringify({ type: "legacy-noise", kind: partial.kind }),
    } as never))
    // Trimmed format: only system_init and tool_result carry debugRaw.
    const trimmedEntries = baseEntries.map((partial) => entry(partial))

    const legacyMessages = processTranscriptMessages(legacyEntries)
    const trimmedMessages = processTranscriptMessages(trimmedEntries)

    expect(stripIds(trimmedMessages)).toEqual(stripIds(legacyMessages))

    // The exit-plan tool result must be extracted from debugRaw's
    // tool_use_result in both formats.
    const toolMessage = trimmedMessages.find((message) => message.kind === "tool")
    if (toolMessage?.kind !== "tool") throw new Error("unexpected message")
    expect(toolMessage.rawResult).toEqual({ plan: "## Plan", isAgent: false })

    // The first system message keeps its raw JSON view in both formats.
    const systemMessage = trimmedMessages.find((message) => message.kind === "system_init")
    if (systemMessage?.kind !== "system_init") throw new Error("unexpected message")
    expect(systemMessage.debugRaw).toBe(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" }))
  })

  test("falls back to the tool result content when debugRaw is absent or unparseable", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-4",
          input: { questions: [{ question: "Provider?" }] },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-4",
        content: { answers: { "Provider?": ["Claude"] } },
        debugRaw: "{not json",
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Claude"] } })
  })
})

describe("processTranscriptMessages subagents", () => {
  const agentCall = (toolId: string) => entry({
    kind: "tool_call",
    tool: { kind: "tool", toolKind: "subagent_task", toolName: "Agent", toolId, input: { subagentType: "Explore" } },
  })
  const childCall = (toolId: string, parentToolUseId: string) => entry({
    kind: "tool_call",
    parentToolUseId,
    tool: { kind: "tool", toolKind: "grep", toolName: "Grep", toolId, input: { pattern: "x" } },
  })
  const childText = (text: string, parentToolUseId: string) => entry({ kind: "assistant_text", text, parentToolUseId })
  const agentRow = (messages: ReturnType<typeof processTranscriptMessages>, index = 0) => {
    const message = messages[index]
    if (message?.kind !== "tool" || message.toolKind !== "subagent_task") throw new Error("unexpected message")
    return message
  }

  test("folds a subagent's entries under its Agent row instead of the main list", () => {
    const messages = processTranscriptMessages([
      agentCall("agent-1"),
      // A background agent's result lands before its work does.
      entry({ kind: "tool_result", toolId: "agent-1", content: "running in background" }),
      childText("Exploring.", "agent-1"),
      childCall("grep-1", "agent-1"),
      entry({ kind: "tool_result", toolId: "grep-1", content: "found", parentToolUseId: "agent-1" }),
      childText("Findings.", "agent-1"),
      entry({ kind: "assistant_text", text: "The agent found it." }),
    ])

    expect(messages.map((message) => message.kind)).toEqual(["tool", "assistant_text"])
    const agent = agentRow(messages)
    expect(agent.result).toBe("running in background")
    expect(agent.children?.map((child) => child.kind)).toEqual(["assistant_text", "tool", "assistant_text"])
    const grep = agent.children?.[1]
    if (grep?.kind !== "tool") throw new Error("unexpected child")
    expect(grep.result).toBe("found")
    expect(grep.resultEntryId).toBeDefined()
  })

  test("an entry whose parent is not in the window stays inline", () => {
    const messages = processTranscriptMessages([
      childText("orphan", "agent-missing"),
      childCall("grep-1", "agent-missing"),
      entry({ kind: "tool_result", toolId: "grep-1", content: "found", parentToolUseId: "agent-missing" }),
    ])

    expect(messages.map((message) => message.kind)).toEqual(["assistant_text", "tool"])
    if (messages[1]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[1].result).toBe("found")
  })

  test("an appended child replaces the parent with a copy and reuses the rest", () => {
    const first = [entry({ kind: "assistant_text", text: "a" }), agentCall("agent-1"), childCall("grep-1", "agent-1")]
    const previous = processTranscriptMessages(first)
    const parentBefore = agentRow(previous, 1)
    const grepBefore = parentBefore.children?.[0]

    const next = processTranscriptMessages(
      [...first, entry({ kind: "tool_result", toolId: "grep-1", content: "found", parentToolUseId: "agent-1" })],
      previous,
    )

    expect(next).toHaveLength(2)
    expect(next[0]).toBe(previous[0])
    const parentAfter = agentRow(next, 1)
    expect(parentAfter).not.toBe(parentBefore)
    expect(parentAfter.children?.[0]).not.toBe(grepBefore)
    if (grepBefore?.kind !== "tool") throw new Error("unexpected child")
    expect(grepBefore.result).toBeUndefined()
    expect(parentBefore.children).toHaveLength(1)
  })
})

describe("getLatestToolIds", () => {
  test("returns the latest unresolved special tool ids", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "tool-2",
          input: {
            todos: [{ content: "Implement adapter", status: "in_progress", activeForm: "Implementing adapter" }],
          },
        },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: messages[0]?.kind === "tool" ? messages[0].id : null,
      ExitPlanMode: null,
      TodoWrite: messages[1]?.kind === "tool" ? messages[1].id : null,
    })
  })

  test("ignores discarded special tools when choosing the latest active id", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: { discarded: true, answers: {} },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-2",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { discarded: true },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: null,
      ExitPlanMode: null,
      TodoWrite: null,
    })
  })
})

describe("trimmed tool payloads", () => {
  const toolCall = (overrides: Record<string, unknown> = {}) => ({
    _id: "call-1",
    createdAt: 1,
    kind: "tool_call",
    tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "tid-1", input: { command: "ls" } },
    ...overrides,
  }) as unknown as TranscriptEntry

  const toolResult = (overrides: Record<string, unknown> = {}) => ({
    _id: "result-1",
    createdAt: 2,
    kind: "tool_result",
    toolId: "tid-1",
    ...overrides,
  }) as unknown as TranscriptEntry

  const toolRowOf = (entries: TranscriptEntry[]) =>
    processTranscriptMessages(entries).find((message) => message.kind === "tool") as
      | (Extract<ReturnType<typeof processTranscriptMessages>[number], { kind: "tool" }>)
      | undefined

  test("a trimmed result still marks the call finished", () => {
    const row = toolRowOf([toolCall(), toolResult({ trimmed: true, isError: false })])

    // Finishedness is the arrival of a result entry, not of its body.
    expect(row?.resultEntryId).toBe("result-1")
    expect(row?.resultTrimmed).toBe(true)
    expect(row?.isError).toBe(false)
  })

  test("a result carries its own stamp beside the call's, trimmed or not", () => {
    const row = toolRowOf([toolCall({ createdAt: 1_000 }), toolResult({ createdAt: 4_200, trimmed: true })])
    expect(row?.timestamp).toBe(new Date(1_000).toISOString())
    expect(row?.resultTimestamp).toBe(new Date(4_200).toISOString())
    expect(toolRowOf([toolCall()])?.resultTimestamp).toBeUndefined()
  })

  test("a trimmed result is not hydrated from an absent body", () => {
    const row = toolRowOf([toolCall(), toolResult({ trimmed: true })])

    expect(row?.result).toBeUndefined()
    expect(row?.rawResult).toBeUndefined()
  })

  test("an untrimmed result hydrates exactly as before", () => {
    const row = toolRowOf([toolCall(), toolResult({ content: "output" })])

    expect(row?.rawResult).toBe("output")
    expect(row?.resultTrimmed).toBeUndefined()
  })

  test("a trimmed call is flagged so the expanded view knows to fetch", () => {
    const row = toolRowOf([toolCall({ trimmed: true }), toolResult({ content: "out" })])

    expect(row?.inputTrimmed).toBe(true)
  })

  test("entries with nothing trimmed carry no flags", () => {
    const row = toolRowOf([toolCall(), toolResult({ content: "out" })])

    expect(row?.inputTrimmed).toBeUndefined()
    expect(row?.resultTrimmed).toBeUndefined()
  })
})

describe("processTranscriptMessages incremental", () => {
  const toolCall = (toolId: string) => entry({
    kind: "tool_call",
    tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId, input: { command: "pwd" } },
  })
  const text = (value: string) => entry({ kind: "assistant_text", text: value })

  test("reuses hydrated messages for the entries it already consumed", () => {
    const first = [text("a"), toolCall("tool-1")]
    const previous = processTranscriptMessages(first)
    const next = processTranscriptMessages([...first, text("b")], previous)

    expect(next).toHaveLength(3)
    expect(next[0]).toBe(previous[0])
    expect(next[1]).toBe(previous[1])
    expect(next[2]?.kind).toBe("assistant_text")
    expect(previous).toHaveLength(2)
  })

  test("returns the previous array when nothing was appended", () => {
    const entries = [text("a")]
    const previous = processTranscriptMessages(entries)
    expect(processTranscriptMessages(entries, previous)).toBe(previous)
  })

  test("a late tool result replaces the call with a copy instead of mutating it", () => {
    const call = toolCall("tool-1")
    const previous = processTranscriptMessages([call])
    const before = previous[0]
    const next = processTranscriptMessages(
      [call, entry({ kind: "tool_result", toolId: "tool-1", content: "/tmp\n" })],
      previous,
    )

    expect(next).toHaveLength(1)
    expect(next[0]).not.toBe(before)
    if (next[0]?.kind !== "tool" || before?.kind !== "tool") throw new Error("unexpected message")
    expect(next[0].result).toBe("/tmp\n")
    expect(before.result).toBeUndefined()
  })

  test("rebuilds when the entries are not a pure append", () => {
    const shared = text("a")
    const previous = processTranscriptMessages([shared, text("optimistic")])
    const next = processTranscriptMessages([shared, text("server"), text("c")], previous)

    expect(next).toHaveLength(3)
    expect(next[0]).not.toBe(previous[0])
    expect(next.map((message) => message.kind === "assistant_text" ? message.text : "")).toEqual(["a", "server", "c"])
  })
})

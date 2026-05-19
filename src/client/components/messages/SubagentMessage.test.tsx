import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SubagentRunSnapshot, TranscriptEntry } from "../../../shared/types"
import { renderForLoopCheck } from "../../lib/testing/renderForLoopCheck"
import { SubagentMessage } from "./SubagentMessage"

function makeRunSnapshot(over: Partial<SubagentRunSnapshot> = {}): SubagentRunSnapshot {
  return {
    runId: "r1",
    chatId: "c1",
    subagentId: "sa-1",
    subagentName: "alpha",
    provider: "claude",
    model: "claude-opus-4-7",
    status: "running",
    parentUserMessageId: "u1",
    parentRunId: null,
    depth: 0,
    startedAt: 1,
    finishedAt: null,
    finalText: null,
    error: null,
    usage: null,
    entries: [],
    pendingTool: null,
    ...over,
  }
}

describe("SubagentMessage", () => {
  test("renders streaming chunks while running with partial text entry", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            { _id: "e1", createdAt: 1, kind: "assistant_text", text: "Partial output so far" } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("Partial output so far")
    expect(html).toContain("streaming...")
  })

  test("shows 'running...' (no caret) before any chunk arrives", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage run={makeRunSnapshot({ status: "running", finalText: null })} indentDepth={0} localPath="/tmp" />,
    )
    expect(html).toContain("running...")
    expect(html).not.toContain("▍")
  })

  test("after completion the caret disappears and streaming label is gone", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "completed", finalText: "Done.", finishedAt: 2, entries: [] })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).not.toContain("streaming")
    expect(html).not.toContain("running...")
    expect(html).not.toContain("▍")
    expect(html).toContain("Done.")
  })

  test("indentDepth controls left margin", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "completed", finalText: "child", depth: 1 })}
        indentDepth={2}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("margin-left:48px")
  })

  test("renders error card for failed run", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "failed", finalText: null, error: { code: "TIMEOUT", message: "too slow" } })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("data-testid=\"subagent-error:r1\"")
    expect(html).toContain("too slow")
  })

  test("renders assistant_text entries via TextMessage", () => {
    const run = makeRunSnapshot({
      status: "completed",
      finalText: "Hello world",
      entries: [
        { _id: "e1", createdAt: 1, kind: "assistant_text", text: "Hello" } as TranscriptEntry,
        { _id: "e2", createdAt: 2, kind: "assistant_text", text: "world" } as TranscriptEntry,
      ],
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    expect(html).toContain("Hello")
    expect(html).toContain("world")
  })

  test("renders tool_call entries as ToolCallMessage", () => {
    const run = makeRunSnapshot({
      status: "completed",
      entries: [
        {
          _id: "e1",
          createdAt: 1,
          kind: "tool_call",
          tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
        },
        { _id: "e2", createdAt: 2, kind: "tool_result", toolId: "t1", content: "f.txt", isError: false },
      ] as TranscriptEntry[],
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    // ToolCallMessage renders the bash command as the label; the terminal icon also appears
    expect(html).toContain("lucide-terminal")
    expect(html).toContain("ls")
  })

  test("pending tool_call (no result yet) shows shiny loading state while run is running", () => {
    const run = makeRunSnapshot({
      status: "running",
      entries: [
        {
          _id: "e1",
          createdAt: 1,
          kind: "tool_call",
          tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
        },
      ] as TranscriptEntry[],
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    // AnimatedShinyText activates only when isLoading=true AND no result — class applied via animate prop
    expect(html).toContain("animate-shiny-pulse")
  })

  test("resolved tool_call does NOT show shiny loading state even while running", () => {
    const run = makeRunSnapshot({
      status: "running",
      entries: [
        {
          _id: "e1",
          createdAt: 1,
          kind: "tool_call",
          tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
        },
        { _id: "e2", createdAt: 2, kind: "tool_result", toolId: "t1", content: "f.txt", isError: false },
      ] as TranscriptEntry[],
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    expect(html).not.toContain("animate-shiny-pulse")
  })

  test("each subagent row gets fade-in animation wrapper", () => {
    const run = makeRunSnapshot({
      status: "completed",
      entries: [
        { _id: "e1", createdAt: 1, kind: "assistant_text", text: "hi" },
      ] as TranscriptEntry[],
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    expect(html).toContain("animate-in")
    expect(html).toContain("fade-in-0")
  })

  test("renders token usage badge when run.usage present", () => {
    const run = makeRunSnapshot({
      status: "completed",
      finalText: "ok",
      usage: { inputTokens: 100, outputTokens: 7 },
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    expect(html).toContain("100↑ 7↓")
  })

  test("falls back to finalText when entries is empty (legacy run)", () => {
    const run = makeRunSnapshot({
      status: "completed",
      finalText: "Legacy text only",
      entries: [],
    })
    const html = renderToStaticMarkup(<SubagentMessage run={run} indentDepth={0} localPath="/tmp" />)
    expect(html).toContain("Legacy text only")
  })

  test("renders AskUserQuestion pending card when pendingTool is set", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          pendingTool: {
            toolUseId: "t1",
            toolKind: "ask_user_question",
            input: {
              questions: [
                { id: "q1", question: "Confirm?", header: "Confirm", multiSelect: false, options: [{ label: "yes" }, { label: "no" }] },
              ],
            },
            requestedAt: 1700000000000,
          },
        })}
        indentDepth={0}
        localPath="/tmp"
        onSubagentAskUserQuestionSubmit={() => undefined}
        onSubagentExitPlanModeSubmit={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="subagent-pending-tool:t1"')
    expect(html).toContain("awaiting your response")
    expect(html).toContain("Confirm?")
  })

  test("renders ExitPlanMode pending card when pendingTool is set", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          pendingTool: {
            toolUseId: "t2",
            toolKind: "exit_plan_mode",
            input: { plan: "Step 1: do thing" },
            requestedAt: 1700000000000,
          },
        })}
        indentDepth={0}
        localPath="/tmp"
        onSubagentAskUserQuestionSubmit={() => undefined}
        onSubagentExitPlanModeSubmit={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="subagent-pending-tool:t2"')
    expect(html).toContain("Step 1: do thing")
  })

  test("renders persisted tool_result with View Full Output link", () => {
    // processTranscriptMessages folds tool_result INTO the preceding tool_call,
    // propagating `persisted` onto the hydrated tool message. Test the same
    // pairing the real flow produces.
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          entries: [
            {
              _id: "call-1",
              createdAt: 0,
              kind: "tool_call",
              messageId: "m1",
              tool: {
                kind: "tool",
                toolKind: "bash",
                toolName: "Bash",
                toolId: "tool-big",
                input: { command: "find /" },
              },
            } as TranscriptEntry,
            {
              _id: "e1",
              createdAt: 0,
              kind: "tool_result",
              toolId: "tool-big",
              content: "<persisted-output>\nOutput too large (60 KB)…\n</persisted-output>",
              persisted: {
                filePath: "/tmp/foo.txt",
                originalSize: 60_000,
                isJson: false,
                truncated: true,
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
        onSubagentAskUserQuestionSubmit={() => undefined}
        onSubagentExitPlanModeSubmit={() => undefined}
      />,
    )
    expect(html).toContain("output too large")
    expect(html).toContain("View full output")
    expect(html).toContain("/tmp/foo.txt")
  })

  test("renders X button while running with correct testid + aria-label", () => {
    // Static markup can't simulate clicks; dispatch path is covered
    // end-to-end by agent.test.ts cancelSubagentRun routing test.
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "running", runId: "r-running", chatId: "c1" })}
        indentDepth={0}
        localPath="/tmp"
        onCancelSubagentRun={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="subagent-cancel:r-running"')
    expect(html).toContain('aria-label="Cancel subagent"')
  })

  test("does not render X button when status is not running", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "completed", finalText: "done" })}
        indentDepth={0}
        localPath="/tmp"
        onCancelSubagentRun={() => undefined}
      />,
    )
    expect(html).not.toContain("subagent-cancel:")
  })

  test("does not render X button when onCancelSubagentRun is not provided", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "running", runId: "r-running" })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).not.toContain("subagent-cancel:")
  })

  test("activity label shows '$ <cmd-title>' when latest tool_call is bash with command", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls -la" } },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("$ ls -la")
  })

  test("activity label prefers bash description over command", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "bash",
                toolName: "Bash",
                toolId: "t1",
                input: { command: "ls -la", description: "List files" },
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("$ List files")
  })

  test("activity label falls back to 'running bash...' when command missing", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "" } },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("running bash...")
  })

  test("activity label falls back to 'streaming...' once tool_call is resolved and text streams", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t1", input: { filePath: "/tmp/foo.ts" } },
            } as TranscriptEntry,
            { _id: "e2", createdAt: 2, kind: "tool_result", toolId: "t1", content: "ok" } as TranscriptEntry,
            { _id: "e3", createdAt: 3, kind: "assistant_text", text: "hi" } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("streaming...")
    expect(html).not.toContain("reading ")
  })

  test("activity label shows 'reading <stripped-path>' for read_file tool_call", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "read_file",
                toolName: "Read",
                toolId: "t1",
                input: { filePath: "/tmp/src/foo.ts" },
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("reading src/foo.ts")
  })

  test("activity label shows 'editing <stripped-path>' for edit_file tool_call", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "edit_file",
                toolName: "Edit",
                toolId: "t1",
                input: { filePath: "/tmp/src/bar.ts", oldString: "a", newString: "b" },
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("editing src/bar.ts")
  })

  test("activity label shows 'grepping <pattern>' for grep tool_call", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "grep",
                toolName: "Grep",
                toolId: "t1",
                input: { pattern: "TODO" },
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("grepping TODO")
  })

  test("activity label shows 'globbing <pattern>' for glob tool_call", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "glob",
                toolName: "Glob",
                toolId: "t1",
                input: { pattern: "**/*.ts" },
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("globbing **/*.ts")
  })

  test("activity label shows '<server>.<tool>' for mcp_generic tool_call", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "mcp_generic",
                toolName: "mcp__kanna__expose_port",
                toolId: "t1",
                input: { server: "kanna", tool: "expose_port", payload: {} },
              },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("kanna.expose_port")
  })

  test("activity label truncates long paths with ellipsis", () => {
    const longPath = "/tmp/very/deeply/nested/directory/structure/with/many/segments/file.ts"
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          entries: [
            {
              _id: "e1",
              createdAt: 1,
              kind: "tool_call",
              tool: { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t1", input: { filePath: longPath } },
            } as TranscriptEntry,
          ],
        })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain("reading ")
    expect(html).toContain("…")
  })

  test("activity label shows 'waiting for input...' when pendingTool is set", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({
          status: "running",
          pendingTool: {
            toolUseId: "t1",
            toolKind: "ask_user_question",
            input: { questions: [{ id: "q1", question: "ok?" }] },
            requestedAt: 1700000000000,
          },
        })}
        indentDepth={0}
        localPath="/tmp"
        onSubagentAskUserQuestionSubmit={() => undefined}
        onSubagentExitPlanModeSubmit={() => undefined}
      />,
    )
    expect(html).toContain("waiting for input...")
  })

  test("activity label emits stable testid for run", () => {
    const html = renderToStaticMarkup(
      <SubagentMessage
        run={makeRunSnapshot({ status: "running", runId: "r-act" })}
        indentDepth={0}
        localPath="/tmp"
      />,
    )
    expect(html).toContain('data-testid="subagent-activity:r-act"')
  })

  test("renders without render-loop when pendingTool is set", async () => {
    const result = await renderForLoopCheck(
      <SubagentMessage
        run={makeRunSnapshot({
          pendingTool: {
            toolUseId: "t-loop",
            toolKind: "ask_user_question",
            input: { questions: [{ id: "q1", question: "ok?" }] },
            requestedAt: 1700000000000,
          },
        })}
        indentDepth={0}
        localPath="/tmp"
        onSubagentAskUserQuestionSubmit={() => undefined}
        onSubagentExitPlanModeSubmit={() => undefined}
      />,
    )
    try {
      expect(result.loopWarnings).toEqual([])
      expect(result.thrown).toBeNull()
    } finally {
      await result.cleanup()
    }
  })
})

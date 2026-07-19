import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import { OpenLocalLinkProvider } from "../components/messages/shared"
import type { HydratedTranscriptMessage } from "../../shared/types"
import {
  buildResolvedTranscriptRows,
  computeStableResolvedTranscriptRows,
  KannaTranscriptRow,
  type StableResolvedTranscriptRowsState,
} from "./KannaTranscript"

const ROW_WRAPPER_CLASS = "mx-auto max-w-[800px] pb-5"

// Minimal test harness mirroring how ChatTranscriptViewport renders resolved rows.
function TestTranscript({ messages }: { messages: HydratedTranscriptMessage[] }) {
  const rows = buildResolvedTranscriptRows(messages, {
    isLoading: false,
    latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
  })

  return (
    <OpenLocalLinkProvider onOpenLocalLink={() => undefined}>
      {rows.map((row) => (
        <div
          key={row.id}
          className={ROW_WRAPPER_CLASS}
        >
          <KannaTranscriptRow
            row={row}
            toolGroupExpanded={row.kind === "tool-group" ? false : undefined}
            onToolGroupExpandedChange={() => undefined}
            onAskUserQuestionSubmit={() => undefined}
            onExitPlanModeConfirm={() => undefined}
          />
        </div>
      ))}
    </OpenLocalLinkProvider>
  )
}

function renderTranscript(messages: HydratedTranscriptMessage[]) {
  return renderToStaticMarkup(<TestTranscript messages={messages} />)
}

function countRowWrappers(html: string) {
  return html.split(ROW_WRAPPER_CLASS).length - 1
}

function createToolMessage(id: string, toolId = id): HydratedTranscriptMessage {
  return {
    id,
    kind: "tool",
    toolKind: "bash",
    toolName: "Bash",
    toolId,
    input: {
      command: `echo ${id}`,
      description: `Run ${id}`,
    },
    timestamp: new Date().toISOString(),
  }
}

describe("KannaTranscript", () => {
  test("renders user attachment cards outside the user bubble", () => {
    const html = renderTranscript([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "What are these files about?",
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
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("spec.pdf")
    expect(html).toContain("application/pdf")
    expect(html).toContain("What are these files about?")
  })

  test("renders uploaded image attachments using the server content URL", () => {
    const html = renderTranscript([
      {
        id: "user-2",
        kind: "user_prompt",
        content: "",
        attachments: [{
          id: "image-1",
          kind: "image",
          displayName: "mock.png",
          absolutePath: "/tmp/project/.kanna/uploads/mock.png",
          relativePath: "./.kanna/uploads/mock.png",
          contentUrl: "/api/projects/project-1/uploads/mock.png/content",
          mimeType: "image/png",
          size: 512,
        }],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("/api/projects/project-1/uploads/mock.png/content")
    expect(html).toContain("mock.png")
    expect(html).toContain("max-h-[300px]")
    expect(html).toContain("min-w-[200px]")
  })

  test("renders images before file attachments and user text", () => {
    const html = renderTranscript([
      {
        id: "user-3",
        kind: "user_prompt",
        content: "Please review these.",
        attachments: [
          {
            id: "image-2",
            kind: "image",
            displayName: "mock.png",
            absolutePath: "/tmp/project/.kanna/uploads/mock.png",
            relativePath: "./.kanna/uploads/mock.png",
            contentUrl: "/api/projects/project-1/uploads/mock.png/content",
            mimeType: "image/png",
            size: 512,
          },
          {
            id: "file-2",
            kind: "file",
            displayName: "spec.pdf",
            absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
            relativePath: "./.kanna/uploads/spec.pdf",
            contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
            mimeType: "application/pdf",
            size: 1234,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("justify-end gap-3")
    expect(html).toContain("justify-end gap-2")
    expect(html).toContain("Please review these.")
  })

  test("hides steer system-message text and renders a steer icon left of the user bubble", () => {
    const html = renderTranscript([
      {
        id: "user-steer-1",
        kind: "user_prompt",
        content: `<system-message>
The user would like you to know the following. Please address the message as you see fit then continue with what you were doing
</system-message>

Please check the latest error first.`,
        steered: true,
        attachments: [],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).not.toContain("The user would like you to know the following.")
    expect(html).toContain("Please check the latest error first.")
    expect(html).toContain('aria-label="Sent mid-turn"')
  })

  test("does not render wrappers for context window updates", () => {
    const html = renderTranscript([
      {
        id: "context-window-1",
        kind: "context_window_updated",
        usage: { usedTokens: 100, maxTokens: 1000, compactsAutomatically: false },
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(0)
  })

  test("renders only the final status row", () => {
    const html = renderTranscript([
      {
        id: "status-1",
        kind: "status",
        status: "working",
        timestamp: new Date().toISOString(),
      },
      {
        id: "status-2",
        kind: "status",
        status: "done",
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("done")
    expect(html).not.toContain("working")
  })

  test("does not render a wrapper for results hidden by context cleared", () => {
    const html = renderTranscript([
      {
        id: "result-1",
        kind: "result",
        success: true,
        result: "Completed",
        durationMs: 100,
        timestamp: new Date().toISOString(),
      },
      {
        id: "context-cleared-1",
        kind: "context_cleared",
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("Context Cleared")
    expect(html).not.toContain("Completed")
  })

  test("renders wrappers for short successful result rows", () => {
    const html = renderTranscript([
      {
        id: "result-short-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Hey! 👋",
        durationMs: 2562,
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("Worked for 2s")
  })

  test("renders wrappers for long successful result rows", () => {
    const html = renderTranscript([
      {
        id: "result-long-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 61000,
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("Worked for 1m 1s")
  })

  test("shows the follow-up prompt time on earlier results and worked-for on the last", () => {
    const promptTimestamp = new Date("2026-07-19T08:32:00").toISOString()
    const html = renderTranscript([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "First ask",
        timestamp: new Date("2026-07-19T08:20:00").toISOString(),
      },
      {
        id: "result-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 480000,
        timestamp: new Date("2026-07-19T08:28:00").toISOString(),
      },
      {
        id: "user-2",
        kind: "user_prompt",
        content: "Second ask",
        timestamp: promptTimestamp,
      },
      {
        id: "result-2",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done again",
        durationMs: 720000,
        timestamp: new Date("2026-07-19T08:44:00").toISOString(),
      },
    ])

    const expectedPromptLabel = new Date(promptTimestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })

    expect(html).not.toContain("Worked for 8m")
    expect(html).toContain(expectedPromptLabel)
    expect(html).toContain("Worked for 12m")
  })

  test("does not render wrappers for duplicate system and account rows", () => {
    const html = renderTranscript([
      {
        id: "system-1",
        kind: "system_init",
        provider: "codex",
        model: "gpt-5",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "system-2",
        kind: "system_init",
        provider: "codex",
        model: "gpt-5",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "account-1",
        kind: "account_info",
        accountInfo: { email: "a@example.com", subscriptionType: "Pro" },
        timestamp: new Date().toISOString(),
      },
      {
        id: "account-2",
        kind: "account_info",
        accountInfo: { email: "a@example.com", subscriptionType: "Pro" },
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(2)
  })

  test("renders a model-changed row when a later session uses a different model", () => {
    const html = renderTranscript([
      {
        id: "system-1",
        kind: "system_init",
        provider: "claude",
        model: "claude-sonnet-4-5",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "system-2",
        kind: "system_init",
        provider: "claude",
        model: "claude-opus-4-6",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "system-3",
        kind: "system_init",
        provider: "claude",
        model: "claude-opus-4-6",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Session started with claude-sonnet-4-5")
    expect(html).toContain("Model changed to claude-opus-4-6")
  })

  test("renders one wrapper for visible transcript rows", () => {
    const html = renderTranscript([
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Visible text",
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(1)
    expect(html).toContain("Visible text")
  })

  test("keeps tool-group row ids stable when the grouped run grows", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const initialRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds,
    })
    const updatedRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
      createToolMessage("tool-3"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    expect(initialRows).toHaveLength(1)
    expect(updatedRows).toHaveLength(1)
    expect(initialRows[0]?.kind).toBe("tool-group")
    expect(updatedRows[0]?.kind).toBe("tool-group")
    expect(initialRows[0]?.id).toBe("tool-group:tool-1")
    expect(updatedRows[0]?.id).toBe("tool-group:tool-1")
  })

  test("groups collapsible tools across hidden context window updates", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "context-window-1",
        kind: "context_window_updated",
        usage: { usedTokens: 100, maxTokens: 1000, compactsAutomatically: false },
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe("tool-group")
    if (rows[0]?.kind !== "tool-group") throw new Error("unexpected row kind")
    expect(rows[0].messages.map((message) => message.id)).toEqual(["tool-1", "tool-2"])
  })

  test("groups collapsible tools across hidden non-final status rows", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "status-1",
        kind: "status",
        status: "working",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
      {
        id: "status-2",
        kind: "status",
        status: "done",
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]?.kind).toBe("tool-group")
    if (rows[0]?.kind !== "tool-group") throw new Error("unexpected row kind")
    expect(rows[0].messages.map((message) => message.id)).toEqual(["tool-1", "tool-2"])
    expect(rows[1]?.kind).toBe("single")
  })

  test("does not group collapsible tools across visible result rows", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "result-short-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 1000,
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.kind === "single")).toBe(true)
  })

  test("does not group collapsible tools across visible transcript rows", () => {
    const rows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Visible text",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    })

    expect(rows).toHaveLength(3)
    expect(rows[0]?.kind).toBe("single")
    expect(rows[1]?.kind).toBe("single")
    expect(rows[2]?.kind).toBe("single")
  })

  test("renders grouped tools as expanded across rerenders while streaming when controlled", () => {
    const initialHtml = renderToStaticMarkup(
      <CollapsedToolGroup
        messages={[
          createToolMessage("tool-1"),
          createToolMessage("tool-2"),
        ]}
        isLoading
        expanded
        onExpandedChange={() => undefined}
      />
    )

    const updatedHtml = renderToStaticMarkup(
      <CollapsedToolGroup
        messages={[
          createToolMessage("tool-1"),
          createToolMessage("tool-2"),
          createToolMessage("tool-3"),
        ]}
        isLoading
        expanded
        onExpandedChange={() => undefined}
      />
    )

    expect(initialHtml).toContain("Run tool-1")
    expect(initialHtml).toContain("Run tool-2")
    expect(updatedHtml).toContain("Run tool-1")
    expect(updatedHtml).toContain("Run tool-2")
    expect(updatedHtml).toContain("Run tool-3")
  })

  test("reuses unchanged single row objects across streaming updates", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const previousRows = buildResolvedTranscriptRows([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "Hello",
        timestamp: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Response",
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: true,
      latestToolIds,
    })
    const previousState: StableResolvedTranscriptRowsState = {
      byId: new Map(previousRows.map((row) => [row.id, row])),
      result: previousRows,
    }
    const nextRows = buildResolvedTranscriptRows([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "Hello",
        timestamp: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Response",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-1"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    const stableState = computeStableResolvedTranscriptRows(nextRows, previousState)

    expect(stableState.result[0]).toBe(previousRows[0])
  })

  test("replaces a user row when attachment content changes", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const previousRows = buildResolvedTranscriptRows([
      {
        id: "user-attachment",
        kind: "user_prompt",
        content: "Check this",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec-a.pdf",
          absolutePath: "/tmp/spec-a.pdf",
          relativePath: "./spec-a.pdf",
          contentUrl: "/files/spec-a.pdf",
          mimeType: "application/pdf",
          size: 10,
        }],
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: false,
      latestToolIds,
    })
    const previousState: StableResolvedTranscriptRowsState = {
      byId: new Map(previousRows.map((row) => [row.id, row])),
      result: previousRows,
    }
    const nextRows = buildResolvedTranscriptRows([
      {
        id: "user-attachment",
        kind: "user_prompt",
        content: "Check this",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec-b.pdf",
          absolutePath: "/tmp/spec-b.pdf",
          relativePath: "./spec-b.pdf",
          contentUrl: "/files/spec-b.pdf",
          mimeType: "application/pdf",
          size: 10,
        }],
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: false,
      latestToolIds,
    })

    const stableState = computeStableResolvedTranscriptRows(nextRows, previousState)

    expect(stableState.result[0]).not.toBe(previousRows[0])
  })

  test("reuses unchanged tool-group rows across grouped run growth elsewhere", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const previousRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Done",
        timestamp: new Date().toISOString(),
      },
    ], {
      isLoading: true,
      latestToolIds,
    })
    const previousState: StableResolvedTranscriptRowsState = {
      byId: new Map(previousRows.map((row) => [row.id, row])),
      result: previousRows,
    }
    const nextRows = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
      {
        id: "assistant-1",
        kind: "assistant_text",
        text: "Done",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-3"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    const stableState = computeStableResolvedTranscriptRows(nextRows, previousState)

    expect(stableState.result[0]).toBe(previousRows[0])
  })
})

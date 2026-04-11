import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import type { HydratedTranscriptMessage } from "../../shared/types"
import { buildResolvedTranscriptRows, KannaTranscript } from "./KannaTranscript"

const ROW_WRAPPER_CLASS = "mx-auto max-w-[800px] pb-5"

function renderTranscript(messages: HydratedTranscriptMessage[]) {
  return renderToStaticMarkup(
    <KannaTranscript
      messages={messages}
      isLoading={false}
      latestToolIds={{ AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }}
      onOpenLocalLink={() => undefined}
      onAskUserQuestionSubmit={() => undefined}
      onExitPlanModeConfirm={() => undefined}
    />
  )
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

  test("does not render wrappers for short successful result rows", () => {
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

    expect(countRowWrappers(html)).toBe(0)
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

  function createToolMessageWithTimestamp(
    id: string,
    timestamp: string,
    toolId = id,
  ): HydratedTranscriptMessage {
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
      result: "ok",
      timestamp,
    }
  }

  test("computes elapsedMs for single tool calls from consecutive timestamps", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const rows = buildResolvedTranscriptRows([
      createToolMessageWithTimestamp("tool-1", "2026-04-11T10:00:00.000Z"),
      createToolMessageWithTimestamp("tool-2", "2026-04-11T10:00:03.000Z"),
      createToolMessageWithTimestamp("tool-3", "2026-04-11T10:00:05.000Z"),
    ], {
      isLoading: false,
      latestToolIds,
    })

    // 3 tools get grouped into a tool-group
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe("tool-group")
    if (rows[0]?.kind !== "tool-group") throw new Error("unexpected")

    // Each tool in the group should have elapsedMs computed
    expect(rows[0].toolElapsedMs?.["tool-1"]).toBe(3000)
    expect(rows[0].toolElapsedMs?.["tool-2"]).toBe(2000)
    // Last tool has no next entry -> undefined
    expect(rows[0].toolElapsedMs?.["tool-3"]).toBeUndefined()
  })

  test("computes elapsedMs for a single (ungrouped) tool call", () => {
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const rows = buildResolvedTranscriptRows([
      {
        id: "text-1",
        kind: "assistant_text",
        text: "Hello",
        timestamp: "2026-04-11T10:00:00.000Z",
      },
      createToolMessageWithTimestamp("tool-1", "2026-04-11T10:00:01.000Z"),
      {
        id: "text-2",
        kind: "assistant_text",
        text: "Done",
        timestamp: "2026-04-11T10:00:04.000Z",
      },
    ], {
      isLoading: false,
      latestToolIds,
    })

    const toolRow = rows.find(r => r.kind === "single" && r.message.kind === "tool")
    expect(toolRow?.kind).toBe("single")
    if (toolRow?.kind !== "single") throw new Error("unexpected")
    expect(toolRow.elapsedMs).toBe(3000)
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
})

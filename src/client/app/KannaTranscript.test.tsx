import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import { OpenLocalLinkProvider } from "../components/messages/shared"
import { formatPromptTimestamp } from "../components/messages/ResultMessage"
import type { HydratedTranscriptMessage, MessageSource } from "../../shared/types"
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

  test("hides steer system-message text and marks nothing on a steered prompt", () => {
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
    expect(html).not.toContain("Sent mid-turn")
    expect(html).not.toContain("<svg")
  })

  test("a steered message from another chat carries no mid-turn mark", () => {
    const html = renderTranscript([
      {
        id: "sourced-steer-1",
        kind: "user_prompt",
        content: "Rebase first.",
        source: { kind: "agent", chatId: "parent" },
        steered: true,
        attachments: [],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("Rebase first.")
    expect(html).not.toContain("Sent mid-turn")
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
        id: "text-1",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date().toISOString(),
      },
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

    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Context Cleared")
    expect(html).not.toContain("Completed")
  })

  test("a session restore surfaces as 'Session Repaired' on the next system init", () => {
    const systemInit = (id: string): HydratedTranscriptMessage => ({
      id,
      kind: "system_init",
      provider: "claude",
      model: "claude-opus-4-1",
      tools: [],
      agents: [],
      slashCommands: [],
      mcpServers: [],
      timestamp: new Date().toISOString(),
    })

    const html = renderTranscript([
      systemInit("init-1"),
      {
        id: "restored-1",
        kind: "session_restored",
        provider: "claude",
        timestamp: new Date().toISOString(),
      },
      systemInit("init-2"),
    ])

    // The boundary renders no row of its own; the second init (same provider,
    // same model — otherwise hidden) surfaces the repair.
    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Session Repaired")
    expect(html).toContain("lucide-rotate-cw")

    // Without the boundary, the identical second init stays hidden.
    const withoutRestore = renderTranscript([systemInit("init-1"), systemInit("init-2")])
    expect(countRowWrappers(withoutRestore)).toBe(1)
    expect(withoutRestore).not.toContain("Session Repaired")
  })

  test("renders wrappers for short successful result rows", () => {
    const html = renderTranscript([
      {
        id: "text-short-1",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date().toISOString(),
      },
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

    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Worked for 2s")
  })

  test("renders wrappers for long successful result rows", () => {
    const html = renderTranscript([
      {
        id: "text-long-1",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date().toISOString(),
      },
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

    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Worked for 1m 1s")
  })

  test("a prompt nobody typed says who sent it in its bubble, and the boundary above only dates it", () => {
    const at = (minute: number) => new Date(2026, 6, 19, 8, minute).toISOString()
    const turn = (index: number, minute: number): HydratedTranscriptMessage[] => [
      { id: `text-${index}`, kind: "assistant_text", text: "ok", timestamp: at(minute) },
      { id: `result-${index}`, kind: "result", success: true, cancelled: false, result: "", durationMs: 1000, timestamp: at(minute) },
    ]
    const html = renderTranscript([
      { id: "user-1", kind: "user_prompt", content: "mine", timestamp: at(0) },
      ...turn(1, 1),
      { id: "user-2", kind: "user_prompt", content: "scheduled", source: { kind: "schedule", scheduleId: "s" }, timestamp: at(10) },
      ...turn(2, 11),
      { id: "user-3", kind: "user_prompt", content: "from a peer", source: { kind: "agent", chatId: "c" }, timestamp: at(20) },
      ...turn(3, 21),
      { id: "user-4", kind: "user_prompt", content: "report", source: { kind: "report", chatIds: ["c"] }, timestamp: at(30) },
      ...turn(4, 31),
      { id: "user-5", kind: "user_prompt", content: "mine again", timestamp: at(40) },
    ])

    // Every boundary is a time and nothing more, the user's own included.
    for (const minute of [10, 20, 30, 40]) expect(html).toContain(`>${formatPromptTimestamp(at(minute))}<`)
    expect(html).not.toContain("from an automation")
    expect(html).not.toContain("from another agent")
    expect(html).not.toContain("from a sub-chat")
    // Each sender is said once, by the quote over its bubble or, for a
    // report, by its line. Nothing here knows the chats or the schedule, so
    // each is named for what it is.
    for (const sender of ["Automation", "Another agent", "A sub-chat replied"]) expect(html.split(`>${sender}<`).length - 1).toBe(1)
  })

  test("a prompt nobody typed sits on the agent's side, in a prompt's bubble", () => {
    const timestamp = new Date(2026, 6, 19, 9, 5).toISOString()
    const bubble = "rounded-2xl border border-border bg-muted"
    const typed = renderTranscript([{ id: "user-1", kind: "user_prompt", content: "mine", timestamp }])
    expect(typed).toContain("items-end")
    expect(typed).not.toContain("items-start")
    expect(typed).toContain(bubble)

    // A report is the exception: a line, not a bubble. See below.
    const sources: MessageSource[] = [
      { kind: "agent", chatId: "c" },
      { kind: "schedule", scheduleId: "s" },
    ]
    for (const source of sources) {
      const html = renderTranscript([{ id: "user-1", kind: "user_prompt", content: "theirs", source, timestamp }])
      expect(html).toContain("items-start")
      expect(html).not.toContain("items-end")
      expect(html).toContain(bubble)
      // Held to five lines until asked for.
      expect(html.split("max-height:5lh").length - 1).toBe(1)
    }
    // The same clamp for what the user typed, with room for 25.
    expect(typed.split("max-height:25lh").length - 1).toBe(1)
    expect(typed).not.toContain("max-height:5lh")
  })

  test("what the agent says is never clamped", () => {
    const html = renderTranscript([
      { id: "text-1", kind: "assistant_text", text: Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n\n"), timestamp: new Date().toISOString() },
    ])
    expect(html).toContain("line 39")
    expect(html).not.toContain("max-height:")
    expect(html).not.toContain("Show more")
  })

  test("a report is a line per sub-chat in a tool row's look, and nothing of the reply", () => {
    const html = renderTranscript([
      {
        id: "chat-1", kind: "tool", toolKind: "chat", toolName: "create_chat", toolId: "chat-1",
        input: { payload: { message: "tell a joke", title: "Joke" } },
        rawResult: { chatId: "abc", title: "Joke" },
        resultEntryId: "result-chat-1",
        timestamp: new Date().toISOString(),
      },
      {
        id: "user-1",
        kind: "user_prompt",
        content: [
          "<system-message>\nSub-chat completed: [Joke](/chat/abc) (chat id abc)\n</system-message>",
          "Why did the scarecrow win an award?",
          "<system-message>\nSub-chat failed: [Deploy](/chat/def) (chat id def)\n</system-message>",
          "---\n\ncredentials expired",
        ].join("\n\n"),
        source: { kind: "report", chatIds: ["abc", "def"] },
        timestamp: new Date().toISOString(),
      },
    ])
    const report = html.slice(html.indexOf('id="msg-user-1"'))
    // The parent's agent relays what matters, so the reply is not drawn again.
    expect(report).not.toContain("Why did the scarecrow")
    expect(report).not.toContain("credentials expired")
    expect(report).not.toContain("max-height:")
    expect(report).not.toContain("rounded-2xl")
    // No quote of what the sub-chat was asked, and no line joining one.
    expect(report).not.toContain(">tell a joke<")
    expect(report).not.toContain("h-[14px] w-[3px]")
    const order = [report.indexOf(">A sub-chat replied<"), report.indexOf(">A sub-chat failed<")]
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The call's own card still says what it asked.
    expect(html).toContain("Started a sub-chat · tell a joke")
  })

  test("a chat that opens with an agent's message gets a boundary of its own", () => {
    const timestamp = new Date(2026, 6, 19, 9, 5).toISOString()
    const fromAgent = renderTranscript([
      { id: "user-1", kind: "user_prompt", content: "audit the parser", source: { kind: "agent", chatId: "parent" }, timestamp },
    ])
    // Dated by the boundary, and attributed by the quote over its bubble: the
    // same row the sender draws on what comes back.
    expect(fromAgent).toContain(`>${formatPromptTimestamp(timestamp)}<`)
    expect(fromAgent).toContain("Another agent")
    expect(fromAgent).not.toContain("Replied to")
    // The boundary comes before the message it introduces.
    expect(fromAgent.indexOf(formatPromptTimestamp(timestamp))).toBeLessThan(fromAgent.indexOf("audit the parser"))

    // A chat the user opens still starts with the message and no boundary.
    const fromUser = renderTranscript([
      { id: "user-1", kind: "user_prompt", content: "audit the parser", timestamp },
    ])
    expect(fromUser).not.toContain(formatPromptTimestamp(timestamp))
  })

  test("a prompt after a stopped turn is still dated and still says it came from an automation", () => {
    const timestamp = new Date(2026, 6, 19, 9, 30).toISOString()
    const html = renderTranscript([
      { id: "user-1", kind: "user_prompt", content: "start", timestamp: new Date(2026, 6, 19, 9, 0).toISOString() },
      { id: "stop-1", kind: "interrupted", timestamp: new Date(2026, 6, 19, 9, 1).toISOString() },
      { id: "user-2", kind: "user_prompt", content: "check the deploy", source: { kind: "schedule", scheduleId: "s" }, timestamp },
    ])
    expect(html).toContain(`>${formatPromptTimestamp(timestamp)}<`)
    expect(html).toContain("Automation")
  })

  test("what Kanna tells the agent inside a message is not shown to the reader", () => {
    const html = renderTranscript([
      {
        id: "user-1",
        kind: "user_prompt",
        content: [
          "<system-message>\nSub-chat completed: [Tell me a joke](/chat/abc) (chat id abc)\n</system-message>",
          "Why did the scarecrow win an award?",
          "<system-message>\nSub-chat failed: [Deploy](/chat/def) (chat id def)\n</system-message>",
          "---\n\ncredentials expired",
        ].join("\n\n"),
        source: { kind: "report", chatIds: ["abc", "def"] },
        timestamp: new Date().toISOString(),
      },
    ])
    expect(html).not.toContain("chat id")
    expect(html).not.toContain("Sub-chat completed")
    expect(html).not.toContain("system-message")
  })

  test("a message with nothing for the reader draws no bubble", () => {
    const timestamp = new Date(2026, 6, 19, 9, 5).toISOString()
    const html = renderTranscript([
      {
        id: "user-1",
        kind: "user_prompt",
        content: "<system-message>\nSub-chat cancelled: [Deploy](/chat/def) (chat id def)\n</system-message>",
        source: { kind: "report", chatIds: ["def"] },
        timestamp,
      },
    ])
    // The boundary still says a sub-chat reported in; there is just no text under it.
    expect(html).toContain("from a sub-chat")
    expect(html).not.toContain("Sub-chat cancelled")
    expect(html).not.toContain("prose")
  })

  test("a report that is only the news of an adoption draws that line, and its boundary only dates it", () => {
    const at = (minute: number) => new Date(2026, 6, 19, 9, minute).toISOString()
    const html = renderTranscript([
      { id: "user-1", kind: "user_prompt", content: "start", timestamp: at(0) },
      { id: "text-1", kind: "assistant_text", text: "ok", timestamp: at(1) },
      { id: "result-1", kind: "result", success: true, cancelled: false, result: "", durationMs: 1000, timestamp: at(1) },
      {
        id: "user-2",
        kind: "user_prompt",
        content: '<system-message>\nSub-chat adopted: [Audit](/chat/abc) (chat id abc) now reports to the chat "Coordinator" (/chat/xyz), which adopted it. Its result will not arrive here. read_chat and wait_for_chats still reach it.\n</system-message>',
        source: { kind: "report", chatIds: ["abc"] },
        timestamp: at(5),
      },
    ])
    expect(html).toContain('id="msg-user-2"')
    expect(html).toContain(" was adopted by ")
    // The line says who it is about, so the divider above it does not.
    expect(html).toContain(`>${formatPromptTimestamp(at(5))}<`)
    expect(html).not.toContain("from a sub-chat")
  })

  test("a chat tool call draws as a card, not folded into a tool group", () => {
    const html = renderTranscript([
      createToolMessage("tool-1"),
      {
        id: "chat-1",
        kind: "tool",
        toolKind: "chat",
        toolName: "create_chat",
        toolId: "chat-1",
        input: { payload: { message: "audit the parser", title: "Parser audit" } },
        rawResult: { chatId: "child", title: "Parser audit" },
        resultEntryId: "result-chat-1",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ])
    expect(html).toContain("Parser audit")
    expect(html).toContain("Started a sub-chat")
    expect(html).toContain("audit the parser")
    // Three rows: the card splits the tool calls either side of it.
    expect(countRowWrappers(html)).toBe(3)
  })

  test("a schedule tool call draws as a card for the schedule", () => {
    const html = renderTranscript([
      createToolMessage("tool-1"),
      {
        id: "sched-1",
        kind: "tool",
        toolKind: "schedule",
        toolName: "set_schedule",
        toolId: "sched-1",
        input: { payload: { name: "Deploy check", message: "check the deploy", everyMinutes: 5 } },
        rawResult: { scheduleId: "s1", name: "Deploy check", message: "check the deploy" },
        resultEntryId: "result-sched-1",
        timestamp: new Date().toISOString(),
      },
      {
        id: "sched-2",
        kind: "tool",
        toolKind: "schedule",
        toolName: "set_schedule",
        toolId: "sched-2",
        input: { payload: { scheduleId: "s1", dailyAt: "09:00", weekdays: [1, 3] } },
        rawResult: { scheduleId: "s1", name: "Deploy check", message: "check the deploy" },
        resultEntryId: "result-sched-2",
        timestamp: new Date().toISOString(),
      },
      {
        // Recorded before the card existed: an unknown tool, its result as JSON text.
        id: "sched-3",
        kind: "tool",
        toolKind: "unknown_tool",
        toolName: "delete_schedule",
        toolId: "sched-3",
        input: { payload: { scheduleId: "s1" } },
        rawResult: [{ type: "text", text: JSON.stringify({ deleted: "s1", name: "Deploy check" }) }],
        resultEntryId: "result-sched-3",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ])
    expect(html).toContain("Scheduled · Every 5 min · check the deploy")
    expect(html).toContain("Updated · Daily at 09:00 · Mon, Wed · check the deploy")
    expect(html).toContain("Deleted")
    expect(html.split("Deploy check").length - 1).toBe(3)
    // Five rows: three cards, and a tool call either side.
    expect(countRowWrappers(html)).toBe(5)
  })

  test("a chat tool call recorded before the card existed still draws as one", () => {
    // Such a call was filed as an unknown tool, and its result is what the
    // provider was sent: the value as JSON in a text block.
    const html = renderTranscript([
      createToolMessage("tool-1"),
      {
        id: "chat-old",
        kind: "tool",
        toolKind: "unknown_tool",
        toolName: "create_chat",
        toolId: "chat-old",
        input: { payload: { message: "summarize the week", title: "Weekly summary" } },
        rawResult: [{ type: "text", text: JSON.stringify({ chatId: "child", title: "Weekly summary" }) }],
        resultEntryId: "result-chat-old",
        timestamp: new Date().toISOString(),
      },
      createToolMessage("tool-2"),
    ])
    expect(html).toContain("Weekly summary")
    expect(html).toContain("Started a sub-chat · summarize the week")
    expect(countRowWrappers(html)).toBe(3)
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
        id: "text-1",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date("2026-07-19T08:21:00").toISOString(),
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
        id: "text-2",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date().toISOString(),
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

    const expectedPromptLabel = formatPromptTimestamp(promptTimestamp)

    expect(html).not.toContain("Worked for 8m")
    expect(html).toContain(expectedPromptLabel)
    expect(html).toContain("Worked for 12m")
  })

  test("prefixes worked-for with the turn's end time", () => {
    const timestamp = new Date("2026-07-19T08:44:00").toISOString()
    const html = renderTranscript([
      {
        id: "text-time-1",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date().toISOString(),
      },
      {
        id: "result-time-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 3000,
        timestamp,
      },
    ])

    expect(html).toContain(`${formatPromptTimestamp(timestamp)} · Worked for 3s`)
  })

  test("hides the result of a turn that showed nothing", () => {
    const html = renderTranscript([
      {
        id: "text-empty-0",
        kind: "assistant_text",
        text: "Working on it",
        timestamp: new Date().toISOString(),
      },
      {
        id: "result-empty-0",
        kind: "result",
        success: true,
        cancelled: false,
        result: "Done",
        durationMs: 5000,
        timestamp: new Date().toISOString(),
      },
      {
        id: "result-empty-1",
        kind: "result",
        success: true,
        cancelled: false,
        result: "",
        durationMs: 29,
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(2)
    expect(html).toContain("Worked for 5s")
    expect(html).not.toContain("Worked for 29ms")
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
        model: "claude-sonnet-4-6",
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
        model: "claude-opus-4-8",
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
        model: "claude-opus-4-8",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(countRowWrappers(html)).toBe(2)
    // Model ids resolve to their human-readable catalog labels.
    expect(html).toContain("Claude Code")
    expect(html).toContain("Sonnet")
    expect(html).toContain("Model Changed")
    expect(html).toContain("Opus")
    expect(html.match(/data-provider-icon="claude"/g)).toHaveLength(1)
  })

  test("does not count a context-window marker alone as a model change", () => {
    const init = (id: string, model: string) => ({
      id,
      kind: "system_init" as const,
      provider: "claude" as const,
      model,
      tools: [],
      agents: [],
      slashCommands: [],
      mcpServers: [],
      timestamp: new Date().toISOString(),
    })
    const html = renderTranscript([
      init("system-1", "claude-opus-5-5"),
      init("system-2", "claude-opus-5-5[1m]"),
      init("system-3", "claude-opus-5-5"),
    ])

    expect(html).not.toContain("Model Changed")
  })

  test("labels the session init after a handoff with only the destination harness", () => {
    const html = renderTranscript([
      {
        id: "system-1",
        kind: "system_init",
        provider: "claude",
        model: "claude-sonnet-4-6",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
      {
        id: "handoff-1",
        kind: "handoff_boundary",
        fromProvider: "claude",
        toProvider: "codex",
        timestamp: new Date().toISOString(),
      },
      {
        id: "user-1",
        kind: "user_prompt",
        content: "keep going",
        timestamp: new Date().toISOString(),
      },
      {
        id: "system-2",
        kind: "system_init",
        provider: "codex",
        model: "gpt-5.4",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
    ])

    // The boundary renders no row of its own — the switch surfaces on the
    // new session init as only the destination harness.
    expect(countRowWrappers(html)).toBe(3)
    expect(html).toContain("Codex")
    expect(html).not.toContain("Claude Code → Codex")
    expect(html).toContain('data-provider-icon="codex"')
    expect(html).not.toContain("Handed off")
    expect(html).not.toContain("Model Changed")
  })

  test("renders a model change on a later session init", () => {
    const html = renderTranscript([
      {
        id: "system-1",
        kind: "system_init",
        provider: "claude",
        model: "claude-sonnet-4-6",
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
        model: "claude-opus-4-8",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        timestamp: new Date().toISOString(),
      },
    ])

    expect(html).toContain("Model Changed")
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
    expect(initialRows[0]?.id).toBe("tool-1")
    expect(updatedRows[0]?.id).toBe("tool-1")
  })

  test("a lone tool keeps its row id when a second call turns it into a group", () => {
    // The single→group transition happens on nearly every multi-tool turn. If
    // it changed the row id, the virtualized list would retire the measured
    // height and remount the subtree mid-stream, which reads as a scroll jump.
    const latestToolIds = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
    const single = buildResolvedTranscriptRows([createToolMessage("tool-1")], {
      isLoading: true,
      latestToolIds,
    })
    const grouped = buildResolvedTranscriptRows([
      createToolMessage("tool-1"),
      createToolMessage("tool-2"),
    ], {
      isLoading: true,
      latestToolIds,
    })

    expect(single[0]?.kind).toBe("single")
    expect(grouped[0]?.kind).toBe("tool-group")
    expect(single[0]?.id).toBe(grouped[0]?.id)
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

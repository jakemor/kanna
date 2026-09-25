import { describe, expect, test } from "bun:test"
import { normalizeToolCall } from "../../../../shared/tools"
import type { SubagentActivity, TranscriptEntry, WorkflowProgress } from "../../../../shared/types"
import {
  deriveSentAttachments,
  deriveSubagentDetails,
  deriveSubagentToolIds,
  formatTokens,
  latestWorkflows,
  orderTaskLog,
  summarizeWorkflow,
  workflowAgentElapsed,
} from "./derive"

let nextId = 0
function toolCall(toolName: string, toolId: string, input: Record<string, unknown>): TranscriptEntry {
  return { _id: `e${nextId++}`, createdAt: 0, kind: "tool_call", tool: normalizeToolCall({ toolName, toolId, input }) } as TranscriptEntry
}
function toolResult(toolId: string, content: unknown, isError = false): TranscriptEntry {
  return { _id: `e${nextId++}`, createdAt: 0, kind: "tool_result", toolId, content, isError } as TranscriptEntry
}
const file = (name: string, kind: "image" | "file" = "image") =>
  ({ type: "attachment", url: `/api/chats/c1/media/${name}`, name, kind, mimeType: kind === "image" ? "image/png" : "text/plain", size: 1 })

describe("deriveSentAttachments", () => {
  test("collects send_attachments and generate_images results, newest first", () => {
    const entries = [
      toolCall("send_attachments", "s1", { attachments: [] }),
      toolResult("s1", [file("one.png"), file("notes.txt", "file")]),
      toolCall("generate_images", "g1", { images: [] }),
      toolResult("g1", [file("two.png")]),
    ]
    expect(deriveSentAttachments(entries).map((attachment) => attachment.name)).toEqual(["two.png", "notes.txt", "one.png"])
  })

  test("skips failed calls, other tools, and results with no usable attachments", () => {
    const entries = [
      toolCall("send_attachments", "s1", {}),
      toolResult("s1", "File not found", true),
      toolCall("show_chart", "c1", { data: [] }),
      toolResult("c1", [file("chart.png")]),
      toolCall("send_attachments", "s2", {}),
      toolResult("s2", [{ type: "attachment", url: "file:///etc/passwd", name: "x", kind: "file" }]),
    ]
    expect(deriveSentAttachments(entries)).toEqual([])
  })

  test("keys are stable per result and index", () => {
    const entries = [toolCall("send_attachments", "s1", {}), toolResult("s1", [file("a.png"), file("b.png")])]
    const keys = deriveSentAttachments(entries).map((attachment) => attachment.key)
    expect(new Set(keys).size).toBe(2)
    expect(deriveSentAttachments(entries).map((attachment) => attachment.key)).toEqual(keys)
  })
})

describe("deriveSubagentToolIds", () => {
  const agent = (id: string, label: string, type = "subagent"): SubagentActivity =>
    ({ id, type, label, status: "running", startedAt: 0 })
  const spawn = (toolId: string, subagentType: string) =>
    toolCall("Agent", toolId, { subagent_type: subagentType, description: "d", prompt: "p" })

  test("an agent keyed by its spawn call's id maps to that call", () => {
    const toolIds = deriveSubagentToolIds([spawn("call-1", "Explore")], [agent("call-1", "Explore")])
    expect(toolIds.get("call-1")).toBe("call-1")
  })

  test("agents keyed by agent_id pair with the latest calls of their type, in order", () => {
    const entries = [spawn("old", "Explore"), spawn("a", "Explore"), spawn("p", "Plan"), spawn("b", "Explore")]
    const toolIds = deriveSubagentToolIds(entries, [agent("x1", "Explore"), agent("x2", "Explore"), agent("y1", "Plan")])
    expect(Object.fromEntries(toolIds)).toEqual({ x1: "a", x2: "b", y1: "p" })
  })

  test("calls outside the loaded window leave the older agents unmapped", () => {
    const toolIds = deriveSubagentToolIds([spawn("b", "Explore")], [agent("x1", "Explore"), agent("x2", "Explore")])
    expect(Object.fromEntries(toolIds)).toEqual({ x2: "b" })
  })

  test("background shells have no spawn call", () => {
    const toolIds = deriveSubagentToolIds([toolCall("Bash", "sh", { command: "sleep 9" })], [agent("task-1", "sleep 9", "shell")])
    expect(toolIds.size).toBe(0)
  })
})

describe("deriveSubagentDetails", () => {
  test("reads the task off the spawn call and counts the agent's own steps", () => {
    const child = (entry: TranscriptEntry, parent: string): TranscriptEntry => ({ ...entry, parentToolUseId: parent })
    const entries: TranscriptEntry[] = [
      toolCall("Agent", "call-1", { subagent_type: "general-purpose", description: "Audit durable.ts turn engine", prompt: "Read CLAUDE.md first." }),
      child(toolCall("Read", "r1", { file_path: "/repo/src/worker/durable.ts" }), "call-1"),
      child({ _id: "t1", createdAt: 3, kind: "assistant_text", text: "Looking at runTurn." }, "call-1"),
      child(toolCall("Grep", "g1", { pattern: "alarm" }), "call-1"),
      // The main thread's own call isn't the agent's.
      toolCall("Bash", "b1", { command: "ls" }),
    ]
    const details = deriveSubagentDetails(entries, new Map([["agent-a", "call-1"]])).get("agent-a")
    expect(details?.description).toBe("Audit durable.ts turn engine")
    expect(details?.subagentType).toBe("general-purpose")
    expect(details?.prompt).toBe("Read CLAUDE.md first.")
    expect(details?.toolCalls).toBe(2)
    expect(details?.messages).toBe(1)
    expect(details?.latestTool?.toolKind).toBe("grep")
  })
})

describe("deriveSubagentToolIds with task events", () => {
  test("a task that names its call jumps there, whatever kind of call it is", () => {
    const entries = [
      toolCall("Monitor", "toolu_m", { description: "watch" }),
      toolCall("Agent", "toolu_a", { subagent_type: "Explore", description: "Find it", prompt: "p" }),
    ]
    const tasks: SubagentActivity[] = [
      { id: "m1", type: "monitor", label: "watch", status: "running", startedAt: 1, toolUseId: "toolu_m" },
      { id: "a1", type: "subagent", label: "Explore", status: "running", startedAt: 1, toolUseId: "toolu_a" },
      // Its call is outside the window: no row to guess at by type.
      { id: "a2", type: "subagent", label: "Explore", status: "running", startedAt: 1, toolUseId: "toolu_gone" },
    ]
    const ids = deriveSubagentToolIds(entries, tasks)
    expect(ids.get("m1")).toBe("toolu_m")
    expect(ids.get("a1")).toBe("toolu_a")
    expect(ids.has("a2")).toBe(false)
  })
})

describe("workflow helpers", () => {
  const progress: WorkflowProgress = {
    name: "review",
    phases: [{ index: 1, title: "Review" }, { index: 2, title: "Verify" }],
    agents: [
      { index: 1, label: "a", state: "done", phaseIndex: 1, tokens: 1000 },
      { index: 2, label: "b", state: "failed", phaseIndex: 1, tokens: 500 },
      { index: 3, label: "c", state: "running", phaseIndex: 2, startedAt: 1000 },
      { index: 4, label: "d", state: "queued", phaseIndex: 2 },
      { index: 5, label: "loose", state: "done" },
    ],
  }

  test("counts agents by state and finds the phase in progress", () => {
    expect(summarizeWorkflow(progress)).toEqual({
      total: 5, queued: 1, running: 1, done: 2, failed: 1, skipped: 0, tokens: 1500,
      currentPhase: { index: 2, title: "Verify" },
    })
    expect(summarizeWorkflow(undefined).total).toBe(0)
  })

  test("elapsed runs live while an agent runs, and stops at its last report", () => {
    expect(workflowAgentElapsed({ index: 1, label: "x", state: "running", startedAt: 1000 }, 4000)).toBe(3000)
    expect(workflowAgentElapsed({ index: 1, label: "x", state: "done", startedAt: 1000, lastProgressAt: 2500 }, 9000)).toBe(1500)
    expect(workflowAgentElapsed({ index: 1, label: "x", state: "queued" }, 9000)).toBeNull()
    expect(workflowAgentElapsed({ index: 1, label: "x", state: "done", durationMs: 42 }, 9000)).toBe(42)
  })

  test("token counts fit a row", () => {
    expect(formatTokens(940)).toBe("940")
    expect(formatTokens(1_250)).toBe("1.3k")
    expect(formatTokens(12_400)).toBe("12k")
    expect(formatTokens(1_300_000)).toBe("1.3M")
  })
})

describe("task log", () => {
  const task = (id: string, startedAt: number, extra: Partial<SubagentActivity> = {}): SubagentActivity =>
    ({ id, type: "subagent", label: id, status: "completed", startedAt, ...extra })
  const run = { phases: [], agents: [] }

  test("running first, then newest first, without a workflow's own agents", () => {
    const tasks = [
      task("monitor", 1, { type: "monitor", status: "running" }),
      task("old", 2),
      task("new", 5),
      task("inner", 6, { workflowId: "w" }),
    ]
    expect(orderTaskLog(tasks).map((entry) => entry.id)).toEqual(["monitor", "new", "old"])
  })

  test("the Workflow card shows the runs going, else the latest run", () => {
    const older = task("w1", 1, { type: "workflow", workflow: run })
    const newer = task("w2", 2, { type: "workflow", workflow: run })
    expect(latestWorkflows([older, newer, task("t", 3)]).map((entry) => entry.id)).toEqual(["w2"])
    const live = { ...older, status: "running" as const }
    expect(latestWorkflows([live, newer]).map((entry) => entry.id)).toEqual(["w1"])
    expect(latestWorkflows([task("t", 1)])).toEqual([])
  })
})

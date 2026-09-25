import { describe, expect, test } from "bun:test"
import type { SubagentActivity } from "../shared/types"
import {
  claudeTaskType,
  findWorkflowOf,
  finishActivity,
  linkWorkflowAgents,
  normalizeClaudeTaskMessage,
  parseWorkflowProgress,
  pruneTaskLog,
} from "./background-tasks"

// Shapes as the bundled CLI emits them (system/task_* messages).
const base = { type: "system", uuid: "u", session_id: "s" }

describe("normalizeClaudeTaskMessage", () => {
  test("a Task subagent starts under its type, with its call and task", () => {
    expect(normalizeClaudeTaskMessage({
      ...base,
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "toolu_1",
      description: "Audit the turn engine",
      subagent_type: "general-purpose",
      task_type: "local_agent",
      is_backgrounded: false,
    })).toEqual({
      kind: "started",
      id: "a1",
      type: "subagent",
      label: "general-purpose",
      toolUseId: "toolu_1",
      description: "Audit the turn engine",
      stoppable: true,
    })
  })

  test("a monitor starts as a monitor, labelled by what it watches", () => {
    const update = normalizeClaudeTaskMessage({
      ...base,
      subtype: "task_started",
      task_id: "m1",
      tool_use_id: "toolu_2",
      description: "Watch the deploy log for errors",
      task_type: "monitor_mcp",
    })
    expect(update).toMatchObject({ kind: "started", type: "monitor", label: "Watch the deploy log for errors" })
  })

  test("a workflow starts under its script's name", () => {
    expect(normalizeClaudeTaskMessage({
      ...base,
      subtype: "task_started",
      task_id: "w1",
      description: "Review the diff",
      task_type: "local_workflow",
      workflow_name: "review-changes",
    })).toMatchObject({ kind: "started", type: "workflow", label: "review-changes", workflowName: "review-changes" })
  })

  test("ambient tasks are named so they can be kept out", () => {
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_started", task_id: "x", description: "watcher", ambient: true }))
      .toEqual({ kind: "ambient", id: "x" })
  })

  test("progress carries usage, and a workflow's whole state when it sends one", () => {
    const update = normalizeClaudeTaskMessage({
      ...base,
      subtype: "task_progress",
      task_id: "w1",
      description: "Verify: check a.ts",
      usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 9000 },
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Review" },
        { type: "workflow_agent", index: 1, label: "review a.ts", phaseIndex: 1, state: "done", tokens: 800, toolCalls: 3 },
      ],
    })
    expect(update).toMatchObject({
      kind: "progress",
      id: "w1",
      usage: { totalTokens: 1200, toolUses: 4 },
      workflow: { phases: [{ index: 1, title: "Review" }], agents: [{ index: 1, state: "done", tokens: 800 }] },
    })
  })

  test("a throttled progress report without workflow_progress changes no agents", () => {
    const update = normalizeClaudeTaskMessage({ ...base, subtype: "task_progress", task_id: "w1", description: "x", usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 } })
    expect(update).not.toHaveProperty("workflow")
  })

  test("endings: completed, failed, stopped, and task_updated's killed", () => {
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_notification", task_id: "a", status: "completed", output_file: "", summary: "done" }))
      .toMatchObject({ kind: "stopped", failed: false, summary: "done" })
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_notification", task_id: "a", status: "failed", output_file: "", summary: "" }))
      .toMatchObject({ kind: "stopped", failed: true })
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_notification", task_id: "a", status: "stopped", output_file: "", summary: "" }))
      .toMatchObject({ kind: "stopped", failed: false, stopped: true })
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_updated", task_id: "a", patch: { status: "killed" } }))
      .toMatchObject({ kind: "stopped", stopped: true })
    // Paused is still work in progress.
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_updated", task_id: "a", patch: { status: "paused" } })).toBeNull()
  })

  test("everything else is not a task report", () => {
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "init" })).toBeNull()
    expect(normalizeClaudeTaskMessage({ type: "assistant", message: {} })).toBeNull()
    expect(normalizeClaudeTaskMessage({ ...base, subtype: "task_started" })).toBeNull()
  })
})

describe("parseWorkflowProgress", () => {
  test("reads agent states the way the CLI's status line counts them", () => {
    const { agents } = parseWorkflowProgress([
      { type: "workflow_agent", index: 1, label: "q", state: "start", queuedAt: 1 },
      { type: "workflow_agent", index: 2, label: "s", state: "start", queuedAt: 1, startedAt: 2 },
      { type: "workflow_agent", index: 3, label: "p", state: "progress", startedAt: 2 },
      { type: "workflow_agent", index: 4, label: "d", state: "done" },
      { type: "workflow_agent", index: 5, label: "e", state: "error", error: "boom" },
      { type: "workflow_agent", index: 6, label: "k", state: "error", skipped: true },
    ])
    expect(agents.map((agent) => agent.state)).toEqual(["queued", "running", "running", "done", "failed", "skipped"])
    expect(agents[4]?.error).toBe("boom")
  })

  test("orders by index, fills a phase only an agent named, and skips junk", () => {
    const progress = parseWorkflowProgress([
      { type: "workflow_agent", index: 2, label: "b", state: "done", phaseIndex: 2, phaseTitle: "Verify" },
      { type: "workflow_phase", index: 1, title: "Review" },
      { type: "workflow_agent", index: 1, label: "a", state: "done", phaseIndex: 1 },
      { type: "workflow_log", message: "hi" },
      null,
      { type: "workflow_agent", label: "no index" },
    ])
    expect(progress.agents.map((agent) => agent.label)).toEqual(["a", "b"])
    expect(progress.phases).toEqual([{ index: 1, title: "Review" }, { index: 2, title: "Verify" }])
  })

  test("clips previews so a large run stays small on the wire", () => {
    const { agents } = parseWorkflowProgress([
      { type: "workflow_agent", index: 1, label: "a", state: "start", promptPreview: "x".repeat(5000) },
    ])
    expect(agents[0]!.promptPreview!.length).toBeLessThanOrEqual(280)
  })
})

describe("registry helpers", () => {
  const workflow: SubagentActivity = {
    id: "w1",
    type: "workflow",
    label: "review",
    status: "running",
    startedAt: 1,
    workflow: {
      phases: [],
      agents: [
        { index: 1, label: "a", state: "done", agentId: "agent-a" },
        { index: 2, label: "b", state: "running", agentId: "agent-b" },
        { index: 3, label: "c", state: "queued" },
      ],
    },
  }

  test("a run that ends settles the agents still going", () => {
    const stopped = finishActivity(workflow, "stopped", 10)
    expect(stopped).toMatchObject({ status: "stopped", endedAt: 10 })
    expect(stopped.workflow!.agents.map((agent) => agent.state)).toEqual(["done", "failed", "skipped"])
    expect(finishActivity(workflow, "completed", 10).workflow!.agents[1]!.state).toBe("done")
  })

  test("a workflow's agents are tied to it by agent id", () => {
    const byId = new Map<string, SubagentActivity>([
      ["w1", workflow],
      ["agent-b", { id: "agent-b", type: "subagent", label: "x", status: "running", startedAt: 2 }],
      ["other", { id: "other", type: "subagent", label: "y", status: "running", startedAt: 2 }],
    ])
    linkWorkflowAgents(byId, "w1", workflow.workflow!.agents)
    expect(byId.get("agent-b")?.workflowId).toBe("w1")
    expect(byId.get("other")?.workflowId).toBeUndefined()
    expect(findWorkflowOf(byId, "agent-a")).toBe("w1")
    expect(findWorkflowOf(byId, "other")).toBeUndefined()
  })

  test("task types use the CLI's own words", () => {
    expect(claudeTaskType("local_bash")).toBe("shell")
    expect(claudeTaskType("monitor_ws")).toBe("monitor")
    expect(claudeTaskType("something_new")).toBe("something_new")
    expect(claudeTaskType(undefined, "Explore")).toBe("subagent")
  })
})

describe("pruneTaskLog", () => {
  const task = (id: string, startedAt: number, extra: Partial<SubagentActivity> = {}): SubagentActivity =>
    ({ id, type: "subagent", label: id, status: "completed", startedAt, endedAt: startedAt + 1, ...extra })

  test("keeps the newest finished tasks and every running one", () => {
    const byId = new Map<string, SubagentActivity>()
    for (let index = 0; index < 5; index += 1) byId.set(`t${index}`, task(`t${index}`, index))
    byId.set("old-monitor", task("old-monitor", -10, { type: "monitor", status: "running", endedAt: undefined }))
    pruneTaskLog(byId, 2)
    expect([...byId.keys()].sort()).toEqual(["old-monitor", "t3", "t4"])
  })

  test("a workflow's agents take no place in the log, and leave with it", () => {
    const byId = new Map<string, SubagentActivity>([
      ["w-old", task("w-old", 1, { type: "workflow", workflow: { phases: [], agents: [] } })],
      ["inner", task("inner", 2, { workflowId: "w-old" })],
      ["t", task("t", 3)],
    ])
    pruneTaskLog(byId, 1)
    expect([...byId.keys()]).toEqual(["t"])
  })

  test("only the newest workflow keeps its agents' previews", () => {
    const agents = [{ index: 1, label: "a", state: "done" as const, promptPreview: "p", resultPreview: "r" }]
    const byId = new Map<string, SubagentActivity>([
      ["w1", task("w1", 1, { type: "workflow", workflow: { phases: [], agents } })],
      ["w2", task("w2", 2, { type: "workflow", workflow: { phases: [], agents } })],
    ])
    pruneTaskLog(byId)
    expect(byId.get("w1")?.workflow?.agents[0]).toEqual({ index: 1, label: "a", state: "done" })
    expect(byId.get("w2")?.workflow?.agents[0]?.promptPreview).toBe("p")
  })
})

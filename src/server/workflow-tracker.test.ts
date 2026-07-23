import { describe, expect, test } from "bun:test"
import { WorkflowTracker } from "./workflow-tracker"
import type { WorkflowStateEntry } from "../shared/types"

const TOOL_ID = "toolu_01QeXqtJ8tXG7dfx9qwQf8an"
const TASK_ID = "wj6t8vti0"

function taskStarted(overrides: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: TASK_ID,
    tool_use_id: TOOL_ID,
    description: "Demo workflow",
    task_type: "local_workflow",
    workflow_name: "probe-demo",
    prompt: "export const meta = {...}",
    uuid: "u1",
    session_id: "s1",
    ...overrides,
  }
}

function taskProgress(workflowProgress: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: TASK_ID,
    tool_use_id: TOOL_ID,
    description: "Greetings: agent-1",
    usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
    summary: "Demo workflow",
    workflow_progress: workflowProgress,
    uuid: "u2",
    session_id: "s1",
    ...overrides,
  }
}

function agentEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "workflow_agent",
    index: 1,
    label: "agent-1",
    phaseIndex: 1,
    phaseTitle: "Greetings",
    model: "claude-opus-4-8",
    state: "start",
    queuedAt: 1000,
    promptPreview: "Say hi",
    ...overrides,
  }
}

function single(entries: unknown[]): WorkflowStateEntry {
  expect(entries).toHaveLength(1)
  const entry = entries[0] as WorkflowStateEntry
  expect(entry.kind).toBe("workflow_state")
  return entry
}

describe("WorkflowTracker", () => {
  test("task_started for a local_workflow emits an initial running snapshot", () => {
    const tracker = new WorkflowTracker()
    const entry = single(tracker.process(taskStarted()))

    expect(entry.taskId).toBe(TASK_ID)
    expect(entry.toolId).toBe(TOOL_ID)
    expect(entry.workflowName).toBe("probe-demo")
    expect(entry.description).toBe("Demo workflow")
    expect(entry.status).toBe("running")
    expect(entry.phases).toEqual([])
    expect(entry.agents).toEqual([])
  })

  test("non-workflow task_started is ignored", () => {
    const tracker = new WorkflowTracker()
    expect(tracker.process(taskStarted({ task_type: "subagent", workflow_name: undefined }))).toEqual([])
    // Progress for an untracked, non-workflow task is also ignored.
    expect(tracker.process(taskProgress([], { workflow_progress: undefined }))).toEqual([])
  })

  test("skip_transcript stamps hidden on snapshots", () => {
    const tracker = new WorkflowTracker()
    const entry = single(tracker.process(taskStarted({ skip_transcript: true })))
    expect(entry.hidden).toBe(true)
  })

  test("folds phases and agent lifecycle from workflow_progress", () => {
    const tracker = new WorkflowTracker()
    tracker.process(taskStarted())

    const entry = single(tracker.process(taskProgress([
      { type: "workflow_phase", index: 1, title: "Greetings" },
      agentEvent(),
      agentEvent({ index: 2, label: "agent-2", promptPreview: "Say hello" }),
      agentEvent({ agentId: "a5a5ced", startedAt: 1010 }),
    ])))

    expect(entry.phases).toEqual([{ index: 1, title: "Greetings" }])
    expect(entry.agents).toHaveLength(2)
    expect(entry.agents[0]).toMatchObject({
      index: 1,
      label: "agent-1",
      state: "running",
      agentId: "a5a5ced",
      phaseIndex: 1,
      phaseTitle: "Greetings",
      model: "claude-opus-4-8",
      promptPreview: "Say hi",
    })
    // agent-2 was queued (start without startedAt).
    expect(entry.agents[1]).toMatchObject({ index: 2, state: "queued" })
    expect(entry.usage).toEqual({ totalTokens: 100, toolUses: 2, durationMs: 500 })
  })

  test("agent progress and terminal states merge without losing earlier fields", () => {
    const tracker = new WorkflowTracker()
    tracker.process(taskStarted())
    tracker.process(taskProgress([agentEvent({ agentId: "a1", startedAt: 1010 })]))

    const entry = single(tracker.process(taskProgress([
      agentEvent({ state: "progress", tokens: 5000, toolCalls: 3 }),
      agentEvent({ state: "done", tokens: 8000, toolCalls: 4, durationMs: 4200 }),
    ])))

    expect(entry.agents[0]).toMatchObject({
      index: 1,
      state: "done",
      agentId: "a1",
      tokens: 8000,
      toolCalls: 4,
      durationMs: 4200,
      model: "claude-opus-4-8",
    })
  })

  test("error state captures the error message", () => {
    const tracker = new WorkflowTracker()
    tracker.process(taskStarted())
    const entry = single(tracker.process(taskProgress([
      agentEvent({ state: "error", error: "model not available", durationMs: 799 }),
    ])))
    expect(entry.agents[0]).toMatchObject({ state: "error", error: "model not available" })
  })

  test("terminal agent state never regresses on a replayed start event", () => {
    let nowMs = 0
    const tracker = new WorkflowTracker(() => nowMs)
    tracker.process(taskStarted())
    tracker.process(taskProgress([agentEvent({ state: "done", tokens: 100 })]))
    // A replayed start is a no-op (no structural change), so it flushes on the
    // throttle interval rather than immediately.
    nowMs = 5_000
    const entry = single(tracker.process(taskProgress([agentEvent({ state: "start", startedAt: 1010 })])))
    expect(entry.agents[0]!.state).toBe("done")
  })

  test("pure token ticks are throttled; structural changes emit immediately", () => {
    let nowMs = 0
    const tracker = new WorkflowTracker(() => nowMs)
    tracker.process(taskStarted())
    tracker.process(taskProgress([agentEvent({ startedAt: 1010 })]))

    // Token-only update right after the last emit: swallowed.
    nowMs = 100
    expect(tracker.process(taskProgress([agentEvent({ state: "progress", tokens: 10 })]))).toEqual([])

    // Past the throttle interval the buffered progress flushes.
    nowMs = 5_000
    const flushed = single(tracker.process(taskProgress([agentEvent({ state: "progress", tokens: 20 })])))
    expect(flushed.agents[0]!.tokens).toBe(20)

    // A state transition emits immediately even inside the interval.
    nowMs = 5_100
    const terminal = single(tracker.process(taskProgress([agentEvent({ state: "done", tokens: 30 })])))
    expect(terminal.agents[0]!.state).toBe("done")
  })

  test("task_updated patches run status", () => {
    const tracker = new WorkflowTracker()
    tracker.process(taskStarted())
    const entry = single(tracker.process({
      type: "system",
      subtype: "task_updated",
      task_id: TASK_ID,
      patch: { status: "completed", end_time: 2000 },
    }))
    expect(entry.status).toBe("completed")
  })

  test("task_notification finalizes status, summary, usage, and straggling agents", () => {
    const tracker = new WorkflowTracker()
    tracker.process(taskStarted())
    tracker.process(taskProgress([
      agentEvent({ agentId: "a1", startedAt: 1010 }),
      agentEvent({ index: 2, label: "agent-2", state: "done", tokens: 500 }),
    ]))

    const entry = single(tracker.process({
      type: "system",
      subtype: "task_notification",
      task_id: TASK_ID,
      tool_use_id: TOOL_ID,
      status: "completed",
      summary: "Workflow completed",
      usage: { total_tokens: 900, tool_uses: 7, duration_ms: 6000 },
    }))

    expect(entry.status).toBe("completed")
    expect(entry.summary).toBe("Workflow completed")
    expect(entry.usage).toEqual({ totalTokens: 900, toolUses: 7, durationMs: 6000 })
    // The still-running agent is coerced to a terminal state.
    expect(entry.agents.every((agent) => agent.state === "done")).toBe(true)
  })

  test("stopped notification maps to killed and errors stragglers", () => {
    const tracker = new WorkflowTracker()
    tracker.process(taskStarted())
    tracker.process(taskProgress([agentEvent({ startedAt: 1010 })]))
    const entry = single(tracker.process({
      type: "system",
      subtype: "task_notification",
      task_id: TASK_ID,
      status: "stopped",
    }))
    expect(entry.status).toBe("killed")
    expect(entry.agents[0]!.state).toBe("error")
  })

  test("mid-flight task_progress with workflow_progress lazily creates the run", () => {
    const tracker = new WorkflowTracker()
    const entry = single(tracker.process(taskProgress([agentEvent({ startedAt: 1010 })])))
    expect(entry.taskId).toBe(TASK_ID)
    expect(entry.agents).toHaveLength(1)
  })

  test("unknown message shapes are ignored", () => {
    const tracker = new WorkflowTracker()
    expect(tracker.process({ type: "assistant" })).toEqual([])
    expect(tracker.process({ type: "system", subtype: "init" })).toEqual([])
    expect(tracker.process(null)).toEqual([])
    expect(tracker.process({ type: "system", subtype: "task_updated", task_id: "unknown", patch: { status: "completed" } })).toEqual([])
  })

  test("workflow inside a subagent keeps the parent agent scope", () => {
    const tracker = new WorkflowTracker()
    const entry = single(tracker.process(taskStarted({ parent_tool_use_id: "toolu_parent" })))
    expect(entry.agentId).toBe("toolu_parent")
  })
})

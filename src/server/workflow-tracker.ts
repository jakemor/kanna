import { asRecord } from "../shared/json"
import type {
  TranscriptEntry,
  WorkflowAgentRunState,
  WorkflowAgentSnapshot,
  WorkflowPhaseSnapshot,
  WorkflowRunStatus,
  WorkflowUsageSnapshot,
} from "../shared/types"
import { timestamped } from "./transcript"

/**
 * Minimum interval between appended snapshots for pure token/progress ticks.
 * Structural changes (new agents, state transitions, run status changes)
 * always emit immediately — this only throttles the noisy middle.
 */
const PROGRESS_EMIT_INTERVAL_MS = 1_500

interface WorkflowRun {
  taskId: string
  toolId?: string
  workflowName?: string
  description?: string
  status: WorkflowRunStatus
  usage?: WorkflowUsageSnapshot
  phases: Map<number, WorkflowPhaseSnapshot>
  agents: Map<number, WorkflowAgentSnapshot>
  summary?: string
  /** Parent subagent scope when the workflow was launched inside a child agent. */
  agentId?: string
  hidden?: boolean
  lastEmittedAt: number
  pendingProgress: boolean
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function normalizeUsage(value: unknown): WorkflowUsageSnapshot | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  return {
    totalTokens: asNumber(usage.total_tokens) ?? 0,
    toolUses: asNumber(usage.tool_uses) ?? 0,
    durationMs: asNumber(usage.duration_ms) ?? 0,
  }
}

function normalizeRunStatus(value: unknown): WorkflowRunStatus | null {
  if (
    value === "pending" || value === "running" || value === "completed"
    || value === "failed" || value === "killed" || value === "paused"
  ) return value
  // task_notification uses "stopped" for user-killed runs.
  if (value === "stopped") return "killed"
  return null
}

/**
 * The CLI's workflow_agent events use state "start" both for queued entries
 * (no startedAt yet) and actually-started ones; "progress" for running ticks;
 * "error"/"done" as terminals. Unknown states keep the previous value so a
 * future CLI can add states without regressing existing runs to "queued".
 */
function normalizeAgentState(value: unknown, startedAt: unknown, previous?: WorkflowAgentRunState): WorkflowAgentRunState {
  if (value === "error" || value === "failed") return "error"
  if (value === "done" || value === "success" || value === "complete" || value === "completed") return "done"
  if (value === "progress" || value === "running") return "running"
  if (value === "start" || value === "queued") {
    // Terminal states never regress on a late/replayed start event.
    if (previous === "done" || previous === "error") return previous
    return startedAt !== undefined && startedAt !== null ? "running" : "queued"
  }
  return previous ?? "running"
}

function isTerminalAgentState(state: WorkflowAgentRunState): boolean {
  return state === "done" || state === "error"
}

/**
 * Folds the Claude CLI's background-task lifecycle messages
 * (system/task_started, task_progress, task_updated, task_notification) for
 * `local_workflow` tasks into canonical `workflow_state` transcript snapshots.
 *
 * NOT the todo list: TaskCreate/TaskUpdate/... tool calls are handled by
 * ClaudeTaskTracker. This tracker consumes system messages the normalizer
 * otherwise drops, so it is purely additive to the entry stream.
 */
export class WorkflowTracker {
  private readonly runs = new Map<string, WorkflowRun>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  process(message: any): TranscriptEntry[] {
    if (message?.type !== "system") return []

    const subtype = message.subtype
    if (subtype === "task_started") return this.onTaskStarted(message)
    if (subtype === "task_progress") return this.onTaskProgress(message)
    if (subtype === "task_updated") return this.onTaskUpdated(message)
    if (subtype === "task_notification") return this.onTaskNotification(message)
    return []
  }

  private onTaskStarted(message: any): TranscriptEntry[] {
    const taskId = asString(message.task_id)
    if (!taskId) return []
    const isWorkflow = message.task_type === "local_workflow" || asString(message.workflow_name) !== undefined
    if (!isWorkflow) return []

    const run: WorkflowRun = {
      taskId,
      toolId: asString(message.tool_use_id),
      workflowName: asString(message.workflow_name),
      description: asString(message.description),
      status: "running",
      phases: new Map(),
      agents: new Map(),
      agentId: asString(message.parent_tool_use_id),
      ...(message.skip_transcript === true ? { hidden: true } : {}),
      lastEmittedAt: 0,
      pendingProgress: false,
    }
    this.runs.set(taskId, run)
    return [this.snapshot(run)]
  }

  private onTaskProgress(message: any): TranscriptEntry[] {
    const taskId = asString(message.task_id)
    if (!taskId) return []

    let run = this.runs.get(taskId)
    // A run can surface mid-flight (session resume): create it lazily, but
    // only when the payload proves it is a workflow task.
    if (!run) {
      if (!Array.isArray(message.workflow_progress)) return []
      run = {
        taskId,
        toolId: asString(message.tool_use_id),
        description: asString(message.summary) ?? asString(message.description),
        status: "running",
        phases: new Map(),
        agents: new Map(),
        agentId: asString(message.parent_tool_use_id),
        lastEmittedAt: 0,
        pendingProgress: false,
      }
      this.runs.set(taskId, run)
    }

    const usage = normalizeUsage(message.usage)
    if (usage) run.usage = usage

    let structuralChange = false
    if (Array.isArray(message.workflow_progress)) {
      for (const rawEvent of message.workflow_progress) {
        const event = asRecord(rawEvent)
        if (!event) continue

        if (event.type === "workflow_phase") {
          const index = asNumber(event.index)
          const title = asString(event.title)
          if (index === undefined || !title) continue
          if (!run.phases.has(index)) structuralChange = true
          run.phases.set(index, { index, title })
          continue
        }

        if (event.type === "workflow_agent") {
          const index = asNumber(event.index)
          if (index === undefined) continue
          const previous = run.agents.get(index)
          const state = normalizeAgentState(event.state, event.startedAt, previous?.state)
          const next: WorkflowAgentSnapshot = {
            index,
            label: asString(event.label) ?? previous?.label ?? `agent-${index}`,
            state,
            ...(asNumber(event.phaseIndex) !== undefined
              ? { phaseIndex: asNumber(event.phaseIndex) }
              : previous?.phaseIndex !== undefined ? { phaseIndex: previous.phaseIndex } : {}),
            ...(asString(event.phaseTitle)
              ? { phaseTitle: asString(event.phaseTitle) }
              : previous?.phaseTitle ? { phaseTitle: previous.phaseTitle } : {}),
            ...(asString(event.agentId)
              ? { agentId: asString(event.agentId) }
              : previous?.agentId ? { agentId: previous.agentId } : {}),
            ...(asString(event.model)
              ? { model: asString(event.model) }
              : previous?.model ? { model: previous.model } : {}),
            ...(asString(event.promptPreview)
              ? { promptPreview: asString(event.promptPreview) }
              : previous?.promptPreview ? { promptPreview: previous.promptPreview } : {}),
            ...(asNumber(event.tokens) !== undefined
              ? { tokens: asNumber(event.tokens) }
              : previous?.tokens !== undefined ? { tokens: previous.tokens } : {}),
            ...(asNumber(event.toolCalls) !== undefined
              ? { toolCalls: asNumber(event.toolCalls) }
              : previous?.toolCalls !== undefined ? { toolCalls: previous.toolCalls } : {}),
            ...(asNumber(event.durationMs) !== undefined
              ? { durationMs: asNumber(event.durationMs) }
              : previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
            ...(asString(event.error)
              ? { error: asString(event.error) }
              : previous?.error ? { error: previous.error } : {}),
          }
          if (!previous || previous.state !== next.state || isTerminalAgentState(next.state) && !isTerminalAgentState(previous.state)) {
            structuralChange = true
          }
          run.agents.set(index, next)
        }
      }
    }

    run.pendingProgress = true
    if (structuralChange || this.now() - run.lastEmittedAt >= PROGRESS_EMIT_INTERVAL_MS) {
      return [this.snapshot(run)]
    }
    return []
  }

  private onTaskUpdated(message: any): TranscriptEntry[] {
    const taskId = asString(message.task_id)
    const run = taskId ? this.runs.get(taskId) : undefined
    if (!run) return []

    const patch = asRecord(message.patch)
    const status = normalizeRunStatus(patch?.status)
    if (!status) return []
    if (status === run.status && !run.pendingProgress) return []
    run.status = status
    return [this.snapshot(run)]
  }

  private onTaskNotification(message: any): TranscriptEntry[] {
    const taskId = asString(message.task_id)
    const run = taskId ? this.runs.get(taskId) : undefined
    if (!run) return []

    const status = normalizeRunStatus(message.status)
    if (status) run.status = status
    const usage = normalizeUsage(message.usage)
    if (usage) run.usage = usage
    const summary = asString(message.summary)
    if (summary) run.summary = summary

    // Terminal signal: no straggling agent may stay "running"/"queued" forever.
    if (run.status === "completed" || run.status === "failed" || run.status === "killed") {
      for (const [index, agent] of run.agents) {
        if (!isTerminalAgentState(agent.state)) {
          run.agents.set(index, { ...agent, state: run.status === "completed" ? "done" : "error" })
        }
      }
    }
    return [this.snapshot(run)]
  }

  private snapshot(run: WorkflowRun): TranscriptEntry {
    run.lastEmittedAt = this.now()
    run.pendingProgress = false
    return timestamped({
      kind: "workflow_state",
      ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(run.hidden ? { hidden: true } : {}),
      taskId: run.taskId,
      ...(run.toolId ? { toolId: run.toolId } : {}),
      ...(run.workflowName ? { workflowName: run.workflowName } : {}),
      ...(run.description ? { description: run.description } : {}),
      status: run.status,
      ...(run.usage ? { usage: run.usage } : {}),
      phases: [...run.phases.values()].sort((left, right) => left.index - right.index),
      agents: [...run.agents.values()].sort((left, right) => left.index - right.index),
      ...(run.summary ? { summary: run.summary } : {}),
    }, this.now())
  }
}

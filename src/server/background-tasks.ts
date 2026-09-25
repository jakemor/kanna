import { asNumber, asRecord } from "../shared/json"
import type { SubagentActivity, WorkflowAgent, WorkflowAgentState, WorkflowPhase, WorkflowProgress } from "../shared/types"

/**
 * Claude's background-task stream, normalized for the chat's task registry
 * (AgentCoordinator.applySubagentActivity).
 *
 * The CLI keeps one registry of everything running on a session's behalf:
 * subagents, backgrounded shells, monitors, workflows. It reports each one
 * as it starts (`task_started`), as it goes (`task_progress`, `task_updated`)
 * and as it ends (`task_notification`), on the same stream as the
 * conversation. Before this, Kanna heard about a monitor or a shell only when
 * the main agent stopped and the Stop hook swept the registry, so a monitor
 * started mid-turn stayed invisible until the turn was over.
 */

/**
 * What the registry learns, from the task stream or from hooks.
 *
 * `inFlight` is the authoritative sweep the Stop hook carries: everything
 * still running at the moment the main agent went quiet. It is what keeps the
 * count trustworthy when an end event never lands (crash, kill, a session
 * torn down mid-flight). `ambient` names a task the CLI says is housekeeping,
 * not activity, so the sweep must not list it either.
 */
export type SubagentActivityUpdate =
  | {
    kind: "started"
    id: string
    type: string
    label: string
    toolUseId?: string
    description?: string
    workflowName?: string
    /** The provider can stop just this task. */
    stoppable?: boolean
  }
  | {
    kind: "progress"
    id: string
    summary?: string
    usage?: SubagentActivity["usage"]
    workflow?: Pick<WorkflowProgress, "phases" | "agents">
  }
  | {
    kind: "stopped"
    id: string
    failed: boolean
    /** Stopped on request rather than finished: neither a success nor a failure. */
    stopped?: boolean
    summary?: string
    usage?: SubagentActivity["usage"]
  }
  | { kind: "inFlight"; ids: readonly { id: string; type: string; label: string }[] }
  | { kind: "ambient"; id: string }

/**
 * The CLI's own friendly names for its task types, as its Stop hook reports
 * them in `background_tasks[].type`. Using the same words keeps a task the
 * sweep discovers and one the stream announced the same kind.
 */
const CLAUDE_TASK_TYPES: Record<string, string> = {
  local_agent: "subagent",
  local_workflow: "workflow",
  local_bash: "shell",
  monitor_mcp: "monitor",
  monitor_ws: "monitor",
  mcp_task: "MCP task",
  in_process_teammate: "teammate",
  dream: "dream",
  auto_mode_scan: "auto-mode scan",
  remote_agent: "cloud session",
}

/** Bounds the one field in a task report that is free text of any length. */
const SUMMARY_LIMIT = 400
/** Per workflow agent, so a 50-agent run stays a few KB on the wire. */
const PREVIEW_LIMIT = 280

function text(value: unknown, limit?: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return limit !== undefined && trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

function usageFrom(value: unknown): SubagentActivity["usage"] {
  const usage = asRecord(value)
  if (!usage) return undefined
  const totalTokens = asNumber(usage.total_tokens)
  const toolUses = asNumber(usage.tool_uses)
  if (totalTokens === undefined && toolUses === undefined) return undefined
  return { totalTokens: totalTokens ?? 0, toolUses: toolUses ?? 0 }
}

export function claudeTaskType(taskType: unknown, subagentType?: string): string {
  if (typeof taskType === "string" && taskType) return CLAUDE_TASK_TYPES[taskType] ?? taskType
  // A CLI that predates `task_type` sent these only for Task subagents.
  return subagentType ? "subagent" : "task"
}

/**
 * The CLI's agent states, read the way its own status line counts them: a
 * `start` with a queue time and no start time is waiting for a slot, any other
 * `start` is running. A blocked or errored agent failed, unless it was skipped.
 */
function workflowAgentState(event: Record<string, unknown>): WorkflowAgentState {
  switch (event.state) {
    case "done":
      return "done"
    case "error":
      return event.skipped === true ? "skipped" : "failed"
    case "progress":
      return "running"
    case "start":
      return event.queuedAt !== undefined && event.startedAt === undefined ? "queued" : "running"
    default:
      return "running"
  }
}

/**
 * A `task_progress` report's `workflow_progress`: the run's whole state so far,
 * one event per phase and per agent (logs filtered out by the CLI), each the
 * latest for its index. So it replaces what came before rather than adding to
 * it. The CLI sends it only when something structural changed or a throttle
 * lapsed; a report without it changes nothing here.
 */
export function parseWorkflowProgress(events: readonly unknown[]): Pick<WorkflowProgress, "phases" | "agents"> {
  const phases = new Map<number, WorkflowPhase>()
  const agents = new Map<number, WorkflowAgent>()
  for (const raw of events) {
    const event = asRecord(raw)
    const index = asNumber(event?.index)
    if (!event || index === undefined) continue
    if (event.type === "workflow_phase") {
      const title = text(event.title)
      if (title) phases.set(index, { index, title })
      continue
    }
    if (event.type !== "workflow_agent") continue
    const agent: WorkflowAgent = {
      index,
      label: text(event.label, PREVIEW_LIMIT) ?? `Agent ${index}`,
      state: workflowAgentState(event),
    }
    const phaseIndex = asNumber(event.phaseIndex)
    if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex
    const phaseTitle = text(event.phaseTitle)
    // An agent can name a phase the run never announced on its own.
    if (phaseIndex !== undefined && phaseTitle && !phases.has(phaseIndex)) phases.set(phaseIndex, { index: phaseIndex, title: phaseTitle })
    const agentId = text(event.agentId)
    if (agentId) agent.agentId = agentId
    const model = text(event.model)
    if (model) agent.model = model
    const tokens = asNumber(event.tokens)
    if (tokens !== undefined) agent.tokens = tokens
    const toolCalls = asNumber(event.toolCalls)
    if (toolCalls !== undefined) agent.toolCalls = toolCalls
    const startedAt = asNumber(event.startedAt)
    if (startedAt !== undefined) agent.startedAt = startedAt
    const lastProgressAt = asNumber(event.lastProgressAt)
    if (lastProgressAt !== undefined) agent.lastProgressAt = lastProgressAt
    const durationMs = asNumber(event.durationMs)
    if (durationMs !== undefined) agent.durationMs = durationMs
    const promptPreview = text(event.promptPreview, PREVIEW_LIMIT)
    if (promptPreview) agent.promptPreview = promptPreview
    const resultPreview = text(event.resultPreview, PREVIEW_LIMIT)
    if (resultPreview) agent.resultPreview = resultPreview
    const error = text(event.error, PREVIEW_LIMIT)
    if (error) agent.error = error
    if (event.cached === true) agent.cached = true
    agents.set(index, agent)
  }
  return {
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
  }
}

/**
 * A task at its end. A workflow's agents end with it: a run that stopped or
 * failed leaves its running agents failed and its queued ones skipped, as its
 * last report would otherwise leave them spinning on a finished card.
 */
export function finishActivity(
  activity: SubagentActivity,
  status: Exclude<SubagentActivity["status"], "running">,
  now: number,
): SubagentActivity {
  const finished: SubagentActivity = { ...activity, status, endedAt: now }
  if (activity.workflow) {
    finished.workflow = {
      ...activity.workflow,
      agents: activity.workflow.agents.map((agent) => {
        if (agent.state === "queued") return { ...agent, state: "skipped" }
        if (agent.state === "running") return { ...agent, state: status === "completed" ? "done" : "failed" }
        return agent
      }),
    }
  }
  return finished
}

/** Finished tasks a chat's log keeps. Running ones don't count and are never dropped. */
export const TASK_LOG_LIMIT = 30

/**
 * Trims a chat's task log, which runs across turns: the widgets show the
 * latest work whether its turn is still going or long over, so finished tasks
 * stay until newer ones push them out rather than clearing at each prompt.
 *
 * The oldest finished go first, by start. An agent that ran inside a workflow
 * isn't a row of its own, so it takes no place in the log and leaves with its
 * workflow. Only the newest workflow keeps its agents' previews: it is the one
 * the Workflow card opens up, and an older run's are dead weight on every push.
 */
export function pruneTaskLog(byId: Map<string, SubagentActivity>, limit = TASK_LOG_LIMIT) {
  const newestFirst = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
  const finished = newestFirst.filter((task) => task.status !== "running" && !task.workflowId)
  for (const task of finished.slice(limit)) byId.delete(task.id)
  for (const task of byId.values()) {
    if (task.workflowId && task.status !== "running" && !byId.has(task.workflowId)) byId.delete(task.id)
  }
  const newestWorkflowId = newestFirst.find((task) => task.workflow && byId.has(task.id))?.id
  for (const task of byId.values()) {
    if (!task.workflow || task.status === "running" || task.id === newestWorkflowId) continue
    if (!task.workflow.agents.some((agent) => agent.promptPreview || agent.resultPreview || agent.error)) continue
    byId.set(task.id, {
      ...task,
      workflow: {
        ...task.workflow,
        agents: task.workflow.agents.map(({ promptPreview: _p, resultPreview: _r, error: _e, ...agent }) => agent),
      },
    })
  }
}

/** The running workflow whose agents include this task, if any. */
export function findWorkflowOf(byId: ReadonlyMap<string, SubagentActivity>, taskId: string): string | undefined {
  for (const activity of byId.values()) {
    if (activity.workflow?.agents.some((agent) => agent.agentId === taskId)) return activity.id
  }
  return undefined
}

/**
 * Marks the tasks a workflow's agents run as, once its progress names them.
 * Whether the CLI registers a workflow's agents as tasks of their own is its
 * business. If it does, they belong to the workflow's card, not beside it.
 */
export function linkWorkflowAgents(
  byId: Map<string, SubagentActivity>,
  workflowId: string,
  agents: readonly WorkflowAgent[],
) {
  for (const agent of agents) {
    const task = agent.agentId ? byId.get(agent.agentId) : undefined
    if (task && task.id !== workflowId && task.workflowId !== workflowId) {
      byId.set(task.id, { ...task, workflowId })
    }
  }
}

/**
 * One SDK message, as a registry update, or null when it isn't a task report.
 * Every task the stream reports can be stopped on its own (`stopTask`).
 */
export function normalizeClaudeTaskMessage(message: unknown): SubagentActivityUpdate | null {
  const record = asRecord(message)
  if (!record || record.type !== "system") return null
  const id = text(record.task_id)
  if (!id) return null

  switch (record.subtype) {
    case "task_started": {
      // Housekeeping the CLI runs for itself (live-update watchers and the
      // like). Its own guidance: keep it out of activity indicators.
      if (record.ambient === true) return { kind: "ambient", id }
      const subagentType = text(record.subagent_type)
      const description = text(record.description, SUMMARY_LIMIT)
      const workflowName = text(record.workflow_name)
      const type = claudeTaskType(record.task_type, subagentType)
      return {
        kind: "started",
        id,
        type,
        label: workflowName ?? subagentType ?? description ?? type,
        ...(text(record.tool_use_id) ? { toolUseId: text(record.tool_use_id) } : {}),
        ...(description ? { description } : {}),
        ...(workflowName ? { workflowName } : {}),
        stoppable: true,
      }
    }
    case "task_progress": {
      const usage = usageFrom(record.usage)
      const summary = text(record.summary, SUMMARY_LIMIT)
      return {
        kind: "progress",
        id,
        ...(usage ? { usage } : {}),
        ...(summary ? { summary } : {}),
        ...(Array.isArray(record.workflow_progress) ? { workflow: parseWorkflowProgress(record.workflow_progress) } : {}),
      }
    }
    case "task_updated": {
      // Only an end matters here. `paused` (a workflow waiting out a rate
      // limit) is still work in progress, and reads as running.
      const status = asRecord(record.patch)?.status
      if (status === "completed") return { kind: "stopped", id, failed: false }
      if (status === "failed") return { kind: "stopped", id, failed: true }
      if (status === "killed") return { kind: "stopped", id, failed: false, stopped: true }
      return null
    }
    case "task_notification": {
      const usage = usageFrom(record.usage)
      const summary = text(record.summary, SUMMARY_LIMIT)
      return {
        kind: "stopped",
        id,
        failed: record.status === "failed",
        ...(record.status === "stopped" ? { stopped: true } : {}),
        ...(usage ? { usage } : {}),
        ...(summary ? { summary } : {}),
      }
    }
    default:
      return null
  }
}

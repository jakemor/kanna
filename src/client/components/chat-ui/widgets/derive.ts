import { ATTACHMENT_TOOL_NAMES, displayAttachments, type DisplayAttachment } from "../../../../shared/display-tools"
import type {
  NormalizedToolCall,
  SubagentActivity,
  ToolCallEntry,
  TranscriptEntry,
  WorkflowAgent,
  WorkflowPhase,
  WorkflowProgress,
} from "../../../../shared/types"

/**
 * What the widgets read out of the transcript. Kept pure (entries in, data
 * out) so they are cheap to memo on the transcript and easy to test.
 *
 * They only see the loaded window of the transcript. That is the recent end,
 * which is what a sidebar about the current work wants anyway.
 */

export interface WidgetAttachment extends DisplayAttachment {
  /** The tool result it came from, plus its index: stable across pushes. */
  key: string
}

/**
 * Every file the agent sent with send_attachments or generate_images, newest
 * first. Results travel inline with the transcript (display is an inline tool
 * kind), so nothing has to be fetched. A result that failed, or that an older
 * client cache holds trimmed, contributes nothing.
 */
export function deriveSentAttachments(entries: readonly TranscriptEntry[]): WidgetAttachment[] {
  const attachmentToolIds = new Set<string>()
  const attachments: WidgetAttachment[] = []
  for (const entry of entries) {
    if (entry.kind === "tool_call" && entry.tool.toolKind === "display" && ATTACHMENT_TOOL_NAMES.includes(entry.tool.toolName)) {
      attachmentToolIds.add(entry.tool.toolId)
      continue
    }
    if (entry.kind !== "tool_result" || entry.isError || !attachmentToolIds.has(entry.toolId)) continue
    displayAttachments(entry.content).forEach((attachment, index) => {
      attachments.push({ ...attachment, key: `${entry._id}:${index}` })
    })
  }
  return attachments.reverse()
}

/**
 * The tool call that started each task, so its row in the Tasks widget can
 * jump to it. Keyed by task id; a task missing here has no call in the
 * loaded window and its row stays static.
 *
 * Claude's task events name the call (`toolUseId`), for every kind: a
 * subagent's Agent call, a monitor's Monitor call, a workflow's Workflow call.
 * Codex and Grok key a subagent by its tool call id, so the id is the answer.
 * A Claude agent the Stop sweep found carries neither. Its spawn calls are
 * matched by type instead: the latest calls for a subagent type pair, in
 * order, with this turn's agents of that type. A turn's agents are the latest
 * spawned, so the tail of the calls is theirs.
 */
export function deriveSubagentToolIds(
  entries: readonly TranscriptEntry[],
  subagents: readonly SubagentActivity[],
): Map<string, string> {
  const callIdsByLabel = new Map<string, string[]>()
  const callIds = new Set<string>()
  const allCallIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== "tool_call") continue
    allCallIds.add(entry.tool.toolId)
    if (entry.tool.toolKind !== "subagent_task") continue
    callIds.add(entry.tool.toolId)
    const label = entry.tool.input.subagentType || entry.tool.input.description
    if (!label) continue
    const ids = callIdsByLabel.get(label) ?? []
    ids.push(entry.tool.toolId)
    callIdsByLabel.set(label, ids)
  }

  const toolIds = new Map<string, string>()
  const unmatchedByLabel = new Map<string, SubagentActivity[]>()
  const claimed = new Set<string>()
  for (const agent of subagents) {
    if (agent.toolUseId && allCallIds.has(agent.toolUseId)) {
      toolIds.set(agent.id, agent.toolUseId)
      claimed.add(agent.toolUseId)
    }
  }
  for (const agent of subagents) {
    if (toolIds.has(agent.id) || agent.toolUseId) continue
    if (callIds.has(agent.id)) {
      toolIds.set(agent.id, agent.id)
    } else if (agent.type === "subagent") {
      const agents = unmatchedByLabel.get(agent.label) ?? []
      agents.push(agent)
      unmatchedByLabel.set(agent.label, agents)
    }
  }
  for (const [label, agents] of unmatchedByLabel) {
    const calls = (callIdsByLabel.get(label) ?? []).filter((toolId) => !claimed.has(toolId))
    const tail = calls.slice(-agents.length)
    // Fewer calls than agents means the older ones are outside the window:
    // the calls still loaded belong to the newest agents.
    const offset = agents.length - tail.length
    tail.forEach((toolId, index) => toolIds.set(agents[offset + index]!.id, toolId))
  }
  return toolIds
}

/** What an Agents row and its card know about one subagent, from the transcript. */
export interface SubagentDetails {
  /** The call that spawned it: its entry, for fetching a prompt left in the sidecar. */
  spawn: ToolCallEntry
  /** The short task the caller gave it ("Audit durable.ts turn engine"). */
  description?: string
  /** "general-purpose", "Explore", … */
  subagentType?: string
  /** The full task text, when the transcript carries it inline. */
  prompt?: string
  /** Tool calls it has made so far. */
  toolCalls: number
  /** Messages it has written so far (its text, not its tool calls). */
  messages: number
  /** Its latest tool call: what it's doing now, or did last. */
  latestTool?: NormalizedToolCall
}

/**
 * Each subagent's spawn call and what it has done since, keyed by subagent
 * id. Its work is every entry whose `parentToolUseId` is the spawn call:
 * providers that don't stream a subagent's steps give zeros, not a guess.
 */
export function deriveSubagentDetails(
  entries: readonly TranscriptEntry[],
  toolIds: ReadonlyMap<string, string>,
): Map<string, SubagentDetails> {
  const byToolId = new Map<string, SubagentDetails>()
  const wanted = new Set(toolIds.values())
  for (const entry of entries) {
    if (entry.kind === "tool_call" && entry.tool.toolKind === "subagent_task" && wanted.has(entry.tool.toolId)) {
      byToolId.set(entry.tool.toolId, {
        spawn: entry,
        description: entry.tool.input.description || undefined,
        subagentType: entry.tool.input.subagentType || undefined,
        prompt: entry.tool.input.prompt || undefined,
        toolCalls: 0,
        messages: 0,
      })
      continue
    }
    const parent = entry.parentToolUseId ? byToolId.get(entry.parentToolUseId) : undefined
    if (!parent) continue
    if (entry.kind === "tool_call") {
      parent.toolCalls += 1
      parent.latestTool = entry.tool
    } else if (entry.kind === "assistant_text" && entry.text.trim()) {
      parent.messages += 1
    }
  }
  const details = new Map<string, SubagentDetails>()
  for (const [agentId, toolId] of toolIds) {
    const found = byToolId.get(toolId)
    if (found) details.set(agentId, found)
  }
  return details
}

/** What a workflow's card says at a glance, counted from its agents. */
export interface WorkflowSummary {
  total: number
  queued: number
  running: number
  done: number
  failed: number
  skipped: number
  tokens: number
  /** Where the run is: the latest phase with an agent running, else the latest one reached. */
  currentPhase?: WorkflowPhase
}

export function summarizeWorkflow(progress: WorkflowProgress | undefined): WorkflowSummary {
  const summary: WorkflowSummary = { total: 0, queued: 0, running: 0, done: 0, failed: 0, skipped: 0, tokens: 0 }
  if (!progress) return summary
  let runningPhase: number | undefined
  let reachedPhase: number | undefined
  for (const agent of progress.agents) {
    summary.total += 1
    summary[agent.state] += 1
    summary.tokens += agent.tokens ?? 0
    if (agent.phaseIndex === undefined) continue
    if (agent.state === "running") runningPhase = Math.max(runningPhase ?? agent.phaseIndex, agent.phaseIndex)
    if (agent.state !== "queued") reachedPhase = Math.max(reachedPhase ?? agent.phaseIndex, agent.phaseIndex)
  }
  const phaseIndex = runningPhase ?? reachedPhase
  const currentPhase = phaseIndex === undefined ? undefined : progress.phases.find((phase) => phase.index === phaseIndex)
  if (currentPhase) summary.currentPhase = currentPhase
  return summary
}

/** How long a workflow agent has run, or ran. Null until it starts. */
export function workflowAgentElapsed(agent: WorkflowAgent, now: number): number | null {
  if (agent.durationMs !== undefined) return agent.durationMs
  if (agent.startedAt === undefined) return null
  if (agent.state === "running") return Math.max(0, now - agent.startedAt)
  return agent.lastProgressAt !== undefined ? Math.max(0, agent.lastProgressAt - agent.startedAt) : null
}

/** "940", "12.4k", "1.3M": a token count at the width of a row's meta. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/**
 * The Tasks card's log order: what is running, then what finished, each
 * newest first. The log runs across turns, so a long-lived monitor can be
 * the oldest entry and still the one that matters most.
 */
export function orderTaskLog(tasks: readonly SubagentActivity[]): SubagentActivity[] {
  return tasks
    .filter((task) => !task.workflowId)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt)
}

/**
 * The runs the Workflow card opens up: every one still running, or when none
 * is, the latest to have run, whether its turn is going or long over.
 */
export function latestWorkflows(tasks: readonly SubagentActivity[]): SubagentActivity[] {
  const workflows = tasks.filter((task) => task.type === "workflow" && task.workflow)
  const running = workflows.filter((task) => task.status === "running")
  if (running.length > 0) return running.sort((a, b) => a.startedAt - b.startedAt)
  const latest = workflows.reduce<SubagentActivity | undefined>((newest, task) => (!newest || task.startedAt > newest.startedAt ? task : newest), undefined)
  return latest ? [latest] : []
}

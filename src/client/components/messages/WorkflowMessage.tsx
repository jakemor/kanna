import { useEffect, useMemo, useState } from "react"
import { ChevronRight, CircleCheck, CircleX, Pause, Workflow as WorkflowIcon } from "lucide-react"
import type { HydratedTranscriptMessage, WorkflowAgentSnapshot, WorkflowRunStatus } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"

type WorkflowStateMessage = Extract<HydratedTranscriptMessage, { kind: "workflow_state" }>

interface Props {
  message: WorkflowStateMessage
}

// Local copy: upstream has no shared formatDuration export.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0) parts.push(`${seconds}s`)
  return parts.join(" ") || "0s"
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)}`
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`
}

function formatShortDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "—"
  if (ms < 1000) return "<1s"
  return formatDuration(ms)
}

function statusIcon(status: WorkflowRunStatus) {
  if (status === "completed") return <CircleCheck className="size-4 shrink-0 text-emerald-500" />
  if (status === "failed" || status === "killed") return <CircleX className="size-4 shrink-0 text-destructive" />
  if (status === "paused") return <Pause className="size-4 shrink-0 text-muted-icon" />
  return <WorkflowIcon className="size-4 shrink-0 text-muted-icon" />
}

function agentDotClass(state: WorkflowAgentSnapshot["state"]): string {
  switch (state) {
    case "done": return "bg-emerald-500"
    case "error": return "bg-destructive"
    case "running": return "bg-amber-400 animate-pulse"
    default: return "bg-muted-foreground/25"
  }
}

const MAX_GRID_DOTS = 200

/** Live elapsed while running; frozen at the last snapshot's age once terminal. */
function useElapsedMs(message: WorkflowStateMessage): number {
  const running = message.status === "running" || message.status === "pending"
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])

  if (!running) return Math.max(0, message.revision - message.startedAtMs)
  return Math.max(0, now - message.startedAtMs)
}

function AgentRow({ agent }: { agent: WorkflowAgentSnapshot }) {
  return (
    <tr className="border-t border-border/50">
      <td className="flex min-w-0 items-center gap-1.5 py-1 pr-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", agentDotClass(agent.state))} />
        <span className="min-w-0 truncate" title={agent.error ?? agent.promptPreview}>
          {agent.label}
        </span>
        {agent.error ? <span className="min-w-0 truncate text-destructive/80" title={agent.error}>{agent.error}</span> : null}
      </td>
      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums text-muted-foreground">
        {agent.tokens !== undefined && agent.tokens > 0 ? formatTokens(agent.tokens) : "—"}
      </td>
      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums text-muted-foreground">
        {agent.toolCalls ?? 0}
      </td>
      <td className="whitespace-nowrap py-1 text-right tabular-nums text-muted-foreground">
        {formatShortDuration(agent.durationMs)}
      </td>
    </tr>
  )
}

export function WorkflowMessage({ message }: Props) {
  const [expanded, setExpanded] = useState(false)
  const elapsedMs = useElapsedMs(message)
  const running = message.status === "running" || message.status === "pending"

  const agents = message.agents
  const totalTokens = useMemo(() => {
    const agentSum = agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0)
    return Math.max(message.usage?.totalTokens ?? 0, agentSum)
  }, [agents, message.usage?.totalTokens])

  const phaseGroups = useMemo(() => {
    const groups = new Map<number, { title: string | null; agents: WorkflowAgentSnapshot[] }>()
    for (const phase of message.phases) {
      groups.set(phase.index, { title: phase.title, agents: [] })
    }
    for (const agent of agents) {
      const key = agent.phaseIndex ?? 0
      let group = groups.get(key)
      if (!group) {
        group = { title: agent.phaseTitle ?? null, agents: [] }
        groups.set(key, group)
      }
      group.agents.push(agent)
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, group]) => group)
      .filter((group) => group.agents.length > 0)
  }, [agents, message.phases])

  const name = message.workflowName ?? "workflow"
  const metaParts = [
    "Workflow",
    agents.length > 0 ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : null,
    elapsedMs > 0 ? formatShortDuration(elapsedMs) : null,
    totalTokens > 0 ? `${formatTokens(totalTokens)} tokens` : null,
  ].filter(Boolean)

  return (
    <div className="my-1 w-full max-w-xl rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="group/workflow flex w-full min-w-0 cursor-pointer items-center gap-2.5 text-left"
        aria-expanded={expanded}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          {statusIcon(message.status)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            <AnimatedShinyText animate={running}>{name}</AnimatedShinyText>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {metaParts.map((part, index) => (
              <span key={part} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums">
                {index > 0 ? <span className="text-muted-foreground/50">·</span> : null}
                {part}
              </span>
            ))}
          </span>
        </span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-icon transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
      </button>

      {agents.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-[3px] pl-[30px]" aria-hidden>
          {agents.slice(0, MAX_GRID_DOTS).map((agent) => (
            <span
              key={agent.index}
              className={cn("size-[7px] rounded-[2px]", agentDotClass(agent.state))}
              title={`${agent.label}: ${agent.state}`}
            />
          ))}
          {agents.length > MAX_GRID_DOTS ? (
            <span className="text-[9px] leading-none text-muted-foreground">+{agents.length - MAX_GRID_DOTS}</span>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-2.5 border-t border-border/60 pt-2 pl-[30px]">
          {message.description ? (
            <p className="mb-2 text-xs text-muted-foreground">{message.description}</p>
          ) : null}
          {phaseGroups.map((group, groupIndex) => (
            <div key={group.title ?? groupIndex} className={cn(groupIndex > 0 && "mt-3")}>
              {group.title ? (
                <div className="mb-1 text-xs font-medium text-foreground/80">{group.title}</div>
              ) : null}
              <table className="w-full table-fixed text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="w-auto pb-1 font-medium">Agent</th>
                    <th className="w-16 pb-1 pr-2 text-right font-medium">Tokens</th>
                    <th className="w-12 pb-1 pr-2 text-right font-medium">Tools</th>
                    <th className="w-14 pb-1 text-right font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {group.agents.map((agent) => <AgentRow key={agent.index} agent={agent} />)}
                </tbody>
              </table>
            </div>
          ))}
          {message.summary ? (
            <p className="mt-2 text-xs text-muted-foreground">{message.summary}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

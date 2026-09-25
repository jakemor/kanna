import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Loader2, MessageSquare, Network, Radar, Square, X, type LucideIcon } from "lucide-react"
import type { SubagentActivity, TranscriptEntry } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { formatToolCallTitle } from "../../messages/ToolCallMessage"
import { useToolPayload } from "../../messages/tool-payload-context"
import { ContextMenuItem } from "../../ui/context-menu"
import { TURN_CARD_ROW_INSET, TurnCardMetaRow, TurnCardMetaSeparator } from "../../ui/turn-card"
import { deriveSubagentDetails, formatTokens, summarizeWorkflow, type SubagentDetails } from "./derive"
import { WIDGET_ROW_REVEAL_CLASS, WidgetError, WidgetList, WidgetMoreRow, WidgetRow } from "./parts"
import type { StopTaskControl } from "./useStopTask"
import { SwapIn, WidgetCard } from "./WidgetCard"
import { WidgetHoverCard } from "./WidgetHoverCard"

/**
 * What runs on the chat's behalf: subagents, background shells, monitors,
 * workflows. Everything the provider reports as a task, as a log that runs
 * across turns: what is running first, then what finished, newest first.
 *
 * The main agent's result lands as soon as *it* stops, so a turn can read as
 * finished while the work it kicked off runs on. This widget makes that
 * visible: while anything is running the chat is not done, whatever the turn
 * status says.
 *
 * A workflow's own agents are on its card (WorkflowWidget), not here: here it
 * is one row, one thing running.
 */

/** Elapsed time, re-rendered on a 1s tick only while something is running. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Rows the Tasks log shows before "Show more". */
const TASK_LOG_ROWS = 5

/** "3 of 5 running" while some run, "3 running" while all do, then the total. */
export function formatTasksCount(tasks: readonly SubagentActivity[]): string {
  const running = tasks.filter((task) => task.status === "running").length
  if (running === 0) return String(tasks.length)
  return running === tasks.length ? `${running} running` : `${running} of ${tasks.length} running`
}

/** The word a row puts under its title for each kind, as Claude Code names them. */
const KIND_NAMES: Record<string, string> = {
  subagent: "Agent",
  monitor: "Monitor",
  shell: "Shell",
  workflow: "Workflow",
}

export function taskKindName(type: string): string {
  return KIND_NAMES[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`
}

interface StatusIcon {
  Icon: LucideIcon
  className: string
  label: string
}

export const TASK_STATUS_ICON: Record<SubagentActivity["status"], StatusIcon> = {
  // Grey: work in progress is the normal state here, not something to flag.
  running: { Icon: Loader2, className: "animate-spin text-muted-foreground", label: "Running" },
  completed: { Icon: Check, className: "text-success", label: "Done" },
  failed: { Icon: X, className: "text-destructive", label: "Failed" },
  // Someone chose to end it: not an outcome to flag in red or green.
  stopped: { Icon: Square, className: "text-muted-foreground", label: "Stopped" },
}

/**
 * A monitor waits on something else (a log line, a CI run) rather than works
 * toward an end, so it doesn't spin while it runs: it watches, in the same
 * grey a running task gets. It ends like anything else, in a check or an X.
 */
const MONITOR_RUNNING_ICON: StatusIcon = { Icon: Radar, className: "text-muted-foreground", label: "Watching" }
const STOPPING_ICON: StatusIcon = { Icon: Loader2, className: "animate-spin text-muted-foreground", label: "Stopping" }

function statusIcon(task: SubagentActivity, stopping: boolean): StatusIcon {
  if (task.status === "running" && stopping) return STOPPING_ICON
  if (task.status === "running" && task.type === "monitor") return MONITOR_RUNNING_ICON
  return TASK_STATUS_ICON[task.status]
}

/** "1 tool call", "12 messages". */
function countLabel(count: number, noun: string) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`
}

/** The row's title: the task it was given, not its kind ("general-purpose" six times says nothing). */
function taskTitle(task: SubagentActivity, details: SubagentDetails | undefined): string {
  if (task.type === "workflow") return task.workflow?.name ?? task.label
  return details?.description ?? task.description ?? task.label
}

/**
 * The line under a row's title. A subagent needs none: the title says what it
 * does, and the column is mostly them. Every other kind says what it is, since
 * "Watch the deploy log" could be a monitor or a shell, and a workflow says
 * how far it has got.
 */
function taskSubtitle(task: SubagentActivity): string | undefined {
  if (task.type === "subagent") return task.summary
  const kind = taskKindName(task.type)
  if (task.type === "workflow") {
    const summary = summarizeWorkflow(task.workflow)
    if (summary.total === 0) return task.status === "running" ? `${kind} · Starting` : kind
    const phase = task.status === "running" && summary.currentPhase ? ` · ${summary.currentPhase.title}` : ""
    return `${kind} · ${summary.done} of ${summary.total} agents${phase}`
  }
  return task.summary ? `${kind} · ${task.summary}` : kind
}

/**
 * A subagent's card: what it was asked (the prompt, clamped), what it has
 * done (calls and messages so far, and its latest step), and when it started
 * and for how long it has run.
 */
export function AgentHoverCardContent({
  agent,
  details,
  prompt,
  now,
  canJump,
}: {
  agent: SubagentActivity
  details: SubagentDetails
  /** The full prompt, once fetched when the transcript left it in the sidecar. */
  prompt?: string
  now: number
  canJump: boolean
}) {
  const running = agent.status === "running"
  const latest = details.latestTool ? formatToolCallTitle(details.latestTool) : null
  return (
    <>
      <TurnCardMetaRow>
        <span className="truncate">{details.subagentType ?? agent.label}</span>
        <TurnCardMetaSeparator />
        <span className="shrink-0">{TASK_STATUS_ICON[agent.status].label}</span>
        <span className="ml-auto shrink-0 pl-2 tabular-nums">
          {formatPromptTimestamp(new Date(agent.startedAt).toISOString())} · {formatElapsed((agent.endedAt ?? now) - agent.startedAt)}
        </span>
      </TurnCardMetaRow>
      {/* The task in full, which the row cuts to one line. */}
      {details.description ? (
        <div className={cn("mt-1 line-clamp-3 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET)}>{details.description}</div>
      ) : null}
      {/* What it was told: the start of the prompt, as much as a card holds. */}
      {prompt ? (
        <div className={cn("mt-0.5 line-clamp-[8] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>{prompt.trim()}</div>
      ) : null}
      <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden />
      <TurnCardMetaRow className="mt-1.5">
        <span>{countLabel(details.toolCalls, "tool call")}</span>
        <TurnCardMetaSeparator />
        <span>{countLabel(details.messages, "message")}</span>
        {agent.usage?.totalTokens ? (
          <>
            <TurnCardMetaSeparator />
            <span>{formatTokens(agent.usage.totalTokens)} tokens</span>
          </>
        ) : null}
      </TurnCardMetaRow>
      {latest ? (
        <div className={cn("truncate text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET)}>
          <span className="text-muted-foreground/70">{running ? "Now" : "Last"}</span> {latest}
        </div>
      ) : running ? (
        <div className={cn("text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET)}>No steps yet</div>
      ) : null}
      {canJump ? (
        <TurnCardMetaRow className="mt-1">
          <span>Click to show in chat</span>
        </TurnCardMetaRow>
      ) : null}
    </>
  )
}

/** Fetches the prompt when the transcript holds only the spawn call's header. */
function AgentHoverCardBody(props: Omit<Parameters<typeof AgentHoverCardContent>[0], "prompt">) {
  const { spawn } = props.details
  const full = useToolPayload(!props.details.prompt && spawn.trimmed ? spawn._id : undefined)
  const fetched = full?.kind === "tool_call" && full.tool.toolKind === "subagent_task" ? full.tool.input.prompt : undefined
  return <AgentHoverCardContent {...props} prompt={props.details.prompt ?? fetched} />
}

/**
 * Any other task's card: its kind and state, what it was started to do in
 * full, its latest status, and what it has used. A workflow's adds where its
 * run has got; its agents are on its own card.
 */
export function TaskHoverCardContent({ task, now, canJump }: { task: SubagentActivity; now: number; canJump: boolean }) {
  const title = taskTitle(task, undefined)
  const workflow = task.type === "workflow" ? summarizeWorkflow(task.workflow) : null
  const phases = task.workflow?.phases ?? []
  const phaseNumber = workflow?.currentPhase ? phases.findIndex((phase) => phase.index === workflow.currentPhase!.index) + 1 : 0
  const status = task.status === "running" && task.type === "monitor" ? MONITOR_RUNNING_ICON : TASK_STATUS_ICON[task.status]
  const tokens = workflow?.tokens || task.usage?.totalTokens
  return (
    <>
      <TurnCardMetaRow>
        <span className="truncate">{taskKindName(task.type)}</span>
        <TurnCardMetaSeparator />
        <span className="shrink-0">{status.label}</span>
        <span className="ml-auto shrink-0 pl-2 tabular-nums">
          {formatPromptTimestamp(new Date(task.startedAt).toISOString())} · {formatElapsed((task.endedAt ?? now) - task.startedAt)}
        </span>
      </TurnCardMetaRow>
      <div className={cn("mt-1 line-clamp-3 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET)}>{title}</div>
      {task.description && task.description !== title ? (
        <div className={cn("mt-0.5 line-clamp-[6] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>{task.description}</div>
      ) : null}
      {task.summary ? (
        <div className={cn("mt-1 line-clamp-4 whitespace-pre-wrap text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET)}>{task.summary}</div>
      ) : null}
      {(workflow && workflow.total > 0) || task.usage || tokens ? (
        <>
          <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden />
          <TurnCardMetaRow className="mt-1.5">
            {workflow && workflow.total > 0 ? (
              <span>{workflow.done} of {countLabel(workflow.total, "agent")} done</span>
            ) : task.usage ? (
              <span>{countLabel(task.usage.toolUses, "tool call")}</span>
            ) : null}
            {tokens ? (
              <>
                <TurnCardMetaSeparator />
                <span>{formatTokens(tokens)} tokens</span>
              </>
            ) : null}
          </TurnCardMetaRow>
          {workflow?.currentPhase ? (
            <div className={cn("truncate text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET)}>
              <span className="text-muted-foreground/70">Phase {phaseNumber} of {phases.length}</span> {workflow.currentPhase.title}
            </div>
          ) : null}
        </>
      ) : null}
      {canJump ? (
        <TurnCardMetaRow className="mt-1">
          <span>Click to show in chat</span>
        </TurnCardMetaRow>
      ) : null}
    </>
  )
}

export function TasksWidget({
  tasks,
  toolIds,
  entries,
  stopControl,
  onJumpToToolCall,
}: {
  /** The tasks this widget lists: a workflow's own agents are left out upstream. */
  tasks: readonly SubagentActivity[]
  /** Task id → the tool call that started it, for the ones found in the loaded transcript. */
  toolIds: ReadonlyMap<string, string>
  /** The loaded transcript: each subagent's task, prompt and steps so far. */
  entries: readonly TranscriptEntry[]
  stopControl: StopTaskControl
  onJumpToToolCall: (toolId: string) => void
}) {
  const now = useNow(tasks.some((task) => task.status === "running"))
  const details = useMemo(() => deriveSubagentDetails(entries, toolIds), [entries, toolIds])
  const listRef = useRef<HTMLDivElement | null>(null)
  const { stopping, stop, error } = stopControl
  // A log that runs across turns grows long; the newest few are what you
  // came for. Whatever is running always shows, however many that is.
  const [showAll, setShowAll] = useState(false)
  const collapsedCount = Math.max(TASK_LOG_ROWS, tasks.filter((task) => task.status === "running").length)
  const shown = showAll ? tasks : tasks.slice(0, collapsedCount)
  return (
    <WidgetCard
      // Static: the rows already spin for what is running, and a spinning
      // header too read as the main agent being busy.
      icon={<Network />}
      title="Tasks"
      count={formatTasksCount(tasks)}
    >
      <WidgetList listRef={listRef}>
        {error ? <WidgetError>{error}</WidgetError> : null}
        {shown.map((task, index) => {
          const isStopping = stopping.has(task.id)
          const { Icon, className, label } = statusIcon(task, isStopping)
          const toolId = toolIds.get(task.id)
          const taskDetails = task.type === "subagent" ? details.get(task.id) : undefined
          const title = taskTitle(task, taskDetails)
          const kind = taskKindName(task.type)
          const canStop = task.status === "running" && task.stoppable && !isStopping
          return (
            <WidgetRow
              key={task.id}
              rowKey={task.id}
              className={index >= collapsedCount ? WIDGET_ROW_REVEAL_CLASS : undefined}
              icon={(
                <SwapIn swapKey={isStopping ? "stopping" : task.status}>
                  <Icon role="img" className={className} aria-label={label} />
                </SwapIn>
              )}
              title={title}
              subtitle={taskSubtitle(task)}
              meta={isStopping ? "Stopping…" : formatElapsed((task.endedAt ?? now) - task.startedAt)}
              // Opens the chat at the call that started it: a list of labels
              // with timers otherwise leaves "where is that?" open.
              onActivate={toolId ? () => onJumpToToolCall(toolId) : undefined}
              // Every row has a card, which says it all; a native tooltip on
              // top would be a second popover.
              menuLabel={`${kind} actions`}
              menu={canStop ? (
                <>
                  {toolId ? (
                    <ContextMenuItem onSelect={() => onJumpToToolCall(toolId)}>
                      <MessageSquare className="size-3.5" />
                      <span>Show in Chat</span>
                    </ContextMenuItem>
                  ) : null}
                  <ContextMenuItem onSelect={() => stop(task.id)} className="text-destructive focus:text-destructive">
                    <Square className="size-3.5" />
                    <span>Stop {kind}</span>
                  </ContextMenuItem>
                </>
              ) : undefined}
            />
          )
        })}
        {tasks.length > collapsedCount ? (
          <WidgetMoreRow
            count={tasks.length - collapsedCount}
            shown={showAll}
            onShow={() => setShowAll(true)}
            onHide={() => setShowAll(false)}
          />
        ) : null}
      </WidgetList>
      <WidgetHoverCard containerRef={listRef}>
        {(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId)
          if (!task) return null
          const canJump = toolIds.has(taskId)
          const taskDetails = task.type === "subagent" ? details.get(taskId) : undefined
          if (taskDetails) return <AgentHoverCardBody agent={task} details={taskDetails} now={now} canJump={canJump} />
          return <TaskHoverCardContent task={task} now={now} canJump={canJump} />
        }}
      </WidgetHoverCard>
    </WidgetCard>
  )
}

import { useEffect, useRef, type Ref } from "react"
import { Loader2, Square, Workflow as WorkflowIcon } from "lucide-react"
import type { SubagentActivity, WorkflowAgent, WorkflowAgentState } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { Button } from "../../ui/button"
import { TURN_CARD_ROW_INSET, TurnCardMetaRow, TurnCardMetaSeparator } from "../../ui/turn-card"
import { formatTokens, summarizeWorkflow, workflowAgentElapsed, type WorkflowSummary } from "./derive"
import { WidgetStatic } from "./parts"
import { formatElapsed, TASK_STATUS_ICON, useNow } from "./TasksWidget"
import type { StopTaskControl } from "./useStopTask"
import { SwapIn, WidgetGroup, WidgetSection } from "./WidgetCard"
import { WidgetHoverCard } from "./WidgetHoverCard"

/**
 * Claude workflows: scripts that fan a job out to many agents in phases
 * ("review each file, then verify each finding"). The Tasks card has each run
 * as one row; this card opens it up, one section per run: a tile per agent,
 * and one line saying where the run is, how long it has taken and what it has
 * used. An agent's detail is on its tile's hover card, not in a list: a row
 * per agent said again what the tile and its card already say.
 *
 * It follows the run as the CLI reports it: an agent is queued, then running,
 * then done or failed, and a phase's agents arrive as the phase starts. It
 * shows every run still going, or when none is, the latest one, whether its
 * turn is going or long over (latestWorkflows).
 */

const AGENT_STATE_LABEL: Record<WorkflowAgentState, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
}

/**
 * The tiles' fills. Queued and skipped stay faint, like the empty days of a
 * contribution graph, so the grid reads as filling up. Running is a mid grey
 * that breathes (kanna-tile-pulse): red read as an alarm. Done is the full
 * green (a softened one looked washed out) and failed the full red.
 */
const TILE_CLASS: Record<WorkflowAgentState, string> = {
  queued: "bg-muted-foreground/15",
  running: "bg-muted-foreground/55 kanna-tile-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/[0.07]",
}

/** Past this many the grid would outgrow the card; the rest is a count. */
const MAX_TILES = 200

/**
 * "5/7": agents done of agents so far. Short enough never to truncate beside
 * a long name; the pulsing tiles already say whether any are running.
 */
export function formatWorkflowCount(summary: WorkflowSummary): string | undefined {
  if (summary.total === 0) return undefined
  return `${summary.done}/${summary.total}`
}

/** The ended run's word for the status line, and the Tasks row's. */
const OUTCOME_WORD: Record<Exclude<SubagentActivity["status"], "running">, string> = {
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
}

/**
 * Where the run is, for the status line: its phase while it runs ("Phase 2
 * of 3 Score"), how it ended once it has ("Failed · 5 of 7 done, 1 failed").
 */
function workflowStatus(workflow: SubagentActivity, summary: WorkflowSummary, phases: readonly { index: number }[], stopping: boolean) {
  const tally = `${summary.done} of ${summary.total} done${summary.failed ? `, ${summary.failed} failed` : ""}`
  if (workflow.status !== "running") {
    return summary.total > 0 ? `${OUTCOME_WORD[workflow.status]} · ${tally}` : OUTCOME_WORD[workflow.status]
  }
  if (stopping) return "Stopping…"
  if (summary.total === 0) return "Starting…"
  if (!summary.currentPhase) return tally
  const number = phases.findIndex((phase) => phase.index === summary.currentPhase!.index) + 1
  return <><span className="text-muted-foreground/70">Phase {number} of {phases.length}</span> {summary.currentPhase.title}</>
}

export function WorkflowWidget({
  workflows,
  stopControl,
}: {
  /** The runs to show, oldest first. */
  workflows: readonly SubagentActivity[]
  stopControl: StopTaskControl
}) {
  const now = useNow(workflows.some((workflow) => workflow.status === "running"))
  return (
    <WidgetGroup>
      {workflows.map((workflow) => (
        <WorkflowSection key={workflow.id} workflow={workflow} now={now} stopControl={stopControl} />
      ))}
    </WidgetGroup>
  )
}

function WorkflowSection({
  workflow,
  now,
  stopControl,
}: {
  workflow: SubagentActivity
  now: number
  stopControl: StopTaskControl
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const tileGridRef = useRef<HTMLDivElement | null>(null)
  const progress = workflow.workflow ?? { phases: [], agents: [] }
  const summary = summarizeWorkflow(progress)
  const running = workflow.status === "running"
  const stopping = running && stopControl.stopping.has(workflow.id)
  // Tiles a phase adds grow in. The ones already there when the card mounted
  // don't, or opening the column would grow the whole run in. Marked seen
  // after they first paint.
  const seenRef = useRef<Set<number> | null>(null)
  seenRef.current ??= new Set(progress.agents.map((agent) => agent.index))
  const seen = seenRef.current
  useEffect(() => {
    for (const agent of progress.agents) seen.add(agent.index)
  })
  const outcome = TASK_STATUS_ICON[workflow.status]
  const elapsed = formatElapsed((workflow.endedAt ?? now) - workflow.startedAt)

  return (
    <WidgetSection
      icon={<WorkflowIcon />}
      title={progress.name ?? workflow.label}
      count={formatWorkflowCount(summary)}
      actions={running ? (
        workflow.stoppable ? (
          <Button
            type="button"
            variant="ghost"
            size="none"
            disabled={stopping}
            aria-label="Stop workflow"
            title="Stop workflow"
            onClick={() => stopControl.stop(workflow.id)}
            className="size-6 justify-center rounded-md p-0 text-muted-foreground transition-[color,scale] duration-150 ease-snappy hover:text-destructive active:scale-[0.97]"
          >
            <SwapIn swapKey={stopping ? "stopping" : "stop"}>
              {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
            </SwapIn>
          </Button>
        ) : undefined
      ) : (
        <span className="flex size-6 items-center justify-center">
          <SwapIn swapKey={workflow.status}>
            <outcome.Icon role="img" aria-label={outcome.label} className={cn("size-4", outcome.className)} />
          </SwapIn>
        </span>
      )}
    >
      {/* Always a body, even before the first agent: the status line has the
          run's time. A section with an empty body drew its divider over the
          card's own edge, a doubled line. */}
      <div ref={bodyRef}>
        <WidgetStatic className="flex flex-col gap-2">
          {summary.total > 0 ? (
            <WorkflowTiles agents={progress.agents} summary={summary} ended={!running} isNew={(index) => !seen.has(index)} gridRef={tileGridRef} />
          ) : null}
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{workflowStatus(workflow, summary, progress.phases, stopping)}</span>
            <span className="ml-auto shrink-0 pl-2 tabular-nums">
              {elapsed}
              {summary.tokens > 0 ? ` · ${formatTokens(summary.tokens)} tokens` : ""}
            </span>
          </div>
        </WidgetStatic>
        <WidgetHoverCard containerRef={tileGridRef} alignTo={bodyRef}>
          {(rowKey) => {
            const agent = progress.agents.find((candidate) => String(candidate.index) === rowKey)
            if (!agent) return null
            const phase = progress.phases.find((candidate) => candidate.index === agent.phaseIndex)
            return <WorkflowAgentCardContent agent={agent} phaseTitle={phase?.title} now={now} />
          }}
        </WidgetHoverCard>
      </div>
    </WidgetSection>
  )
}

/**
 * The run as a grid of tiles, one per agent, in the order the script runs
 * them, like a contribution graph: at a glance, how far it has got, what is
 * running now and whether anything failed. Hovering a tile opens the agent's
 * card.
 *
 * A tile changes colour with a short ease when its agent moves on, and one a
 * phase adds grows in from 75%. Nothing else moves. An ended run's grid dims,
 * so a live card and a finished one tell apart at a glance. Each tile sits in
 * a cell that touches its neighbours, so the pointer never crosses dead space
 * between two tiles and the card never drops out on the way across.
 */
export function WorkflowTiles({
  agents,
  summary,
  ended,
  isNew,
  gridRef,
}: {
  agents: readonly WorkflowAgent[]
  summary: WorkflowSummary
  ended: boolean
  /** A tile not yet painted, which enters rather than appears. */
  isNew: (index: number) => boolean
  gridRef?: Ref<HTMLDivElement>
}) {
  const label = `${summary.done} of ${summary.total} agents done${summary.failed ? `, ${summary.failed} failed` : ""}`
  const shown = agents.slice(0, MAX_TILES)
  return (
    <div
      ref={gridRef}
      role="img"
      aria-label={label}
      className={cn("-m-[1.5px] flex flex-wrap items-center transition-opacity duration-200 ease-snappy", ended && "opacity-60")}
    >
      {shown.map((agent) => (
        <span key={agent.index} data-row-key={String(agent.index)} className="group/tile p-[1.5px]">
          <span
            className={cn(
              // The ring lights the tile the card describes, instantly, as a
              // row's highlight does. It stands off the tile by a pixel of the
              // card's own colour, so it contrasts with the card, whatever the
              // tile's fill: drawn on the tile's edge, it all but vanished
              // against the green. Raised, so a neighbour can't paint over it.
              "block size-3 rounded-[3px] transition-[background-color,opacity,scale] duration-200 ease-snappy group-hover/tile:relative group-hover/tile:z-10 group-hover/tile:ring-1 group-hover/tile:ring-foreground group-hover/tile:ring-offset-1 group-hover/tile:ring-offset-background dark:group-hover/tile:ring-offset-card",
              TILE_CLASS[agent.state],
              isNew(agent.index) && "starting:scale-75 starting:opacity-0 motion-reduce:starting:scale-100",
            )}
          />
        </span>
      ))}
      {agents.length > shown.length ? (
        <span className="pl-1 text-[10px] leading-none tabular-nums text-muted-foreground">+{agents.length - shown.length}</span>
      ) : null}
    </div>
  )
}

/**
 * One agent's card: its phase and state, the model it ran on, its label in
 * full, the start of what it was told, what it has used, and how it ended.
 */
export function WorkflowAgentCardContent({ agent, phaseTitle, now }: { agent: WorkflowAgent; phaseTitle?: string; now: number }) {
  const elapsed = workflowAgentElapsed(agent, now)
  const state = AGENT_STATE_LABEL[agent.state]
  const hasUsage = agent.toolCalls !== undefined || agent.tokens !== undefined
  return (
    <>
      <TurnCardMetaRow>
        <span className="truncate">{phaseTitle ?? `Agent ${agent.index}`}</span>
        <TurnCardMetaSeparator />
        <span className="shrink-0">{agent.cached ? "Cached" : state}</span>
        {agent.model ? (
          <>
            <TurnCardMetaSeparator />
            <span className="truncate">{agent.model}</span>
          </>
        ) : null}
        {agent.startedAt !== undefined ? (
          <span className="ml-auto shrink-0 pl-2 tabular-nums">
            {formatPromptTimestamp(new Date(agent.startedAt).toISOString())}
            {elapsed !== null ? ` · ${formatElapsed(elapsed)}` : ""}
          </span>
        ) : null}
      </TurnCardMetaRow>
      <div className={cn("mt-1 line-clamp-3 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET)}>{agent.label}</div>
      {agent.promptPreview ? (
        <div className={cn("mt-0.5 line-clamp-[6] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>{agent.promptPreview}</div>
      ) : null}
      {hasUsage || agent.error || agent.resultPreview ? <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden /> : null}
      {hasUsage ? (
        <TurnCardMetaRow className="mt-1.5">
          <span>{(agent.toolCalls ?? 0).toLocaleString()} tool call{agent.toolCalls === 1 ? "" : "s"}</span>
          {agent.tokens ? (
            <>
              <TurnCardMetaSeparator />
              <span>{formatTokens(agent.tokens)} tokens</span>
            </>
          ) : null}
        </TurnCardMetaRow>
      ) : null}
      {agent.error ? (
        <div className={cn("mt-0.5 line-clamp-4 whitespace-pre-wrap text-[12px] text-destructive", TURN_CARD_ROW_INSET)}>{agent.error}</div>
      ) : agent.resultPreview ? (
        <div className={cn("mt-0.5 line-clamp-4 whitespace-pre-wrap text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET)}>
          <span className="text-muted-foreground/70">Result</span> {agent.resultPreview}
        </div>
      ) : null}
    </>
  )
}

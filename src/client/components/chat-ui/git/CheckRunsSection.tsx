import { useEffect, useState } from "react"
import { Check, CircleSlash, Minus, X } from "lucide-react"
import type { ChatCheckRun, ChatCheckRunState, ChatCommitChecks } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { formatDuration } from "../../messages/ResultMessage"
import { TURN_CARD_ROW_INSET } from "../../ui/turn-card"

/** Enough to show every failing job on most repos without the card running off the screen. */
export const VISIBLE_CHECK_RUN_COUNT = 8

// What needs a look first: broken, then still running, then the rest.
const STATE_RANK: Record<ChatCheckRunState, number> = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }

/** Failing first, then running; GitHub's order within each, which keeps a workflow's jobs together. */
export function sortCheckRuns(runs: readonly ChatCheckRun[]): ChatCheckRun[] {
  return [...runs].sort((left, right) => STATE_RANK[left.state] - STATE_RANK[right.state])
}

/**
 * The rollup the section's header states. The History row's own rollup when
 * there is one, since GitHub counts past the 100 checks a read lists;
 * otherwise worked out from the runs.
 */
export function rollupFromRuns(runs: readonly ChatCheckRun[]): ChatCommitChecks {
  const passed = runs.filter((run) => run.state === "success").length
  const state = runs.some((run) => run.state === "failure")
    ? "failure"
    : runs.some((run) => run.state === "pending") ? "pending" : "success"
  return { state, passed, total: runs.length }
}

/** The right edge of a row: how long a finished job took, or what an unfinished one is doing. */
export function describeCheckRunTiming(run: ChatCheckRun): string | null {
  if (run.state === "skipped") return "skipped"
  if (run.state === "pending") return run.startedAt ? "running" : "pending"
  if (!run.startedAt || !run.completedAt) return null
  const elapsed = Date.parse(run.completedAt) - Date.parse(run.startedAt)
  // A job GitHub never really started reports the same instant for both.
  return Number.isFinite(elapsed) && elapsed >= 1_000 ? formatDuration(elapsed) : null
}

function CheckRunGlyph({ state }: { state: ChatCheckRunState }) {
  // A fixed 10px box, as CheckRollupLabel's, so names line up whatever the glyph.
  return (
    <span className="flex size-2.5 shrink-0 items-center justify-center" aria-hidden>
      {state === "success"
        ? <Check className="size-2.5 text-success" strokeWidth={2.5} />
        : state === "failure"
          ? <X className="size-2.5 text-destructive" strokeWidth={2.5} />
          : state === "pending"
            ? <span className="size-1.5 rounded-full bg-amber-500" />
            : state === "skipped"
              ? <CircleSlash className="size-2.5 opacity-60" strokeWidth={2.5} />
              : <Minus className="size-2.5 opacity-60" strokeWidth={2.5} />}
    </span>
  )
}

/** How many of the runs are in each state, for the header's tallies and ring. */
export function countCheckRuns(runs: readonly ChatCheckRun[]): Record<ChatCheckRunState, number> {
  const counts: Record<ChatCheckRunState, number> = { success: 0, failure: 0, pending: 0, skipped: 0, neutral: 0 }
  for (const run of runs) counts[run.state] += 1
  return counts
}

/**
 * How long CI took, start to finish on the wall clock: from the first job
 * starting to the last one ending, so jobs that ran side by side count once
 * rather than adding up. Runs to `now` while anything hasn't finished. Null
 * when GitHub gave no times (commit statuses carry none).
 */
export function checksWallClock(runs: readonly ChatCheckRun[], now = Date.now()): { ms: number; running: boolean } | null {
  const starts = runs.map((run) => Date.parse(run.startedAt ?? "")).filter(Number.isFinite)
  if (starts.length === 0) return null
  const running = runs.some((run) => run.state === "pending")
  const ends = runs.map((run) => Date.parse(run.completedAt ?? "")).filter(Number.isFinite)
  const end = running ? now : Math.max(...ends)
  const ms = end - Math.min(...starts)
  return Number.isFinite(ms) && ms >= 0 ? { ms, running } : null
}

/** A clock that ticks each second while `active`, for a duration still counting. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [active])
  return now
}

// The ring's order and colours, clockwise from the top: passed, then what
// went wrong, then what's still going, then what never ran.
const RING_SEGMENTS: ReadonlyArray<{ state: ChatCheckRunState; className: string }> = [
  { state: "success", className: "stroke-success" },
  { state: "failure", className: "stroke-destructive" },
  { state: "pending", className: "stroke-amber-500" },
  { state: "neutral", className: "stroke-muted-foreground/50" },
  { state: "skipped", className: "stroke-muted-foreground/30" },
]

const RING_RADIUS = 4.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The runs as a ring in the glyph's place: each state's share of the circle
 * in its colour, so one glance says how far along and how bad, where a single
 * ✓ or ✕ could only say which.
 */
function ChecksRing({ counts, total }: { counts: Record<ChatCheckRunState, number>; total: number }) {
  let offset = 0
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0 -rotate-90" aria-hidden>
      <circle cx="6" cy="6" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-muted" />
      {RING_SEGMENTS.map(({ state, className }) => {
        if (counts[state] === 0 || total === 0) return null
        const length = (counts[state] / total) * RING_CIRCUMFERENCE
        const dashOffset = -offset
        offset += length
        return (
          <circle
            key={state}
            cx="6"
            cy="6"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            strokeDasharray={`${length} ${RING_CIRCUMFERENCE - length}`}
            strokeDashoffset={dashOffset}
            className={className}
          />
        )
      })}
    </svg>
  )
}

/**
 * One line: the ring, "12/16 passed, 2 failed, 1 skipped" with the failures
 * and running jobs in their own colour, and on the right edge, where every
 * card keeps its accessory, how long CI took on the wall clock.
 */
function ChecksHeader({ rollup, runs }: { rollup: ChatCommitChecks; runs: readonly ChatCheckRun[] }) {
  const counts = countCheckRuns(runs)
  const running = counts.pending > 0
  const now = useNow(running)
  const wallClock = checksWallClock(runs, now)
  const tallies = [
    counts.failure ? <span key="failure" className="text-destructive">{counts.failure} failed</span> : null,
    counts.pending ? <span key="pending" className="text-amber-500">{counts.pending} running</span> : null,
    counts.skipped ? <span key="skipped">{counts.skipped} skipped</span> : null,
  ].filter(Boolean)
  return (
    <div className={cn("mt-1.5 mb-1 flex items-center gap-1.5 text-[12px] tracking-wide text-muted-foreground", TURN_CARD_ROW_INSET)}>
      <ChecksRing counts={counts} total={runs.length} />
      <span className="min-w-0 truncate tabular-nums">
        <span className="font-medium text-popover-foreground">{rollup.passed}/{rollup.total}</span> passed
        {tallies.map((tally, index) => <span key={index}>, {tally}</span>)}
      </span>
      {wallClock ? (
        <span
          className="ml-auto shrink-0 pl-2 tabular-nums"
          title={wallClock.running ? "Since the first job started" : "First job's start to last job's end"}
        >
          {formatDuration(Math.floor(wallClock.ms / 1_000) * 1_000)}
        </span>
      ) : null}
    </div>
  )
}

/**
 * A hover card's CI section: the rollup as its header, then each check,
 * failing ones first, each opening its own job on GitHub. The last part of a
 * commit's or a PR's card, under a rule like every card appendix.
 */
export function CheckRunsSection({
  runs,
  checks,
  onOpen,
}: {
  runs: readonly ChatCheckRun[]
  checks?: ChatCommitChecks
  /** Opens a job's page (or the whole run, from "N more"); unset where nothing can open. */
  onOpen?: (url: string) => void
}) {
  if (runs.length === 0) return null
  const rollup = checks ?? rollupFromRuns(runs)
  const sorted = sortCheckRuns(runs)
  const shown = sorted.slice(0, VISIBLE_CHECK_RUN_COUNT)
  // Against GitHub's total, which counts past the 100 a read lists.
  const hiddenCount = Math.max(rollup.total, runs.length) - shown.length
  return (
    <>
      <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden />
      <ChecksHeader rollup={rollup} runs={runs} />
      {shown.map((run, index) => {
        const timing = describeCheckRunTiming(run)
        const url = run.url
        const open = onOpen && url ? () => onOpen(url) : undefined
        return (
          <button
            // Two jobs can share a name across workflows, or even within one (a matrix).
            key={`${run.workflowName ?? ""}\u0000${run.name}\u0000${index}`}
            type="button"
            aria-label={`${run.workflowName ? `${run.workflowName} / ` : ""}${run.name}: ${run.state}`}
            title={run.description}
            onClick={open}
            disabled={!open}
            className={cn(
              "flex w-full items-center gap-1.5 rounded text-left text-[12px] text-muted-foreground",
              TURN_CARD_ROW_INSET,
              open
                ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                : "cursor-default",
              (run.state === "skipped" || run.state === "neutral") && "opacity-70",
            )}
          >
            <CheckRunGlyph state={run.state} />
            <span className="min-w-0 flex-1 truncate">
              {run.workflowName ? <span className="text-muted-foreground/70">{run.workflowName} / </span> : null}
              <span className={run.state === "failure" ? "text-foreground" : undefined}>{run.name}</span>
            </span>
            {timing ? <span className="shrink-0 pl-2 tabular-nums">{timing}</span> : null}
          </button>
        )
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={onOpen && rollup.url ? () => onOpen(rollup.url!) : undefined}
          disabled={!onOpen || !rollup.url}
          className={cn(
            "w-full rounded text-left text-[12px] text-muted-foreground/70",
            TURN_CARD_ROW_INSET,
            onOpen && rollup.url ? "cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground" : "cursor-default",
          )}
        >
          {hiddenCount} more check{hiddenCount === 1 ? "" : "s"}
        </button>
      ) : null}
    </>
  )
}

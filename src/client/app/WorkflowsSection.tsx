import { useCallback, useEffect, useRef, useState } from "react"
import { Activity } from "lucide-react"
import { cn } from "../lib/utils"
import { formatCompactDuration } from "../lib/formatDuration"
import type { WorkflowRun, WorkflowRunSummary, WorkflowStatus } from "../../shared/workflow-types"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../components/ui/dialog"

// ── Status helpers ────────────────────────────────────────────────────────────

type WorkflowStatusTone = "muted" | "active" | "destructive" | "warning"

function workflowStatusLabel(status: WorkflowStatus): string {
  switch (status) {
    case "running": return "Running"
    case "completed": return "Completed"
    case "failed": return "Failed"
    case "killed": return "Killed"
    case "unknown": return "Unknown"
  }
}

function workflowStatusTone(status: WorkflowStatus): WorkflowStatusTone {
  switch (status) {
    case "running": return "active"
    case "failed": return "destructive"
    case "killed": return "warning"
    case "completed":
    case "unknown":
    default: return "muted"
  }
}

function workflowStatusDotClass(tone: WorkflowStatusTone): string {
  switch (tone) {
    case "active": return "bg-emerald-500 dark:bg-emerald-400"
    case "destructive": return "bg-destructive"
    case "warning": return "bg-amber-500 dark:bg-amber-400"
    case "muted":
    default: return "bg-muted-foreground"
  }
}

function workflowStatusTextClass(tone: WorkflowStatusTone): string {
  switch (tone) {
    case "active": return "text-emerald-500 dark:text-emerald-400"
    case "destructive": return "text-destructive"
    case "warning": return "text-amber-500 dark:text-amber-400"
    case "muted":
    default: return "text-muted-foreground"
  }
}

// ── StatusPill ────────────────────────────────────────────────────────────────

function WorkflowStatusPill({ status }: { status: WorkflowStatus }) {
  const tone = workflowStatusTone(status)
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
      <span
        aria-hidden
        className={cn("inline-block size-1.5 rounded-full", workflowStatusDotClass(tone))}
      />
      <span className={workflowStatusTextClass(tone)}>{workflowStatusLabel(status)}</span>
    </span>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface WorkflowsSectionProps {
  runs: WorkflowRunSummary[]
  onSelectRun: (runId: string) => void
}

// ── WorkflowsSection ──────────────────────────────────────────────────────────

export function WorkflowsSection({ runs, onSelectRun }: WorkflowsSectionProps) {
  if (runs.length === 0) {
    return <WorkflowEmptyState />
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {runs.map((run) => (
          <WorkflowRunRow key={run.runId} run={run} onSelect={onSelectRun} />
        ))}
      </ul>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function WorkflowEmptyState() {
  return (
    <div
      className="flex w-full flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-14 text-center"
      data-testid="workflow-empty"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Activity className="size-5" aria-hidden />
      </div>
      <p className="text-sm font-medium text-foreground">No workflow runs</p>
      <p className="text-xs text-muted-foreground">Workflow runs will appear here when triggered.</p>
    </div>
  )
}

// ── WorkflowRunRow ────────────────────────────────────────────────────────────

function WorkflowRunRow(props: { run: WorkflowRunSummary; onSelect: (runId: string) => void }) {
  const { run } = props
  const label = run.workflowName ?? run.runId

  const handleClick = useCallback(() => {
    props.onSelect(run.runId)
  }, [props, run.runId])

  return (
    <li>
      <button
        type="button"
        data-testid={`workflow-row:${run.runId}`}
        onClick={handleClick}
        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          <WorkflowStatusPill status={run.status} />
        </span>
        <span className="flex w-full items-center gap-3 text-xs text-muted-foreground">
          {run.agentCount != null ? (
            <span
              className="tabular-nums"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {run.agentCount} {run.agentCount === 1 ? "agent" : "agents"}
            </span>
          ) : null}
          {run.totalTokens != null ? (
            <span
              className="tabular-nums"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {run.totalTokens.toLocaleString()} tokens
            </span>
          ) : null}
          {run.durationMs != null ? (
            <span className="tabular-nums" style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatCompactDuration(run.durationMs)}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  )
}

// ── WorkflowRunDetailDialog ───────────────────────────────────────────────────

interface WorkflowRunDetailDialogProps {
  run: WorkflowRun | null
  open: boolean
  onClose: () => void
}

function agentStateTone(state: string): WorkflowStatusTone {
  if (state === "running") return "active"
  if (state === "failed" || state === "error") return "destructive"
  if (state === "killed") return "warning"
  return "muted"
}

export function WorkflowRunDetailDialog({ run, open, onClose }: WorkflowRunDetailDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent size="lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {run ? (run.workflowName ?? run.runId) : "Workflow run"}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {run ? <WorkflowRunDetail run={run} /> : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function WorkflowRunDetail({ run }: { run: WorkflowRun }) {
  const tone = workflowStatusTone(run.status)

  return (
    <div className="flex flex-col gap-5">
      {/* Header meta */}
      <div className="flex flex-wrap items-center gap-3">
        <WorkflowStatusPill status={run.status} />
        {run.durationMs != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatCompactDuration(run.durationMs)}
          </span>
        ) : null}
        {run.agentCount != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {run.agentCount} {run.agentCount === 1 ? "agent" : "agents"}
          </span>
        ) : null}
        {run.totalTokens != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {run.totalTokens.toLocaleString()} tokens
          </span>
        ) : null}
        {run.totalToolCalls != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {run.totalToolCalls} tool calls
          </span>
        ) : null}
      </div>

      {/* Phases */}
      {run.phases.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Phases</h4>
          <ol className="flex flex-col gap-0.5">
            {run.phases.map((phase, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 tabular-nums text-xs text-muted-foreground">{i + 1}.</span>
                <div className="flex flex-col">
                  <span className="text-foreground">{phase.title}</span>
                  {phase.detail ? (
                    <span className="text-xs text-muted-foreground">{phase.detail}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* Agents */}
      {run.agents.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</h4>
          <ul className="flex flex-col gap-0.5">
            {run.agents.map((agent) => {
              const stateTone = agentStateTone(agent.state)
              return (
                <li
                  key={agent.index}
                  className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 inline-block size-1.5 shrink-0 rounded-full",
                      workflowStatusDotClass(stateTone),
                    )}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{agent.label}</span>
                      {agent.model ? (
                        <span className="text-[10px] text-muted-foreground">{agent.model}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className={cn("capitalize", workflowStatusTextClass(stateTone))}>
                        {agent.state}
                      </span>
                      {agent.lastToolName ? (
                        <span>last: {agent.lastToolName}</span>
                      ) : null}
                      {agent.tokens != null ? (
                        <span className="tabular-nums">{agent.tokens.toLocaleString()} tok</span>
                      ) : null}
                      {agent.toolCalls != null ? (
                        <span className="tabular-nums">{agent.toolCalls} calls</span>
                      ) : null}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {/* Summary */}
      {run.summary ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Summary</h4>
          <p className="text-sm text-foreground whitespace-pre-wrap">{run.summary}</p>
        </section>
      ) : null}

      {/* Error */}
      {run.error && run.status !== "completed" ? (
        <section className="flex flex-col gap-1">
          <h4 className={cn("text-xs font-medium uppercase tracking-wide", workflowStatusTextClass(tone))}>
            Error
          </h4>
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive whitespace-pre-wrap">
            {run.error}
          </p>
        </section>
      ) : null}
    </div>
  )
}

// ── WorkflowsSectionWithDetail ────────────────────────────────────────────────
// Self-contained version that manages its own dialog state.
// Used when the parent provides a getRunDetail fetcher.

export interface WorkflowsSectionWithDetailProps {
  runs: WorkflowRunSummary[]
  getRunDetail: (runId: string) => Promise<WorkflowRun | null>
}

export function WorkflowsSectionWithDetail({ runs, getRunDetail }: WorkflowsSectionWithDetailProps) {
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null | "loading">(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const isOpen = selectedRun !== null
  // Track the runs reference that was present when the run was last selected
  // via a click. The push-refetch effect only fires when runs changes identity
  // AFTER the selection has already been established.
  const runsAtSelectionRef = useRef<WorkflowRunSummary[] | null>(null)

  const handleSelectRun = useCallback(async (runId: string) => {
    runsAtSelectionRef.current = runs
    setSelectedRunId(runId)
    setSelectedRun("loading")
    const detail = await getRunDetail(runId)
    setSelectedRun(detail)
  }, [getRunDetail, runs])

  const handleClose = useCallback(() => {
    setSelectedRunId(null)
    setSelectedRun(null)
    runsAtSelectionRef.current = null
  }, [])

  // Re-fetch the selected run's detail in-place (no "loading" swap) whenever
  // the snapshot push delivers a new `runs` reference AND the selected run is
  // still running. Stops naturally once the sidecar lands (status flips).
  // Guard: skip when `runs` is the same reference as when the row was clicked
  // (that click already initiated the initial fetch).
  useEffect(() => {
    if (selectedRunId === null) return
    if (runs === runsAtSelectionRef.current) return
    const row = runs.find((r) => r.runId === selectedRunId)
    if (!row || row.status !== "running") return
    let stale = false
    void getRunDetail(selectedRunId).then((detail) => {
      if (stale || detail === null) return
      setSelectedRun(detail)
    })
    return () => { stale = true }
  }, [runs, selectedRunId, getRunDetail])

  return (
    <>
      <WorkflowsSection
        runs={runs}
        onSelectRun={(runId) => { void handleSelectRun(runId) }}
      />
      <WorkflowRunDetailDialog
        run={selectedRun === "loading" ? null : selectedRun}
        open={isOpen}
        onClose={handleClose}
      />
    </>
  )
}

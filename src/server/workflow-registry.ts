import type { WorkflowJournalEntry, WorkflowRawFile, WorkflowRunDirInfo } from "./workflow-watch-io.adapter"
import { parseWorkflowRunFile, toRunSummary } from "../shared/workflow-types"
import type { WorkflowAgentProgress, WorkflowRun, WorkflowRunSummary } from "../shared/workflow-types"

export interface WorkflowRegistryDeps {
  read: (dir: string) => WorkflowRawFile[]
  watch: (dir: string, onChange: () => void) => () => void
  /**
   * List the live run dirs (`subagents/workflows/wf_*`) for the registered
   * workflows dir. Read lazily by `hasActiveRun`; absent in legacy callers
   * (treated as "no live runs", preserving prior behavior).
   */
  listRunDirs?: (workflowsDir: string) => WorkflowRunDirInfo[]
  /**
   * Watch the live run-dir root so a newly-launched run (no sidecar yet) pushes
   * a snapshot promptly. Absent in legacy callers (no live-run push, only
   * sidecar-change pushes — preserves prior behavior).
   */
  watchRunDirs?: (workflowsDir: string, onChange: () => void) => () => void
  /**
   * Read the live `journal.jsonl` for a running run. Used by `getRun` to
   * derive per-agent state for a synthesized running `WorkflowRun`. Absent in
   * legacy callers (running run keeps `agents:[]`, preserving prior behavior).
   */
  readRunJournal?: (workflowsDir: string, runId: string) => WorkflowJournalEntry[]
}
export interface WorkflowRegistry {
  register(chatId: string, workflowsDir: string): void
  unregister(chatId: string): void
  snapshot(chatId: string): WorkflowRunSummary[]
  getRun(chatId: string, runId: string): WorkflowRun | null
  /**
   * True when the chat hosts an in-flight run. A run is live when its live
   * transcript dir saw activity within `freshnessMs` AND it has no terminal
   * sidecar yet (absent, or status still "running"). The terminal sidecar is
   * Claude's authoritative death signal; the freshness window is the belt for
   * a hard crash that never wrote one. Used by the idle reaper / budget
   * enforcer so a live workflow's PTY host is never torn down mid-run.
   */
  hasActiveRun(chatId: string, freshnessMs: number, now: number): boolean
  subscribe(cb: (chatId: string) => void): () => void
}

interface Entry { dir: string; dispose: () => void; runs: Map<string, WorkflowRun> }

// A live run dir with no terminal sidecar and activity within this window is
// surfaced as a synthetic `running` row. Claude flushes the wf_<runId>.json
// sidecar only at/near termination, so without this the panel would only ever
// show terminal runs and never an in-flight one. Stale dirs past the window
// (likely a crash that never wrote a sidecar) are dropped rather than shown
// as forever-running.
const SNAPSHOT_LIVE_WINDOW_MS = 10 * 60 * 1000

function byNewest(a: WorkflowRun, b: WorkflowRun): number {
  return (b.startTime ?? 0) - (a.startTime ?? 0)
}

function synthRunningRun(runId: string, startTime: number): WorkflowRun {
  return { runId, status: "running", startTime, phases: [], agents: [] }
}

// The no-op crash shape: a workflow whose script threw at eval before any
// agent ran (`status=failed`, `agentCount=0`, no agents). Claude embeds the
// runId in the persisted script filename, so a fix-and-relaunch via scriptPath
// reuses this same runId and pours its agents into the same live dir WITHOUT
// rewriting this sidecar until it terminates. A crash sidecar is therefore the
// only terminal status that may be overridden by a fresh, non-empty live
// journal (see adr-20260604-workflow-rerun-masking). Because agentCount is 0,
// any live-journal agent can ONLY belong to a later run — a monotonic,
// clock-independent signal, unlike mtime ordering. Every other terminal
// status (completed / killed / failed-with-agents) wins unconditionally.
function isStaleCrashSidecar(run: WorkflowRun): boolean {
  return run.status === "failed" && (run.agentCount ?? 0) === 0 && run.agents.length === 0
}

function basenameAfterSlash(p: string | undefined): string | undefined {
  if (!p) return undefined
  // Strip trailing slash so "/repo/pkg/x/" still yields "x", not "".
  const trimmed = p.replace(/\/+$/, "")
  if (!trimmed) return undefined
  const i = trimmed.lastIndexOf("/")
  const out = i < 0 ? trimmed : trimmed.slice(i + 1)
  return out || undefined
}

function buildAgentsFromJournal(entries: WorkflowJournalEntry[]): WorkflowAgentProgress[] {
  const out = new Map<string, WorkflowAgentProgress>()
  for (const e of entries) {
    if (!e.agentId) continue // defensive: drop entries with blank/missing agentId
    if (!out.has(e.agentId)) {
      out.set(e.agentId, { index: out.size + 1, label: "agent", agentId: e.agentId, state: "running" })
    }
    if (e.type === "result") {
      const cur = out.get(e.agentId)
      if (!cur) continue
      cur.state = "completed"
      const dirBase = basenameAfterSlash(e.result?.dir)
      if (dirBase) cur.label = dirBase
      const parts: string[] = []
      if (typeof e.result?.fixed === "number") parts.push(`fixed ${e.result.fixed}`)
      if (e.result?.test_status) parts.push(`test:${e.result.test_status}`)
      if (parts.length > 0) cur.lastToolSummary = parts.join(", ")
    }
  }
  return [...out.values()]
}

export function createWorkflowRegistry(deps: WorkflowRegistryDeps): WorkflowRegistry {
  const entries = new Map<string, Entry>()
  const subs = new Set<(chatId: string) => void>()

  function refresh(chatId: string): void {
    const entry = entries.get(chatId)
    if (!entry) return
    const next = new Map<string, WorkflowRun>()
    for (const { raw } of deps.read(entry.dir)) {
      const run = parseWorkflowRunFile(raw)
      if (run) next.set(run.runId, run)
    }
    entry.runs = next
    for (const cb of subs) cb(chatId)
  }

  return {
    register(chatId, workflowsDir) {
      entries.get(chatId)?.dispose()
      const disposeSidecar = deps.watch(workflowsDir, () => refresh(chatId))
      // Also watch the live run-dir root so a launch (no sidecar yet) pushes a
      // snapshot — otherwise an in-flight run is invisible until it terminates.
      const disposeLive = deps.watchRunDirs?.(workflowsDir, () => refresh(chatId)) ?? (() => {})
      const dispose = () => { disposeSidecar(); disposeLive() }
      entries.set(chatId, { dir: workflowsDir, dispose, runs: new Map() })
      refresh(chatId)
    },
    unregister(chatId) {
      const entry = entries.get(chatId)
      if (!entry) return
      entry.dispose()
      entries.delete(chatId)
    },
    snapshot(chatId) {
      const entry = entries.get(chatId)
      if (!entry) return []
      // Sidecar runs (terminal/authoritative) + synthetic running rows for live
      // run dirs that have no sidecar yet. A real terminal sidecar wins over a
      // synthetic row; the sole exception is a no-op crash sidecar overridden by
      // a fresh non-empty live journal (a re-run reused the runId — see below).
      const merged = new Map(entry.runs)
      if (deps.listRunDirs) {
        const floor = Date.now() - SNAPSHOT_LIVE_WINDOW_MS
        for (const { runId, newestMtimeMs } of deps.listRunDirs(entry.dir)) {
          if (newestMtimeMs < floor) continue
          const existing = merged.get(runId)
          // No sidecar yet: surface the live run as a synthetic running row.
          if (!existing) { merged.set(runId, synthRunningRun(runId, newestMtimeMs)); continue }
          // A real terminal sidecar wins. Only a crash sidecar (no-op shape)
          // may be overridden, and only when the live journal proves a re-run
          // reused the runId (≥1 agent). Journal is read solely in this rare
          // case, keeping the common no-sidecar path journal-free.
          if (!isStaleCrashSidecar(existing) || !deps.readRunJournal) continue
          const agents = buildAgentsFromJournal(deps.readRunJournal(entry.dir, runId))
          if (agents.length === 0) continue // true crash, no re-run → keep failed
          // Carry the crash sidecar's taskId/workflowName so the launch card
          // (joined by taskId) binds to the live re-run that reused the runId.
          merged.set(runId, {
            ...synthRunningRun(runId, newestMtimeMs),
            taskId: existing.taskId, workflowName: existing.workflowName,
            agentCount: agents.length, agents,
          })
        }
      }
      return [...merged.values()].sort(byNewest).map(toRunSummary)
    },
    getRun(chatId, runId) {
      const entry = entries.get(chatId)
      if (!entry) return null
      const sidecar = entry.runs.get(runId)
      // A real terminal sidecar wins. A crash sidecar (no-op shape) falls
      // through to live synthesis so a re-run that reused the runId surfaces
      // as running; it falls BACK to the failed sidecar if the live dir proves
      // no re-run (empty/missing journal). See adr-20260604-workflow-rerun-masking.
      if (sidecar && !isStaleCrashSidecar(sidecar)) return sidecar
      // Synthesize a running run from the live dir, enriched from the journal.
      if (deps.listRunDirs) {
        const floor = Date.now() - SNAPSHOT_LIVE_WINDOW_MS
        const live = deps.listRunDirs(entry.dir).find((r) => r.runId === runId && r.newestMtimeMs >= floor)
        if (live) {
          const base = synthRunningRun(runId, live.newestMtimeMs)
          if (deps.readRunJournal) {
            const agents = buildAgentsFromJournal(deps.readRunJournal(entry.dir, runId))
            // A crash sidecar with no live agents is a true crash → keep failed.
            // When overriding, carry the crash sidecar's taskId/workflowName.
            if (agents.length > 0 || !sidecar) {
              return { ...base, taskId: sidecar?.taskId, workflowName: sidecar?.workflowName, agentCount: agents.length, agents }
            }
          } else if (!sidecar) {
            return base
          }
        }
      }
      return sidecar ?? null
    },
    hasActiveRun(chatId, freshnessMs, now) {
      const entry = entries.get(chatId)
      if (!entry || !deps.listRunDirs) return false
      const floor = now - freshnessMs
      for (const { runId, newestMtimeMs } of deps.listRunDirs(entry.dir)) {
        if (newestMtimeMs < floor) continue // stale: no activity within the window
        const sidecar = entry.runs.get(runId)
        // No terminal sidecar yet (still mid-run), or it explicitly says running.
        if (!sidecar || sidecar.status === "running") return true
      }
      return false
    },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
  }
}

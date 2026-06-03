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
      // run dirs that have no sidecar yet. A sidecar always wins over a synthetic
      // row (it carries the real terminal status + counts).
      const merged = new Map(entry.runs)
      if (deps.listRunDirs) {
        const floor = Date.now() - SNAPSHOT_LIVE_WINDOW_MS
        for (const { runId, newestMtimeMs } of deps.listRunDirs(entry.dir)) {
          if (merged.has(runId) || newestMtimeMs < floor) continue
          merged.set(runId, synthRunningRun(runId, newestMtimeMs))
        }
      }
      return [...merged.values()].sort(byNewest).map(toRunSummary)
    },
    getRun(chatId, runId) {
      const entry = entries.get(chatId)
      if (!entry) return null
      const sidecar = entry.runs.get(runId)
      if (sidecar) return sidecar
      // Synthesize a running run from the live dir, enriched from the journal.
      if (deps.listRunDirs) {
        const floor = Date.now() - SNAPSHOT_LIVE_WINDOW_MS
        const live = deps.listRunDirs(entry.dir).find((r) => r.runId === runId && r.newestMtimeMs >= floor)
        if (live) {
          const base = synthRunningRun(runId, live.newestMtimeMs)
          if (deps.readRunJournal) {
            const agents = buildAgentsFromJournal(deps.readRunJournal(entry.dir, runId))
            return { ...base, agentCount: agents.length, agents }
          }
          return base
        }
      }
      return null
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

import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs"
import { join, dirname, basename } from "node:path"

export interface WorkflowRawFile { runId: string; raw: unknown }

/** Liveness probe for an in-flight run, derived from its live transcript dir. */
export interface WorkflowRunDirInfo { runId: string; newestMtimeMs: number }

function isWfFile(name: string): boolean { return name.startsWith("wf_") && name.endsWith(".json") }
function isWfDir(name: string): boolean { return name.startsWith("wf_") }

/**
 * List the LIVE run directories Claude writes under the sibling
 * `<session>/subagents/workflows/wf_<runId>/` (one per run, holding
 * `journal.jsonl` + per-agent `agent-*.jsonl`). These are written from the
 * first second of a run, UNLIKE the terminal `workflows/wf_<runId>.json`
 * sidecar which Claude only flushes at/near termination. `newestMtimeMs` is
 * the max mtime across the run dir's files — the run's last on-disk activity.
 *
 * `workflowsDir` is the sidecar dir the registry already tracks
 * (`<session>/workflows`); the live dirs are its `../subagents/workflows`
 * sibling. Returns [] if the sibling does not exist yet.
 */
/** The sibling live-run-dir root for a registered sidecar `workflows` dir. */
export function liveRunRoot(workflowsDir: string): string {
  return join(dirname(workflowsDir), "subagents", basename(workflowsDir))
}

export function listWorkflowRunDirs(workflowsDir: string): WorkflowRunDirInfo[] {
  const liveRoot = liveRunRoot(workflowsDir)
  if (!existsSync(liveRoot)) return []
  let names: string[]
  try { names = readdirSync(liveRoot) } catch { return [] }
  const out: WorkflowRunDirInfo[] = []
  for (const name of names) {
    if (!isWfDir(name)) continue
    const runDir = join(liveRoot, name)
    let newest = 0
    try {
      for (const f of readdirSync(runDir)) {
        try {
          const m = statSync(join(runDir, f)).mtimeMs
          if (m > newest) newest = m
        } catch { /* file vanished mid-scan — skip */ }
      }
    } catch { continue }
    out.push({ runId: name, newestMtimeMs: newest })
  }
  return out
}

export function readWorkflowDir(dir: string): WorkflowRawFile[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: WorkflowRawFile[] = []
  for (const name of names) {
    if (!isWfFile(name)) continue
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"))
      out.push({ runId: name.slice(0, -".json".length), raw })
    } catch {
      // partial write / corrupt file — skip this tick; next write re-fires the watch
    }
  }
  return out
}

function nearestExistingAncestor(dir: string): string | null {
  let cur = dir
  for (let i = 0; i < 64; i++) {
    const parent = dirname(cur)
    if (parent === cur) return existsSync(cur) ? cur : null
    if (existsSync(parent)) return parent
    cur = parent
  }
  return null
}

/**
 * Watch the live run-dir root (`subagents/workflows`) so a newly-launched run
 * (which writes NO sidecar until termination) pushes a snapshot promptly. Same
 * parent-arming as watchWorkflowDir — the sibling appears lazily on first run.
 */
export function watchWorkflowRunDirs(
  workflowsDir: string, onChange: () => void, opts?: { debounceMs?: number },
): () => void {
  return watchWorkflowDir(liveRunRoot(workflowsDir), onChange, opts)
}

export interface WorkflowJournalEntry {
  type: "started" | "result"
  agentId: string
  key?: string
  result?: {
    dir?: string
    fixed?: number
    test_status?: string
    summary?: string
  }
}

const KNOWN_JOURNAL_KINDS: ReadonlySet<string> = new Set(["started", "result"])

function parseJournalLine(line: string): WorkflowJournalEntry | null {
  if (!line) return null
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return null }
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const type = r.type
  const agentId = r.agentId
  if (typeof type !== "string" || !KNOWN_JOURNAL_KINDS.has(type)) return null
  if (typeof agentId !== "string") return null
  const out: WorkflowJournalEntry = { type: type as "started" | "result", agentId }
  if (typeof r.key === "string") out.key = r.key
  if (r.result && typeof r.result === "object" && !Array.isArray(r.result)) {
    const rr = r.result as Record<string, unknown>
    const res: WorkflowJournalEntry["result"] = {}
    if (typeof rr.dir === "string") res.dir = rr.dir
    if (typeof rr.fixed === "number") res.fixed = rr.fixed
    if (typeof rr.test_status === "string") res.test_status = rr.test_status
    if (typeof rr.summary === "string") res.summary = rr.summary
    out.result = res
  }
  return out
}

export function readWorkflowRunJournal(workflowsDir: string, runId: string): WorkflowJournalEntry[] {
  const journalPath = join(liveRunRoot(workflowsDir), runId, "journal.jsonl")
  if (!existsSync(journalPath)) return []
  let text: string
  try { text = readFileSync(journalPath, "utf8") } catch { return [] }
  const out: WorkflowJournalEntry[] = []
  for (const line of text.split("\n")) {
    const entry = parseJournalLine(line)
    if (entry) out.push(entry)
  }
  return out
}

export function watchWorkflowDir(
  dir: string, onChange: () => void, opts?: { debounceMs?: number },
): () => void {
  const debounceMs = opts?.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let watcher: ReturnType<typeof watch> | null = null

  const fire = () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; if (!disposed) onChange() }, debounceMs)
  }

  const closeWatcher = () => { try { watcher?.close() } catch { /* already closed */ } watcher = null }

  const armTarget = () => {
    if (disposed) return
    try { watcher = watch(dir, { persistent: false }, fire) } catch { watcher = null }
  }

  const armParent = () => {
    if (disposed) return
    const ancestor = nearestExistingAncestor(dir)
    if (!ancestor) return
    try {
      watcher = watch(ancestor, { persistent: false }, () => {
        if (disposed || !existsSync(dir)) return
        closeWatcher()
        armTarget()
        fire() // the dir just appeared — trigger an initial read
      })
    } catch { watcher = null }
  }

  if (existsSync(dir)) armTarget()
  else armParent()

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    closeWatcher()
  }
}

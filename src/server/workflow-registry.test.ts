import { describe, expect, test } from "bun:test"
import { createWorkflowRegistry } from "./workflow-registry"
import type { WorkflowRawFile } from "./workflow-watch-io.adapter"

function fakeIo(files: Map<string, WorkflowRawFile[]>) {
  const cbs = new Map<string, () => void>()
  return {
    read: (dir: string): WorkflowRawFile[] => files.get(dir) ?? [],
    watch: (dir: string, onChange: () => void) => { cbs.set(dir, onChange); return () => cbs.delete(dir) },
    trigger: (dir: string) => cbs.get(dir)?.(),
  }
}

describe("WorkflowRegistry", () => {
  test("register reads + snapshots, sorted newest-first", () => {
    const files = new Map<string, WorkflowRawFile[]>([["/d", [
      { runId: "wf_old", raw: { runId: "wf_old", startTime: 1, status: "completed" } },
      { runId: "wf_new", raw: { runId: "wf_new", startTime: 2, status: "running" } },
    ]]])
    const io = fakeIo(files)
    const reg = createWorkflowRegistry({ read: io.read, watch: io.watch })
    reg.register("chat1", "/d")
    const snap = reg.snapshot("chat1")
    expect(snap.map((r) => r.runId)).toEqual(["wf_new", "wf_old"])
  })

  test("watch change re-reads and notifies subscribers with chatId", () => {
    const files = new Map<string, WorkflowRawFile[]>([["/d", []]])
    const io = fakeIo(files)
    const reg = createWorkflowRegistry({ read: io.read, watch: io.watch })
    const seen: string[] = []
    reg.subscribe((chatId) => seen.push(chatId))
    reg.register("chat1", "/d")
    files.set("/d", [{ runId: "wf_a", raw: { runId: "wf_a", status: "running" } }])
    io.trigger("/d")
    expect(seen).toContain("chat1")
    expect(reg.snapshot("chat1").map((r) => r.runId)).toEqual(["wf_a"])
  })

  test("getRun returns full run incl. heavy fields; null when unknown", () => {
    const files = new Map<string, WorkflowRawFile[]>([["/d", [
      { runId: "wf_a", raw: { runId: "wf_a", status: "running", script: "S", args: "[]" } },
    ]]])
    const io = fakeIo(files)
    const reg = createWorkflowRegistry({ read: io.read, watch: io.watch })
    reg.register("chat1", "/d")
    expect(reg.getRun("chat1", "wf_a")?.script).toBe("S")
    expect(reg.getRun("chat1", "nope")).toBeNull()
  })

  test("unregister stops watching and clears snapshot", () => {
    const files = new Map<string, WorkflowRawFile[]>([["/d", [
      { runId: "wf_a", raw: { runId: "wf_a", status: "running" } },
    ]]])
    const io = fakeIo(files)
    const reg = createWorkflowRegistry({ read: io.read, watch: io.watch })
    reg.register("chat1", "/d")
    reg.unregister("chat1")
    expect(reg.snapshot("chat1")).toEqual([])
  })

  describe("snapshot surfaces in-flight runs (no sidecar yet)", () => {
    test("synthesizes a running row for a fresh live run dir with no sidecar", () => {
      const io = fakeIo(new Map([["/d", []]]))
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_live", newestMtimeMs: Date.now() }],
      })
      reg.register("chat1", "/d")
      const snap = reg.snapshot("chat1")
      expect(snap.map((r) => r.runId)).toEqual(["wf_live"])
      expect(snap[0].status).toBe("running")
    })

    test("a terminal sidecar wins over the synthetic running row", () => {
      const io = fakeIo(new Map([["/d", [
        { runId: "wf_live", raw: { runId: "wf_live", status: "killed", startTime: 5 } },
      ]]]))
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_live", newestMtimeMs: Date.now() }],
      })
      reg.register("chat1", "/d")
      const snap = reg.snapshot("chat1")
      expect(snap).toHaveLength(1)
      expect(snap[0].status).toBe("killed")
    })

    test("getRun running enrich: derives agents + agentCount from the journal", () => {
      const io = fakeIo(new Map([["/d", []]]))
      const journal: import("./workflow-watch-io.adapter").WorkflowJournalEntry[] = [
        { type: "started", agentId: "a1" },
        { type: "started", agentId: "a2" },
        { type: "result", agentId: "a1", result: { dir: "/repo/pkg/x", fixed: 3, test_status: "pass" } },
      ]
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_live", newestMtimeMs: Date.now() }],
        readRunJournal: () => journal,
      })
      reg.register("chat1", "/d")
      const run = reg.getRun("chat1", "wf_live")
      expect(run?.status).toBe("running")
      expect(run?.agentCount).toBe(2)
      expect(run?.agents).toHaveLength(2)
      expect(run?.agents[0]).toMatchObject({ agentId: "a1", state: "completed", label: "x" })
      expect(run?.agents[0].lastToolSummary).toBe("fixed 3, test:pass")
      expect(run?.agents[1]).toMatchObject({ agentId: "a2", state: "running", label: "agent" })
    })

    test("getRun: legacy/no-readRunJournal dep still works (agents:[] for running)", () => {
      const io = fakeIo(new Map([["/d", []]]))
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_live", newestMtimeMs: Date.now() }],
      })
      reg.register("chat1", "/d")
      const run = reg.getRun("chat1", "wf_live")
      expect(run?.status).toBe("running")
      expect(run?.agents).toEqual([])
    })

    test("getRun returns a synthetic running run for a live dir with no sidecar (no dialog flicker)", () => {
      const io = fakeIo(new Map([["/d", []]]))
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_live", newestMtimeMs: Date.now() }],
      })
      reg.register("chat1", "/d")
      const run = reg.getRun("chat1", "wf_live")
      expect(run).not.toBeNull()
      expect(run?.status).toBe("running")
      // unknown / stale runId still null
      expect(reg.getRun("chat1", "wf_unknown")).toBeNull()
    })

    test("getRun: terminal sidecar wins over synthetic running", () => {
      const io = fakeIo(new Map([["/d", [
        { runId: "wf_live", raw: { runId: "wf_live", status: "completed" } },
      ]]]))
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_live", newestMtimeMs: Date.now() }],
      })
      reg.register("chat1", "/d")
      expect(reg.getRun("chat1", "wf_live")?.status).toBe("completed")
    })

    test("drops a stale live dir (crash that never wrote a sidecar)", () => {
      const io = fakeIo(new Map([["/d", []]]))
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => [{ runId: "wf_stale", newestMtimeMs: 0 }],
      })
      reg.register("chat1", "/d")
      expect(reg.snapshot("chat1")).toEqual([])
    })

    test("watchRunDirs change notifies subscribers (launch with no sidecar)", () => {
      const io = fakeIo(new Map([["/d", []]]))
      let liveCb: (() => void) | null = null
      let launched = false
      const seen: string[] = []
      const reg = createWorkflowRegistry({
        read: io.read, watch: io.watch,
        listRunDirs: () => launched ? [{ runId: "wf_live", newestMtimeMs: Date.now() }] : [],
        watchRunDirs: (_dir, cb) => { liveCb = cb; return () => { liveCb = null } },
      })
      reg.subscribe((c) => seen.push(c))
      reg.register("chat1", "/d")
      expect(reg.snapshot("chat1").map((r) => r.runId)).toEqual([]) // nothing launched yet
      launched = true
      liveCb!() // live run dir appeared → watcher fires
      expect(seen).toContain("chat1")
      expect(reg.snapshot("chat1").map((r) => r.runId)).toEqual(["wf_live"])
    })
  })

  describe("hasActiveRun", () => {
    const NOW = 1_000_000
    const FRESH = 600_000
    function regWith(runDirs: { runId: string; newestMtimeMs: number }[], sidecars: WorkflowRawFile[] = []) {
      const io = fakeIo(new Map([["/d", sidecars]]))
      const reg = createWorkflowRegistry({ read: io.read, watch: io.watch, listRunDirs: () => runDirs })
      reg.register("chat1", "/d")
      return reg
    }

    test("true: fresh live run dir with NO terminal sidecar (the mid-run window)", () => {
      const reg = regWith([{ runId: "wf_a", newestMtimeMs: NOW - 1000 }])
      expect(reg.hasActiveRun("chat1", FRESH, NOW)).toBe(true)
    })

    test("false: run dir present but a terminal sidecar exists (killed/completed)", () => {
      const reg = regWith(
        [{ runId: "wf_a", newestMtimeMs: NOW - 1000 }],
        [{ runId: "wf_a", raw: { runId: "wf_a", status: "killed" } }],
      )
      expect(reg.hasActiveRun("chat1", FRESH, NOW)).toBe(false)
    })

    test("true: sidecar exists but status still running", () => {
      const reg = regWith(
        [{ runId: "wf_a", newestMtimeMs: NOW - 1000 }],
        [{ runId: "wf_a", raw: { runId: "wf_a", status: "running" } }],
      )
      expect(reg.hasActiveRun("chat1", FRESH, NOW)).toBe(true)
    })

    test("false: run dir activity older than the freshness window (stalled/crashed)", () => {
      const reg = regWith([{ runId: "wf_a", newestMtimeMs: NOW - FRESH - 1 }])
      expect(reg.hasActiveRun("chat1", FRESH, NOW)).toBe(false)
    })

    test("false: no listRunDirs dep (legacy) or unknown chat", () => {
      const io = fakeIo(new Map([["/d", []]]))
      const legacy = createWorkflowRegistry({ read: io.read, watch: io.watch })
      legacy.register("chat1", "/d")
      expect(legacy.hasActiveRun("chat1", FRESH, NOW)).toBe(false)
      expect(regWith([{ runId: "wf_a", newestMtimeMs: NOW }]).hasActiveRun("unknown", FRESH, NOW)).toBe(false)
    })
  })
})

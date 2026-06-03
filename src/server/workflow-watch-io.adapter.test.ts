import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkflowJournalEntry } from "./workflow-watch-io.adapter"
import { listWorkflowRunDirs, readWorkflowDir, readWorkflowRunJournal, watchWorkflowDir } from "./workflow-watch-io.adapter"

const dirs: string[] = []
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "wf-")); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe("workflow-watch-io.adapter", () => {
  test("readWorkflowDir returns raw JSON for each wf_*.json, ignores other files", () => {
    const d = tmp()
    writeFileSync(join(d, "wf_a.json"), JSON.stringify({ runId: "wf_a" }))
    writeFileSync(join(d, "notes.txt"), "x")
    const items = readWorkflowDir(d)
    expect(items).toHaveLength(1)
    expect((items[0].raw as { runId: string }).runId).toBe("wf_a")
  })

  test("readWorkflowDir returns [] for a missing dir", () => {
    expect(readWorkflowDir(join(tmp(), "nope"))).toEqual([])
  })

  test("readWorkflowDir skips unparseable files without throwing", () => {
    const d = tmp()
    writeFileSync(join(d, "wf_bad.json"), "{not json")
    writeFileSync(join(d, "wf_ok.json"), JSON.stringify({ runId: "wf_ok" }))
    const items = readWorkflowDir(d)
    expect(items.map((i) => i.runId)).toEqual(["wf_ok"])
  })

  test("arms when the workflows dir is created AFTER watch starts (watches parent)", async () => {
    const base = tmp()                      // exists
    const dir = join(base, "workflows")     // does NOT exist yet
    let calls = 0
    const dispose = watchWorkflowDir(dir, () => { calls += 1 }, { debounceMs: 20 })
    mkdirSync(dir)
    writeFileSync(join(dir, "wf_a.json"), "{}")
    await new Promise((r) => setTimeout(r, 200))
    expect(calls).toBeGreaterThanOrEqual(1)
    dispose()
  }, 5000)

  test("watchWorkflowDir fires (debounced) on a new file, dispose stops it", async () => {
    const d = tmp()
    let calls = 0
    const dispose = watchWorkflowDir(d, () => { calls += 1 }, { debounceMs: 30 })
    writeFileSync(join(d, "wf_a.json"), "{}")
    writeFileSync(join(d, "wf_a.json"), "{}")
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toBe(1)
    dispose()
    writeFileSync(join(d, "wf_b.json"), "{}")
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toBe(1)
  }, 5000)

  test("listWorkflowRunDirs reads sibling subagents/workflows/wf_* with newest mtime", () => {
    const session = tmp()
    const workflowsDir = join(session, "workflows")          // registered (sidecar) dir
    const liveRoot = join(session, "subagents", "workflows") // live run dirs
    mkdirSync(join(liveRoot, "wf_a"), { recursive: true })
    mkdirSync(join(liveRoot, "wf_b"), { recursive: true })
    mkdirSync(join(liveRoot, "ignore"), { recursive: true })  // not wf_*
    writeFileSync(join(liveRoot, "wf_a", "journal.jsonl"), "{}")
    writeFileSync(join(liveRoot, "wf_b", "agent-x.jsonl"), "{}")

    const out = listWorkflowRunDirs(workflowsDir)
    expect(out.map((r) => r.runId).sort()).toEqual(["wf_a", "wf_b"])
    expect(out.every((r) => r.newestMtimeMs > 0)).toBe(true)
  })

  test("listWorkflowRunDirs returns [] when the sibling dir is absent", () => {
    const session = tmp()
    expect(listWorkflowRunDirs(join(session, "workflows"))).toEqual([])
  })

  test("readWorkflowRunJournal parses started + result lines for a runId", () => {
    const session = tmp()
    const liveRoot = join(session, "subagents", "workflows")
    const runDir = join(liveRoot, "wf_a")
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, "journal.jsonl"),
      [
        JSON.stringify({ type: "started", agentId: "a1", key: "v2:x" }),
        JSON.stringify({
          type: "result",
          agentId: "a1",
          key: "v2:x",
          result: { dir: "/repo/pkg/x", fixed: 3, test_status: "pass", summary: "ok" },
        }),
      ].join("\n") + "\n",
    )

    const entries = readWorkflowRunJournal(join(session, "workflows"), "wf_a")
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: "started", agentId: "a1" })
    expect(entries[1]).toMatchObject({ type: "result", agentId: "a1" })
    expect(entries[1].result).toMatchObject({ dir: "/repo/pkg/x", fixed: 3, test_status: "pass" })
  })

  test("readWorkflowRunJournal skips blank + unparseable lines; returns [] for missing file", () => {
    const session = tmp()
    const liveRoot = join(session, "subagents", "workflows")
    const runDir = join(liveRoot, "wf_b")
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, "journal.jsonl"),
      [
        "",
        "{not json",
        JSON.stringify({ type: "started", agentId: "b1" }),
        JSON.stringify({ type: "unrelated", agentId: "x" }),
      ].join("\n") + "\n",
    )

    const entries = readWorkflowRunJournal(join(session, "workflows"), "wf_b")
    expect(entries.map((e: WorkflowJournalEntry) => e.agentId)).toEqual(["b1"])

    expect(readWorkflowRunJournal(join(session, "workflows"), "wf_missing")).toEqual([])
  })
})

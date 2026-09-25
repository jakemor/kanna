import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatCheckRun } from "../../../../shared/types"
import { CheckRunsSection, checksWallClock, describeCheckRunTiming, rollupFromRuns, sortCheckRuns, VISIBLE_CHECK_RUN_COUNT } from "./CheckRunsSection"

function run(name: string, state: ChatCheckRun["state"], extra: Partial<ChatCheckRun> = {}): ChatCheckRun {
  return { name, state, ...extra }
}

describe("sortCheckRuns", () => {
  test("puts failing, then running checks first, keeping GitHub's order within each", () => {
    const sorted = sortCheckRuns([
      run("a", "success"),
      run("b", "skipped"),
      run("c", "failure"),
      run("d", "pending"),
      run("e", "failure"),
      run("f", "success"),
    ])
    expect(sorted.map((entry) => entry.name)).toEqual(["c", "e", "d", "a", "f", "b"])
  })
})

describe("rollupFromRuns", () => {
  test("fails on any failure, waits on any pending, and counts only successes", () => {
    expect(rollupFromRuns([run("a", "success"), run("b", "skipped")])).toEqual({ state: "success", passed: 1, total: 2 })
    expect(rollupFromRuns([run("a", "pending"), run("b", "success")]).state).toBe("pending")
    expect(rollupFromRuns([run("a", "pending"), run("b", "failure")]).state).toBe("failure")
  })
})

describe("describeCheckRunTiming", () => {
  test("gives a finished job its duration and an unfinished one its phase", () => {
    expect(describeCheckRunTiming(run("a", "success", { startedAt: "2026-09-25T10:00:00Z", completedAt: "2026-09-25T10:00:42Z" }))).toBe("42s")
    expect(describeCheckRunTiming(run("a", "pending", { startedAt: "2026-09-25T10:00:00Z" }))).toBe("running")
    expect(describeCheckRunTiming(run("a", "pending"))).toBe("pending")
    expect(describeCheckRunTiming(run("a", "skipped"))).toBe("skipped")
    // Never really ran.
    expect(describeCheckRunTiming(run("a", "failure", { startedAt: "2026-09-25T10:00:00Z", completedAt: "2026-09-25T10:00:00Z" }))).toBeNull()
  })
})

describe("checksWallClock", () => {
  test("spans the first start to the last end, so parallel jobs count once", () => {
    const runs = [
      run("build", "success", { startedAt: "2026-09-25T10:00:00Z", completedAt: "2026-09-25T10:03:00Z" }),
      run("test", "success", { startedAt: "2026-09-25T10:00:10Z", completedAt: "2026-09-25T10:05:00Z" }),
      run("deploy", "success", { startedAt: "2026-09-25T10:05:05Z", completedAt: "2026-09-25T10:06:00Z" }),
      run("vercel", "success"),
    ]
    expect(checksWallClock(runs)).toEqual({ ms: 6 * 60_000, running: false })
  })

  test("counts up to now while a job is unfinished", () => {
    const runs = [
      run("build", "success", { startedAt: "2026-09-25T10:00:00Z", completedAt: "2026-09-25T10:01:00Z" }),
      run("test", "pending", { startedAt: "2026-09-25T10:01:00Z" }),
    ]
    expect(checksWallClock(runs, Date.parse("2026-09-25T10:04:00Z"))).toEqual({ ms: 4 * 60_000, running: true })
  })

  test("has nothing to say without times", () => {
    expect(checksWallClock([run("vercel", "success")])).toBeNull()
  })
})

describe("CheckRunsSection", () => {
  test("says how many more there are past the visible rows, against GitHub's total", () => {
    const runs = Array.from({ length: VISIBLE_CHECK_RUN_COUNT + 2 }, (_, index) => run(`job-${index}`, "success"))
    const markup = renderToStaticMarkup(createElement(CheckRunsSection, {
      runs,
      checks: { state: "success", passed: 120, total: 120, url: "https://github.com/acme/repo/actions/runs/1" },
    }))
    expect(markup).toContain("120/120")
    expect(markup).toContain(`job-${VISIBLE_CHECK_RUN_COUNT - 1}`)
    expect(markup).not.toContain(`job-${VISIBLE_CHECK_RUN_COUNT}<`)
    expect(markup).toContain(`${120 - VISIBLE_CHECK_RUN_COUNT} more checks`)
  })

  test("tallies what failed, is running and was skipped beside the count", () => {
    const markup = renderToStaticMarkup(createElement(CheckRunsSection, {
      runs: [run("a", "success"), run("b", "failure"), run("c", "failure"), run("d", "pending"), run("e", "skipped")],
    }))
    expect(markup).toContain("1/5")
    expect(markup).toContain("2 failed")
    expect(markup).toContain("1 running")
    expect(markup).toContain("1 skipped")
  })

  test("renders nothing without runs", () => {
    expect(renderToStaticMarkup(createElement(CheckRunsSection, { runs: [] }))).toBe("")
  })
})

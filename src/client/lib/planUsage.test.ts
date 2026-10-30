import { describe, expect, test } from "bun:test"
import type { ProviderUsageSnapshot, UsageLimitCredits, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"
import { formatResetCountdown, selectPlanUsage, shortUsageLabel } from "./planUsage"

function makeWindow(id: string, label: string, usedPercent: number | null): UsageLimitWindow {
  return {
    id,
    label,
    usedPercent,
    resetsAt: "2026-10-27T18:00:00.000Z",
    recordedAt: "2026-10-27T12:00:00.000Z",
    source: "turn_push",
  }
}

function makeSnapshot(
  provider: ProviderUsageSnapshot["provider"],
  windows: UsageLimitWindow[],
  status: ProviderUsageSnapshot["status"] = "ok",
  credits: UsageLimitCredits | null = null,
): UsageLimitsSnapshot {
  return {
    providers: [{ provider, status, plan: "max", windows, credits, detail: null, updatedAt: null }],
  }
}

const CLAUDE = makeSnapshot("claude", [
  makeWindow("five_hour", "Current session (5-hour)", 42),
  makeWindow("seven_day", "Weekly · All models", 18),
  makeWindow("seven_day_opus", "Weekly · Opus", 61),
  makeWindow("seven_day_sonnet", "Weekly · Sonnet", 90),
])

const ids = (rows: ReturnType<typeof selectPlanUsage>) => rows?.map((row) => row.window.id) ?? null
const labels = (rows: ReturnType<typeof selectPlanUsage>) => rows?.map((row) => row.shortLabel) ?? null

describe("selectPlanUsage", () => {
  test("stacks the windows every Claude model shares, shortest first, without the per-family lanes", () => {
    const rows = selectPlanUsage(CLAUDE, "claude")
    expect(ids(rows)).toEqual(["five_hour", "seven_day"])
    expect(labels(rows)).toEqual(["5h", "Wk"])
  })

  test("orders by window length, not by the order the provider reported", () => {
    const reversed = makeSnapshot("claude", [
      makeWindow("seven_day", "Weekly · All models", 18),
      makeWindow("five_hour", "Current session (5-hour)", 42),
    ])
    expect(ids(selectPlanUsage(reversed, "claude"))).toEqual(["five_hour", "seven_day"])
  })

  test("keeps a window whose reset has passed, at 0%, so the rows don't change", () => {
    const afterFiveHourReset = Date.parse("2026-10-27T18:30:00.000Z")
    const rows = selectPlanUsage(CLAUDE, "claude", afterFiveHourReset)
    expect(ids(rows)).toEqual(["five_hour", "seven_day"])
    expect(rows?.every((row) => row.window.usedPercent === 0 && row.window.resetsAt === null)).toBe(true)
    const before = selectPlanUsage(CLAUDE, "claude", Date.parse("2026-10-27T12:00:00.000Z"))
    expect(before?.map((row) => row.window.usedPercent)).toEqual([42, 18])
  })

  test("returns null when the provider has no usable data", () => {
    expect(selectPlanUsage(null, "claude")).toBeNull()
    expect(selectPlanUsage(CLAUDE, "codex")).toBeNull()
    expect(selectPlanUsage(makeSnapshot("claude", [], "unavailable"), "claude")).toBeNull()
    expect(selectPlanUsage(makeSnapshot("claude", [makeWindow("five_hour", "Current session (5-hour)", null)]), "claude")).toBeNull()
  })

  test("keeps Codex to the lanes every model shares", () => {
    const codex = makeSnapshot("codex", [
      makeWindow("codex:primary", "5-hour · All models", 20),
      makeWindow("codex:secondary", "Weekly · All models", 30),
      makeWindow("spark:primary", "5-hour · GPT 5.3 Codex Spark", 95),
      makeWindow("spark:secondary", "Weekly · GPT 5.3 Codex Spark", 40),
    ])
    expect(labels(selectPlanUsage(codex, "codex"))).toEqual(["5h", "Wk"])
  })

  test("uses Grok's shared credit pool when it is reported", () => {
    const grok = makeSnapshot("grok", [
      makeWindow("credits", "Weekly · All products", 12),
      makeWindow("grok-build", "Weekly · Grok Build", 80),
    ])
    const rows = selectPlanUsage(grok, "grok")
    expect(ids(rows)).toEqual(["credits"])
    expect(labels(rows)).toEqual(["Wk"])
  })

  test("stands a spend cap in as the one row when there are no windows", () => {
    const credits: UsageLimitCredits = {
      label: "Extra usage",
      usedPercent: 4,
      usedAmount: 44,
      limitAmount: 1000,
      currency: "USD",
      detail: null,
      recordedAt: "2026-10-27T12:00:00.000Z",
      source: "on_demand",
    }
    const rows = selectPlanUsage(makeSnapshot("claude", [], "ok", credits), "claude")
    expect(ids(rows)).toEqual(["credits"])
    expect(rows?.[0]).toMatchObject({ shortLabel: "", credits, window: { usedPercent: 4, resetsAt: null } })
    // A cap with no percent has nothing to draw.
    expect(selectPlanUsage(makeSnapshot("claude", [], "ok", { ...credits, usedPercent: null }), "claude")).toBeNull()
    // Windows win when there are any.
    expect(ids(selectPlanUsage(makeSnapshot("claude", [makeWindow("five_hour", "Current session (5-hour)", 42)], "ok", credits), "claude"))).toEqual(["five_hour"])
  })
})

describe("shortUsageLabel", () => {
  test("keeps row labels to a few characters", () => {
    expect(shortUsageLabel(makeWindow("codex:primary", "15-minute", 1))).toBe("15m")
    expect(shortUsageLabel(makeWindow("codex:primary", "3-day", 1))).toBe("3d")
    expect(shortUsageLabel(makeWindow("grok-build", "Weekly · Grok Build", 1))).toBe("Wk Build")
  })
})

describe("formatResetCountdown", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z")

  test("counts down to the reset, rounded up to the minute", () => {
    expect(formatResetCountdown("2026-10-27T14:14:00.000Z", now)).toBe("2h 14m")
    expect(formatResetCountdown("2026-10-27T12:38:00.000Z", now)).toBe("38m")
    expect(formatResetCountdown("2026-10-27T12:00:20.000Z", now)).toBe("1m")
    expect(formatResetCountdown("2026-10-27T15:00:00.000Z", now)).toBe("3h")
    expect(formatResetCountdown("2026-10-30T16:00:00.000Z", now)).toBe("3d 4h")
  })

  test("is null when the reset time is unknown or already past", () => {
    expect(formatResetCountdown(null, now)).toBeNull()
    expect(formatResetCountdown("not a date", now)).toBeNull()
    expect(formatResetCountdown("2026-10-27T11:59:00.000Z", now)).toBeNull()
  })
})

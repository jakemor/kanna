import { describe, expect, test } from "bun:test"
import type { ProviderUsageSnapshot, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"
import {
  LIMIT_RING_PROVIDERS,
  limitRingColorClass,
  limitRingRemainingPercent,
  modelScopeMatches,
  selectLimitRingWindows,
} from "./usageLimitRings"

const FIVE_HOUR = 300
const WEEKLY = 10_080

function makeWindow(
  id: string,
  usedPercent: number | null,
  windowMinutes: number | null,
  modelLabel: string | null = null,
): UsageLimitWindow {
  return {
    id,
    label: id,
    usedPercent,
    resetsAt: null,
    windowMinutes,
    modelLabel,
    recordedAt: "2026-08-15T00:00:00.000Z",
    source: "on_demand",
  }
}

function makeSnapshot(provider: "claude" | "codex", windows: UsageLimitWindow[]): UsageLimitsSnapshot {
  const providerSnapshot: ProviderUsageSnapshot = {
    provider,
    status: "ok",
    plan: null,
    windows,
    credits: null,
    detail: null,
    updatedAt: null,
  }
  return { providers: [providerSnapshot] }
}

/** Mirrors a real Claude Max response: keyed windows plus a model_scoped lane. */
const CLAUDE_WINDOWS = [
  makeWindow("five_hour", 18, FIVE_HOUR),
  makeWindow("seven_day", 15, WEEKLY),
  makeWindow("model_scoped:fable", 17, WEEKLY, "Fable"),
]

describe("selectLimitRingWindows", () => {
  test("claude weekly follows the selected model when a lane exists", () => {
    const { slots } = selectLimitRingWindows(makeSnapshot("claude", CLAUDE_WINDOWS), "claude", "claude-fable-5")
    expect(slots.map((slot) => slot.key)).toEqual(["session", "weekly"])
    expect(slots[0]?.window?.id).toBe("five_hour")
    expect(slots[1]?.window?.id).toBe("model_scoped:fable")
    expect(slots[1]?.window?.usedPercent).toBe(17)
  })

  test("claude weekly falls back to the all-models window for other models", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5[1m]"]) {
      const { slots } = selectLimitRingWindows(makeSnapshot("claude", CLAUDE_WINDOWS), "claude", model)
      const expected = model.startsWith("claude-fable") ? "model_scoped:fable" : "seven_day"
      expect(slots[1]?.window?.id).toBe(expected)
    }
  })

  test("claude never substitutes a fixed per-model key for the all-models weekly", () => {
    const windows = [makeWindow("seven_day_opus", 90, WEEKLY), makeWindow("five_hour", 5, FIVE_HOUR)]
    const { slots } = selectLimitRingWindows(makeSnapshot("claude", windows), "claude", "claude-opus-5")
    expect(slots[1]?.window).toBeNull()
  })

  test("codex shows one weekly ring, taken from the window's duration not its slot", () => {
    const windows = [
      makeWindow("codex:primary", 21, WEEKLY),
      makeWindow("codex_bengalfox:primary", 4, WEEKLY, "GPT 5.3 Codex Spark"),
    ]
    const { slots } = selectLimitRingWindows(makeSnapshot("codex", windows), "codex", "gpt-5.3-codex")
    expect(slots.map((slot) => slot.key)).toEqual(["weekly"])
    expect(slots[0]?.window?.id).toBe("codex:primary")
  })

  test("codex weekly switches to the model lane when that exact model is selected", () => {
    const windows = [
      makeWindow("codex:primary", 21, WEEKLY),
      makeWindow("codex_bengalfox:primary", 4, WEEKLY, "GPT 5.3 Codex Spark"),
    ]
    const { slots } = selectLimitRingWindows(makeSnapshot("codex", windows), "codex", "gpt-5.3-codex-spark")
    expect(slots[0]?.window?.id).toBe("codex_bengalfox:primary")
  })

  test("codex session window is never shown, even when the plan reports one", () => {
    const windows = [makeWindow("codex:primary", 30, FIVE_HOUR), makeWindow("codex:secondary", 21, WEEKLY)]
    const { slots } = selectLimitRingWindows(makeSnapshot("codex", windows), "codex", null)
    expect(slots.map((slot) => slot.key)).toEqual(["weekly"])
    expect(slots[0]?.window?.id).toBe("codex:secondary")
  })

  test("a snapshot from an older server still fills the rings", () => {
    const legacy = (id: string, label: string, usedPercent: number) => ({
      id,
      label,
      usedPercent,
      resetsAt: null,
      recordedAt: "2026-08-15T00:00:00.000Z",
      source: "cache" as const,
    }) as unknown as UsageLimitWindow

    const claude = selectLimitRingWindows(
      makeSnapshot("claude", [
        legacy("five_hour", "Current session (5-hour)", 21),
        legacy("seven_day", "Weekly · All models", 14),
        legacy("nimbus_quill", "Nimbus Quill", 0),
      ]),
      "claude",
      "claude-opus-5",
    )
    expect(claude.slots.map((slot) => slot.window?.usedPercent)).toEqual([21, 14])

    const codex = selectLimitRingWindows(
      makeSnapshot("codex", [
        legacy("codex:primary", "Weekly", 21),
        legacy("codex_bengalfox:primary", "Weekly · GPT 5.3 Codex Spark", 0),
      ]),
      "codex",
      "gpt-5.3-codex",
    )
    expect(codex.slots[0]?.window?.id).toBe("codex:primary")
  })

  test("missing windows keep their slot with a null window", () => {
    const empty = selectLimitRingWindows(null, "claude", "claude-fable-5")
    expect(empty.snapshot).toBeNull()
    expect(empty.slots.map((slot) => slot.window)).toEqual([null, null])

    const partial = selectLimitRingWindows(
      makeSnapshot("claude", [makeWindow("five_hour", 5, FIVE_HOUR)]),
      "claude",
      "claude-fable-5",
    )
    expect(partial.slots[0]?.window?.id).toBe("five_hour")
    expect(partial.slots[1]?.window).toBeNull()
  })

  test("only claude and codex are ring providers", () => {
    expect([...LIMIT_RING_PROVIDERS].sort()).toEqual(["claude", "codex"])
    expect(selectLimitRingWindows(makeSnapshot("claude", CLAUDE_WINDOWS), "pi", null).slots).toEqual([])
  })
})

describe("modelScopeMatches", () => {
  test("a one-word scope matches the selected model's family", () => {
    expect(modelScopeMatches("Fable", "claude-fable-5")).toBe(true)
    expect(modelScopeMatches("Fable", "claude-fable-5[1m]")).toBe(true)
    expect(modelScopeMatches("Fable", "fable")).toBe(true)
    expect(modelScopeMatches("Opus", "claude-opus-4-8")).toBe(true)
    expect(modelScopeMatches("Fable", "claude-opus-5")).toBe(false)
  })

  test("a multi-word scope requires the whole model, so a shorter name cannot claim it", () => {
    expect(modelScopeMatches("GPT 5.3 Codex Spark", "gpt-5.3-codex-spark")).toBe(true)
    expect(modelScopeMatches("GPT 5.3 Codex Spark", "gpt-5.3-codex")).toBe(false)
  })

  test("no selected model never matches", () => {
    expect(modelScopeMatches("Fable", null)).toBe(false)
  })
})

describe("limitRingRemainingPercent", () => {
  test("inverts used percent and clamps", () => {
    expect(limitRingRemainingPercent(0)).toBe(100)
    expect(limitRingRemainingPercent(40)).toBe(60)
    expect(limitRingRemainingPercent(120)).toBe(0)
    expect(limitRingRemainingPercent(null)).toBeNull()
  })
})

describe("limitRingColorClass", () => {
  test("matches the Usage page thresholds", () => {
    expect(limitRingColorClass(10)).toBe("text-emerald-500")
    expect(limitRingColorClass(74.9)).toBe("text-emerald-500")
    expect(limitRingColorClass(75)).toBe("text-amber-500")
    expect(limitRingColorClass(90)).toBe("text-red-500")
    expect(limitRingColorClass(null)).toBe("text-muted-foreground/40")
  })
})

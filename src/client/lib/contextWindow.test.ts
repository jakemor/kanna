import { describe, expect, test } from "bun:test"
import type { TranscriptEntry } from "../../shared/types"
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  overrideContextWindowMaxTokens,
} from "./contextWindow"

function entry(partial: Omit<TranscriptEntry, "_id" | "createdAt">, createdAt = Date.now()): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...partial,
  } as TranscriptEntry
}

describe("deriveLatestContextWindowSnapshot", () => {
  test("derives the latest valid snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      entry({ kind: "context_window_updated", usage: { usedTokens: 0, compactsAutomatically: false } }, 1),
      entry({ kind: "context_window_updated", usage: { usedTokens: 125, maxTokens: 500, compactsAutomatically: false } }, 2),
    ])

    expect(snapshot).not.toBeNull()
    expect(snapshot?.usedTokens).toBe(125)
    expect(snapshot?.maxTokens).toBe(500)
    expect(snapshot?.usedPercentage).toBe(25)
    expect(snapshot?.remainingTokens).toBe(375)
  })

  test("marks snapshots as compaction-capable when the chat contains compaction signals", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      entry({ kind: "compact_boundary" }, 1),
      entry({ kind: "context_window_updated", usage: { usedTokens: 321, compactsAutomatically: false } }, 2),
    ])

    expect(snapshot?.compactsAutomatically).toBe(true)
  })

  test("a harness switch resets the meter: only usage after the last handoff boundary counts", () => {
    // Usage (and compaction signals) from the old provider's session don't
    // describe the new session's context window.
    expect(deriveLatestContextWindowSnapshot([
      entry({ kind: "compact_boundary" }, 1),
      entry({ kind: "context_window_updated", usage: { usedTokens: 999, compactsAutomatically: false } }, 2),
      entry({ kind: "handoff_boundary", fromProvider: "claude", toProvider: "codex" }, 3),
    ])).toBeNull()

    const afterSwitch = deriveLatestContextWindowSnapshot([
      entry({ kind: "compact_boundary" }, 1),
      entry({ kind: "context_window_updated", usage: { usedTokens: 999, compactsAutomatically: false } }, 2),
      entry({ kind: "handoff_boundary", fromProvider: "claude", toProvider: "codex" }, 3),
      entry({ kind: "context_window_updated", usage: { usedTokens: 42, compactsAutomatically: false } }, 4),
    ])
    expect(afterSwitch?.usedTokens).toBe(42)
    expect(afterSwitch?.compactsAutomatically).toBe(false)
  })

  test("a session restore resets the meter like a handoff boundary", () => {
    // The restored session is a fresh native session, so usage before the
    // session_restored boundary describes the old (gone) one.
    expect(deriveLatestContextWindowSnapshot([
      entry({ kind: "context_window_updated", usage: { usedTokens: 999, compactsAutomatically: false } }, 1),
      entry({ kind: "session_restored", provider: "claude" }, 2),
    ])).toBeNull()

    const afterRestore = deriveLatestContextWindowSnapshot([
      entry({ kind: "context_window_updated", usage: { usedTokens: 999, compactsAutomatically: false } }, 1),
      entry({ kind: "session_restored", provider: "claude" }, 2),
      entry({ kind: "context_window_updated", usage: { usedTokens: 7, compactsAutomatically: false } }, 3),
    ])
    expect(afterRestore?.usedTokens).toBe(7)
  })
})

describe("formatContextWindowTokens", () => {
  test("formats raw and abbreviated token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999")
    expect(formatContextWindowTokens(1400)).toBe("1.4k")
    expect(formatContextWindowTokens(14_000)).toBe("14k")
    expect(formatContextWindowTokens(1_400_000)).toBe("1.4m")
  })
})

describe("overrideContextWindowMaxTokens", () => {
  test("recomputes denominator-dependent fields with a staged max token value", () => {
    const base = deriveLatestContextWindowSnapshot([
      entry({ kind: "context_window_updated", usage: { usedTokens: 50_000, maxTokens: 200_000, compactsAutomatically: false } }),
    ])

    const overridden = overrideContextWindowMaxTokens(base, 1_000_000)

    expect(overridden?.maxTokens).toBe(1_000_000)
    expect(overridden?.usedPercentage).toBe(5)
    expect(overridden?.remainingTokens).toBe(950_000)
  })
})

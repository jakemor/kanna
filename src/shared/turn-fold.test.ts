import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import fixtures from "./turn-fold.fixtures.json"
import {
  computeTurnFolds,
  foldEntriesFromTranscript,
  formatWorkedDuration,
  runningTurnStartedAt,
  turnFoldLabel,
  type FoldEntry,
  type TurnFold,
} from "./turn-fold"
import type { TranscriptEntry } from "./types"

interface ExpectedFold {
  id: string
  header: string | null
  settled: boolean
  folds: boolean
  outcome: string
  workedMs: number | null
  label: string
  roles: Record<string, string>
}

/** A fold as the fixtures write it: by entry id, so the web's hydrated rows and the raw entries both check against it. */
function describeFolds(entries: readonly FoldEntry[], folds: readonly TurnFold[]): ExpectedFold[] {
  return folds.map((fold) => {
    const roles: Record<string, string> = {}
    fold.roles.forEach((role, offset) => { roles[entries[fold.start + offset]!.id] = role })
    return {
      id: fold.id,
      header: fold.start <= fold.end ? entries[fold.start]!.id : null,
      settled: fold.settled,
      folds: fold.folds,
      outcome: fold.outcome,
      workedMs: fold.workedMs ?? null,
      label: turnFoldLabel(fold, false),
      roles,
    }
  })
}

describe("turn folds (shared fixtures, also run by the iOS app)", () => {
  for (const fixture of fixtures.cases) {
    test(fixture.name, () => {
      const entries = foldEntriesFromTranscript(fixture.entries as unknown as TranscriptEntry[])
      const folds = computeTurnFolds(entries, { atRest: fixture.atRest })
      expect(describeFolds(entries, folds)).toEqual(fixture.folds as ExpectedFold[])
      // The live clock, where a case says where it should start (the web's alone).
      if ("workingSince" in fixture) expect(runningTurnStartedAt(entries)).toBe(fixture.workingSince ?? null)
    })
  }
})

describe("turn fold words", () => {
  test("durations", () => {
    expect(formatWorkedDuration(400)).toBe("<1s")
    expect(formatWorkedDuration(32_000)).toBe("32s")
    expect(formatWorkedDuration(10 * 60_000)).toBe("10m 0s")
    expect(formatWorkedDuration(134_000)).toBe("2m 14s")
  })

  test("an open fold with no time offers to hide the work", () => {
    expect(turnFoldLabel({ outcome: "completed", workedMs: undefined }, true)).toBe("Hide work")
    expect(turnFoldLabel({ outcome: "completed", workedMs: undefined }, false)).toBe("Show work")
    expect(turnFoldLabel({ outcome: "completed", workedMs: 5000 }, true)).toBe("Worked for 5s")
    expect(turnFoldLabel({ outcome: "stopped", workedMs: undefined }, false)).toBe("Stopped · Show work")
    expect(turnFoldLabel({ outcome: "failed", workedMs: undefined }, true)).toBe("Failed · Hide work")
  })
})

describe("runningTurnStartedAt", () => {
  const entry = (id: string, kind: FoldEntry["kind"], createdAt: number): FoldEntry => ({ id, kind, hidden: false, createdAt })

  test("from the prompt that started the run", () => {
    expect(runningTurnStartedAt([entry("p0", "prompt", 0), entry("r0", "result", 5), entry("p1", "prompt", 10), entry("a1", "text", 20)])).toBe(10)
  })

  test("never from a prompt before the latest, even one whose turn wrote no end", () => {
    expect(runningTurnStartedAt([entry("p1", "prompt", 10), entry("c1", "tool", 11), entry("p2", "prompt", 5_000), entry("a1", "text", 5_020)])).toBe(5_000)
  })

  test("nothing is running once the last turn ended", () => {
    expect(runningTurnStartedAt([entry("p1", "prompt", 10), entry("r1", "result", 20)])).toBeNull()
  })
})

// The iOS app runs the same file from its own repository. Where both are
// checked out together, the two copies have to say the same thing.
test("the iOS copy of the fixtures matches", () => {
  const iosCopy = path.join(import.meta.dir, "../../ios/Tests/Fixtures/turn-fold.fixtures.json")
  if (!existsSync(iosCopy)) return
  const ours = readFileSync(path.join(import.meta.dir, "turn-fold.fixtures.json"), "utf8")
  expect(readFileSync(iosCopy, "utf8")).toBe(ours)
})

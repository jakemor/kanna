import { describe, expect, test } from "bun:test"
import fixtures from "./turn-folds.fixtures.json"
import {
  buildChatTurnFolds,
  computeTurnFolds,
  foldEntriesFromTranscript,
  runningTurnStartedAt,
  sliceTurnFolds,
  TurnFoldCache,
  type FoldEntry,
  type TurnFold,
} from "./turn-folds"
import { formatWorkedDuration, turnFoldLabel } from "../shared/turn-fold-label"
import type { TranscriptEntry } from "../shared/types"

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

describe("turn folds (the fixtures)", () => {
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
  const entry = (id: string, kind: FoldEntry["kind"], createdAt: number): FoldEntry => ({ id, index: createdAt, kind, hidden: false, createdAt })

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

describe("the folds a snapshot carries", () => {
  const entries = (name: string) => fixtures.cases.find((c) => c.name === name)!.entries as unknown as TranscriptEntry[]

  test("named by entry id: span, reply, the rule that ends it, and what else stays", () => {
    const wire = buildChatTurnFolds(entries("What survives the fold"), { status: "idle" })
    expect(wire.folds).toEqual([{
      id: "p1",
      firstEntryId: "c1",
      lastEntryId: "res1",
      outcome: "completed",
      workedMs: 134_000,
      replyEntryId: "a1",
      endEntryId: "res1",
      keptEntryIds: ["c2", "c7", "c8", "c9", "c11", "cb", "cs", "c14"],
    }])
    expect(wire.latestId).toBe("p1")
    expect(wire.latestSettled).toBe(true)
    expect(wire.workingSince).toBeUndefined()
  })

  test("a delegator's chat cards stay and its reports fold", () => {
    const [fold] = buildChatTurnFolds(entries("A delegator's exchange keeps its chat cards and folds the reports"), { status: "idle" }).folds
    expect(fold!.keptEntryIds).toEqual(["cc1", "cc2", "cc3"])
    expect(fold!.replyEntryId).toBe("a4")
  })

  test("while a turn runs: only the settled ones, and when it started", () => {
    const wire = buildChatTurnFolds(entries("A running turn is not settled; the one before it is"), { status: "running" })
    expect(wire.folds.map((fold) => fold.id)).toEqual(["p0"])
    expect(wire.latestId).toBe("p1")
    expect(wire.latestSettled).toBe(false)
    expect(wire.workingSince).toBe(5000)
  })

  test("waiting on sub-chats is not settled, and is not working either", () => {
    const wire = buildChatTurnFolds(entries("A delegator's turn waits unfolded on its sub-chats"), { status: "waiting_on_subagent" })
    expect(wire.folds).toEqual([])
    expect(wire.latestSettled).toBe(false)
    expect(wire.workingSince).toBeUndefined()
  })

  test("a window carries the folds that end inside it, whole even when it starts inside one", () => {
    const all = entries("A running turn is not settled; the one before it is")
    const settledFirst = buildChatTurnFolds(all, { status: "running" })
    expect(settledFirst.folds.map((fold) => fold.id)).toEqual(["p0"])
    // From the second entry on: the first fold is cut, but still carried.
    expect(buildChatTurnFolds(all, { status: "running", fromIndex: 1 }).folds.map((fold) => fold.id)).toEqual(["p0"])
    // Past its end: not carried.
    const afterFirst = all.findIndex((entry) => entry._id === "p1")
    expect(buildChatTurnFolds(all, { status: "running", fromIndex: afterFirst }).folds).toEqual([])
    expect(sliceTurnFolds(settledFirst, all.slice(0, afterFirst)).folds).toEqual([])
    expect(sliceTurnFolds(settledFirst, all.slice(0, 2))).toBe(settledFirst)
  })

  test("the cache answers the same while a turn streams, and again once a prompt opens the next", () => {
    const cache = new TurnFoldCache()
    const live = [...entries("A running turn is not settled; the one before it is")]
    const first = cache.get(live, "running", 0)
    live.push({ _id: "a9", kind: "assistant_text", text: "more", createdAt: 9_000 } as TranscriptEntry)
    expect(cache.get(live, "running", 0)).toEqual(first)
    live.push({ _id: "res9", kind: "result", subtype: "success", isError: false, durationMs: 4000, result: "", createdAt: 9_500 } as TranscriptEntry)
    const settled = cache.get(live, "idle", 0)
    expect(settled.folds.map((fold) => fold.id)).toEqual(["p0", "p1"])
    expect(settled.latestSettled).toBe(true)
  })
})

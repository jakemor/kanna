import { describe, expect, test } from "bun:test"
import fixtures from "./turn-folds.fixtures.json"
import {
  buildChatTurnFolds,
  computeTurnFolds,
  foldEntriesFromTranscript,
  runningTurnStartedAt,
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
  chatCards?: unknown[]
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
      ...(fold.chatCards.length > 0 ? { chatCards: fold.chatCards } : {}),
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

// Snapshots fold one turn's entries at a time; the fixtures read a whole
// transcript. The two have to agree on every fold.
describe("one turn at a time, as snapshots fold, says what the fixtures say", () => {
  for (const fixture of fixtures.cases) {
    test(fixture.name, () => {
      const wire = buildChatTurnFolds(fixture.entries as unknown as TranscriptEntry[], { status: fixture.atRest ? "idle" : "running" })
      const expected = (fixture.folds as ExpectedFold[]).filter((fold) => fold.folds)
      expect(Object.values(wire.folds).map((fold) => [fold.id, fold.firstEntryId, fold.replyEntryId ?? null]))
        .toEqual(expected.map((fold) => [fold.id, fold.header, Object.entries(fold.roles).find(([, role]) => role === "reply")?.[0] ?? null]))
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

  test("by turn: span, reply, the rule that ends it, and what else stays", () => {
    const wire = buildChatTurnFolds(entries("What survives the fold"), { status: "idle" })
    expect(wire.folds).toEqual({
      p1: {
        id: "p1",
        firstEntryId: "c1",
        lastEntryId: "res1",
        outcome: "completed",
        workedMs: 134_000,
        replyEntryId: "a1",
        endEntryId: "res1",
        keptEntryIds: ["c2", "c7", "c8", "c9", "c11", "cb", "cs", "c14"],
      },
    })
    expect(wire.runningTurnId).toBeUndefined()
  })

  test("a delegator's turns are folds of their own, named by what opened each", () => {
    const wire = buildChatTurnFolds(entries("A delegator's turns fold one by one, each report above its own"), { status: "idle" })
    // The last turn had nothing to hide.
    expect(Object.keys(wire.folds)).toEqual(["p1", "rp1"])
    expect(wire.folds.p1!.chatCards?.map((card) => [card.chatId, card.last])).toEqual([["chatA", "started"], ["chatB", "started"]])
    expect(wire.folds.rp1!.firstEntryId).toBe("a3")
    expect(wire.folds.rp1!.replyEntryId).toBe("a3")
    // The report that opened it is above it, not a card in it.
    expect(wire.folds.rp1!.chatCards?.map((card) => [card.chatId, card.last])).toEqual([["chatA", "sent"]])
    expect(wire.folds.rp1!.keptEntryIds).toEqual([])
  })

  test("Product: three folds, each with its one reply", () => {
    const wire = buildChatTurnFolds(entries("Product: each turn the delegator ends folds on its own"), { status: "idle" })
    expect(Object.values(wire.folds).map((fold) => [fold.id, fold.replyEntryId, fold.workedMs, fold.chatCards?.length ?? 0]))
      .toEqual([["p1", "a1", 3000, 1], ["rp1", "a2", 3000, 0], ["rp2", "a3", 1000, 0]])
  })

  test("a chat call that failed keeps its own row and makes no card", () => {
    const failed = [
      { _id: "p1", kind: "user_prompt", content: "go", createdAt: 0 },
      { _id: "a1", kind: "assistant_text", text: "Asking.", createdAt: 1 },
      { _id: "cc1", kind: "tool_call", createdAt: 2, tool: { kind: "tool", toolKind: "chat", toolName: "send_message", toolId: "t1", input: { payload: { chatId: "gone", message: "hi" } } } },
      { _id: "rc1", kind: "tool_result", toolId: "t1", content: "No such chat", isError: true, createdAt: 3 },
      { _id: "a2", kind: "assistant_text", text: "It is gone.", createdAt: 4 },
      { _id: "res1", kind: "result", subtype: "success", isError: false, durationMs: 4, result: "", createdAt: 5 },
    ] as unknown as TranscriptEntry[]
    const fold = buildChatTurnFolds(failed, { status: "idle" }).folds.p1!
    expect(fold.keptEntryIds).toEqual(["cc1"])
    expect(fold.chatCards).toBeUndefined()
  })

  test("the turn in progress has no fold; every turn before it has one", () => {
    const wire = buildChatTurnFolds(entries("A running turn is not settled; the one before it is"), { status: "running" })
    expect(Object.keys(wire.folds)).toEqual(["p0"])
    expect(wire.runningTurnId).toBe("p1")
    expect(wire.workingSince).toBe(5000)
  })

  test("waiting on sub-chats, the delegator's turn has ended: it folds, and nothing is running", () => {
    const wire = buildChatTurnFolds(entries("A delegator turn still going is not folded"), { status: "waiting_on_subagent" })
    expect(Object.keys(wire.folds)).toEqual(["p1"])
    expect(wire.runningTurnId).toBeUndefined()
    expect(wire.workingSince).toBeUndefined()
  })

  test("a turn a report resumed runs unfolded; the turn before it stays folded", () => {
    const all = entries("A delegator's turns fold one by one, each report above its own")
    const upToRunning = all.slice(0, all.findIndex((entry) => entry._id === "c1") + 1)
    const wire = buildChatTurnFolds(upToRunning, { status: "running" })
    expect(Object.keys(wire.folds)).toEqual(["p1"])
    expect(wire.runningTurnId).toBe("rp1")
    expect(wire.workingSince).toBe(60000)
  })

  test("a window carries the folds of the turns that end inside it, whole even when it starts inside one", () => {
    const all = entries("A running turn is not settled; the one before it is")
    expect(Object.keys(buildChatTurnFolds(all, { status: "running", fromIndex: 1 }).folds)).toEqual(["p0"])
    const afterFirst = all.findIndex((entry) => entry._id === "p1")
    expect(buildChatTurnFolds(all, { status: "running", fromIndex: afterFirst }).folds).toEqual({})
  })
})

describe("a fold, once its turn has ended, never changes", () => {
  const first: TranscriptEntry[] = [
    { _id: "p1", kind: "user_prompt", content: "go", createdAt: 0 },
    { _id: "a1", kind: "assistant_text", text: "Looking.", createdAt: 1_000 },
    { _id: "c1", kind: "tool_call", createdAt: 2_000, tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: {} } },
    { _id: "r1", kind: "tool_result", toolId: "t1", content: "ok", createdAt: 3_000 },
    { _id: "a2", kind: "assistant_text", text: "Done.", createdAt: 4_000 },
    { _id: "res1", kind: "result", subtype: "success", isError: false, durationMs: 4_000, result: "", createdAt: 5_000 },
  ] as unknown as TranscriptEntry[]
  const second = [
    { _id: "p2", kind: "user_prompt", content: "again", createdAt: 9_000 },
    { _id: "b1", kind: "assistant_text", text: "On it.", createdAt: 9_500 },
    { _id: "d1", kind: "tool_call", createdAt: 9_600, tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t2", input: {} } },
    { _id: "e1", kind: "tool_result", toolId: "t2", content: "ok", createdAt: 9_700 },
  ] as unknown as TranscriptEntry[]
  const secondEnd = [
    { _id: "b2", kind: "assistant_text", text: "Done again.", createdAt: 9_800 },
    { _id: "res2", kind: "result", subtype: "success", isError: false, durationMs: 800, result: "", createdAt: 9_900 },
  ] as unknown as TranscriptEntry[]

  test("through the next turn starting, streaming and ending, and through the cache", () => {
    const cache = new TurnFoldCache()
    const live = [...first]
    const ended = cache.get(live, "idle", 0).folds.p1
    expect(ended).toBeDefined()
    // The next prompt arrives: the chat is running again.
    live.push(second[0]!)
    let wire = cache.get(live, "running", 0)
    expect(wire.folds.p1).toEqual(ended!)
    expect(wire.runningTurnId).toBe("p2")
    expect(wire.folds.p2).toBeUndefined()
    // It streams.
    for (const entry of second.slice(1)) {
      live.push(entry)
      wire = cache.get(live, "running", 0)
      expect(wire.folds.p1).toEqual(ended!)
      expect(wire.folds.p2).toBeUndefined()
    }
    // It ends: it folds too, and the first does not move.
    live.push(...secondEnd)
    wire = cache.get(live, "idle", 0)
    expect(wire.folds.p1).toEqual(ended!)
    expect(wire.folds.p2?.replyEntryId).toBe("b2")
    expect(wire.runningTurnId).toBeUndefined()
    // A fresh read, as after a restart, says the same.
    expect(buildChatTurnFolds(live, { status: "idle" }).folds).toEqual(wire.folds)
  })
})

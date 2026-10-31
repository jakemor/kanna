import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import fixtures from "../../shared/turn-fold.fixtures.json"
import { computeTurnFolds, foldEntriesFromMessages, turnFoldLabel, type FoldEntry, type TurnFold } from "../../shared/turn-fold"
import type { HydratedTranscriptMessage, TranscriptEntry } from "../../shared/types"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { buildTranscriptTurns } from "./ChatPage/transcriptTurns"
import { buildRowIndexByMessageId, getRowAnchorMessageId } from "./ChatPage/transcriptScrollAnchors"
import { buildResolvedTranscriptRows, KannaTranscriptRow, type ResolvedTranscriptRow } from "./KannaTranscript"
import { applyTurnFolds, foldHeaderRowId, indexTurnFolds, isTurnFoldOpen } from "./turnFolds"

type Fixture = (typeof fixtures.cases)[number]

function fixture(name: string): Fixture {
  const found = fixtures.cases.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no fixture ${name}`)
  return found
}

function hydrate(entries: unknown[]): HydratedTranscriptMessage[] {
  return processTranscriptMessages(entries as TranscriptEntry[])
}

function describeFolds(entries: readonly FoldEntry[], folds: readonly TurnFold[]) {
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

// The shared fixtures again, through the rows the web client actually holds:
// hydrated messages, with tool results folded into their calls.
describe("turn folds from hydrated messages", () => {
  for (const testCase of fixtures.cases) {
    test(testCase.name, () => {
      const entries = foldEntriesFromMessages(hydrate(testCase.entries))
      expect(describeFolds(entries, computeTurnFolds(entries, { atRest: testCase.atRest }))).toEqual(testCase.folds as ReturnType<typeof describeFolds>)
    })
  }
})

function foldedRows(testCase: Fixture, open: (foldId: string) => boolean) {
  const messages = hydrate(testCase.entries)
  const rows = buildResolvedTranscriptRows(messages, {
    isLoading: !testCase.atRest,
    latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
  })
  const folds = computeTurnFolds(foldEntriesFromMessages(messages), { atRest: testCase.atRest })
  return { rows, folded: applyTurnFolds(rows, indexTurnFolds(messages, folds), open) }
}

/** What each row is, by the messages it draws. */
function rowNames(rows: readonly ResolvedTranscriptRow[]) {
  return rows.map((row) => {
    if (row.kind === "fold-header") return `[${row.open ? "open" : "closed"} ${row.foldId}]`
    if (row.kind === "tool-group") return row.messages.map((message) => message.id).join("+")
    return row.endsFold ? `${row.message.id}(ends)` : row.message.id
  })
}

describe("the transcript's rows around a fold", () => {
  test("closed: the prompt, the header, what survives, the reply and the rule", () => {
    const { folded } = foldedRows(fixture("What survives the fold"), () => false)
    expect(rowNames(folded)).toEqual(["p1", "[closed p1]", "c2", "c7", "c8", "c9", "c11", "cb", "cs", "a1", "c14", "res1(ends)"])
  })

  test("open: every row back in place under the header", () => {
    const { rows, folded } = foldedRows(fixture("What survives the fold"), () => true)
    const names = rowNames(folded)
    expect(names[1]).toBe("[open p1]")
    expect(names.filter((name) => !name.startsWith("["))).toEqual(rowNames(rows).map((name) => name === "res1" ? "res1(ends)" : name))
  })

  test("a delegator's chat cards and reports stay in place inside its closed fold", () => {
    const { folded } = foldedRows(fixture("A delegator's exchange folds around its chat cards and reports"), () => false)
    expect(rowNames(folded)).toEqual(["p1", "[closed p1]", "cc1", "cc2", "rp1", "cc3", "rp2", "a4", "res3(ends)"])
  })

  test("a delegator waiting on its sub-chats draws no header", () => {
    const { rows, folded } = foldedRows(fixture("A delegator's turn waits unfolded on its sub-chats"), () => false)
    expect(rowNames(folded)).toEqual(rowNames(rows))
  })

  test("a failed turn keeps its error under the header", () => {
    const { folded } = foldedRows(fixture("A failed turn keeps its error"), () => false)
    expect(rowNames(folded)).toEqual(["p1", "[closed p1]", "res1"])
  })

  test("a running turn draws everything and no header; the settled one before it folds", () => {
    const { folded } = foldedRows(fixture("A running turn is not settled; the one before it is"), () => false)
    expect(rowNames(folded)).toEqual(["p0", "[closed p0]", "a00", "res0(ends)", "p1", "a1", "c1"])
  })

  test("supervibes: the turn left on an unanswered form shows whole, with no empty header", () => {
    const testCase = fixture("Supervibes: the chart turn once it ends")
    const { folded } = foldedRows(testCase, () => false)
    const names = rowNames(folded)
    const oauth = names.findIndex((name) => name.startsWith("902f6b2d"))
    const chart = names.findIndex((name) => name.startsWith("b576b9a0"))
    expect(names.slice(oauth + 1, chart).some((name) => name.startsWith("["))).toBe(false)
    expect(names.slice(oauth + 1, chart).some((name) => name.startsWith("6e961f70"))).toBe(true)
    // The form turns before it fold, timed without the wait on the form.
    expect(folded.filter((row) => row.kind === "fold-header").map((row) => row.kind === "fold-header" && row.workedMs)).toEqual([8923, 8225])
  })

  test("a turn the window cut folds under a header at the top", () => {
    const { folded } = foldedRows(fixture("A window that cuts a turn folds what it holds, timed by the provider"), () => false)
    expect(rowNames(folded)).toEqual(["[closed partial:a0]", "a1", "res0(ends)", "p1", "a2", "res1"])
  })

  test("the minimap still counts what a closed fold hides, and a header is no read position", () => {
    const { folded } = foldedRows(fixture("A finished turn folds its work and keeps its reply"), () => false)
    const turns = buildTranscriptTurns(folded)
    // a1 and c1 hidden, a2 shown.
    expect(turns[0]?.agentMessageCount).toBe(3)
    const header = folded.find((row) => row.kind === "fold-header")!
    expect(getRowAnchorMessageId(header)).toBeNull()
    expect(buildRowIndexByMessageId(folded).has("c1")).toBe(false)
  })

  test("the header renders as a button that says what it holds", () => {
    const { folded } = foldedRows(fixture("What survives the fold"), () => false)
    const header = folded.find((row) => row.kind === "fold-header")!
    const html = renderToStaticMarkup(
      <KannaTranscriptRow
        row={header}
        onToolGroupExpandedChange={() => undefined}
        onAskUserQuestionSubmit={() => undefined}
        onExitPlanModeConfirm={() => undefined}
      />,
    )
    expect(html).toContain("Worked for 2m 14s")
    expect(html).toContain("aria-expanded=\"false\"")
    expect(header.id).toBe(foldHeaderRowId("p1"))
  })
})

describe("whether a fold is open", () => {
  const base = { preference: undefined, landing: false, watched: false, latest: false }

  test("an older settled fold starts closed", () => {
    expect(isTurnFoldOpen(base)).toBe(false)
    expect(isTurnFoldOpen({ ...base, latest: true })).toBe(false)
  })

  test("a turn watched running stays open as it settles, until the next turn starts", () => {
    expect(isTurnFoldOpen({ ...base, watched: true, latest: true })).toBe(true)
    expect(isTurnFoldOpen({ ...base, watched: true, latest: false })).toBe(false)
  })

  test("the reader's own choice wins over everything", () => {
    expect(isTurnFoldOpen({ ...base, preference: false, watched: true, latest: true, landing: true })).toBe(false)
    expect(isTurnFoldOpen({ ...base, preference: true })).toBe(true)
  })

  test("a fold a jump or restored position lands in is open", () => {
    expect(isTurnFoldOpen({ ...base, landing: true })).toBe(true)
  })
})

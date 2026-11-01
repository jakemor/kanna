import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import fixtures from "../../server/turn-folds.fixtures.json"
// The server decides the folds; these tests build them as it would, then
// check what the client draws from them.
import { buildChatTurnFolds } from "../../server/turn-folds"
import type { ChatTurnFolds, HydratedTranscriptMessage, TranscriptEntry } from "../../shared/types"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { buildTranscriptTurns } from "./ChatPage/transcriptTurns"
import { buildRowIndexByMessageId, getRowAnchorMessageId } from "./ChatPage/transcriptScrollAnchors"
import { buildResolvedTranscriptRows, KannaTranscriptRow, type ResolvedTranscriptRow } from "./KannaTranscript"
import { applyTurnFolds, foldHeaderRowId, indexTurnFolds, settleScrollTarget, turnJustFolded } from "./turnFolds"

type Fixture = (typeof fixtures.cases)[number]

function fixture(name: string): Fixture {
  const found = fixtures.cases.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no fixture ${name}`)
  return found
}

function hydrate(entries: unknown[]): HydratedTranscriptMessage[] {
  return processTranscriptMessages(entries as TranscriptEntry[])
}

function serverFolds(testCase: Fixture): ChatTurnFolds {
  return buildChatTurnFolds(testCase.entries as unknown as TranscriptEntry[], { status: testCase.atRest ? "idle" : "running" })
}

/** The rows drawn from `entries` (a window of the case's), folded as the server says. */
function foldedRows(testCase: Fixture, open: (foldId: string) => boolean, options: { folds?: ChatTurnFolds | null; from?: number } = {}) {
  const messages = hydrate(testCase.entries.slice(options.from ?? 0))
  const rows = buildResolvedTranscriptRows(messages, {
    isLoading: !testCase.atRest,
    latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
  })
  const folds = options.folds === null ? undefined : (options.folds ?? serverFolds(testCase))
  return { rows, folded: applyTurnFolds(rows, indexTurnFolds(messages, folds), open) }
}

/** What each row is, by the messages it draws. */
function rowNames(rows: readonly ResolvedTranscriptRow[]) {
  return rows.map((row) => {
    if (row.kind === "fold-header") return `[${row.open ? "open" : "closed"} ${row.foldId}]`
    if (row.kind === "tool-group") return row.messages.map((message) => message.id).join("+")
    if (row.kind === "fold-chat-card") return `<${row.card.chatId} ${row.card.last}>`
    return row.kind === "single" && row.endsFold ? `${row.message.id}(ends)` : (row as { message: { id: string } }).message.id
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

  test("closed, each turn a delegator ends is its own fold, the report that resumed it above it", () => {
    const { folded } = foldedRows(fixture("A delegator's turns fold one by one, each report above its own"), () => false)
    // The last turn had nothing to hide: drawn whole, with no header.
    expect(rowNames(folded)).toEqual([
      "p1", "[closed p1]", "<chatA started>", "<chatB started>", "a2", "res1(ends)",
      "rp1", "[closed rp1]", "a3", "<chatA sent>", "res2(ends)",
      "rp2", "a4", "res3",
    ])
  })

  test("Product: three folds, each with its one reply", () => {
    const { folded } = foldedRows(fixture("Product: each turn the delegator ends folds on its own"), () => false)
    expect(rowNames(folded)).toEqual([
      "p1", "[closed p1]", "<chatD sent>", "a1", "res1(ends)",
      "rp1", "[closed rp1]", "a2", "res2(ends)",
      "rp2", "[closed rp2]", "a3", "res3(ends)",
    ])
  })

  test("open, a report-opened fold is the raw log: its send card, and no deduped card", () => {
    const { rows, folded } = foldedRows(fixture("A delegator's turns fold one by one, each report above its own"), () => true)
    const names = rowNames(folded)
    expect(names.some((name) => name.startsWith("<"))).toBe(false)
    expect(names.filter((name) => !name.startsWith("["))).toEqual(rowNames(rows).map((name) => (name === "res1" || name === "res2") ? `${name}(ends)` : name))
    for (const id of ["cc1", "cc2", "cc3", "rp1", "rp2"]) expect(names).toContain(id)
  })

  test("a send and the report it brings back are two turns: the send's card, then the report above the reply", () => {
    const { folded } = foldedRows(fixture("A send, then the report it brings back, are two turns"), () => false)
    expect(rowNames(folded)).toEqual(["p1", "[closed p1]", "<chatA sent>", "res1(ends)", "rp1", "a1", "res2"])
  })

  test("a card reads the last thing that passed, and opens its chat", () => {
    const { folded } = foldedRows(fixture("A send, then the report it brings back, are two turns"), () => false)
    const card = folded.find((row) => row.kind === "fold-chat-card")!
    const html = renderToStaticMarkup(
      <KannaTranscriptRow row={card} onToolGroupExpandedChange={() => undefined} onAskUserQuestionSubmit={() => undefined} onExitPlanModeConfirm={() => undefined} />,
    )
    expect(html).toContain("Sent · Correction on MMP.")
  })

  test("from a server that sends no folds, everything is drawn as it was", () => {
    const testCase = fixture("What survives the fold")
    const { rows, folded } = foldedRows(testCase, () => false, { folds: null })
    expect(rowNames(folded)).toEqual(rowNames(rows))
  })

  test("a delegator turn still going draws no header", () => {
    const { rows, folded } = foldedRows(fixture("A delegator turn still going is not folded"), () => false)
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
    // The server folds over the whole chat; the client holds from the middle of the report's turn.
    const testCase = fixture("A delegator's turns fold one by one, each report above its own")
    const from = testCase.entries.findIndex((entry) => entry._id === "c1")
    const { folded } = foldedRows(testCase, () => false, { from })
    expect(rowNames(folded)).toEqual(["[closed rp1]", "<chatA sent>", "res2(ends)", "rp2", "a4", "res3"])
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

describe("the rule: the turn in progress is drawn whole, every other turn is folded", () => {
  const closed = () => false

  test("a turn that just ended draws closed, with its card and reply", () => {
    const { folded } = foldedRows(fixture("A finished turn folds its work and keeps its reply"), closed)
    expect(rowNames(folded)).toEqual(["p1", "s1", "[closed p1]", "a2", "res1(ends)"])
  })

  test("a fold a report opened is keyed by the report, so its open state stays its own", () => {
    const testCase = fixture("Product: each turn the delegator ends folds on its own")
    const names = rowNames(foldedRows(testCase, (id) => id === "rp1").folded)
    expect(names).toContain("[open rp1]")
    expect(names).toContain("[closed p1]")
    expect(names).toContain("[closed rp2]")
    expect(foldHeaderRowId("rp1")).toBe("fold:rp1")
  })

  test("the turn in progress draws whole even when a fold for it is still held", () => {
    // A report resumed the turn: the client still holds the fold it had.
    const testCase = fixture("What survives the fold")
    const folds = serverFolds(testCase)
    const { rows, folded } = foldedRows(testCase, closed, { folds: { ...folds, runningTurnId: "p1" } })
    expect(rowNames(folded)).toEqual(rowNames(rows))
  })

  test("a fold the reader opened stays open; nothing else opens one", () => {
    const testCase = fixture("What survives the fold")
    expect(rowNames(foldedRows(testCase, (id) => id === "p1").folded)[1]).toBe("[open p1]")
    expect(rowNames(foldedRows(testCase, closed).folded)[1]).toBe("[closed p1]")
  })

  test("a turn that ended between two snapshots is the one that was running", () => {
    const folds = serverFolds(fixture("What survives the fold"))
    expect(turnJustFolded("p1", folds)).toBe("p1")
    expect(turnJustFolded(undefined, folds)).toBeUndefined()
    expect(turnJustFolded("p1", { ...folds, runningTurnId: "p1" })).toBeUndefined()
    expect(turnJustFolded("p9", folds)).toBeUndefined()
  })
})

describe("the scroll as a turn folds", () => {
  const base = {
    atEnd: false,
    text: { rowId: "a1", contentTop: 1_500 },
    scrollTop: 1_200,
    rowIds: new Set(["p1", "a1"]),
    headerOffsetPx: 60,
  }

  test("keeps the reply where it was on screen", () => {
    // 300px below the viewport's top before; the header inset is 60.
    expect(settleScrollTarget(base)).toEqual({ kind: "pin", rowId: "a1", offsetFromMessage: -240 })
  })

  test("a reader at the end stays at the end", () => {
    expect(settleScrollTarget({ ...base, atEnd: true })).toEqual({ kind: "end" })
  })

  test("nothing to hold when the reply is not drawn", () => {
    expect(settleScrollTarget({ ...base, rowIds: new Set(["p1"]) })).toBeNull()
    expect(settleScrollTarget({ ...base, text: null })).toBeNull()
  })
})

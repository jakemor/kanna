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
  const folds = options.folds === null ? undefined : (options.folds ?? serverFolds(testCase)).folds
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

  test("closed, a delegator's turn draws one card per sub-chat, where each first came up, and no report lines", () => {
    const testCase = fixture("A delegator's exchange closes to one card per sub-chat, in the order they came up")
    const { folded } = foldedRows(testCase, () => false)
    expect(rowNames(folded)).toEqual(["p1", "[closed p1]", "<chatA replied>", "<chatB started>", "<chatC replied>", "a4", "res3(ends)"])
  })

  test("open, the same turn is the raw log: every send card and report line, and no deduped cards", () => {
    const testCase = fixture("A delegator's exchange closes to one card per sub-chat, in the order they came up")
    const { rows, folded } = foldedRows(testCase, () => true)
    const names = rowNames(folded)
    expect(names.some((name) => name.startsWith("<"))).toBe(false)
    expect(names.filter((name) => !name.startsWith("["))).toEqual(rowNames(rows).map((name) => name === "res3" ? "res3(ends)" : name))
    for (const id of ["cc1", "cc2", "cc3", "rp1", "rp2"]) expect(names).toContain(id)
  })

  test("a send and a reply from one chat are one card; a chat that only replied gets one too", () => {
    const { folded } = foldedRows(fixture("A send and its reply from one chat are one card, saying the reply"), () => false)
    expect(rowNames(folded)).toEqual(["p1", "[closed p1]", "<chatA replied>", "<chatB replied>", "a1", "res2(ends)"])
  })

  test("a card reads the last thing that passed, and opens its chat", () => {
    const { folded } = foldedRows(fixture("A send and its reply from one chat are one card, saying the reply"), () => false)
    const card = folded.find((row) => row.kind === "fold-chat-card")!
    const html = renderToStaticMarkup(
      <KannaTranscriptRow row={card} onToolGroupExpandedChange={() => undefined} onAskUserQuestionSubmit={() => undefined} onExitPlanModeConfirm={() => undefined} />,
    )
    expect(html).toContain("Replied · Fixed the MMP page.")
  })

  test("from a server that sends no folds, everything is drawn as it was", () => {
    const testCase = fixture("What survives the fold")
    const { rows, folded } = foldedRows(testCase, () => false, { folds: null })
    expect(rowNames(folded)).toEqual(rowNames(rows))
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
    // The server folds over the whole chat; the client holds from the middle of turn 1.
    const testCase = fixture("A delegator's exchange closes to one card per sub-chat, in the order they came up")
    const from = testCase.entries.findIndex((entry) => entry._id === "rp1")
    const { folded } = foldedRows(testCase, () => false, { from })
    // The cards whose chat first came up before the window come first.
    expect(rowNames(folded)).toEqual(["[closed p1]", "<chatA replied>", "<chatB started>", "<chatC replied>", "a4", "res3(ends)"])
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

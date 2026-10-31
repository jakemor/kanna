import type { ChatTurnFolds, HydratedTranscriptMessage, TranscriptTurnFold, TurnFoldChatCard, TurnFoldOutcome } from "../../shared/types"
import type { ResolvedTranscriptRow } from "./KannaTranscript"

/**
 * Where the transcript's rows meet the folds the server sends
 * (`ChatSnapshot.turnFolds`, decided in server/turn-folds.ts): the header row
 * each fold gets, which rows a closed fold leaves out, and whether a fold is
 * open. Nothing here decides what folds.
 *
 * The rule is the server's and has no exceptions: the turn in progress is
 * drawn whole, every other turn is folded, and a fold is closed unless the
 * reader opened it themselves (lib/turn-fold-state.ts).
 */

export interface ResolvedFoldHeaderTranscriptRow {
  kind: "fold-header"
  id: string
  foldId: string
  open: boolean
  outcome: TurnFoldOutcome
  workedMs?: number
  /** What the closed fold leaves out that the minimap counts as the agent's. */
  hiddenAgentCount: number
}

export function foldHeaderRowId(foldId: string) {
  return `fold:${foldId}`
}

/** A sub-chat a closed fold dealt with, as one card (`TranscriptTurnFold.chatCards`). */
export interface ResolvedFoldChatCardTranscriptRow {
  kind: "fold-chat-card"
  id: string
  card: TurnFoldChatCard
}

/** What a message is to its fold: drawn only while open, or drawn either way. */
export type FoldRole = "folded" | "kept" | "reply" | "end"

/** Where each message stands: the fold it is in, and its role there. */
export interface FoldIndex {
  foldAt: Array<TranscriptTurnFold | undefined>
  roleAt: Array<FoldRole | undefined>
  /** Message id to the fold that hides it while closed. */
  foldIdByHiddenMessageId: Map<string, string>
  /** Each fold's chat cards, with the message index each stands at (-1 before the window). */
  cardsByFoldId: Map<string, Array<{ card: TurnFoldChatCard; at: number }>>
}

/**
 * Place the server's folds on the messages held. A fold spans its first entry
 * to its last; where the window starts inside one, it spans from the first
 * message held. One with neither end held is not in this window. A fold the
 * client still holds for the turn now in progress (a turn a report resumed)
 * is not drawn: that turn is drawn whole until it ends again.
 */
export function indexTurnFolds(messages: readonly HydratedTranscriptMessage[], turnFolds: ChatTurnFolds | undefined): FoldIndex {
  const foldAt = new Array<TranscriptTurnFold | undefined>(messages.length)
  const roleAt = new Array<FoldRole | undefined>(messages.length)
  const foldIdByHiddenMessageId = new Map<string, string>()
  const cardsByFoldId = new Map<string, Array<{ card: TurnFoldChatCard; at: number }>>()
  const folds = Object.values(turnFolds?.folds ?? {}).filter((fold) => fold.id !== turnFolds?.runningTurnId)
  if (folds.length === 0) return { foldAt, roleAt, foldIdByHiddenMessageId, cardsByFoldId }
  const indexById = new Map<string, number>()
  messages.forEach((message, index) => indexById.set(message.id, index))
  for (const fold of folds) {
    const end = indexById.get(fold.lastEntryId)
    if (end === undefined) continue
    const start = indexById.get(fold.firstEntryId) ?? 0
    const kept = new Set(fold.keptEntryIds)
    for (let index = start; index <= end; index += 1) {
      const message = messages[index]!
      const role: FoldRole = message.id === fold.replyEntryId ? "reply"
        : message.id === fold.endEntryId ? "end"
        : kept.has(message.id) ? "kept"
        : "folded"
      foldAt[index] = fold
      roleAt[index] = role
      if (role === "folded") foldIdByHiddenMessageId.set(message.id, fold.id)
    }
    if (fold.chatCards?.length) {
      cardsByFoldId.set(fold.id, fold.chatCards.map((card) => ({ card, at: indexById.get(card.anchorEntryId) ?? -1 })))
    }
  }
  return { foldAt, roleAt, foldIdByHiddenMessageId, cardsByFoldId }
}

function agentCountOf(row: ResolvedTranscriptRow): number {
  if (row.kind === "tool-group") return row.messages.length
  if (row.kind !== "single") return 0
  if (row.message.kind === "tool") return 1
  if (row.message.kind === "assistant_text" && row.message.text.trim()) return 1
  return 0
}

/**
 * The rows with each fold's header put in, and a closed fold's work taken out.
 *
 * A row is placed by its message index (a tool group by its first member's;
 * a group never crosses a fold's edge, since every row that opens or ends a
 * fold stops a run). The header goes before the first row at or after the
 * fold's start. A row that ends its fold loses the "Worked for" on its rule,
 * which the header now says.
 *
 * A closed fold also draws one card per sub-chat it dealt with, each where
 * that chat first came up, in place of the chat calls and report lines it
 * stands for. Open, those are back as they happened and the cards are not.
 */
export function applyTurnFolds(
  rows: readonly ResolvedTranscriptRow[],
  index: FoldIndex,
  isOpen: (foldId: string) => boolean,
): ResolvedTranscriptRow[] {
  const result: ResolvedTranscriptRow[] = []
  let currentFold: TranscriptTurnFold | undefined
  let currentHeader: ResolvedFoldHeaderTranscriptRow | undefined
  // The closed fold's cards still to draw, first first.
  let cards: Array<{ card: TurnFoldChatCard; at: number }> = []
  const drawCards = (upTo: number) => {
    while (cards.length > 0 && cards[0]!.at <= upTo) {
      const { card } = cards.shift()!
      result.push({ kind: "fold-chat-card", id: `fold-chat:${currentFold!.id}:${card.chatId}`, card })
    }
  }

  for (const row of rows) {
    if (row.kind === "fold-header" || row.kind === "fold-chat-card") continue
    const messageIndex = row.kind === "single" ? row.index : row.startIndex
    const fold = index.foldAt[messageIndex]
    if (fold !== currentFold) drawCards(Number.POSITIVE_INFINITY)
    if (!fold) {
      currentFold = undefined
      result.push(row)
      continue
    }
    if (fold !== currentFold) {
      currentFold = fold
      currentHeader = {
        kind: "fold-header",
        id: foldHeaderRowId(fold.id),
        foldId: fold.id,
        open: isOpen(fold.id),
        outcome: fold.outcome,
        workedMs: fold.workedMs,
        hiddenAgentCount: 0,
      }
      result.push(currentHeader)
      cards = currentHeader.open ? [] : [...(index.cardsByFoldId.get(fold.id) ?? [])]
    }
    drawCards(messageIndex)
    const role = index.roleAt[messageIndex]
    if (role === "folded" && !currentHeader!.open) {
      currentHeader!.hiddenAgentCount += agentCountOf(row)
      continue
    }
    result.push(role === "end" && row.kind === "single" ? { ...row, endsFold: true } : row)
  }
  drawCards(Number.POSITIVE_INFINITY)

  return result
}

/**
 * The turn that ended between two snapshots and now has a fold: the one that
 * was running before and is not now. Undefined when none did.
 */
export function turnJustFolded(previousRunningTurnId: string | undefined, turnFolds: ChatTurnFolds | undefined): string | undefined {
  if (!previousRunningTurnId || turnFolds?.runningTurnId === previousRunningTurnId) return undefined
  return turnFolds?.folds[previousRunningTurnId] ? previousRunningTurnId : undefined
}

/**
 * Where to scroll on the commit a turn ends and folds closed. A reader at the
 * end stays at the end. Anyone else keeps the turn's reply (the newest text,
 * measured on the commit before) where it was on screen while the work above
 * it folds away. Null when the text is not drawn.
 */
export function settleScrollTarget({ atEnd, text, scrollTop, rowIds, headerOffsetPx }: {
  atEnd: boolean
  /** The newest text row and its top in the content, from the commit before. */
  text: { rowId: string; contentTop: number } | null
  scrollTop: number
  rowIds: ReadonlySet<string>
  headerOffsetPx: number
}): { kind: "end" } | { kind: "pin"; rowId: string; offsetFromMessage: number } | null {
  if (atEnd) return { kind: "end" }
  if (!text || !rowIds.has(text.rowId)) return null
  return { kind: "pin", rowId: text.rowId, offsetFromMessage: headerOffsetPx - (text.contentTop - scrollTop) }
}

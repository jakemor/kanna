import type { HydratedTranscriptMessage } from "../../shared/types"
import type { FoldOutcome, FoldRole, TurnFold } from "../../shared/turn-fold"
import type { ResolvedTranscriptRow } from "./KannaTranscript"

/**
 * Where the transcript's rows meet the shared fold decision
 * (shared/turn-fold.ts): the header row each fold gets, which rows a closed
 * fold leaves out, and whether a fold is open.
 */

export interface ResolvedFoldHeaderTranscriptRow {
  kind: "fold-header"
  id: string
  foldId: string
  open: boolean
  outcome: FoldOutcome
  workedMs?: number
  /** What the closed fold leaves out that the minimap counts as the agent's. */
  hiddenAgentCount: number
}

export function foldHeaderRowId(foldId: string) {
  return `fold:${foldId}`
}

/** Where each message stands: the fold it is in, and its role there. Only folds that fold. */
export interface FoldIndex {
  foldAt: Array<TurnFold | undefined>
  roleAt: Array<FoldRole | undefined>
  /** Message id to the fold that hides it while closed. */
  foldIdByHiddenMessageId: Map<string, string>
}

export function indexTurnFolds(messages: readonly HydratedTranscriptMessage[], folds: readonly TurnFold[]): FoldIndex {
  const foldAt = new Array<TurnFold | undefined>(messages.length)
  const roleAt = new Array<FoldRole | undefined>(messages.length)
  const foldIdByHiddenMessageId = new Map<string, string>()
  for (const fold of folds) {
    if (!fold.folds) continue
    fold.roles.forEach((role, offset) => {
      const index = fold.start + offset
      foldAt[index] = fold
      roleAt[index] = role
      const message = messages[index]
      if (role === "folded" && message) foldIdByHiddenMessageId.set(message.id, fold.id)
    })
  }
  return { foldAt, roleAt, foldIdByHiddenMessageId }
}

/**
 * Whether a fold is open.
 *
 * The reader's own choice wins, wherever and whenever it was made. Without
 * one, a fold someone is being taken to (a stored read position, a jump) is
 * open, so the row they land on is there. A turn the reader watched run
 * stays open as it settles, so nothing they were reading folds away under
 * them; it closes when the next turn starts, which is when the transcript
 * follows the new prompt to the bottom anyway. Every other fold is closed.
 */
export function isTurnFoldOpen({ preference, landing, watched, latest }: {
  preference: boolean | undefined
  landing: boolean
  watched: boolean
  latest: boolean
}): boolean {
  if (preference !== undefined) return preference
  if (landing) return true
  return watched && latest
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
 */
export function applyTurnFolds(
  rows: readonly ResolvedTranscriptRow[],
  index: FoldIndex,
  isOpen: (foldId: string) => boolean,
): ResolvedTranscriptRow[] {
  const result: ResolvedTranscriptRow[] = []
  let currentFold: TurnFold | undefined
  let currentHeader: ResolvedFoldHeaderTranscriptRow | undefined

  for (const row of rows) {
    if (row.kind === "fold-header") continue
    const messageIndex = row.kind === "single" ? row.index : row.startIndex
    const fold = index.foldAt[messageIndex]
    if (!fold) {
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
    }
    const role = index.roleAt[messageIndex]
    if (role === "folded" && !currentHeader!.open) {
      currentHeader!.hiddenAgentCount += agentCountOf(row)
      continue
    }
    result.push(role === "end" && row.kind === "single" ? { ...row, endsFold: true } : row)
  }

  return result
}

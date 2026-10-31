import type { TurnFoldOutcome } from "./types"

/**
 * The words on a fold's header. The server decides the folds
 * (server/turn-folds.ts); this is only how one reads. The iOS app says the
 * same in `TurnFoldText`.
 */

/** "32s", "23m 0s", "6h 23m 32s". Minutes always carry their seconds, so the width barely moves. */
export function formatWorkedDuration(ms: number): string {
  if (ms < 1000) return "<1s"
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** The header's words. Nothing about what is inside: opening it says that. */
export function turnFoldLabel(fold: { outcome: TurnFoldOutcome; workedMs?: number }, open: boolean): string {
  if (fold.workedMs === undefined) {
    const action = open ? "Hide work" : "Show work"
    if (fold.outcome === "failed") return `Failed · ${action}`
    if (fold.outcome === "stopped") return `Stopped · ${action}`
    return action
  }
  const worked = formatWorkedDuration(fold.workedMs)
  if (fold.outcome === "failed") return `Failed after ${worked}`
  if (fold.outcome === "stopped") return `Stopped after ${worked}`
  return `Worked for ${worked}`
}

import { diffWordsWithSpace, diffWords } from "diff"
import type { DiffSegment } from "./types"

export interface WordLevelDiffResult {
  oldSegments: DiffSegment[]
  newSegments: DiffSegment[]
}

/**
 * Compute word-level diff between two strings.
 * Returns segments for both old and new lines, marked as unchanged / added / removed.
 */
export function computeWordLevelDiff(oldContent: string, newContent: string): WordLevelDiffResult {
  const changes = diffWordsWithSpace(oldContent, newContent)
  const oldSegments: DiffSegment[] = []
  const newSegments: DiffSegment[] = []

  for (const change of changes) {
    if (change.added) {
      newSegments.push({ value: change.value, type: "added" })
    } else if (change.removed) {
      oldSegments.push({ value: change.value, type: "removed" })
    } else {
      oldSegments.push({ value: change.value, type: "unchanged" })
      newSegments.push({ value: change.value, type: "unchanged" })
    }
  }

  return { oldSegments, newSegments }
}

/**
 * Check if two lines are similar enough to warrant word-level highlighting.
 * Requires at least 20 % shared content.
 */
export function shouldComputeWordDiff(oldContent: string, newContent: string): boolean {
  if (!oldContent.trim() || !newContent.trim()) return false
  if (oldContent === newContent) return false

  const changes = diffWords(oldContent, newContent)
  let unchangedLen = 0
  let totalLen = 0

  for (const c of changes) {
    totalLen += c.value.length
    if (!c.added && !c.removed) unchangedLen += c.value.length
  }

  return unchangedLen / totalLen >= 0.2
}

import { createTwoFilesPatch } from "diff"
import { parseUnifiedDiff } from "./parseDiff"
import type { DiffFile } from "./types"

/**
 * Create a DiffFile from an edit operation (oldString → newString).
 * Uses the `diff` library to generate a unified patch, then parses it with
 * our standard unified-diff parser so the result is identical to what we'd
 * get from `git diff`.
 */
export function createDiffFromEdit(
  filePath: string,
  oldString: string,
  newString: string,
): DiffFile | null {
  if (oldString === newString) return null

  const patch = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    oldString,
    newString,
    undefined,
    undefined,
    { context: 3 },
  )

  const files = parseUnifiedDiff(patch)
  return files[0] ?? null
}

/**
 * Create a DiffFile for a newly-written file (no old content).
 */
export function createDiffFromWrite(
  filePath: string,
  content: string,
): DiffFile {
  const lines = content.split("\n")
  return {
    path: filePath,
    status: "added",
    additions: lines.length,
    deletions: 0,
    chunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((line, i) => ({
          type: "add" as const,
          content: line,
          newLineNumber: i + 1,
        })),
      },
    ],
  }
}

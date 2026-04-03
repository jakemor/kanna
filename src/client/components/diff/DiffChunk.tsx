import { Fragment, memo, useCallback, useMemo, useState } from "react"
import type { DiffChunk as DiffChunkType, DiffLine, DiffSide, CommentThread, LineNumber, DiffSegment } from "./types"
import { computeWordLevelDiff, shouldComputeWordDiff } from "./wordDiff"
import { DiffLineRow } from "./DiffLineRow"
import { DiffCommentForm } from "./DiffCommentForm"
import { DiffCommentThread } from "./DiffCommentThread"

interface DiffChunkProps {
  chunk: DiffChunkType
  filePath: string
  threads: CommentThread[]
  onAddComment: (line: LineNumber, body: string, codeContent: string | undefined, side: DiffSide) => void
  onRemoveThread: (threadId: string) => void
  onReplyToThread: (threadId: string, body: string) => void
  onRemoveMessage: (threadId: string, messageId: string) => void
  onCopyPrompt: (threadId: string) => string
}

export const DiffChunk = memo(function DiffChunk({
  chunk,
  filePath,
  threads,
  onAddComment,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onCopyPrompt,
}: DiffChunkProps) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const [commentingLine, setCommentingLine] = useState<{
    side: DiffSide
    lineNumber: number
  } | null>(null)

  // ---- Word-level diff map (line index -> segments) ----
  const wordDiffMap = useMemo(() => {
    const map = new Map<number, DiffSegment[]>()
    const lines = chunk.lines
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      if (line.type === "delete") {
        // Collect consecutive deletes
        let j = i + 1
        while (j < lines.length && lines[j].type === "delete") j++
        const deleteLines = lines.slice(i, j)
        const deleteStartIdx = i

        // Collect consecutive adds after deletes
        const addLines: { line: DiffLine; index: number }[] = []
        while (j < lines.length && lines[j].type === "add") {
          addLines.push({ line: lines[j], index: j })
          j++
        }

        // Pair and compute
        const max = Math.max(deleteLines.length, addLines.length)
        for (let k = 0; k < max; k++) {
          const del = deleteLines[k]
          const add = addLines[k]
          if (del && add && shouldComputeWordDiff(del.content, add.line.content)) {
            const result = computeWordLevelDiff(del.content, add.line.content)
            map.set(deleteStartIdx + k, result.oldSegments)
            map.set(add.index, result.newSegments)
          }
        }

        i = j
      } else {
        i++
      }
    }

    return map
  }, [chunk.lines])

  // ---- Threads for a specific line ----
  const getThreadsForLine = useCallback(
    (lineNumber: number, side: DiffSide) =>
      threads.filter((t) => {
        const lineMatch =
          typeof t.line === "number" ? t.line === lineNumber : t.line[1] === lineNumber
        return lineMatch && t.side === side
      }),
    [threads],
  )

  // ---- Comment handlers ----
  const handleToggleComment = useCallback(
    (line: DiffLine) => {
      const lineNumber = line.newLineNumber ?? line.oldLineNumber
      const side: DiffSide = line.type === "delete" ? "old" : "new"
      if (!lineNumber) return

      if (commentingLine?.side === side && commentingLine.lineNumber === lineNumber) {
        setCommentingLine(null)
      } else {
        setCommentingLine({ side, lineNumber })
      }
    },
    [commentingLine],
  )

  const handleSubmitComment = useCallback(
    (body: string) => {
      if (!commentingLine) return

      // Find the code content for context
      const { side, lineNumber } = commentingLine
      const sourceLine = chunk.lines.find((l) =>
        side === "old" ? l.oldLineNumber === lineNumber : l.newLineNumber === lineNumber,
      )

      onAddComment(lineNumber, body, sourceLine?.content, side)
      setCommentingLine(null)
    },
    [commentingLine, chunk.lines, onAddComment],
  )

  return (
    <div>
      {/* Chunk header */}
      <div className="sticky top-0 z-[1] border-y border-border bg-muted/80 px-3 py-0.5 font-mono text-[10px] leading-5 text-muted-foreground backdrop-blur-sm">
        {chunk.header.replace(/^@@.*@@\s?/, "")}
      </div>

      <table className="w-full table-fixed border-collapse font-mono text-xs">
        <tbody>
          {chunk.lines.map((line, index) => {
            const lineNumber = line.newLineNumber ?? line.oldLineNumber ?? 0
            const lineSide: DiffSide = line.type === "delete" ? "old" : "new"
            const lineThreads =
              lineNumber > 0
                ? getThreadsForLine(lineNumber, lineSide)
                : []

            const isCommentTarget =
              commentingLine?.side === lineSide && commentingLine.lineNumber === lineNumber

            return (
              <Fragment key={index}>
                <DiffLineRow
                  line={line}
                  index={index}
                  isCommentTarget={isCommentTarget}
                  hoveredIndex={hoveredLine}
                  onMouseEnter={() => setHoveredLine(index)}
                  onMouseLeave={() => setHoveredLine(null)}
                  onCommentClick={() => handleToggleComment(line)}
                  diffSegments={wordDiffMap.get(index)}
                />

                {/* Comment threads attached to this line */}
                {lineThreads.map((thread) => (
                  <tr key={thread.id}>
                    <td colSpan={3} className="p-0">
                      <div className="mx-2 my-1.5">
                        <DiffCommentThread
                          thread={thread}
                          onRemoveThread={onRemoveThread}
                          onReplyToThread={onReplyToThread}
                          onRemoveMessage={onRemoveMessage}
                          onCopyPrompt={onCopyPrompt}
                        />
                      </div>
                    </td>
                  </tr>
                ))}

                {/* New comment form */}
                {isCommentTarget && (
                  <tr>
                    <td colSpan={3} className="p-0">
                      <div className="mx-2 my-1.5">
                        <DiffCommentForm
                          onSubmit={handleSubmitComment}
                          onCancel={() => setCommentingLine(null)}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

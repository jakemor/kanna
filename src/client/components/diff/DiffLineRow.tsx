import { memo } from "react"
import { MessageSquarePlus } from "lucide-react"
import type { DiffLine, DiffSegment } from "./types"
import { cn } from "../../lib/utils"

interface DiffLineRowProps {
  line: DiffLine
  index: number
  isCommentTarget: boolean
  hoveredIndex: number | null
  onMouseEnter: () => void
  onMouseLeave: () => void
  onCommentClick: () => void
  onClick?: () => void
  diffSegments?: DiffSegment[]
}

const lineTypeClass: Record<DiffLine["type"], string> = {
  add: "bg-green-500/8 dark:bg-green-500/10",
  delete: "bg-red-500/8 dark:bg-red-500/10",
  context: "",
}

const lineNumClass: Record<DiffLine["type"], string> = {
  add: "text-green-700/50 dark:text-green-400/40",
  delete: "text-red-700/50 dark:text-red-400/40",
  context: "text-muted-foreground/50",
}

const prefixMap: Record<DiffLine["type"], string> = {
  add: "+",
  delete: "-",
  context: " ",
}

const prefixClass: Record<DiffLine["type"], string> = {
  add: "text-green-600 dark:text-green-400",
  delete: "text-red-600 dark:text-red-400",
  context: "text-muted-foreground/40",
}

function WordDiffHighlighter({ segments }: { segments: DiffSegment[] }) {
  return (
    <span>
      {segments.map((seg, i) => {
        if (seg.type === "unchanged") return <span key={i}>{seg.value}</span>
        const highlight =
          seg.type === "added"
            ? "bg-green-400/25 dark:bg-green-400/20 rounded-[2px]"
            : "bg-red-400/25 dark:bg-red-400/20 rounded-[2px]"
        return (
          <span key={i} className={highlight}>
            {seg.value}
          </span>
        )
      })}
    </span>
  )
}

export const DiffLineRow = memo(function DiffLineRow({
  line,
  index,
  isCommentTarget,
  hoveredIndex,
  onMouseEnter,
  onMouseLeave,
  onCommentClick,
  onClick,
  diffSegments,
}: DiffLineRowProps) {
  const isHovered = hoveredIndex === index
  const lineNumber = line.newLineNumber ?? line.oldLineNumber

  return (
    <tr
      className={cn(
        "group relative",
        lineTypeClass[line.type],
        isCommentTarget && "ring-1 ring-inset ring-logo/30",
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {/* Old line number */}
      <td
        className={cn(
          "w-[42px] min-w-[42px] select-none px-1.5 text-right align-top text-[11px] leading-5 tabular-nums",
          lineNumClass[line.type],
        )}
      >
        {line.oldLineNumber ?? ""}
      </td>

      {/* New line number + comment button */}
      <td
        className={cn(
          "w-[42px] min-w-[42px] select-none px-1.5 text-right align-top text-[11px] leading-5 tabular-nums relative",
          lineNumClass[line.type],
        )}
      >
        <span>{line.newLineNumber ?? ""}</span>
        {isHovered && lineNumber != null && (
          <button
            type="button"
            aria-label="Add comment"
            className="absolute -left-[3px] top-[1px] flex h-[18px] w-[18px] items-center justify-center rounded bg-logo text-white shadow-sm transition-transform hover:scale-110"
            onClick={(e) => {
              e.stopPropagation()
              onCommentClick()
            }}
          >
            <MessageSquarePlus className="h-3 w-3" />
          </button>
        )}
      </td>

      {/* Code content */}
      <td className="w-full p-0 align-top">
        <div className="flex min-h-[20px] items-start">
          <span
            className={cn(
              "inline-block w-4 shrink-0 text-center text-[11px] leading-5 select-none",
              prefixClass[line.type],
            )}
          >
            {prefixMap[line.type]}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-all px-1.5 font-mono text-xs leading-5 text-foreground select-text">
            {diffSegments ? <WordDiffHighlighter segments={diffSegments} /> : line.content}
          </span>
        </div>
      </td>
    </tr>
  )
})

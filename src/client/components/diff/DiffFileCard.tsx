import { useState } from "react"
import { ChevronDown, ChevronRight, FilePlus, FileMinus, FileEdit, FileSymlink } from "lucide-react"
import type { DiffFile, CommentThread, DiffSide, LineNumber } from "./types"
import { DiffChunk } from "./DiffChunk"
import { cn } from "../../lib/utils"

interface DiffFileCardProps {
  file: DiffFile
  threads: CommentThread[]
  defaultCollapsed?: boolean
  onAddComment: (filePath: string, line: LineNumber, body: string, codeContent: string | undefined, side: DiffSide) => void
  onRemoveThread: (threadId: string) => void
  onReplyToThread: (threadId: string, body: string) => void
  onRemoveMessage: (threadId: string, messageId: string) => void
  onCopyPrompt: (threadId: string) => string
}

const statusConfig: Record<
  DiffFile["status"],
  { icon: typeof FileEdit; label: string; colorClass: string; bgClass: string }
> = {
  modified: {
    icon: FileEdit,
    label: "M",
    colorClass: "text-yellow-600 dark:text-yellow-400",
    bgClass: "bg-yellow-500/10",
  },
  added: {
    icon: FilePlus,
    label: "A",
    colorClass: "text-green-600 dark:text-green-400",
    bgClass: "bg-green-500/10",
  },
  deleted: {
    icon: FileMinus,
    label: "D",
    colorClass: "text-red-600 dark:text-red-400",
    bgClass: "bg-red-500/10",
  },
  renamed: {
    icon: FileSymlink,
    label: "R",
    colorClass: "text-blue-600 dark:text-blue-400",
    bgClass: "bg-blue-500/10",
  },
}

export function DiffFileCard({
  file,
  threads,
  defaultCollapsed = false,
  onAddComment,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onCopyPrompt,
}: DiffFileCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const cfg = statusConfig[file.status]
  const StatusIcon = cfg.icon
  const fileThreads = threads.filter((t) => t.filePath === file.path)
  const threadCount = fileThreads.length

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* File header */}
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50",
          collapsed ? "border-b-0" : "border-b border-border",
        )}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}

        <span className={cn("flex h-5 w-5 items-center justify-center rounded", cfg.bgClass)}>
          <StatusIcon className={cn("h-3 w-3", cfg.colorClass)} />
        </span>

        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {file.path}
          {file.oldPath && (
            <span className="ml-1 text-muted-foreground">
              (from {file.oldPath})
            </span>
          )}
        </span>

        {/* Stats */}
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
          {file.additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
          )}
          {threadCount > 0 && (
            <span className="ml-1 rounded-full bg-logo/15 px-1.5 py-0.5 text-[10px] font-medium text-logo">
              {threadCount}
            </span>
          )}
        </span>
      </button>

      {/* Chunks */}
      {!collapsed && (
        <div className="overflow-x-auto bg-background">
          {file.chunks.map((chunk, chunkIdx) => (
            <DiffChunk
              key={chunkIdx}
              chunk={chunk}
              filePath={file.path}
              threads={fileThreads}
              onAddComment={(line, body, codeContent, side) =>
                onAddComment(file.path, line, body, codeContent, side)
              }
              onRemoveThread={onRemoveThread}
              onReplyToThread={onReplyToThread}
              onRemoveMessage={onRemoveMessage}
              onCopyPrompt={onCopyPrompt}
            />
          ))}
        </div>
      )}
    </div>
  )
}

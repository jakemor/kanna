import { useCallback } from "react"
import { ClipboardCopy, MessageSquare, Send, Trash2 } from "lucide-react"
import { useDiffStore } from "../../stores/diffStore"
import type { DiffSide, LineNumber } from "./types"
import { DiffFileCard } from "./DiffFileCard"

interface DiffViewProps {
  onSendAll?: (message: string) => void
}

/**
 * Top-level diff viewer. Reads from the shared diffStore and renders all files
 * with inline commenting support.
 */
export function DiffView({ onSendAll }: DiffViewProps) {
  const files = useDiffStore((s) => s.files)
  const threads = useDiffStore((s) => s.threads)
  const addThread = useDiffStore((s) => s.addThread)
  const removeThread = useDiffStore((s) => s.removeThread)
  const replyToThread = useDiffStore((s) => s.replyToThread)
  const removeMessage = useDiffStore((s) => s.removeMessage)
  const generateThreadPrompt = useDiffStore((s) => s.generateThreadPrompt)
  const generateAllThreadsPrompt = useDiffStore((s) => s.generateAllThreadsPrompt)
  // clear is available via useDiffStore.getState().clear() if needed

  const handleAddComment = useCallback(
    (filePath: string, line: LineNumber, body: string, codeContent: string | undefined, side: DiffSide) => {
      addThread({ filePath, line, side, body, codeContent })
    },
    [addThread],
  )

  const handleCopyAll = useCallback(async () => {
    const prompt = generateAllThreadsPrompt()
    if (prompt) {
      try {
        await navigator.clipboard.writeText(prompt)
      } catch {
        // clipboard may not be available
      }
    }
  }, [generateAllThreadsPrompt])

  const handleSendAll = useCallback(() => {
    const prompt = generateAllThreadsPrompt()
    if (prompt && onSendAll) {
      onSendAll(`Address these comments:\n\n${prompt}`)
    }
  }, [generateAllThreadsPrompt, onSendAll])

  // ---- Empty state ----
  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-muted-foreground">No diffs to display</p>
        <p className="text-xs text-muted-foreground/60">
          Diffs from tool calls will appear here
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Toolbar */}
      {threads.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            {threads.length} comment{threads.length !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-1">
            {onSendAll && (
              <button
                type="button"
                onClick={handleSendAll}
                title="Send all comments to chat"
                className="flex h-6 items-center gap-1 rounded-md bg-logo px-2 text-[11px] font-medium text-white transition-colors hover:bg-logo/90"
              >
                <Send className="h-3 w-3" />
                Send all
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyAll}
              title="Copy all comments as prompt"
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ClipboardCopy className="h-3 w-3" />
              Copy all
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm("Clear all comments?")) {
                  // Only clear threads, keep files
                  useDiffStore.setState({ threads: [] })
                }
              }}
              title="Clear all comments"
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-red-500 transition-colors hover:bg-red-500/10 dark:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {files.map((file) => (
          <DiffFileCard
            key={file.path}
            file={file}
            threads={threads}
            onAddComment={handleAddComment}
            onRemoveThread={removeThread}
            onReplyToThread={replyToThread}
            onRemoveMessage={removeMessage}
            onCopyPrompt={generateThreadPrompt}
          />
        ))}
      </div>
    </div>
  )
}

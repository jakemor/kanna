import { useState } from "react"
import { Check, Copy, MessageSquareReply, Trash2 } from "lucide-react"
import type { CommentThread } from "./types"
import { DiffCommentForm } from "./DiffCommentForm"
import { cn } from "../../lib/utils"

interface DiffCommentThreadProps {
  thread: CommentThread
  onRemoveThread: (threadId: string) => void
  onReplyToThread: (threadId: string, body: string) => void
  onRemoveMessage: (threadId: string, messageId: string) => void
  onCopyPrompt: (threadId: string) => string
}

export function DiffCommentThread({
  thread,
  onRemoveThread,
  onReplyToThread,
  onRemoveMessage,
  onCopyPrompt,
}: DiffCommentThreadProps) {
  const [isReplying, setIsReplying] = useState(false)
  const [isCopied, setIsCopied] = useState(false)

  const lineLabel =
    typeof thread.line === "number" ? `L${thread.line}` : `L${thread.line[0]}-${thread.line[1]}`

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const prompt = onCopyPrompt(thread.id)
      await navigator.clipboard.writeText(prompt)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch {
      // clipboard not available
    }
  }

  const rootMessage = thread.messages[0]
  if (!rootMessage) return null

  return (
    <div className="rounded-lg border border-logo/20 bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate rounded bg-logo/10 px-1.5 py-0.5 font-mono text-[10px] text-logo">
          {thread.filePath}:{lineLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            title="Copy comment as prompt"
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
            {isCopied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => setIsReplying((prev) => !prev)}
            title="Reply"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MessageSquareReply className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-0 divide-y divide-border">
        {thread.messages.map((message, idx) => (
          <div
            key={message.id}
            className={cn("group/msg flex items-start gap-2 px-3 py-2", idx > 0 && "pl-6")}
          >
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground">
              {message.body}
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (idx === 0) {
                  onRemoveThread(thread.id)
                } else {
                  onRemoveMessage(thread.id, message.id)
                }
              }}
              title={idx === 0 ? "Resolve thread" : "Delete reply"}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-all group-hover/msg:opacity-100",
                idx === 0
                  ? "text-green-600 hover:bg-green-500/10 dark:text-green-400"
                  : "text-red-500 hover:bg-red-500/10 dark:text-red-400",
              )}
            >
              {idx === 0 ? <Check className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
            </button>
          </div>
        ))}
      </div>

      {/* Reply form */}
      {isReplying && (
        <div className="border-t border-border p-2">
          <DiffCommentForm
            onSubmit={(body) => {
              onReplyToThread(thread.id, body)
              setIsReplying(false)
            }}
            onCancel={() => setIsReplying(false)}
            placeholder="Write a reply..."
            submitLabel="Reply"
          />
        </div>
      )}
    </div>
  )
}

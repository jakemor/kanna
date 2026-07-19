import { ArrowUp } from "lucide-react"
import type { ChatBranchHistoryEntry } from "../../../../shared/types"
import { formatRelativeTime } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"

export function CommitHistoryRow({ entry, isPendingPush = false }: { entry: ChatBranchHistoryEntry; isPendingPush?: boolean }) {
  const relativeTime = formatRelativeTime(entry.authoredAt)
  const isClickable = Boolean(entry.githubUrl)
  return (
    <button
      type="button"
      disabled={!isClickable}
      onClick={() => {
        if (!entry.githubUrl || typeof window === "undefined") return
        window.open(entry.githubUrl, "_blank", "noopener,noreferrer")
      }}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border border-border bg-background pl-3 pr-2 py-2 text-left transition-colors",
        isClickable ? "hover:bg-accent" : "cursor-default opacity-60"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{entry.summary}</div>
        {entry.description ? (
          <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
            {entry.description}
          </div>
        ) : null}
        <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {entry.authorName ? <span className="truncate">{entry.authorName}</span> : null}
          {entry.authorName && relativeTime ? <span aria-hidden="true">•</span> : null}
          {relativeTime ? <span>{relativeTime}</span> : null}
        </div>
      </div>
      {entry.tags.length > 0 ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {entry.tags.map((tag) => (
            <span key={tag} className="inline-flex items-center rounded-full bg-slate-900/10 border-black/10 dark:bg-white/10 border dark:border-white/10  px-2 py-0.5 text-[11px]">
              {tag}
            </span>
          ))}
          {isPendingPush ? (
            <span className="inline-flex items-center rounded-full bg-slate-900/10 border-black/10 dark:bg-white/10 border dark:border-white/10  px-2 py-0.5 text-[11px]">
              <ArrowUp className="size-3" />
            </span>
          ) : null}
        </div>
      ) : isPendingPush ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <span className="inline-flex items-center rounded-full bg-slate-900/10 border-black/10 dark:bg-white/10 border dark:border-white/10  px-2 py-0.5 text-[11px]">
            <ArrowUp className="size-3" />
          </span>
        </div>
      ) : null}
    </button>
  )
}

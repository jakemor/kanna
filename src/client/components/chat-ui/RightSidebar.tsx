import { RefreshCw, X } from "lucide-react"
import { DiffView } from "../diff"

interface RightSidebarProps {
  onClose: () => void
  onRefresh?: () => void
}

export function RightSidebar({ onClose, onRefresh }: RightSidebarProps) {
  return (
    <div className="h-full min-h-0 border-l border-border bg-background md:min-w-[300px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Diffs</div>
          {onRefresh && (
            <button
              type="button"
              aria-label="Refresh diff"
              onClick={onRefresh}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Close right sidebar"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <DiffView />
      </div>
    </div>
  )
}

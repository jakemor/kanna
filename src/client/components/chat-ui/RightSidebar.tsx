import { X } from "lucide-react"
import { cn } from "../../lib/utils"

interface RightSidebarProps {
  onClose: () => void
  className?: string
}

export function RightSidebar({ onClose, className }: RightSidebarProps) {
  return (
    <div className={cn("h-full min-h-0 bg-background md:min-w-[300px] md:border-l md:border-border", className)}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Diffs</div>
          <button
            type="button"
            aria-label="Close right sidebar"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground">diffs coming soon</p>
        </div>
      </div>
    </div>
  )
}

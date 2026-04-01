import { Clock, X } from "lucide-react"
import { MetaRow, MetaContent } from "./shared"

interface QueuedMessageIndicatorProps {
  onCancel: () => void
}

export function QueuedMessageIndicator({ onCancel }: QueuedMessageIndicatorProps) {
  return (
    <MetaRow className="ml-[1px]">
      <MetaContent>
        <div className="group/queued relative flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 group-hover/queued:opacity-0 transition-opacity">
            <Clock className="size-4.5 text-muted-icon" />
            <span className="ml-[1px] text-sm text-muted-foreground">
              Message queued
            </span>
          </div>
          <button
            onClick={onCancel}
            className="absolute inset-0 flex items-center gap-1.5 opacity-0 group-hover/queued:opacity-100 transition-opacity cursor-pointer"
          >
            <X className="size-4.5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Cancel
            </span>
          </button>
        </div>
      </MetaContent>
    </MetaRow>
  )
}

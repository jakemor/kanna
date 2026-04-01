import { Loader2, X } from "lucide-react"
import { MetaRow, MetaContent } from "./shared"
import { AnimatedShinyText } from "../ui/animated-shiny-text"

interface DrainingIndicatorProps {
  onStop: () => void
}

export function DrainingIndicator({ onStop }: DrainingIndicatorProps) {
  return (
    <MetaRow className="ml-[1px]">
      <MetaContent>
        <div className="group/draining relative flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 group-hover/draining:opacity-0 transition-opacity">
            <Loader2 className="size-4.5 animate-spin text-muted-icon" />
            <AnimatedShinyText className="ml-[1px] text-sm" shimmerWidth={44}>
              Running...
            </AnimatedShinyText>
          </div>
          <button
            onClick={onStop}
            className="absolute inset-0 flex items-center gap-1.5 opacity-0 group-hover/draining:opacity-100 transition-opacity cursor-pointer"
          >
            <X className="size-4.5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Stop
            </span>
          </button>
        </div>
      </MetaContent>
    </MetaRow>
  )
}

import { ChevronRight } from "lucide-react"
import { turnFoldLabel, type FoldOutcome } from "../../../shared/turn-fold"
import { cn } from "../../lib/utils"

interface Props {
  open: boolean
  outcome: FoldOutcome
  workedMs?: number
  onToggle: () => void
}

/**
 * The line a finished turn folds behind: "Worked for 2m 14s", and the chevron
 * that opens it. It says nothing of what is inside; opening it does that.
 *
 * Opening and closing are instant: a reader toggles these constantly, and the
 * rows appearing are the feedback. Only the chevron turns, and not at all
 * with reduced motion. The whole width of the row is the button, so there is
 * no dead band beside the words.
 */
export function TurnFoldHeader({ open, outcome, workedMs, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "group/fold flex w-full cursor-pointer items-center gap-1 py-0.5 text-left text-sm",
        "text-muted-foreground transition-[color,opacity] duration-150 ease-out hover:text-foreground active:opacity-60",
        "motion-reduce:transition-none",
        open && "text-foreground/80",
      )}
    >
      <span className={cn("font-medium", outcome === "failed" && "text-destructive/80")}>
        {turnFoldLabel({ outcome, workedMs }, open)}
      </span>
      <ChevronRight
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-muted-icon transition-transform duration-150 ease-out motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
    </button>
  )
}

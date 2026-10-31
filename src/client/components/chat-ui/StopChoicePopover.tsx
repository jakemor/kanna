import type { ReactNode } from "react"
import { cascadeStopLabel } from "../../../shared/stop-turn"
import { cn } from "../../lib/utils"
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover"

const CHOICE_CLASS = "flex w-full items-center rounded-lg px-3 py-2 text-left text-sm outline-hidden transition-colors duration-100 hover:bg-muted focus-visible:bg-muted motion-reduce:transition-none"

/**
 * What Stop asks while sub-chats this chat started are running: stop the
 * turn alone, or the turn and them. Opened from the stop button, which it
 * sits over. Escape or a press outside closes it and stops nothing.
 *
 * "Stop this turn" leads and takes the focus, so Enter right after the
 * press keeps the sub-chats' work. The other is in red: it ends work in
 * chats the user may not be looking at.
 */
export function StopChoicePopover({ open, onOpenChange, count, onStop, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  onStop: (cascade: boolean) => void
  /** The stop button, which the popover is placed from. */
  children: ReactNode
}) {
  const choose = (cascade: boolean) => {
    onOpenChange(false)
    onStop(cascade)
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label="Stop"
        // Opening focuses the first choice (Radix's focus scope does that),
        // and closing hands the focus back to the composer (PopoverContent).
        className="w-auto min-w-56 p-1"
      >
        <div role="menu" aria-label="Stop" className="flex flex-col">
          <button type="button" role="menuitem" className={CHOICE_CLASS} onClick={() => choose(false)}>
            Stop this turn
          </button>
          <button type="button" role="menuitem" className={cn(CHOICE_CLASS, "text-destructive")} onClick={() => choose(true)}>
            {cascadeStopLabel(count)}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

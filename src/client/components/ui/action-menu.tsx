/**
 * ActionMenu — a programmatically-opened floating menu.
 *
 * Used on mobile where Radix ContextMenu's right-click trigger is unavailable.
 * Opened at explicit (x, y) coordinates supplied by a long-press handler.
 */
import type { ReactNode } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "../../lib/utils"

interface ActionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Screen coordinates (clientX/Y) where the menu should appear */
  position: { x: number; y: number } | null
  children: ReactNode
}

/**
 * Renders a positioned floating menu anchored to a virtual fixed-position element.
 */
export function ActionMenu({ open, onOpenChange, position, children }: ActionMenuProps) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* Virtual anchor: a zero-size fixed element at the touch coordinates */}
      <PopoverPrimitive.Anchor
        style={
          position
            ? { position: "fixed", left: position.x, top: position.y, width: 0, height: 0 }
            : undefined
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            "z-50 min-w-[170px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg",
            "animate-in fade-in-0 zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

interface ActionMenuItemProps {
  onSelect: () => void
  className?: string
  children: ReactNode
}

export function ActionMenuItem({ onSelect, className, children }: ActionMenuItemProps) {
  return (
    <button
      type="button"
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium outline-hidden transition-colors",
        "hover:bg-accent focus:bg-accent",
        className
      )}
      onPointerDown={(e) => {
        // Close menu and call handler without delay
        e.preventDefault()
        onSelect()
      }}
    >
      {children}
    </button>
  )
}

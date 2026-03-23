import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "../../lib/utils"
import { Kbd, KbdGroup } from "./kbd"

const HOTKEY_TOOLTIP_CONTENT_CLASSNAME =
  "z-50 overflow-hidden rounded-md border border-border backdrop-blur-md p-0.5 text-[11px] font-medium text-card-foreground shadow-sm animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-card text-card-foreground border border-border px-3 py-1.5 text-xs animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

const HotkeyTooltip = TooltipPrimitive.Root

const HotkeyTooltipTrigger = TooltipPrimitive.Trigger

function formatHotkeyLabel(label: string) {
  return label.toUpperCase()
}

function renderShortcutKeys(shortcut: string) {
  const keys = shortcut.split("+")
  return (
    <KbdGroup>
      {keys.map((key, i) => (
        <Kbd key={`${key}-${i}`}>{formatHotkeyLabel(key)}</Kbd>
      ))}
    </KbdGroup>
  )
}

type HotkeyTooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  shortcut?: string | string[]
}

const HotkeyTooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  HotkeyTooltipContentProps
>(({ className, sideOffset = 4, children, shortcut, ...props }, ref) => {
  const firstShortcut = shortcut === undefined
    ? null
    : Array.isArray(shortcut)
      ? shortcut[0] ?? null
      : shortcut

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
          className
        )}
        {...props}
      >
        {firstShortcut ? (
          renderShortcutKeys(firstShortcut)
        ) : (
          <span>{typeof children === "string" ? formatHotkeyLabel(children) : children}</span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
})
HotkeyTooltipContent.displayName = "HotkeyTooltipContent"

export {
  HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
  HotkeyTooltip,
  HotkeyTooltipTrigger,
  HotkeyTooltipContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  formatHotkeyLabel,
}

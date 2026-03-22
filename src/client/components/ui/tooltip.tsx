import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "../../lib/utils"

const HOTKEY_TOOLTIP_CONTENT_CLASSNAME =
  "z-50 overflow-hidden rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium tracking-[0.14em] text-card-foreground uppercase shadow-sm animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
const HOTKEY_TOOLTIP_TEXT_CLASSNAME = "font-mono"

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

type HotkeyTooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  shortcut?: string | string[]
}

const HotkeyTooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  HotkeyTooltipContentProps
>(({ className, sideOffset = 4, children, shortcut, ...props }, ref) => {
  const shortcuts = shortcut === undefined
    ? null
    : Array.isArray(shortcut)
      ? shortcut
      : [shortcut]

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
        {shortcuts ? (
          <span className={HOTKEY_TOOLTIP_TEXT_CLASSNAME}>
            {shortcuts.map((label, index) => (
              <React.Fragment key={`${label}-${index}`}>
                {index > 0 ? <span className="px-1.5 text-muted-foreground">/</span> : null}
                <span>{formatHotkeyLabel(label)}</span>
              </React.Fragment>
            ))}
          </span>
        ) : (
          <span className={HOTKEY_TOOLTIP_TEXT_CLASSNAME}>{typeof children === "string" ? formatHotkeyLabel(children) : children}</span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
})
HotkeyTooltipContent.displayName = "HotkeyTooltipContent"

export {
  HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
  HOTKEY_TOOLTIP_TEXT_CLASSNAME,
  HotkeyTooltip,
  HotkeyTooltipTrigger,
  HotkeyTooltipContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  formatHotkeyLabel,
}

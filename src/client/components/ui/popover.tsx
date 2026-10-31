import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "../../lib/utils"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE, RESTORE_CHAT_INPUT_FOCUS_EVENT } from "../../app/chatFocusPolicy"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

/** Where the content is placed from, when something other than a trigger opens it. */
const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      {...{ [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        window.dispatchEvent(new Event(RESTORE_CHAT_INPUT_FOCUS_EVENT))
        props.onCloseAutoFocus?.(event)
      }}
      className={cn(
        "z-50 w-72 rounded-xl border border-border bg-background p-4 shadow-lg outline-hidden floating-surface",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }

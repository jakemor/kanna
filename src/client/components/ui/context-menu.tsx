import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { cn } from "../../lib/utils"

const ContextMenuCloseContext = React.createContext<(() => void) | null>(null)

function ContextMenu({
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>) {
  const [resetKey, setResetKey] = React.useState(0)

  const close = React.useCallback(() => {
    setResetKey((current) => current + 1)
    onOpenChange?.(false)
  }, [onOpenChange])

  return (
    <ContextMenuCloseContext.Provider value={close}>
      <ContextMenuPrimitive.Root
        key={resetKey}
        onOpenChange={onOpenChange}
        {...props}
      />
    </ContextMenuCloseContext.Provider>
  )
}

const ContextMenuGroup = ContextMenuPrimitive.Group

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 min-w-[170px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg outline-hidden floating-surface",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(({ className, onSelect, ...props }, ref) => {
  const closeContextMenu = React.useContext(ContextMenuCloseContext)

  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground outline-hidden transition-colors hover:bg-muted focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      onSelect={(event) => {
        onSelect?.(event)
        closeContextMenu?.()
      }}
      {...props}
    />
  )
})
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

export {
  ContextMenu,
  ContextMenuGroup,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
}

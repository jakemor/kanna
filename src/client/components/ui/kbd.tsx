import { cn } from "../../lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/60 bg-muted/50 px-1.5 font-mono text-[11px] font-medium text-current select-none",
        className,
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }

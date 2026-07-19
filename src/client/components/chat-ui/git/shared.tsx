import { Check, Minus } from "lucide-react"
import type { ReactNode } from "react"
import type { ChatDiffSnapshot } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"

export type DiffRenderMode = "unified" | "split"
export type DiffFile = ChatDiffSnapshot["files"][number]

export function IconButton(props: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={props.label}
          title={props.label}
          onClick={props.onClick}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            props.active && "bg-accent text-foreground"
          )}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  )
}

export function StageCheckbox({
  checked,
  mixed = false,
  label,
  className,
  onClick,
}: {
  checked: boolean
  mixed?: boolean
  label?: string
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label ?? (checked ? "Exclude file from commit" : "Include file in commit")}
      aria-checked={mixed ? "mixed" : checked}
      aria-pressed={mixed ? "mixed" : checked}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex size-4.5 shrink-0 items-center justify-center rounded border transition-colors",
        checked || mixed
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-transparent",
        className
      )}
    >
      {mixed
        ? <Minus className="h-3 w-3" strokeWidth={3} />
        : checked
          ? <Check className="h-3 w-3" strokeWidth={3} />
          : null}
    </button>
  )
}

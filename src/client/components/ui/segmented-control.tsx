import { type ReactNode, isValidElement } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

type SegmentedSize = "sm" | "md"

export type SegmentedOption<T extends string> = {
  value: T
  label: ReactNode
  icon?: LucideIcon | ReactNode
  disabled?: boolean
  tooltip?: ReactNode
}

interface SegmentedControlProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: SegmentedOption<T>[]
  size?: SegmentedSize
  className?: string
  optionClassName?: string
}

const sizeClasses: Record<SegmentedSize, string> = {
  sm: "text-sm px-2.5 py-1",
  md: "text-sm px-3 py-1.5",
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  optionClassName,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border border-border p-[3px] ",
        className,
      )}
    >
      {options.map((option) => {
        const isActive = option.value === value
        const icon = option.icon
        // Support both LucideIcon components (forwardRef objects or functions) and ReactNode
        const iconElement = icon
          ? isValidElement(icon)
            ? icon
            : (() => { const Icon = icon as LucideIcon; return <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> })()
          : null
        const button = (
          <button
            key={option.value}
            type="button"
            onClick={() => onValueChange(option.value)}
            disabled={option.disabled}
            aria-pressed={isActive}
            className={cn(
              "rounded-[4px] border transition-colors",
              icon ? "grid grid-cols-[auto_auto] items-center gap-2" : "inline-flex items-center gap-1.5",
              sizeClasses[size],
              isActive
                ? "bg-white dark:bg-muted text-slate-900 dark:text-slate-200 border-slate-300 dark:border-white/10 bg-slate-200 "
                : "border-transparent text-slate-800 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground",
              option.disabled && "opacity-50 pointer-events-none",
              optionClassName,
            )}
          >
            {iconElement}
            <span>{option.label}</span>
          </button>
        )

        if (!option.tooltip) {
          return button
        }

        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{option.tooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

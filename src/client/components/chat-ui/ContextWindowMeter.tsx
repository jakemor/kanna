import { cn } from "../../lib/utils"
import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`
  }
  return `${Math.round(value)}%`
}

export function ContextWindowMeter({ usage }: { usage: ContextWindowSnapshot }) {
  const usedPercentage = formatPercentage(usage.usedPercentage)
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0))
  const displayTokens = usage.inputTokens ?? usage.usedTokens
  const radius = 9.75
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
          aria-label={`${formatContextWindowTokens(displayTokens)} tokens used`}
        >
          <span className="relative flex h-6 w-6 items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-muted-foreground/20"
              />
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className="text-muted-foreground transition-[stroke-dashoffset] duration-500 ease-out"
              />
            </svg>
            <span
              className={cn(
                "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[9px] font-medium",
                "text-muted-foreground",
              )}
            >
              {usage.usedPercentage !== null
                ? Math.round(usage.usedPercentage)
                : formatContextWindowTokens(usage.usedTokens)}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1 leading-tight">
          <div className="whitespace-nowrap text-xs font-medium text-foreground">
            {formatContextWindowTokens(displayTokens)} tokens used
          </div>
          {usage.maxTokens !== undefined && usedPercentage ? (
            <div className="whitespace-nowrap text-xs text-muted-foreground">
              {usedPercentage} context · {formatContextWindowTokens(usage.remainingTokens)} remaining
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

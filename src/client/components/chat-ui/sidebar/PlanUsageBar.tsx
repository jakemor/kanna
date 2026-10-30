import { Fragment, useEffect, useState, type ReactNode } from "react"
import type { UsageLimitCredits } from "../../../../shared/types"
import { formatMoney, formatPercent, formatUntil } from "../../../app/settings/UsageSection"
import { formatResetCountdown, windowAsOf, type PlanUsageRow } from "../../../lib/planUsage"
import { formatRelativeTime } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { openCommandPalette } from "../../command-palette/CommandPalette"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"

/** What's left under a spend cap, abbreviated: "$956 left", "$1.2k left". */
function creditsLeft(credits: UsageLimitCredits): string | null {
  if (credits.usedAmount === null || credits.limitAmount === null) return null
  return `${formatMoney(Math.max(0, credits.limitAmount - credits.usedAmount), credits.currency)} left`
}

/** What was spent against a spend cap: "$44 of $1k used". */
function creditsSpent(credits: UsageLimitCredits): string | null {
  if (credits.usedAmount === null) return null
  const used = formatMoney(credits.usedAmount, credits.currency)
  return credits.limitAmount !== null ? `${used} of ${formatMoney(credits.limitAmount, credits.currency)} used` : `${used} used`
}

/** The fourth column: the reset countdown, or for a spend cap what's left. */
function rowTail({ window, credits }: PlanUsageRow): string | null {
  return credits ? creditsLeft(credits) : formatResetCountdown(window.resetsAt)
}

function fillColorClass(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-red-500"
  if (usedPercent >= 75) return "bg-amber-500"
  return "bg-muted-foreground"
}

/** Re-renders once a minute, for the reset countdowns. */
function useMinuteTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 60_000)
    return () => clearInterval(id)
  }, [])
}

/**
 * One provider's plan usage: a thin meter per window that limits it, shortest
 * first ("5h ▬▬ 42% 2h 14m" over "Wk ▬ 18% 3d 4h"), or a lone spend-cap row
 * ("▬▬ 4% $956 left"), in 9px type, after the provider's icon. Full names on
 * hover; a click opens the command palette's Usage page.
 */
export function PlanUsageBar({
  rows: rawRows,
  title,
  icon,
}: {
  rows: PlanUsageRow[]
  /** Whose usage this is: the hover card's heading and the button's name. */
  title: string
  icon?: ReactNode
}) {
  useMinuteTick()
  // Re-read each minute, so a window that resets mid-session drops to 0%.
  const rows = rawRows.map((row) => ({ ...row, window: windowAsOf(row.window) }))
  const labeled = rows.some((row) => row.shortLabel !== "")
  const summary = rows.map((row) => {
    const tail = rowTail(row)
    const suffix = tail ? (row.credits ? `, ${tail}` : `, resets in ${tail}`) : ""
    return `${row.window.label} ${formatPercent(row.window.usedPercent)} used${suffix}`
  }).join("; ")

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openCommandPalette("usage")}
          aria-label={`${title} plan usage: ${summary}. Open usage`}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {icon ? <span className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5" aria-hidden="true">{icon}</span> : null}
          <span
            className={cn(
              "grid min-w-0 flex-1 items-center gap-x-1.5 gap-y-1 overflow-hidden text-left text-[9px] font-medium leading-[9px]",
              labeled ? "grid-cols-[auto_minmax(24px,1fr)_auto_auto]" : "grid-cols-[minmax(24px,1fr)_auto_auto]",
            )}
          >
            {rows.map((row) => {
              const usedPercent = Math.max(0, Math.min(100, row.window.usedPercent ?? 0))
              return (
                <Fragment key={row.window.id}>
                  {/* Kept (empty) beside labelled rows, so the columns line up. */}
                  {labeled ? <span className="whitespace-nowrap tabular-nums">{row.shortLabel}</span> : null}
                  <span className="h-[3px] overflow-hidden rounded-full bg-muted-foreground/20" aria-hidden="true">
                    <span
                      className={cn("block h-full rounded-full transition-[width] duration-500 ease-out", fillColorClass(usedPercent))}
                      style={{ width: `${usedPercent > 0 ? Math.max(4, usedPercent) : 0}%` }}
                    />
                  </span>
                  <span className="whitespace-nowrap text-right tabular-nums">{formatPercent(row.window.usedPercent)}</span>
                  <span className="whitespace-nowrap tabular-nums">{rowTail(row) ?? ""}</span>
                </Fragment>
              )
            })}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="whitespace-nowrap text-xs font-semibold text-foreground">{title}</div>
          {rows.map(({ window, credits }) => {
            // Pushed and refreshed reads are current; a cached one is from an
            // earlier session, so say how old it is.
            const stale = window.source === "cache" ? `Updated ${formatRelativeTime(window.recordedAt)}` : null
            const resets = window.resetsAt ? `Resets ${formatUntil(window.resetsAt)}` : null
            const detail = [credits ? creditsSpent(credits) : resets, stale].filter(Boolean).join(" · ")
            return (
              <div key={window.id}>
                <div className="whitespace-nowrap text-xs font-medium text-foreground">
                  {window.label} · {formatPercent(window.usedPercent)} used
                </div>
                {detail ? <div className="whitespace-nowrap text-xs text-muted-foreground">{detail}</div> : null}
              </div>
            )
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

import { useNavigate } from "react-router-dom"
import type { AgentProvider, UsageLimitWindow } from "../../../shared/types"
import { formatUntil } from "../../lib/formatters"
import {
  LIMIT_RING_PROVIDERS,
  limitRingColorClass,
  limitRingRemainingPercent,
  selectLimitRingWindows,
} from "../../lib/usageLimitRings"
import { cn } from "../../lib/utils"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { useUsageLimitsSnapshot } from "../../stores/usageLimitsStore"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

export function useUsageLimitRingsVisible(provider: AgentProvider): boolean {
  const enabled = useAppSettingsStore((store) => store.settings?.usageLimitIndicatorsEnabled !== false)
  return enabled && LIMIT_RING_PROVIDERS.has(provider)
}

function LimitRing({
  slotLabel,
  window,
  alsoApplies,
  unavailableDetail,
  onOpenUsagePage,
}: {
  /** Fallback title used until the provider reports this window. */
  slotLabel: string
  window: UsageLimitWindow | null
  alsoApplies: UsageLimitWindow | null
  unavailableDetail: string | null
  onOpenUsagePage: () => void
}) {
  const remaining = limitRingRemainingPercent(window?.usedPercent ?? null)
  const radius = 9.75
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - ((remaining ?? 0) / 100) * circumference
  const resets = window?.resetsAt ? formatUntil(window.resetsAt) : null
  const title = window?.label ?? slotLabel
  const alsoRemaining = limitRingRemainingPercent(alsoApplies?.usedPercent ?? null)

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenUsagePage}
          className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
          aria-label={
            remaining !== null
              ? `${title}: ${Math.round(remaining)}% remaining. Open the Usage page.`
              : `${title}: no usage data. Open the Usage page.`
          }
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
              {remaining !== null ? (
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
                  className={cn(
                    "transition-[stroke-dashoffset] duration-500 ease-out",
                    limitRingColorClass(window?.usedPercent ?? null),
                  )}
                />
              ) : null}
            </svg>
            <span className="relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[9px] font-medium text-muted-foreground">
              {remaining !== null ? Math.round(remaining) : "–"}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1 leading-tight">
          <div className="whitespace-nowrap text-xs font-medium text-foreground">{title}</div>
          <div className="whitespace-nowrap text-xs text-muted-foreground">
            {remaining !== null
              ? `${Math.round(remaining)}% left${resets ? ` · Resets ${resets}` : ""}`
              : unavailableDetail ?? "No usage data yet."}
          </div>
          {alsoApplies && alsoRemaining !== null ? (
            <div className="whitespace-nowrap text-xs text-muted-foreground">
              {`${alsoApplies.label}: ${Math.round(alsoRemaining)}% left`}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export function UsageLimitRings({
  provider,
  model,
}: {
  provider: AgentProvider
  /** Selects the model-scoped weekly lane when the provider reports one. */
  model: string | null
}) {
  const navigate = useNavigate()
  const visible = useUsageLimitRingsVisible(provider)
  const snapshot = useUsageLimitsSnapshot(visible)

  if (!visible) return null

  const { snapshot: providerSnapshot, slots } = selectLimitRingWindows(snapshot, provider, model)
  const unavailableDetail = providerSnapshot?.detail ?? null

  return (
    <div className="flex items-center gap-1">
      {slots.map((slot) => (
        <LimitRing
          key={slot.key}
          slotLabel={slot.label}
          window={slot.window}
          alsoApplies={slot.alsoApplies}
          unavailableDetail={unavailableDetail}
          onOpenUsagePage={() => navigate("/settings/usage")}
        />
      ))}
    </div>
  )
}

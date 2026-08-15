import { useCallback, useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"
import type { ProviderUsageSnapshot, UsageLimitWindow, UsageLimitsSnapshot } from "../../../shared/types"
import { PROVIDERS } from "../../../shared/types"
import { PROVIDER_ICONS } from "../../components/chat-ui/ChatPreferenceControls"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"
import { formatRelativeTime, formatUntil } from "../../lib/formatters"
import { cn } from "../../lib/utils"
import type { KannaState } from "../useKannaState"

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  if (value > 0 && value < 1) return "<1%"
  return `${Math.round(value)}%`
}

/** The currency symbol for a code ("$"), or "" for codes Intl doesn't know. */
function currencySymbol(currency: string | null): string {
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: 0,
    }).formatToParts(0)
    return parts.find((part) => part.type === "currency")?.value ?? ""
  } catch {
    return ""
  }
}

/**
 * Rounded and abbreviated above a thousand: 130.42 → "130", 2000 → "2k",
 * 7051.8 → "7.1k", 1_200_000 → "1.2m". Fractions are noise at this altitude.
 */
function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  const unit = (scaled: number, suffix: string) =>
    `${sign}${scaled.toLocaleString("en-US", { maximumFractionDigits: 1 })}${suffix}`
  if (abs >= 1_000_000) return unit(abs / 1_000_000, "m")
  if (abs >= 1_000) return unit(abs / 1_000, "k")
  return `${sign}${Math.round(abs)}`
}

/** Whole-dollar money, abbreviated above a thousand: "$130", "$1.3k", "$2k", "$1.2m". */
function formatMoney(amount: number, currency: string | null): string {
  const compact = formatCompact(amount)
  const symbol = currencySymbol(currency)
  // Keep the symbol ahead of the sign: -$5, not $-5.
  return compact.startsWith("-") ? `-${symbol}${compact.slice(1)}` : `${symbol}${compact}`
}

function creditsSummary(credits: NonNullable<ProviderUsageSnapshot["credits"]>): string | null {
  const parts: string[] = []
  if (credits.usedAmount != null) {
    const used = formatMoney(credits.usedAmount, credits.currency)
    parts.push(credits.limitAmount != null ? `${used} of ${formatMoney(credits.limitAmount, credits.currency)} used` : `${used} used`)
  }
  if (credits.usedPercent != null) parts.push(`${formatPercent(credits.usedPercent)} used`)
  if (credits.detail) {
    // Codex reports its prepaid balance as a bare numeric string ("1000");
    // render it as a remaining count. Non-numeric details ("Unlimited") pass through.
    const numeric = /^\d+(\.\d+)?$/.test(credits.detail.trim()) ? Number(credits.detail) : null
    parts.push(numeric !== null ? `${formatCompact(numeric)} credits remaining` : credits.detail)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

function providerLabel(providerId: string): string {
  return PROVIDERS.find((entry) => entry.id === providerId)?.label ?? providerId
}

function isNimbusQuillWindow(window: UsageLimitWindow): boolean {
  return window.id === "nimbus_quill" || window.label.trim().toLowerCase() === "nimbus quill"
}

function usageWindowsForDisplay(windows: UsageLimitWindow[]): UsageLimitWindow[] {
  const regularWindows = windows.filter((window) => !isNimbusQuillWindow(window))
  const nimbusQuillWindows = windows.filter(isNimbusQuillWindow)
  return [...regularWindows, ...nimbusQuillWindows]
}

/**
 * Classify a plan string (Claude `subscription_type` / Codex `planType`) into a
 * personal vs org-managed account scope, so the card can show whether the
 * signed-in account is a personal or work/enterprise plan.
 * Personal tiers: free/go/plus/pro/prolite/max. Everything org-billed
 * (team/business/enterprise/edu) reads as "Enterprise".
 */
function accountScopeLabel(plan: string | null): string | null {
  if (!plan) return null
  const value = plan.toLowerCase()
  if (/team|business|enterprise|edu/.test(value)) return "Enterprise"
  if (/free|go|plus|pro|prolite|max/.test(value)) return "Personal"
  return null
}

function barColorClass(usedPercent: number | null): string {
  if (usedPercent === null) return "bg-muted-foreground/40"
  if (usedPercent >= 90) return "bg-red-500"
  if (usedPercent >= 75) return "bg-amber-500"
  return "bg-emerald-500"
}

function UsageBar({ usedPercent }: { usedPercent: number | null }) {
  const width = usedPercent === null ? 0 : Math.max(usedPercent > 0 ? 1.5 : 0, Math.min(100, usedPercent))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out", barColorClass(usedPercent))}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

/** Shared grid so every window row lines up like a table (settings + empty state). */
const WINDOW_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_5rem_minmax(4rem,1.4fr)_2.375rem] items-center gap-3"

/**
 * Same grid for a collapsed card's header, minus the reset column on narrow
 * screens — the provider name plus a meter is all that fits on a phone, and the
 * reset time is one tap away in the expanded rows.
 */
const COLLAPSED_HEADER_GRID = cn(
  "grid grid-cols-[minmax(0,1fr)_minmax(4rem,1.4fr)_2.375rem] items-center gap-3",
  "md:grid-cols-[minmax(0,1fr)_5rem_minmax(4rem,1.4fr)_2.375rem]",
)

function WindowRow({ window }: { window: UsageLimitWindow }) {
  const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
  return (
    <div className={WINDOW_ROW_GRID}>
      <div className="min-w-0 truncate text-sm text-foreground">{window.label}</div>
      <div className="truncate text-xs text-muted-foreground">{resets ? `Resets ${resets}` : ""}</div>
      <UsageBar usedPercent={window.usedPercent} />
      <div className="text-right text-sm font-medium tabular-nums text-foreground">
        {formatPercent(window.usedPercent)}
      </div>
    </div>
  )
}

export function ProviderCard({
  snapshot,
  collapsible = false,
  refreshing = false,
  onRefresh,
}: {
  snapshot: ProviderUsageSnapshot
  /** When true, the card starts collapsed and the header toggles it open/closed. */
  collapsible?: boolean
  /** Show "Refreshing…" in the header's timestamp slot while a read is in flight. */
  refreshing?: boolean
  /**
   * Force a refresh of all providers. When set (and the card isn't collapsible,
   * whose header is already a toggle button), the "Updated …" timestamp becomes
   * the clickable refresh affordance — no separate button.
   */
  onRefresh?: () => void
}) {
  const Icon = PROVIDER_ICONS[snapshot.provider]
  const hasContent = snapshot.windows.length > 0 || snapshot.credits
  const [expanded, setExpanded] = useState(false)
  const showBody = !collapsible || expanded

  const timestampText = refreshing
    ? "Refreshing…"
    : snapshot.updatedAt
      ? `Updated ${formatRelativeTime(snapshot.updatedAt)}`
      : onRefresh
        ? "Refresh"
        : null

  // The timestamp doubles as the refresh control on non-collapsible cards
  // (collapsible headers are already a toggle button — no nesting buttons).
  const timestampNode = timestampText === null
    ? null
    : onRefresh && !collapsible ? (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              if (!refreshing) onRefresh()
            }}
            className="shrink-0 cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {timestampText}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">Refresh usage</TooltipContent>
      </Tooltip>
    ) : (
      <span className="shrink-0 text-xs text-muted-foreground">{timestampText}</span>
    )

  // Scope and plan share one pill ("Personal Pro"); `capitalize` title-cases the
  // raw plan string ("max" → "Max").
  const planBadgeText = [accountScopeLabel(snapshot.plan), snapshot.plan].filter(Boolean).join(" ")

  const identity = (
    <div className="flex min-w-0 items-center gap-2.5">
      {collapsible ? (
        // Harness icon by default; on card hover it cross-fades (scale/fade/
        // blur, like the sidebar logo) to a chevron indicating expand state.
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          <Icon className="absolute inset-0 h-4 w-4 text-foreground transition-all duration-150 ease-out opacity-100 scale-100 blur-none group-hover/usage-card:opacity-0 group-hover/usage-card:scale-50 group-hover/usage-card:blur-[1px]" />
          <ChevronRight
            className={cn(
              "absolute inset-0 h-4 w-4 text-muted-foreground transition-all duration-150 ease-out opacity-0 scale-50 blur-[1px] group-hover/usage-card:opacity-100 group-hover/usage-card:scale-100 group-hover/usage-card:blur-none",
              expanded ? "rotate-90" : undefined,
            )}
          />
        </span>
      ) : (
        <Icon className="h-4 w-4 shrink-0 text-foreground" />
      )}
      <span className="truncate text-sm font-semibold text-foreground">
        {providerLabel(snapshot.provider)}
      </span>
      {planBadgeText ? (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
          {planBadgeText}
        </span>
      ) : null}
    </div>
  )

  // Collapsed cards fold the first window's meter into the header, laid out on
  // the same grid the expanded rows use so every bar lines up card to card. The
  // row title and the freshness stamp (which the header no longer prints) live
  // in the bar's tooltip instead.
  const displayWindows = usageWindowsForDisplay(snapshot.windows)
  const summaryWindow = displayWindows[0] ?? null
  const summaryResets = summaryWindow?.resetsAt ? formatUntil(summaryWindow.resetsAt) : null

  const header = showBody ? (
    <div className="flex items-center justify-between gap-3">
      {identity}
      {timestampNode}
    </div>
  ) : (
    <div className={COLLAPSED_HEADER_GRID}>
      {identity}
      <div className="hidden truncate text-xs text-muted-foreground md:block">
        {summaryResets ? `Resets ${summaryResets}` : ""}
      </div>
      {summaryWindow ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            {/* Padding widens the 8px bar's hover target without adding height:
                the identity column already sets the row's height. */}
            <div className="min-w-0 py-1.5">
              <UsageBar usedPercent={summaryWindow.usedPercent} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            <div>{summaryWindow.label}</div>
            {timestampText ? <div className="text-muted-foreground">{timestampText}</div> : null}
          </TooltipContent>
        </Tooltip>
      ) : (
        <div />
      )}
      <div className="text-right text-sm font-medium tabular-nums text-foreground">
        {summaryWindow ? formatPercent(summaryWindow.usedPercent) : ""}
      </div>
    </div>
  )

  const body = showBody ? (
    hasContent ? (
      <div className="mt-4 space-y-2.5">
        {displayWindows.map((window) => (
          <WindowRow key={window.id} window={window} />
        ))}
        {snapshot.credits ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-border pt-3 text-sm">
            <span className="text-foreground">{snapshot.credits.label}</span>
            <span className="text-muted-foreground">{creditsSummary(snapshot.credits)}</span>
          </div>
        ) : null}
        {snapshot.detail ? (
          <div className="text-xs text-muted-foreground">{snapshot.detail}</div>
        ) : null}
      </div>
    ) : (
      <div className="mt-3 text-sm text-muted-foreground">
        {snapshot.detail
          ?? (snapshot.status === "unknown" ? "No usage recorded yet." : "Usage limits are not available.")}
      </div>
    )
  ) : null

  const cardClass = "group/usage-card block w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left"

  // Collapsible cards toggle on click anywhere on the card; non-collapsible
  // cards stay a plain container (they carry their own interactive controls).
  if (collapsible) {
    return (
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className={cn(cardClass, "cursor-pointer")}
      >
        {header}
        {body}
      </button>
    )
  }

  return (
    <div className={cardClass}>
      {header}
      {body}
    </div>
  )
}

/** How often an open usage view re-checks; server-side TTL coalesces the reads. */
const USAGE_POLL_MS = 60_000

export function UsageSection({ state }: { state: Pick<KannaState, "socket"> }) {
  const socket = state.socket
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(true)

  // Live subscription: the immediate push shows cached/stale data right away,
  // and turn-pushed updates land here while the view is open.
  useEffect(() => {
    return socket.subscribe<UsageLimitsSnapshot>({ type: "usage-limits" }, setSnapshot)
  }, [socket])

  const runRefresh = useCallback(
    async (force: boolean) => {
      setRefreshing(true)
      try {
        const result = await socket.command<UsageLimitsSnapshot>({ type: "usage.refresh", force })
        if (result && Array.isArray(result.providers)) setSnapshot(result)
      } catch {
        // Errors surface as "unavailable" provider states in the snapshot.
      } finally {
        setRefreshing(false)
      }
    },
    [socket],
  )

  // Keep the view current on its own: refresh on open and every minute while
  // visible. Both are TTL-respecting (force=false), so the server coalesces to
  // at most one real read per minute regardless of how many views poll.
  useEffect(() => {
    void runRefresh(false)
    const interval = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void runRefresh(false)
      }
    }, USAGE_POLL_MS)
    return () => clearInterval(interval)
  }, [runRefresh])

  return (
    <div className="space-y-4">
      {snapshot ? (
        // Always render whatever we have (cached/stale) — the poll swaps in
        // fresh numbers when they land; the header "Updated …" is the control.
        snapshot.providers.map((provider) => (
          <ProviderCard
            key={provider.provider}
            snapshot={provider}
            refreshing={refreshing}
            onRefresh={() => {
              if (!refreshing) void runRefresh(true)
            }}
          />
        ))
      ) : (
        <div className="rounded-2xl border border-border bg-card/40 px-5 py-6 text-sm text-muted-foreground">
          Loading usage…
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"
import type { ProviderUsageSnapshot, UsageLimitWindow, UsageLimitsSnapshot } from "../../../shared/types"
import { DEFAULT_USAGE_RESET_DAY, MAX_USAGE_RESET_DAY, MIN_USAGE_RESET_DAY, PROVIDERS } from "../../../shared/types"
import { PROVIDER_ICONS } from "../../components/chat-ui/ChatPreferenceControls"
import { Input } from "../../components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"
import { formatRelativeTime } from "../../lib/formatters"
import { cn } from "../../lib/utils"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import type { KannaState } from "../useKannaState"
import { handleSettingsInputKeyDown, SETTINGS_NUMBER_INPUT_CLASS, SettingsField, SettingsGroup, SettingsRow } from "./shared"
import { SETTINGS_ROWS } from "./registry"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "in 40m" / "in 3h" / "in 2d" — future counterpart of formatRelativeTime. */
export function formatUntil(isoTimestamp: string): string | null {
  const timestamp = Date.parse(isoTimestamp)
  if (!Number.isFinite(timestamp)) return null
  const delta = timestamp - Date.now()
  if (delta <= 0) return "now"
  if (delta < HOUR_MS) return `in ${Math.max(1, Math.round(delta / MINUTE_MS))}m`
  if (delta < DAY_MS) return `in ${Math.round(delta / HOUR_MS)}h`
  return `in ${Math.round(delta / DAY_MS)}d`
}

export function formatPercent(value: number | null): string {
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

/** The next time the monthly cap resets on `day` of the month, local time, as ISO 8601. */
export function nextMonthlyReset(day: number, now = new Date()): string {
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day)
  return (thisMonth.getTime() > now.getTime() ? thisMonth : new Date(now.getFullYear(), now.getMonth() + 1, day)).toISOString()
}

/**
 * `assumedReset` is for a cap whose provider reports no reset (Claude's), so
 * the row says it is a guess; a reset the provider reports reads plainly.
 */
function creditsSummary(credits: NonNullable<ProviderUsageSnapshot["credits"]>, assumedReset: string | null = null): string | null {
  const parts: string[] = []
  if (credits.usedAmount != null) {
    const used = formatMoney(credits.usedAmount, credits.currency)
    parts.push(credits.limitAmount != null ? `${used} of ${formatMoney(credits.limitAmount, credits.currency)} used` : `${used} used`)
  }
  if (credits.usedPercent != null) parts.push(`${formatPercent(credits.usedPercent)} used`)
  if (credits.limitReached) parts.push("Limit reached")
  const resetsAt = credits.resetsAt ?? assumedReset
  const until = resetsAt ? formatUntil(resetsAt) : null
  if (until) parts.push(`Resets ${until}${credits.resetsAt ? "" : " (assumed)"}`)
  if (credits.detail) {
    // Codex reports its prepaid balance as a bare numeric string ("1000");
    // render it as a remaining count. Non-numeric details ("Unlimited") pass through.
    const numeric = /^\d+(\.\d+)?$/.test(credits.detail.trim()) ? Number(credits.detail) : null
    parts.push(numeric !== null ? `${formatCompact(numeric)} credits remaining` : credits.detail)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

export function providerLabel(providerId: string): string {
  return PROVIDERS.find((entry) => entry.id === providerId)?.label ?? providerId
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

export function UsageBar({ usedPercent }: { usedPercent: number | null }) {
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

// The widget column's rows: a bare reset time ("2h"), a bar 40% narrower, and
// the percent right-aligned so the numbers line up down the card. The narrow
// columns stay fixed rather than hugging their text so the bars still line up
// row to row.
const COMPACT_WINDOW_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_1.75rem_minmax(2.4rem,0.84fr)_2.25rem] items-center gap-2"

/**
 * When a window resets. Full ("Resets in 2h") normally; compact shows just
 * the time and keeps the full sentence for its tooltip.
 */
function ResetTime({ resets, compact, className }: { resets: string | null; compact: boolean; className?: string }) {
  if (!resets) return <div className={className} />
  const full = `Resets ${resets}`
  if (!compact) return <div className={cn("truncate text-xs text-muted-foreground", className)}>{full}</div>
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <div className={cn("truncate text-xs text-muted-foreground", className)}>{resets.replace(/^in /, "")}</div>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">{full}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Same grid for a collapsed card's header, minus the reset column on narrow
 * screens — the provider name plus a meter is all that fits on a phone, and the
 * reset time is one tap away in the expanded rows. The meter column is 30%
 * narrower than a window row's (1fr, not 1.4fr) so the name and plan pill
 * keep their room; the identity column truncates instead of overlapping.
 */
const COLLAPSED_HEADER_GRID = cn(
  "grid grid-cols-[minmax(0,1fr)_minmax(4rem,1fr)_2.375rem] items-center gap-3",
  "md:grid-cols-[minmax(0,1fr)_5rem_minmax(4rem,1fr)_2.375rem]",
)

function WindowRow({ window, compact = false }: { window: UsageLimitWindow; compact?: boolean }) {
  const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
  return (
    <div className={compact ? COMPACT_WINDOW_ROW_GRID : WINDOW_ROW_GRID}>
      <div className="min-w-0 truncate text-sm text-foreground">{window.label}</div>
      <ResetTime resets={resets} compact={compact} />
      <UsageBar usedPercent={window.usedPercent} />
      <div className={cn("tabular-nums", compact ? "text-right text-xs text-muted-foreground" : "text-right text-sm font-medium text-foreground")}>
        {formatPercent(window.usedPercent)}
      </div>
    </div>
  )
}

/** Scope and plan as one label ("Personal max"), or "" when neither is known. */
export function planLabel(snapshot: ProviderUsageSnapshot): string {
  return [accountScopeLabel(snapshot.plan), snapshot.plan].filter(Boolean).join(" ")
}

/**
 * A provider's limit windows, credits and detail line. Compact is the widget
 * column's density: a bare reset time and a narrower bar.
 */
export function UsageWindowRows({ snapshot, compact = false, className }: {
  snapshot: ProviderUsageSnapshot
  compact?: boolean
  className?: string
}) {
  const resetDay = useAppSettingsStore((store) => store.settings?.usageResetDay) ?? DEFAULT_USAGE_RESET_DAY
  // Claude reports a spend cap but no date it resets; that comes from the setting.
  const assumedReset = snapshot.provider === "claude" && snapshot.credits?.limitAmount != null
    ? nextMonthlyReset(resetDay)
    : null
  return (
    <div className={cn("space-y-2.5", className)}>
      {snapshot.windows.map((window) => (
        <WindowRow key={window.id} window={window} compact={compact} />
      ))}
      {snapshot.credits ? (
        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-3 text-sm">
          <span className="text-foreground">{snapshot.credits.label}</span>
          <span className="text-muted-foreground">{creditsSummary(snapshot.credits, assumedReset)}</span>
        </div>
      ) : null}
      {snapshot.detail ? (
        <div className="text-xs text-muted-foreground">{snapshot.detail}</div>
      ) : null}
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
  const planBadgeText = planLabel(snapshot)

  const identity = (
    <div className="flex min-w-0 items-center gap-2.5">
      {collapsible ? (
        // Harness icon by default; on card hover it cross-fades (scale/fade/
        // blur, like the sidebar logo) to a chevron indicating expand state.
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {/* From 75%, not 50%: at half size the icon reads as vanishing
              rather than turning into the chevron. */}
          <Icon className="absolute inset-0 h-4 w-4 text-foreground transition-[opacity,scale,filter] duration-150 ease-out opacity-100 scale-100 blur-none group-hover/usage-card:opacity-0 group-hover/usage-card:scale-75 group-hover/usage-card:blur-[1px]" />
          <ChevronRight
            className={cn(
              "absolute inset-0 h-4 w-4 text-muted-foreground transition-[opacity,scale,filter,rotate] duration-150 ease-out opacity-0 scale-75 blur-[1px] group-hover/usage-card:opacity-100 group-hover/usage-card:scale-100 group-hover/usage-card:blur-none",
              expanded ? "rotate-90" : undefined,
            )}
          />
        </span>
      ) : (
        <Icon className="h-4 w-4 shrink-0 text-foreground" />
      )}
      <span className="min-w-0 truncate text-sm font-semibold text-foreground">
        {providerLabel(snapshot.provider)}
      </span>
      {planBadgeText ? (
        <span className="min-w-0 shrink truncate rounded-full border border-border px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
          {planBadgeText}
        </span>
      ) : null}
    </div>
  )

  // Collapsed cards fold the first window's meter into the header, laid out on
  // the same grid the expanded rows use so every bar lines up card to card. The
  // row title and the freshness stamp (which the header no longer prints) live
  // in the bar's tooltip instead.
  const summaryWindow = snapshot.windows[0] ?? null
  const summaryResets = summaryWindow?.resetsAt ? formatUntil(summaryWindow.resetsAt) : null

  const header = showBody ? (
    <div className="flex items-center justify-between gap-3">
      {identity}
      {timestampNode}
    </div>
  ) : (
    <div className={COLLAPSED_HEADER_GRID}>
      {identity}
      <ResetTime resets={summaryResets} compact={false} className="hidden md:block" />
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
      <UsageWindowRows snapshot={snapshot} className="mt-4" />
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

/**
 * The live usage-limits snapshot plus a refresh, for any view that shows it.
 * Subscribing gets the cached snapshot at once; while `active`, the view also
 * refreshes on open and every minute. Those refreshes respect the server's
 * TTL, so however many views poll there is at most one real read a minute.
 */
export function useUsageLimits(socket: KannaState["socket"], active = true) {
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null)
  // An active view refreshes the moment it mounts, so it starts out refreshing.
  const [refreshing, setRefreshing] = useState(active)

  // Live subscription: the immediate push shows cached/stale data right away,
  // and turn-pushed updates land here while the view is open.
  useEffect(() => {
    return socket.subscribe<UsageLimitsSnapshot>({ type: "usage-limits" }, setSnapshot)
  }, [socket])

  const refresh = useCallback(
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

  useEffect(() => {
    if (!active) return
    void refresh(false)
    const interval = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void refresh(false)
      }
    }, USAGE_POLL_MS)
    return () => clearInterval(interval)
  }, [active, refresh])

  return { snapshot, refreshing, refresh }
}

/** The assumed monthly reset day of Claude's spend cap (the API reports none). */
function UsageResetDayRow({ onWrite }: { onWrite: KannaState["handleWriteAppSettings"] }) {
  const resetDay = useAppSettingsStore((store) => store.settings?.usageResetDay) ?? DEFAULT_USAGE_RESET_DAY
  const [draft, setDraft] = useState(String(resetDay))
  useEffect(() => {
    setDraft(String(resetDay))
  }, [resetDay])

  function commit() {
    const next = Math.round(Number(draft))
    if (draft.trim() === "" || !Number.isFinite(next)) {
      setDraft(String(resetDay))
      return
    }
    void onWrite({ usageResetDay: next }).catch(() => setDraft(String(resetDay)))
  }

  return (
    <SettingsGroup title="Spend limit">
      <SettingsRow def={SETTINGS_ROWS.usageResetDay} wideControl>
        <SettingsField hint={`Day of the month, ${MIN_USAGE_RESET_DAY}–${MAX_USAGE_RESET_DAY}. An assumption, not read from Claude${resetDay === DEFAULT_USAGE_RESET_DAY ? ` (default ${DEFAULT_USAGE_RESET_DAY})` : ""}`}>
          <Input
            type="number"
            min={MIN_USAGE_RESET_DAY}
            max={MAX_USAGE_RESET_DAY}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => handleSettingsInputKeyDown(event, commit)}
            className={SETTINGS_NUMBER_INPUT_CLASS}
          />
        </SettingsField>
      </SettingsRow>
    </SettingsGroup>
  )
}

export function UsageSection({ state }: { state: Pick<KannaState, "socket" | "handleWriteAppSettings"> }) {
  const { snapshot, refreshing, refresh: runRefresh } = useUsageLimits(state.socket)
  const claudeHasSpendCap = snapshot?.providers.some((provider) => provider.provider === "claude" && provider.credits?.limitAmount != null) ?? false

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
      {claudeHasSpendCap ? <UsageResetDayRow onWrite={state.handleWriteAppSettings} /> : null}
    </div>
  )
}

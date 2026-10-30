import type { AgentProvider, UsageLimitCredits, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"

export interface PlanUsageRow {
  window: UsageLimitWindow
  /** A row label just long enough to tell the stack apart: "5h", "Wk". Empty on the spend-cap row. */
  shortLabel: string
  /** Set on the spend-cap row: `window` is then the cap's percent, with no reset. */
  credits?: UsageLimitCredits
}

/**
 * A spend cap (Claude's extra usage) as a meter row, for plans that report no
 * time windows. Null when the cap has no percent to draw.
 */
function creditsRow(credits: UsageLimitCredits | null): PlanUsageRow | null {
  if (!credits || credits.usedPercent === null) return null
  return {
    window: {
      id: "credits",
      label: credits.label,
      usedPercent: credits.usedPercent,
      resetsAt: null,
      recordedAt: credits.recordedAt,
      source: credits.source,
    },
    shortLabel: "",
    credits,
  }
}

/**
 * The windows that limit every model on this provider. The sidebar is not
 * tied to a chat, so Claude's per-family weekly lanes (seven_day_opus) and
 * Codex's per-model lanes (a " · GPT 5.3 Codex Spark" label) are left out.
 */
function sharedWindows(provider: AgentProvider, windows: UsageLimitWindow[]): UsageLimitWindow[] {
  if (provider === "claude") {
    return windows.filter((window) => !/^seven_day_(opus|sonnet|oauth_apps)$/.test(window.id))
  }
  if (provider === "codex") {
    return windows.filter((window) => {
      const suffix = window.label.split(" · ")[1]
      return !suffix || suffix === "All models"
    })
  }
  if (provider === "grok") {
    // The all-products credit pool is the one every Grok model draws on.
    const pool = windows.filter((window) => window.id === "credits")
    return pool.length > 0 ? pool : windows
  }
  return windows
}

/**
 * Time left until `resetsAt`, rounded up to the minute: "3d 4h", "2h 14m",
 * "38m". Null when the time is unknown or already past.
 */
export function formatResetCountdown(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalMinutes = Math.ceil(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/**
 * A window as it stands at `now`: past its reset with no newer read, the limit
 * is back to empty, so 0% with no countdown (the server merges the same way on
 * its next read) rather than the old figure.
 */
export function windowAsOf(window: UsageLimitWindow, now: number = Date.now()): UsageLimitWindow {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now
    ? { ...window, usedPercent: 0, resetsAt: null }
    : window
}

const SPAN_MINUTES = { minute: 1, hour: 60, day: 1440 } as const

/** A window's length in minutes, read off its label; unknown spans sort last. */
function windowMinutes(window: UsageLimitWindow): number {
  const base = window.label.split(" · ")[0]
  const span = /(\d+)-(minute|hour|day)/.exec(base)
  if (span) return Number(span[1]) * SPAN_MINUTES[span[2] as keyof typeof SPAN_MINUTES]
  if (/week/i.test(base)) return 10080
  if (/month/i.test(base)) return 43200
  return Number.POSITIVE_INFINITY
}

/**
 * "Current session (5-hour)" → "5h", "Weekly · All models" → "Wk",
 * "5-hour · GPT 5.3 Codex Spark" → "5h Spark".
 */
export function shortUsageLabel(window: UsageLimitWindow): string {
  const [base, suffix] = window.label.split(" · ")
  const span = /(\d+)-(minute|hour|day)/.exec(base)
  const head = span ? `${span[1]}${span[2][0]}` : /week/i.test(base) ? "Wk" : base.split(/\s+/)[0]
  if (!suffix || /^All (models|products)$/.test(suffix)) return head
  return `${head} ${suffix.split(/\s+/).at(-1) ?? suffix}`
}

/**
 * Every limit on `provider` that applies to all its models, shortest window
 * first, or null when the provider reports none. The server keeps every
 * window it has seen (`mergeUsageWindows`), so the rows stay put between
 * reads. With no windows, a spend cap stands in as the one row.
 */
export function selectPlanUsage(
  snapshot: UsageLimitsSnapshot | null,
  provider: AgentProvider,
  now: number = Date.now(),
): PlanUsageRow[] | null {
  const providerSnapshot = snapshot?.providers.find((entry) => entry.provider === provider)
  if (!providerSnapshot || providerSnapshot.status !== "ok") return null
  const rows = sharedWindows(provider, providerSnapshot.windows)
    .filter((window) => window.usedPercent !== null)
    .map((window) => windowAsOf(window, now))
    .map((window, index) => ({ window, index, minutes: windowMinutes(window) }))
    .sort((a, b) => a.minutes - b.minutes || a.index - b.index)
    .map(({ window }) => ({ window, shortLabel: shortUsageLabel(window) }))
  if (rows.length > 0) return rows
  const spendCap = creditsRow(providerSnapshot.credits)
  return spendCap ? [spendCap] : null
}

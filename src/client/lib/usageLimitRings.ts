import {
  deriveModelLabel,
  FIVE_HOUR_WINDOW_MINUTES,
  usageLevel,
  WEEKLY_WINDOW_MINUTES,
  type AgentProvider,
  type ProviderUsageSnapshot,
  type UsageLimitWindow,
  type UsageLimitsSnapshot,
} from "../../shared/types"

/** Providers whose plan limits render as rings in the chat input. */
export const LIMIT_RING_PROVIDERS: ReadonlySet<AgentProvider> = new Set(["claude", "codex"])

export interface LimitRingSlot {
  key: "session" | "weekly"
  /** Fallback title shown until the provider reports this window. */
  label: string
  window: UsageLimitWindow | null
  /** A second window that also caps this slot, when the ring shows a model lane. */
  alsoApplies: UsageLimitWindow | null
}

export interface LimitRingSelection {
  snapshot: ProviderUsageSnapshot | null
  slots: LimitRingSlot[]
}

/** Lowercased alphanumerics only, so "GPT-5.3-Codex" and "GPT 5.3 Codex" compare equal. */
function compactLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/**
 * A one-word scope names a model family, so it matches on the family word alone.
 * A multi-word scope must match in full, or "GPT 5.3 Codex" claims the Spark lane.
 */
export function modelScopeMatches(modelLabel: string, selectedModel: string | null): boolean {
  if (!selectedModel) return false
  const scope = compactLabel(modelLabel)
  if (!scope) return false
  const selectedLabel = deriveModelLabel(selectedModel)
  if (compactLabel(selectedLabel) === scope) return true
  if (modelLabel.trim().split(/\s+/).length > 1) return false
  const family = selectedLabel.split(/\s+/)[0] ?? ""
  return compactLabel(family) === scope
}

/** A snapshot cached by an older Kanna has no windowMinutes, so id and label decide. */
function isWeekly(window: UsageLimitWindow): boolean {
  if (window.windowMinutes != null) return window.windowMinutes === WEEKLY_WINDOW_MINUTES
  if (window.id === "seven_day" || window.id.startsWith("model_scoped:")) return true
  return /^weekly\b/i.test(window.label)
}

function isSession(window: UsageLimitWindow): boolean {
  if (window.windowMinutes != null) return window.windowMinutes === FIVE_HOUR_WINDOW_MINUTES
  return window.id === "five_hour"
}

/** Preference order: the selected model's lane, the account-wide window, then any weekly window. */
function selectWeeklyWindows(
  windows: UsageLimitWindow[],
  selectedModel: string | null,
): { window: UsageLimitWindow | null; alsoApplies: UsageLimitWindow | null } {
  const weeklyWindows = windows.filter(isWeekly)
  // Claude's seven_day_opus/_sonnet keys are per-model even in caches written before they carried a modelLabel.
  const accountWide = weeklyWindows.find(
    (window) => !window.modelLabel && !window.id.startsWith("seven_day_"),
  ) ?? null
  const scoped = weeklyWindows.find(
    (window) => window.modelLabel && modelScopeMatches(window.modelLabel, selectedModel),
  ) ?? null
  const window = scoped ?? accountWide ?? weeklyWindows[0] ?? null
  return {
    window,
    alsoApplies: window && accountWide && window !== accountWide ? accountWide : null,
  }
}

function selectSessionWindow(windows: UsageLimitWindow[]): UsageLimitWindow | null {
  return windows.find(isSession) ?? null
}

/** Windows are matched by duration, not by key: Codex reports its weekly window in the "primary" slot. */
export function selectLimitRingWindows(
  snapshot: UsageLimitsSnapshot | null,
  provider: AgentProvider,
  selectedModel: string | null = null,
): LimitRingSelection {
  const providerSnapshot = snapshot?.providers.find((entry) => entry.provider === provider) ?? null
  const windows = providerSnapshot?.windows ?? []
  const weekly: LimitRingSlot = {
    key: "weekly",
    label: "Weekly limit",
    ...selectWeeklyWindows(windows, selectedModel),
  }
  if (provider === "claude") {
    return {
      snapshot: providerSnapshot,
      slots: [
        { key: "session", label: "5-hour limit", window: selectSessionWindow(windows), alsoApplies: null },
        weekly,
      ],
    }
  }
  if (provider === "codex") {
    return { snapshot: providerSnapshot, slots: [weekly] }
  }
  return { snapshot: providerSnapshot, slots: [] }
}

export function limitRingRemainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

const RING_LEVEL_CLASSES = {
  unknown: "text-muted-foreground/40",
  ok: "text-emerald-500",
  warn: "text-amber-500",
  danger: "text-red-500",
} as const

export function limitRingColorClass(usedPercent: number | null): string {
  return RING_LEVEL_CLASSES[usageLevel(usedPercent)]
}

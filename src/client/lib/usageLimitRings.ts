import {
  deriveModelLabel,
  type AgentProvider,
  type ProviderUsageSnapshot,
  type UsageLimitWindow,
  type UsageLimitsSnapshot,
} from "../../shared/types"

/** Providers whose plan limits render as rings in the chat input. */
export const LIMIT_RING_PROVIDERS: ReadonlySet<AgentProvider> = new Set(["claude", "codex"])

const FIVE_HOUR_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080

export interface LimitRingSlot {
  key: "session" | "weekly"
  /** Fallback title shown until the provider reports this window. */
  label: string
  window: UsageLimitWindow | null
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

/** Claude's seven_day_opus/_sonnet keys are per-model, so they cannot serve as the account-wide fallback. */
function selectWeeklyWindow(
  windows: UsageLimitWindow[],
  selectedModel: string | null,
): UsageLimitWindow | null {
  const scoped = windows.find(
    (window) => window.modelLabel && isWeekly(window) && modelScopeMatches(window.modelLabel, selectedModel),
  )
  if (scoped) return scoped
  return windows.find(
    (window) => !window.modelLabel && isWeekly(window) && !window.id.startsWith("seven_day_"),
  ) ?? null
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
    window: selectWeeklyWindow(windows, selectedModel),
  }
  if (provider === "claude") {
    return {
      snapshot: providerSnapshot,
      slots: [
        { key: "session", label: "5-hour limit", window: selectSessionWindow(windows) },
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

/** Thresholds must stay in step with the Usage page bars. */
export function limitRingColorClass(usedPercent: number | null): string {
  if (usedPercent === null) return "text-muted-foreground/40"
  if (usedPercent >= 90) return "text-red-500"
  if (usedPercent >= 75) return "text-amber-500"
  return "text-emerald-500"
}

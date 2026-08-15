import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { LOG_PREFIX } from "../shared/branding"
import { deriveModelLabel } from "../shared/types"
import type {
  AgentProvider,
  ProviderUsageSnapshot,
  UsageLimitCredits,
  UsageLimitSource,
  UsageLimitWindow,
  UsageLimitsSnapshot,
} from "../shared/types"

// ---------------------------------------------------------------------------
// Raw provider shapes (subset of what the SDK / app-server return). We keep
// these local and loose so an upstream field rename degrades to "unavailable"
// instead of a crash.
// ---------------------------------------------------------------------------

interface ClaudeUsageWindowRaw {
  utilization?: number | null
  resets_at?: string | null
}

/** One entry of `rate_limits.model_scoped`: a weekly window for a single model. */
interface ClaudeModelScopedRaw {
  display_name?: string | null
  utilization?: number | null
  resets_at?: string | null
}

interface ClaudeExtraUsageRaw {
  is_enabled?: boolean
  /** Minor currency units (e.g. cents when decimal_places is 2). */
  monthly_limit?: number | null
  /** Minor currency units (e.g. cents when decimal_places is 2). */
  used_credits?: number | null
  utilization?: number | null
  currency?: string | null
  decimal_places?: number | null
}

export interface ClaudeUsageRaw {
  subscription_type?: string | null
  rate_limits_available?: boolean
  /**
   * Keyed windows (five_hour, seven_day, seven_day_opus, ...) plus non-window
   * entries the API mixes in (extra_usage object, limits array, spend object,
   * member_dashboard_available boolean). Values are intentionally loose.
   */
  rate_limits?: Record<string, unknown> | null
}

/** Single-window sparse update pushed by the SDK on each turn. */
export interface ClaudeRateLimitInfoRaw {
  status?: "allowed" | "allowed_warning" | "rejected"
  resetsAt?: number
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage"
  utilization?: number
}

interface CodexRateLimitWindowRaw {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

interface CodexRateLimitSnapshotRaw {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexRateLimitWindowRaw | null
  secondary?: CodexRateLimitWindowRaw | null
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null
  planType?: string | null
}

export interface CodexRateLimitsRaw {
  rateLimits?: CodexRateLimitSnapshotRaw | null
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshotRaw | null | undefined> | null
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "Current session (5-hour)",
  seven_day: "Weekly · All models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · OAuth apps",
}

function prettifyKey(key: string): string {
  return key
    .split(/[_-]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function claudeWindowLabel(key: string): string {
  return CLAUDE_WINDOW_LABELS[key] ?? prettifyKey(key)
}

export const FIVE_HOUR_WINDOW_MINUTES = 300
export const WEEKLY_WINDOW_MINUTES = 10_080

/** Claude keys its windows by period rather than reporting a duration. */
function claudeWindowMinutes(key: string): number | null {
  if (key === "five_hour") return FIVE_HOUR_WINDOW_MINUTES
  if (key.startsWith("seven_day")) return WEEKLY_WINDOW_MINUTES
  return null
}

/** Stable id for a model-scoped weekly window: "Fable" becomes "model_scoped:fable". */
function modelScopedWindowId(displayName: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return `model_scoped:${slug || "model"}`
}

function codexWindowLabel(windowDurationMins: number | null | undefined, suffix: string): string {
  let base: string
  if (windowDurationMins == null) {
    base = "Rolling window"
  } else if (windowDurationMins <= 60) {
    base = `${windowDurationMins}-minute`
  } else if (windowDurationMins < 1440) {
    base = `${Math.round(windowDurationMins / 60)}-hour`
  } else if (windowDurationMins === 10080) {
    base = "Weekly"
  } else {
    base = `${Math.round(windowDurationMins / 1440)}-day`
  }
  return suffix ? `${base} · ${suffix}` : base
}

function clampPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

function latestRecordedAt(snapshot: ProviderUsageSnapshot): string | null {
  const times: string[] = []
  for (const w of snapshot.windows) times.push(w.recordedAt)
  if (snapshot.credits) times.push(snapshot.credits.recordedAt)
  if (times.length === 0) return null
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
}

// ---------------------------------------------------------------------------
// Normalizers (exported for tests)
// ---------------------------------------------------------------------------

export function normalizeClaudeUsage(
  raw: ClaudeUsageRaw | null,
  now: string,
  source: UsageLimitSource = "on_demand",
): ProviderUsageSnapshot {
  const base: ProviderUsageSnapshot = {
    provider: "claude",
    status: "unknown",
    plan: null,
    windows: [],
    credits: null,
    detail: null,
    updatedAt: null,
  }

  if (!raw) {
    return { ...base, status: "unavailable", detail: "Could not read Claude usage." }
  }

  base.plan = raw.subscription_type ?? null

  if (raw.rate_limits_available === false || !raw.rate_limits) {
    return {
      ...base,
      status: "unavailable",
      detail: "Plan limits are not available for this session (API key or non-subscription auth).",
    }
  }

  const windows: UsageLimitWindow[] = []
  let credits: UsageLimitCredits | null = null

  for (const [key, value] of Object.entries(raw.rate_limits)) {
    if (key === "extra_usage") {
      const eu = value as ClaudeExtraUsageRaw | null | undefined
      if (eu && eu.is_enabled) {
        // Amounts are minor currency units per the response's own metadata
        // (currency "USD", decimal_places 2): 706600 → $7,066.00, matching
        // the claude.ai dashboard. Formatting happens client-side.
        const divisor = 10 ** (eu.decimal_places ?? 2)
        credits = {
          label: "Extra usage",
          usedPercent: clampPercent(eu.utilization),
          usedAmount: eu.used_credits != null ? eu.used_credits / divisor : null,
          limitAmount: eu.monthly_limit != null ? eu.monthly_limit / divisor : null,
          currency: eu.currency ?? "USD",
          detail: null,
          recordedAt: now,
          source,
        }
      }
      continue
    }
    // Per-model weekly windows arrive as an array of {display_name,
    // utilization, resets_at} rather than as keyed entries.
    if (key === "model_scoped") {
      if (!Array.isArray(value)) continue
      for (const entry of value as ClaudeModelScopedRaw[]) {
        const displayName = typeof entry?.display_name === "string" ? entry.display_name.trim() : ""
        if (!displayName) continue
        windows.push({
          id: modelScopedWindowId(displayName),
          label: `Weekly · ${displayName}`,
          usedPercent: clampPercent(entry.utilization),
          resetsAt: entry.resets_at ?? null,
          windowMinutes: WEEKLY_WINDOW_MINUTES,
          modelLabel: displayName,
          recordedAt: now,
          source,
        })
      }
      continue
    }
    // Only keyed entries shaped like windows count; the response also carries
    // non-window keys (a `limits` array, a `spend` object, booleans) we skip.
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    if (!("utilization" in value) && !("resets_at" in value)) continue
    const window = value as ClaudeUsageWindowRaw
    windows.push({
      id: key,
      label: claudeWindowLabel(key),
      usedPercent: clampPercent(window.utilization),
      resetsAt: window.resets_at ?? null,
      windowMinutes: claudeWindowMinutes(key),
      modelLabel: null,
      recordedAt: now,
      source,
    })
  }

  const snapshot: ProviderUsageSnapshot = {
    ...base,
    status: windows.length > 0 || credits ? "ok" : "unavailable",
    windows,
    credits,
    detail: windows.length > 0 || credits ? null : "No plan limit windows reported.",
  }
  snapshot.updatedAt = latestRecordedAt(snapshot)
  return snapshot
}

const CLAUDE_PUSH_WINDOW_IDS: Record<string, string> = {
  five_hour: "five_hour",
  seven_day: "seven_day",
  seven_day_opus: "seven_day_opus",
  seven_day_sonnet: "seven_day_sonnet",
}

/**
 * Merge a single-window sparse push into an existing Claude snapshot. The
 * pushed `utilization` is a 0–1 fraction (from the response header), unlike the
 * 0–100 `get_usage` percentages, so we scale it. Only the binding window is
 * updated; other windows keep their last recordedAt (honest staleness).
 */
export function mergeClaudeRateLimitPush(
  prev: ProviderUsageSnapshot | null,
  info: ClaudeRateLimitInfoRaw,
  now: string,
): ProviderUsageSnapshot {
  const base: ProviderUsageSnapshot = prev ?? {
    provider: "claude",
    status: "ok",
    plan: null,
    windows: [],
    credits: null,
    detail: null,
    updatedAt: null,
  }

  const type = info.rateLimitType
  if (!type || type === "overage") {
    // Nothing window-specific to merge (overage handled via credits elsewhere).
    return base
  }
  const id = CLAUDE_PUSH_WINDOW_IDS[type] ?? type
  const usedPercent = info.utilization != null && Number.isFinite(info.utilization)
    ? clampPercent(info.utilization * 100)
    : null
  const resetsAt = unixSecondsToIso(info.resetsAt)

  const windows = [...base.windows]
  const existingIndex = windows.findIndex((w) => w.id === id)
  const existing = windows[existingIndex]
  // A push can carry only a reset time, so the last known figure and its own recordedAt survive it.
  const keepPrevious = usedPercent === null && existing?.usedPercent != null
  const merged: UsageLimitWindow = {
    id,
    label: claudeWindowLabel(id),
    usedPercent: keepPrevious ? existing.usedPercent : usedPercent,
    resetsAt: resetsAt ?? existing?.resetsAt ?? null,
    windowMinutes: claudeWindowMinutes(id),
    modelLabel: null,
    recordedAt: keepPrevious ? existing.recordedAt : now,
    source: keepPrevious ? existing.source : "turn_push",
  }
  if (existingIndex >= 0) {
    windows[existingIndex] = merged
  } else {
    windows.push(merged)
  }

  const snapshot: ProviderUsageSnapshot = {
    ...base,
    status: "ok",
    windows,
    detail: null,
  }
  snapshot.updatedAt = latestRecordedAt(snapshot)
  return snapshot
}

function codexBucketWindows(
  bucket: CodexRateLimitSnapshotRaw,
  keyPrefix: string,
  now: string,
  source: UsageLimitSource,
  labelSuffix: string,
  modelLabel: string | null,
): UsageLimitWindow[] {
  const windows: UsageLimitWindow[] = []
  // primary/secondary are positional slots, not fixed periods: a plan with one
  // window reports it as primary whatever its duration.
  for (const slot of ["primary", "secondary"] as const) {
    const window = bucket[slot]
    if (!window) continue
    windows.push({
      id: `${keyPrefix}:${slot}`,
      label: codexWindowLabel(window.windowDurationMins, labelSuffix),
      usedPercent: clampPercent(window.usedPercent),
      resetsAt: unixSecondsToIso(window.resetsAt),
      windowMinutes: window.windowDurationMins ?? null,
      modelLabel,
      recordedAt: now,
      source,
    })
  }
  return windows
}

export function normalizeCodexRateLimits(
  raw: CodexRateLimitsRaw | null,
  now: string,
  source: UsageLimitSource = "on_demand",
): ProviderUsageSnapshot {
  const base: ProviderUsageSnapshot = {
    provider: "codex",
    status: "unknown",
    plan: null,
    windows: [],
    credits: null,
    detail: null,
    updatedAt: null,
  }

  if (!raw) {
    return { ...base, status: "unavailable", detail: "Could not read Codex usage." }
  }

  const buckets = raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length > 0
    ? Object.entries(raw.rateLimitsByLimitId).filter((entry): entry is [string, CodexRateLimitSnapshotRaw] => Boolean(entry[1]))
    : raw.rateLimits
      ? [[raw.rateLimits.limitId ?? "codex", raw.rateLimits] as [string, CodexRateLimitSnapshotRaw]]
      : []

  // The default "codex" (All models) bucket always renders first; named
  // model-specific lanes (e.g. Spark) follow. Object key order isn't
  // guaranteed and turn-push merges can reorder, so pin it explicitly.
  buckets.sort(([a], [b]) => {
    if (a === "codex") return -1
    if (b === "codex") return 1
    return a.localeCompare(b)
  })

  if (buckets.length === 0) {
    return {
      ...base,
      status: "unavailable",
      detail: "No rate-limit windows reported (sign in to Codex with a ChatGPT plan).",
    }
  }

  const windows: UsageLimitWindow[] = []
  let plan: string | null = null
  let credits: UsageLimitCredits | null = null
  const multiple = buckets.length > 1

  for (const [limitId, bucket] of buckets) {
    plan = plan ?? bucket.planType ?? null
    // The default bucket ("codex") has no limitName; named buckets are
    // model-specific lanes whose limitName is a model id — run it through the
    // shared model-label formatter so "GPT-5.3-Codex-Spark" → "GPT 5.3 Codex
    // Spark", matching the rest of the app.
    const modelLabel = bucket.limitName ? deriveModelLabel(bucket.limitName) : null
    const suffix = !multiple
      ? ""
      : modelLabel
        ?? (limitId === "codex" ? "All models" : limitId)
    windows.push(...codexBucketWindows(bucket, limitId, now, source, suffix, modelLabel))
    if (!credits && bucket.credits && (bucket.credits.hasCredits || bucket.credits.unlimited)) {
      credits = {
        label: "Credits",
        usedPercent: null,
        usedAmount: null,
        limitAmount: null,
        currency: null,
        // Codex reports balance as an opaque string; pass it through.
        detail: bucket.credits.unlimited ? "Unlimited" : bucket.credits.balance ?? null,
        recordedAt: now,
        source,
      }
    }
  }

  const snapshot: ProviderUsageSnapshot = {
    ...base,
    status: windows.length > 0 ? "ok" : "unavailable",
    plan,
    windows,
    credits,
    detail: windows.length > 0 ? null : "No rate-limit windows reported.",
  }
  snapshot.updatedAt = latestRecordedAt(snapshot)
  return snapshot
}

/** Merge a sparse pushed Codex snapshot into the previous full read. */
export function mergeCodexRateLimitPush(
  prev: ProviderUsageSnapshot | null,
  raw: CodexRateLimitSnapshotRaw,
  now: string,
): ProviderUsageSnapshot {
  const fresh = normalizeCodexRateLimits(
    { rateLimits: raw },
    now,
    "turn_push",
  )
  if (!prev || prev.windows.length === 0) return fresh

  // Overlay fresh windows onto prev by id; keep prev windows the push omitted.
  const byId = new Map(prev.windows.map((w) => [w.id, w]))
  for (const w of fresh.windows) byId.set(w.id, w)
  const snapshot: ProviderUsageSnapshot = {
    ...prev,
    status: "ok",
    plan: fresh.plan ?? prev.plan,
    windows: [...byId.values()],
    credits: fresh.credits ?? prev.credits,
    detail: null,
  }
  snapshot.updatedAt = latestRecordedAt(snapshot)
  return snapshot
}

function staticProviderSnapshot(provider: AgentProvider): ProviderUsageSnapshot {
  if (provider === "pi") {
    return {
      provider,
      status: "not_applicable",
      plan: null,
      windows: [],
      credits: null,
      detail: "Pi runs through the Model Registry (pay-per-token). No subscription limits to show.",
      updatedAt: null,
    }
  }
  // cursor (this phase): not wired up.
  return {
    provider,
    status: "unavailable",
    plan: null,
    windows: [],
    credits: null,
    detail: "Usage limits for Cursor are not available yet.",
    updatedAt: null,
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const PROVIDER_ORDER: AgentProvider[] = ["claude", "codex", "cursor", "pi"]

/** Non-forced refreshes within this window reuse the last read (probes are pricey). */
const REFRESH_TTL_MS = 60_000

interface UsageLimitsFile {
  version?: number
  providers?: Partial<Record<AgentProvider, ProviderUsageSnapshot>>
}

export interface UsageLimitsManagerDeps {
  /** Fetch a fresh Claude usage read, or null when unavailable. */
  fetchClaudeUsage?: () => Promise<ClaudeUsageRaw | null>
  /** Fetch a fresh Codex rate-limit read, or null when unavailable. */
  fetchCodexRateLimits?: () => Promise<CodexRateLimitsRaw | null>
  now?: () => Date
}

export class UsageLimitsManager {
  readonly filePath: string
  private readonly deps: UsageLimitsManagerDeps
  private snapshots = new Map<AgentProvider, ProviderUsageSnapshot>()
  private readonly listeners = new Set<(snapshot: UsageLimitsSnapshot) => void>()
  private refreshInFlight: Promise<void> | null = null
  private lastRefreshAt: number | null = null
  /** Serializes disk writes so overlapping saves can't interleave. */
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string, deps: UsageLimitsManagerDeps = {}) {
    this.filePath = filePath
    this.deps = deps
    for (const provider of PROVIDER_ORDER) {
      this.snapshots.set(provider, staticProviderSnapshot(provider))
    }
    // claude/codex start "unknown" until first fetch.
    this.snapshots.set("claude", {
      provider: "claude", status: "unknown", plan: null, windows: [], credits: null, detail: null, updatedAt: null,
    })
    this.snapshots.set("codex", {
      provider: "codex", status: "unknown", plan: null, windows: [], credits: null, detail: null, updatedAt: null,
    })
  }

  private nowIso() {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const text = await readFile(this.filePath, "utf8")
      if (text.trim()) {
        const parsed = JSON.parse(text) as UsageLimitsFile
        for (const provider of ["claude", "codex"] as const) {
          const persisted = parsed.providers?.[provider]
          if (persisted && typeof persisted === "object") {
            // Mark persisted windows as cache-sourced so the UI can show staleness.
            // Fields added after a cache was written come back undefined.
            this.snapshots.set(provider, {
              ...persisted,
              windows: persisted.windows?.map((w) => ({
                ...w,
                windowMinutes: w.windowMinutes ?? null,
                modelLabel: w.modelLabel ?? null,
                source: "cache" as const,
              })) ?? [],
              credits: persisted.credits ? { ...persisted.credits, source: "cache" } : null,
            })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        console.warn(`${LOG_PREFIX} Failed to load usage-limits cache:`, error)
      }
    }
  }

  dispose() {
    this.listeners.clear()
  }

  getSnapshot(): UsageLimitsSnapshot {
    return {
      providers: PROVIDER_ORDER.map((provider) => this.snapshots.get(provider)!),
    }
  }

  onChange(listener: (snapshot: UsageLimitsSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private setProvider(provider: AgentProvider, snapshot: ProviderUsageSnapshot) {
    this.snapshots.set(provider, snapshot)
    this.persistChain = this.persistChain.then(() => this.persist())
    this.emit()
  }

  /** Record a pushed Claude rate-limit event (single binding window). */
  recordClaudeRateLimitPush(info: ClaudeRateLimitInfoRaw) {
    const prev = this.snapshots.get("claude") ?? null
    this.setProvider("claude", mergeClaudeRateLimitPush(prev, info, this.nowIso()))
  }

  /** Record a pushed Codex rate-limit snapshot (sparse). */
  recordCodexRateLimitPush(raw: CodexRateLimitSnapshotRaw) {
    const prev = this.snapshots.get("codex") ?? null
    this.setProvider("codex", mergeCodexRateLimitPush(prev, raw, this.nowIso()))
  }

  /**
   * On-demand refresh of claude + codex; coalesces concurrent calls. Reads may
   * spawn short-lived harness probe processes, so non-forced calls (e.g. every
   * usage-limits subscription) are throttled to once per TTL — the explicit
   * Refresh button passes force.
   */
  async refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    if (!options.force && this.lastRefreshAt !== null) {
      const age = (this.deps.now?.() ?? new Date()).getTime() - this.lastRefreshAt
      if (age < REFRESH_TTL_MS) return
    }
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async doRefresh() {
    await Promise.all([this.refreshClaude(), this.refreshCodex()])
    this.lastRefreshAt = (this.deps.now?.() ?? new Date()).getTime()
    // Make refresh() a durable point: the persisted cache reflects this read.
    await this.persistChain
  }

  /**
   * Apply a fresh read, but never let a failed read wipe last-known data: when
   * the fresh snapshot has no windows and the previous one does, keep the
   * previous windows/credits (their recordedAt timestamps communicate the
   * staleness) and only surface the failure detail.
   */
  private applyRefreshed(provider: AgentProvider, fresh: ProviderUsageSnapshot) {
    const prev = this.snapshots.get(provider)
    if (fresh.status !== "ok" && prev && prev.windows.length > 0) {
      this.setProvider(provider, { ...prev, detail: fresh.detail })
      return
    }
    this.setProvider(provider, fresh)
  }

  private async refreshClaude() {
    if (!this.deps.fetchClaudeUsage) return
    try {
      const raw = await this.deps.fetchClaudeUsage()
      this.applyRefreshed("claude", normalizeClaudeUsage(raw, this.nowIso()))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.applyRefreshed("claude", {
        provider: "claude", status: "unavailable", plan: null, windows: [], credits: null,
        detail: `Failed to read Claude usage: ${detail}`, updatedAt: null,
      })
    }
  }

  private async refreshCodex() {
    if (!this.deps.fetchCodexRateLimits) return
    try {
      const raw = await this.deps.fetchCodexRateLimits()
      this.applyRefreshed("codex", normalizeCodexRateLimits(raw, this.nowIso()))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isAuth = /chatgpt|auth|login|sign/i.test(message)
      this.applyRefreshed("codex", {
        provider: "codex", status: "unavailable", plan: null, windows: [], credits: null,
        detail: isAuth
          ? "Sign in to Codex with a ChatGPT plan to see limits (API-key auth has no limits)."
          : `Failed to read Codex usage: ${message}`,
        updatedAt: null,
      })
    }
  }

  private async persist() {
    const file: UsageLimitsFile = {
      version: 1,
      providers: {
        claude: this.snapshots.get("claude"),
        codex: this.snapshots.get("codex"),
      },
    }
    try {
      await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8")
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to persist usage-limits cache:`, error)
    }
  }
}

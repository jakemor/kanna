import path from "node:path"
import { Context, Deferred, Effect, FileSystem, Layer, Match, Option, Ref, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { deriveModelLabel } from "../shared/types"
import type {
  AgentProvider,
  ProviderUsageSnapshot,
  UsageLimitCredits,
  UsageLimitSource,
  UsageLimitWindow,
  UsageLimitsSnapshot,
} from "../shared/types"
import { Machine } from "./platform/machine"
import { grokProductUsageWindows, moneyVal, type GrokBillingRaw, type GrokUsageError, type GrokUserRaw } from "./grok-cli"

// ---------------------------------------------------------------------------
// Raw provider shapes (subset of what the SDK / app-server return). We keep
// these local and loose so an upstream field rename degrades to "unavailable"
// instead of a crash.
// ---------------------------------------------------------------------------

interface ClaudeUsageWindowRaw {
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
  const merged: UsageLimitWindow = {
    id,
    label: claudeWindowLabel(id),
    usedPercent,
    resetsAt: resetsAt ?? windows[existingIndex]?.resetsAt ?? null,
    recordedAt: now,
    source: "turn_push",
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
): UsageLimitWindow[] {
  const windows: UsageLimitWindow[] = []
  if (bucket.primary) {
    windows.push({
      id: `${keyPrefix}:primary`,
      label: codexWindowLabel(bucket.primary.windowDurationMins, labelSuffix),
      usedPercent: clampPercent(bucket.primary.usedPercent),
      resetsAt: unixSecondsToIso(bucket.primary.resetsAt),
      recordedAt: now,
      source,
    })
  }
  if (bucket.secondary) {
    windows.push({
      id: `${keyPrefix}:secondary`,
      label: codexWindowLabel(bucket.secondary.windowDurationMins, labelSuffix),
      usedPercent: clampPercent(bucket.secondary.usedPercent),
      resetsAt: unixSecondsToIso(bucket.secondary.resetsAt),
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
    const suffix = !multiple
      ? ""
      : bucket.limitName
        ? deriveModelLabel(bucket.limitName)
        : limitId === "codex"
          ? "All models"
          : limitId
    windows.push(...codexBucketWindows(bucket, limitId, now, source, suffix))
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

export interface GrokUsageRaw {
  billing: GrokBillingRaw
  user: GrokUserRaw
}

export function normalizeGrokAccountUsage(
  raw: GrokUsageRaw | null,
  now: string,
  source: UsageLimitSource = "on_demand",
): ProviderUsageSnapshot {
  const base: ProviderUsageSnapshot = {
    provider: "grok",
    status: "unknown",
    plan: null,
    windows: [],
    credits: null,
    detail: null,
    updatedAt: null,
  }
  if (!raw) {
    return { ...base, status: "unavailable", detail: "Could not read Grok usage. Sign in with grok login." }
  }

  const plan = raw.user.subscriptionTier ?? null
  const windows: UsageLimitWindow[] = grokProductUsageWindows(raw.billing).map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: window.usedPercent == null || !Number.isFinite(window.usedPercent)
      ? null
      : Math.max(0, Math.min(100, window.usedPercent)),
    resetsAt: window.resetsAt,
    recordedAt: now,
    source,
  }))

  const onDemandUsed = moneyVal(raw.billing.config?.onDemandUsed)
  const onDemandCap = moneyVal(raw.billing.config?.onDemandCap)
  const prepaid = moneyVal(raw.billing.config?.prepaidBalance)
  let credits: UsageLimitCredits | null = null
  if ((onDemandCap != null && onDemandCap > 0) || (prepaid != null && prepaid > 0)) {
    credits = {
      label: prepaid && prepaid > 0 ? "Prepaid balance" : "On-demand",
      usedPercent: onDemandCap && onDemandCap > 0 && onDemandUsed != null
        ? Math.max(0, Math.min(100, (onDemandUsed / onDemandCap) * 100))
        : null,
      usedAmount: onDemandUsed,
      limitAmount: onDemandCap,
      currency: "USD",
      detail: prepaid && prepaid > 0 ? `Prepaid $${prepaid}` : null,
      recordedAt: now,
      source,
    }
  }

  const snapshot: ProviderUsageSnapshot = {
    ...base,
    status: windows.length > 0 ? "ok" : "unavailable",
    plan,
    windows,
    credits,
    detail: windows.length > 0 ? null : "No Grok usage windows reported.",
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
  if (provider === "grok") {
    return {
      provider,
      status: "unknown",
      plan: null,
      windows: [],
      credits: null,
      detail: null,
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
// Service
// ---------------------------------------------------------------------------

const PROVIDER_ORDER = ["claude", "codex", "cursor", "grok", "pi"] as const satisfies readonly AgentProvider[]

/** The providers whose reads are cached on disk. */
const PERSISTED_PROVIDERS = ["claude", "codex", "grok"] as const satisfies readonly AgentProvider[]

/** Non-forced refreshes within this window reuse the last read (probes are pricey). */
const REFRESH_TTL_MS = 60_000

type UsageLimitsState = Readonly<Record<AgentProvider, ProviderUsageSnapshot>>

// The cache file as Kanna writes it. Window and credit `source` are not read
// back: everything restored from it is marked "cache".
const PersistedWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
})

const PersistedCredits = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  usedAmount: Schema.NullOr(Schema.Number),
  limitAmount: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
})

const PersistedProviderSnapshot = Schema.Struct({
  provider: Schema.Literals(PROVIDER_ORDER),
  status: Schema.Literals(["ok", "unavailable", "not_applicable", "unknown"]),
  plan: Schema.NullOr(Schema.String),
  windows: Schema.optional(Schema.Array(PersistedWindow)),
  credits: Schema.optional(Schema.NullOr(PersistedCredits)),
  detail: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
})

const UsageLimitsFile = Schema.Struct({
  version: Schema.optional(Schema.Number),
  providers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const decodeUsageLimitsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageLimitsFile))
const decodePersistedProvider = Schema.decodeUnknownOption(PersistedProviderSnapshot)

export class UsageLimitsFileError extends Schema.TaggedError<UsageLimitsFileError>()(
  "@kanna/server/usage-limits/UsageLimitsFileError",
  {
    operation: Schema.Literals(["read", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** A provider's usage read (a harness probe or an HTTP call) failed. */
export class UsageReadError extends Schema.TaggedError<UsageReadError>()(
  "@kanna/server/usage-limits/UsageReadError",
  {
    provider: Schema.Literals(PROVIDER_ORDER),
    cause: Schema.Defect(),
  },
) {}

export interface UsageLimitsDeps {
  /** Fetch a fresh Claude usage read, or null when unavailable. */
  fetchClaudeUsage?: () => Promise<ClaudeUsageRaw | null>
  /** Fetch a fresh Codex rate-limit read, or null when unavailable. */
  fetchCodexRateLimits?: () => Promise<CodexRateLimitsRaw | null>
  /** Fetch Grok Build billing + subscription from cli-chat-proxy (`fetchGrokAccountUsage`). */
  fetchGrokUsage?: () => Effect.Effect<GrokUsageRaw | null, GrokUsageError, FileSystem.FileSystem | Machine>
  now?: () => Date
}

/**
 * Plan usage per provider: restored from the on-disk cache when the layer is
 * built, refreshed on demand, and updated by the rate-limit events the
 * harnesses push during turns. Every change is written back to the cache.
 *
 * `changes` emits each snapshot after the current one, never the current one
 * itself; read that with `snapshot`.
 */
export class UsageLimits extends Context.Service<UsageLimits, {
  readonly filePath: string
  readonly snapshot: Effect.Effect<UsageLimitsSnapshot>
  readonly changes: Stream.Stream<UsageLimitsSnapshot>
  /**
   * On-demand refresh of claude, codex and grok; concurrent calls join the
   * one in flight. Reads may spawn short-lived harness probe processes, so
   * non-forced calls (e.g. every usage-limits subscription) are throttled to
   * once per TTL — the explicit Refresh button passes force. When it
   * completes, the cache on disk reflects the read.
   */
  readonly refresh: (options?: { force?: boolean }) => Effect.Effect<void>
  /** Record a pushed Claude rate-limit event (single binding window). */
  readonly recordClaudeRateLimitPush: (info: ClaudeRateLimitInfoRaw) => Effect.Effect<void>
  /** Record a pushed Codex rate-limit snapshot (sparse). */
  readonly recordCodexRateLimitPush: (raw: CodexRateLimitSnapshotRaw) => Effect.Effect<void>
}>()("@kanna/server/UsageLimits") {
  static readonly layer = (filePath: string, deps: UsageLimitsDeps = {}) =>
    Layer.effect(this, makeUsageLimits(filePath, deps))
}

function initialState(): UsageLimitsState {
  const unknown = (provider: AgentProvider): ProviderUsageSnapshot => ({
    provider, status: "unknown", plan: null, windows: [], credits: null, detail: null, updatedAt: null,
  })
  return {
    // claude/codex start "unknown" until the first fetch.
    claude: unknown("claude"),
    codex: unknown("codex"),
    cursor: staticProviderSnapshot("cursor"),
    grok: staticProviderSnapshot("grok"),
    pi: staticProviderSnapshot("pi"),
  }
}

function toUsageLimitsSnapshot(state: UsageLimitsState): UsageLimitsSnapshot {
  return { providers: PROVIDER_ORDER.map((provider) => state[provider]) }
}

/**
 * Apply a fresh read, but never let a failed read wipe last-known data: when
 * the fresh snapshot has no windows and the previous one does, keep the
 * previous windows/credits (their recordedAt timestamps communicate the
 * staleness) and only surface the failure detail.
 */
function applyRefreshed(prev: ProviderUsageSnapshot, fresh: ProviderUsageSnapshot): ProviderUsageSnapshot {
  if (fresh.status !== "ok" && prev.windows.length > 0) {
    return { ...prev, detail: fresh.detail }
  }
  return fresh
}

function unavailable(provider: AgentProvider, detail: string): ProviderUsageSnapshot {
  return { provider, status: "unavailable", plan: null, windows: [], credits: null, detail, updatedAt: null }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

type RefreshAction =
  | { readonly _tag: "join"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "start"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "skip" }

const makeUsageLimits = Effect.fn("UsageLimits.make")(function* (filePath: string, deps: UsageLimitsDeps) {
  const fs = yield* FileSystem.FileSystem
  const grokContext = Context.pick(FileSystem.FileSystem, Machine)(yield* Effect.context<FileSystem.FileSystem | Machine>())
  const scope = yield* Effect.scope
  yield* Effect.annotateCurrentSpan("filePath", filePath)
  const now = () => deps.now?.() ?? new Date()
  const nowIso = () => now().toISOString()

  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new UsageLimitsFileError({ operation: "write", filePath, cause }))),
  )
  const ref = yield* SubscriptionRef.make(yield* readCache(fs, filePath))

  // Serializes disk writes so overlapping saves can't interleave; each one
  // writes the state as it is when it runs.
  const persistLock = yield* Semaphore.make(1)
  const persist = Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(ref)
    const file = {
      version: 1,
      providers: { claude: state.claude, codex: state.codex, grok: state.grok },
    }
    yield* fs.writeFileString(filePath, `${JSON.stringify(file, null, 2)}\n`)
  }).pipe(
    Effect.catchTag("PlatformError", (error) => Effect.logWarning("Failed to persist usage-limits cache:", error)),
    Semaphore.withPermit(persistLock),
  )

  const updateProvider = (provider: AgentProvider, update: (prev: ProviderUsageSnapshot) => ProviderUsageSnapshot) =>
    SubscriptionRef.update(ref, (state) => ({ ...state, [provider]: update(state[provider]) })).pipe(
      Effect.andThen(persist),
    )

  const fetchRaw = <A>(provider: AgentProvider, fetch: () => Promise<A>) =>
    Effect.tryPromise({
      try: fetch,
      catch: (cause) => new UsageReadError({ provider, cause }),
    })

  const refreshClaude = Effect.fn("UsageLimits.refreshClaude")(function* () {
    const fetchClaudeUsage = deps.fetchClaudeUsage
    if (!fetchClaudeUsage) return
    const fresh = yield* fetchRaw("claude", fetchClaudeUsage).pipe(
      Effect.map((raw) => normalizeClaudeUsage(raw, nowIso())),
      Effect.catchTag("@kanna/server/usage-limits/UsageReadError", (error) =>
        Effect.succeed(unavailable("claude", `Failed to read Claude usage: ${errorMessage(error.cause)}`))),
    )
    yield* updateProvider("claude", (prev) => applyRefreshed(prev, fresh))
  })

  const refreshCodex = Effect.fn("UsageLimits.refreshCodex")(function* () {
    const fetchCodexRateLimits = deps.fetchCodexRateLimits
    if (!fetchCodexRateLimits) return
    const fresh = yield* fetchRaw("codex", fetchCodexRateLimits).pipe(
      Effect.map((raw) => normalizeCodexRateLimits(raw, nowIso())),
      Effect.catchTag("@kanna/server/usage-limits/UsageReadError", (error) => {
        const message = errorMessage(error.cause)
        return Effect.succeed(unavailable("codex", /chatgpt|auth|login|sign/i.test(message)
          ? "Sign in to Codex with a ChatGPT plan to see limits (API-key auth has no limits)."
          : `Failed to read Codex usage: ${message}`))
      }),
    )
    yield* updateProvider("codex", (prev) => applyRefreshed(prev, fresh))
  })

  const refreshGrok = Effect.fn("UsageLimits.refreshGrok")(function* () {
    const fetchGrokUsage = deps.fetchGrokUsage
    if (!fetchGrokUsage) return
    const fresh = yield* fetchGrokUsage().pipe(
      Effect.provide(grokContext),
      Effect.map((raw) => normalizeGrokAccountUsage(raw, nowIso())),
      Effect.catchTag("@kanna/server/grok-cli/GrokUsageError", (error) => {
        const message = error.message
        return Effect.succeed(unavailable("grok", /401|403|auth|login|sign/i.test(message)
          ? "Sign in to Grok Build to see usage limits."
          : `Failed to read Grok usage: ${message}`))
      }),
    )
    yield* updateProvider("grok", (prev) => applyRefreshed(prev, fresh))
  })

  const lastRefreshAt = yield* Ref.make(Option.none<number>())
  const inFlight = yield* Ref.make(Option.none<Deferred.Deferred<void>>())

  // Each provider's update persists before it returns, so once all three
  // are done the cache on disk reflects this read.
  const doRefresh = Effect.all([refreshClaude(), refreshCodex(), refreshGrok()], { concurrency: "unbounded", discard: true }).pipe(
    Effect.andThen(Ref.set(lastRefreshAt, Option.some(now().getTime()))),
  )

  const refresh = Effect.fn("UsageLimits.refresh")(function* (options: { force?: boolean } = {}) {
    const lastAt = yield* Ref.get(lastRefreshAt)
    const fresh = Option.isSome(lastAt) && now().getTime() - lastAt.value < REFRESH_TTL_MS
    const done = yield* Deferred.make<void>()
    const action = yield* Ref.modify(inFlight, (current): [RefreshAction, Option.Option<Deferred.Deferred<void>>] => {
      if (Option.isSome(current)) return [{ _tag: "join", done: current.value }, current]
      if (!options.force && fresh) return [{ _tag: "skip" }, current]
      return [{ _tag: "start", done }, Option.some(done)]
    })
    yield* Match.value(action).pipe(
      Match.tagsExhaustive({
        skip: () => Effect.void,
        join: ({ done }) => Deferred.await(done),
        // The read runs in the layer's scope, not the caller's: a caller that
        // goes away does not cancel it for the others waiting on it.
        start: ({ done }) =>
          doRefresh.pipe(
            Effect.ensuring(Ref.set(inFlight, Option.none()).pipe(Effect.andThen(Deferred.succeed(done, undefined)))),
            Effect.forkIn(scope),
            Effect.andThen(Deferred.await(done)),
          ),
      }),
    )
  })

  return UsageLimits.of({
    filePath,
    snapshot: SubscriptionRef.get(ref).pipe(Effect.map(toUsageLimitsSnapshot)),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1), Stream.map(toUsageLimitsSnapshot)),
    refresh,
    recordClaudeRateLimitPush: (info) =>
      updateProvider("claude", (prev) => mergeClaudeRateLimitPush(prev, info, nowIso())),
    recordCodexRateLimitPush: (raw) =>
      updateProvider("codex", (prev) => mergeCodexRateLimitPush(prev, raw, nowIso())),
  })
})

/**
 * The state restored from the cache file: persisted windows and credits are
 * marked "cache" so the UI can show staleness. A missing or unreadable file
 * (or entry) leaves the defaults.
 */
const readCache = Effect.fn("UsageLimits.readCache")(function* (fs: FileSystem.FileSystem, filePath: string) {
  const state: Record<AgentProvider, ProviderUsageSnapshot> = { ...initialState() }
  const text = yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", (error) =>
      Effect.logWarning("Failed to load usage-limits cache:", error).pipe(Effect.as(Option.none<string>()))),
  )
  if (Option.isNone(text) || !text.value.trim()) return state

  const file = yield* decodeUsageLimitsFile(text.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SchemaError", () => Effect.succeedNone),
  )
  if (Option.isNone(file)) return state

  for (const provider of PERSISTED_PROVIDERS) {
    const persisted = decodePersistedProvider(file.value.providers?.[provider])
    if (Option.isNone(persisted)) continue
    state[provider] = {
      ...persisted.value,
      windows: persisted.value.windows?.map((window) => ({ ...window, source: "cache" as const })) ?? [],
      credits: persisted.value.credits ? { ...persisted.value.credits, source: "cache" } : null,
    }
  }
  return state
})


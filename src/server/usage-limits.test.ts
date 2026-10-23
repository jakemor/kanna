import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, type Scope, Stream } from "effect"
import { runTest } from "./effect/testing"
import { GrokUsageError } from "./grok-cli"
import {
  UsageLimits,
  type UsageLimitsDeps,
  mergeClaudeRateLimitPush,
  mergeCodexRateLimitPush,
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  normalizeGrokAccountUsage,
} from "./usage-limits"

const NOW = "2026-07-22T10:00:00.000Z"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-usage-"))
  tempDirs.push(dir)
  return path.join(dir, "usage-limits.json")
}

describe("normalizeClaudeUsage", () => {
  test("maps windows, extra usage, and plan from a get_usage response", () => {
    const snapshot = normalizeClaudeUsage(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-07-22T14:00:00Z" },
          seven_day: { utilization: 7.4, resets_at: "2026-07-28T08:00:00Z" },
          seven_day_opus: { utilization: null, resets_at: null },
          // Amounts are minor units (cents): 1250 → $12.50, 5000 → $50.00.
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: "USD", decimal_places: 2 },
        },
      },
      NOW,
    )

    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBe("max")
    expect(snapshot.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_opus"])
    expect(snapshot.windows[0]).toMatchObject({
      label: "Current session (5-hour)",
      usedPercent: 42,
      resetsAt: "2026-07-22T14:00:00Z",
      recordedAt: NOW,
      source: "on_demand",
    })
    expect(snapshot.windows[2]?.usedPercent).toBeNull()
    expect(snapshot.credits).toMatchObject({
      label: "Extra usage",
      usedPercent: 25,
      usedAmount: 12.5,
      limitAmount: 50,
      currency: "USD",
      detail: null,
    })
    expect(snapshot.updatedAt).toBe(NOW)
  })

  test("skips non-window keys and scales extra usage amounts (real response shape)", () => {
    const snapshot = normalizeClaudeUsage(
      {
        subscription_type: "team",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 2, resets_at: "2026-07-22T15:59:59+00:00" },
          seven_day: { utilization: 19, resets_at: "2026-07-27T16:59:59+00:00" },
          seven_day_opus: null,
          extra_usage: {
            is_enabled: true,
            monthly_limit: null,
            used_credits: 705180,
            utilization: null,
            currency: "USD",
            decimal_places: 2,
          },
          limits: [{ kind: "session", percent: 2 }],
          spend: { used: { amount_minor: 705180 }, percent: 0, enabled: true },
          member_dashboard_available: false,
        },
      },
      NOW,
    )

    expect(snapshot.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day"])
    // 705180 raw minor units → $7,051.80 (matches the claude.ai dashboard).
    expect(snapshot.credits?.usedAmount).toBeCloseTo(7051.8)
    expect(snapshot.credits?.limitAmount).toBeNull()
    expect(snapshot.credits?.currency).toBe("USD")
  })

  test("unknown window keys are still rendered (dynamic model buckets)", () => {
    const snapshot = normalizeClaudeUsage(
      { rate_limits_available: true, rate_limits: { seven_day_fable: { utilization: 12 } } },
      NOW,
    )
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.label).toBe("Seven Day Fable")
  })

  test("API-key sessions come back unavailable", () => {
    const snapshot = normalizeClaudeUsage({ rate_limits_available: false, rate_limits: null }, NOW)
    expect(snapshot.status).toBe("unavailable")
    expect(snapshot.windows).toHaveLength(0)
  })
})

describe("mergeClaudeRateLimitPush", () => {
  test("scales the 0-1 fraction and only touches the binding window", () => {
    const prev = normalizeClaudeUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 40, resets_at: "2026-07-22T14:00:00Z" },
          seven_day: { utilization: 10, resets_at: "2026-07-28T08:00:00Z" },
        },
      },
      "2026-07-22T09:00:00.000Z",
    )

    const merged = mergeClaudeRateLimitPush(
      prev,
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.55, resetsAt: 1784736000 },
      NOW,
    )

    const fiveHour = merged.windows.find((w) => w.id === "five_hour")
    expect(fiveHour?.usedPercent).toBeCloseTo(55)
    expect(fiveHour?.recordedAt).toBe(NOW)
    expect(fiveHour?.source).toBe("turn_push")
    // Untouched window keeps its older recordedAt (honest staleness).
    const sevenDay = merged.windows.find((w) => w.id === "seven_day")
    expect(sevenDay?.usedPercent).toBe(10)
    expect(sevenDay?.recordedAt).toBe("2026-07-22T09:00:00.000Z")
    expect(merged.updatedAt).toBe(NOW)
  })

  test("creates the window when there is no previous snapshot", () => {
    const merged = mergeClaudeRateLimitPush(null, { rateLimitType: "seven_day", utilization: 0.2 }, NOW)
    expect(merged.windows).toHaveLength(1)
    expect(merged.windows[0]).toMatchObject({ id: "seven_day", usedPercent: 20 })
  })

  test("ignores overage-only pushes", () => {
    const merged = mergeClaudeRateLimitPush(null, { rateLimitType: "overage", utilization: 0.5 }, NOW)
    expect(merged.windows).toHaveLength(0)
  })
})

describe("normalizeCodexRateLimits", () => {
  test("maps primary/secondary windows, credits, and plan", () => {
    const snapshot = normalizeCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1784736000 },
          secondary: { usedPercent: 61.5, windowDurationMins: 10080, resetsAt: 1785168000 },
          credits: { hasCredits: true, unlimited: false, balance: "$4.20" },
          planType: "pro",
        },
      },
      NOW,
    )

    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBe("pro")
    expect(snapshot.windows).toHaveLength(2)
    expect(snapshot.windows[0]).toMatchObject({
      id: "codex:primary",
      label: "5-hour",
      usedPercent: 28,
      resetsAt: new Date(1784736000 * 1000).toISOString(),
    })
    expect(snapshot.windows[1]).toMatchObject({ id: "codex:secondary", label: "Weekly", usedPercent: 61.5 })
    expect(snapshot.credits).toMatchObject({ label: "Credits", detail: "$4.20" })
  })

  test("multiple limit buckets get suffixed labels", () => {
    const snapshot = normalizeCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 10, windowDurationMins: 300 } },
          spark: { limitName: "Fast lane", primary: { usedPercent: 90, windowDurationMins: 300 } },
        },
      },
      NOW,
    )
    expect(snapshot.windows.map((w) => w.label)).toEqual(["5-hour · All models", "5-hour · Fast lane"])
  })

  test("model-id limit names run through the shared model-label formatter", () => {
    const snapshot = normalizeCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 0, windowDurationMins: 10080 } },
          codex_bengalfox: { limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 0, windowDurationMins: 10080 } },
        },
      },
      NOW,
    )
    expect(snapshot.windows.map((w) => w.label)).toEqual([
      "Weekly · All models",
      "Weekly · GPT 5.3 Codex Spark",
    ])
  })

  test("empty response is unavailable", () => {
    expect(normalizeCodexRateLimits({}, NOW).status).toBe("unavailable")
    expect(normalizeCodexRateLimits(null, NOW).status).toBe("unavailable")
  })
})

describe("mergeCodexRateLimitPush", () => {
  test("overlays pushed windows onto the previous full read", () => {
    const prev = normalizeCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1784736000 },
          secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1785168000 },
        },
      },
      "2026-07-22T09:00:00.000Z",
    )
    const merged = mergeCodexRateLimitPush(
      prev,
      { limitId: "codex", primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1784736000 } },
      NOW,
    )
    const primary = merged.windows.find((w) => w.id === "codex:primary")
    expect(primary?.usedPercent).toBe(33)
    expect(primary?.source).toBe("turn_push")
    // Secondary omitted from the push keeps the older read.
    const secondary = merged.windows.find((w) => w.id === "codex:secondary")
    expect(secondary?.usedPercent).toBe(5)
    expect(secondary?.recordedAt).toBe("2026-07-22T09:00:00.000Z")
  })
})

describe("normalizeGrokAccountUsage", () => {
  test("maps weekly product lanes and subscription tier", () => {
    const snapshot = normalizeGrokAccountUsage(
      {
        user: { subscriptionTier: "XPremiumPlus", email: "a@b.com" },
        billing: {
          config: {
            currentPeriod: { end: "2026-09-12T00:00:00Z" },
            creditUsagePercent: 6,
            productUsage: [
              { product: "GrokBuild", usagePercent: 4 },
              { product: "GrokChat", usagePercent: 1 },
            ],
            onDemandCap: { val: 0 },
            onDemandUsed: { val: 0 },
            prepaidBalance: { val: 0 },
          },
        },
      },
      NOW,
    )
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBe("XPremiumPlus")
    expect(snapshot.windows.map((window) => window.id)).toEqual(["credits", "GrokBuild", "GrokChat"])
    expect(snapshot.windows[1]).toMatchObject({
      label: "Weekly · Grok Build",
      usedPercent: 4,
      resetsAt: "2026-09-12T00:00:00Z",
    })
    expect(snapshot.credits).toBeNull()
  })
})

/** Runs `body` with a `UsageLimits` built on `filePath`, released when it returns. */
function withUsageLimits<A, E>(
  filePath: string,
  deps: UsageLimitsDeps,
  body: (usageLimits: UsageLimits["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) {
  return runTest(Effect.gen(function* () {
    return yield* body(yield* UsageLimits)
  }).pipe(Effect.provide(UsageLimits.layer(filePath, deps))))
}

describe("UsageLimits", () => {
  test("refresh applies both providers, emits, and persists", async () => {
    const filePath = await createTempFilePath()
    const deps: UsageLimitsDeps = {
      now: () => new Date(NOW),
      fetchClaudeUsage: async () => ({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42, resets_at: "2026-07-22T14:00:00Z" } },
      }),
      fetchCodexRateLimits: async () => ({
        rateLimits: { limitId: "codex", primary: { usedPercent: 28, windowDurationMins: 300 } },
      }),
    }
    const { snapshot, emitted } = await withUsageLimits(filePath, deps, (usageLimits) => Effect.gen(function* () {
      const emissions = yield* usageLimits.changes.pipe(Stream.take(2), Stream.runCount, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* usageLimits.refresh()
      return {
        snapshot: yield* usageLimits.snapshot,
        emitted: yield* Fiber.join(emissions).pipe(Effect.timeout("5 seconds")),
      }
    }))

    expect(snapshot.providers.map((p) => p.provider)).toEqual(["claude", "codex", "cursor", "grok", "pi"])
    expect(snapshot.providers[0]?.status).toBe("ok")
    expect(snapshot.providers[1]?.status).toBe("ok")
    expect(snapshot.providers[2]?.status).toBe("unavailable")
    expect(snapshot.providers[3]?.status).toBe("unknown")
    expect(snapshot.providers[4]?.status).toBe("not_applicable")
    expect(emitted).toBe(2)

    const persisted = JSON.parse(await readFile(filePath, "utf8"))
    expect(persisted.providers.claude.windows).toHaveLength(1)
  })

  test("restores the persisted snapshot marked as cache", async () => {
    const filePath = await createTempFilePath()
    await withUsageLimits(filePath, {
      now: () => new Date(NOW),
      fetchClaudeUsage: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42, resets_at: "2026-07-22T14:00:00Z" } },
      }),
    }, (usageLimits) => usageLimits.refresh())

    const snapshot = await withUsageLimits(filePath, {}, (usageLimits) => usageLimits.snapshot)
    const claude = snapshot.providers.find((p) => p.provider === "claude")
    expect(claude?.windows).toHaveLength(1)
    expect(claude?.windows[0]).toMatchObject({ usedPercent: 42, recordedAt: NOW, source: "cache" })
  })

  test("ignores a cache file that is not JSON, and a cached entry of the wrong shape", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")
    const fromInvalid = await withUsageLimits(filePath, {}, (usageLimits) => usageLimits.snapshot)
    expect(fromInvalid.providers[0]).toMatchObject({ provider: "claude", status: "unknown", windows: [] })

    await writeFile(filePath, JSON.stringify({
      version: 1,
      providers: {
        claude: { provider: "claude", status: "ok", windows: "nope" },
        codex: {
          provider: "codex", status: "ok", plan: "pro", detail: null, updatedAt: NOW, credits: null,
          windows: [{ id: "codex:primary", label: "5-hour", usedPercent: 12, resetsAt: null, recordedAt: NOW, source: "turn_push" }],
        },
      },
    }), "utf8")
    const fromMixed = await withUsageLimits(filePath, {}, (usageLimits) => usageLimits.snapshot)
    expect(fromMixed.providers[0]).toMatchObject({ provider: "claude", status: "unknown", windows: [] })
    expect(fromMixed.providers[1]?.windows).toEqual([
      { id: "codex:primary", label: "5-hour", usedPercent: 12, resetsAt: null, recordedAt: NOW, source: "cache" },
    ])
  })

  test("a failed refresh keeps last-known windows instead of wiping them", async () => {
    const filePath = await createTempFilePath()
    let fail = false
    const claude = await withUsageLimits(filePath, {
      now: () => new Date(NOW),
      fetchClaudeUsage: async () => {
        if (fail) throw new Error("probe timed out")
        return {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 42, resets_at: "2026-07-22T14:00:00Z" } },
        }
      },
    }, (usageLimits) => Effect.gen(function* () {
      yield* usageLimits.refresh()
      fail = true
      yield* usageLimits.refresh({ force: true })
      return (yield* usageLimits.snapshot).providers.find((p) => p.provider === "claude")
    }))

    expect(claude?.windows).toHaveLength(1)
    expect(claude?.windows[0]?.usedPercent).toBe(42)
    expect(claude?.detail).toContain("probe timed out")
  })

  test("refreshes grok through its Effect read, and words a refused read as a sign-in", async () => {
    const filePath = await createTempFilePath()
    let refuse = false
    const grok = await withUsageLimits(filePath, {
      now: () => new Date(NOW),
      fetchGrokUsage: () => refuse
        ? Effect.fail(new GrokUsageError({ message: "Grok billing request failed (401).", url: "https://proxy.test/billing", status: 401, cause: null }))
        : Effect.succeed({
          billing: { config: { creditUsagePercent: 6, currentPeriod: { end: "2026-09-12T00:00:00Z" } } },
          user: { subscriptionTier: "SuperGrok" },
        }),
    }, (usageLimits) => Effect.gen(function* () {
      yield* usageLimits.refresh()
      const fresh = (yield* usageLimits.snapshot).providers.find((p) => p.provider === "grok")
      refuse = true
      yield* usageLimits.refresh({ force: true })
      return { fresh, refused: (yield* usageLimits.snapshot).providers.find((p) => p.provider === "grok") }
    }))

    expect(grok.fresh).toMatchObject({ status: "ok", plan: "SuperGrok", windows: [{ id: "credits", usedPercent: 6 }] })
    // The failed read keeps the last-known windows and only says why.
    expect(grok.refused?.windows).toHaveLength(1)
    expect(grok.refused?.detail).toBe("Sign in to Grok Build to see usage limits.")
  })

  test("a grok read that fails otherwise says what failed", async () => {
    const filePath = await createTempFilePath()
    const grok = await withUsageLimits(filePath, {
      fetchGrokUsage: () => Effect.fail(new GrokUsageError({ message: "Unable to connect", url: "https://proxy.test/billing", cause: null })),
    }, (usageLimits) => usageLimits.refresh().pipe(
      Effect.andThen(usageLimits.snapshot),
      Effect.map((snapshot) => snapshot.providers.find((p) => p.provider === "grok")),
    ))
    expect(grok).toMatchObject({ status: "unavailable", detail: "Failed to read Grok usage: Unable to connect" })
  })

  test("non-forced refresh is throttled by TTL; force bypasses it", async () => {
    const filePath = await createTempFilePath()
    let fetches = 0
    await withUsageLimits(filePath, {
      now: () => new Date(NOW),
      fetchClaudeUsage: async () => {
        fetches += 1
        return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } }
      },
    }, (usageLimits) => Effect.gen(function* () {
      yield* usageLimits.refresh()
      yield* usageLimits.refresh() // within TTL → skipped
      expect(fetches).toBe(1)
      yield* usageLimits.refresh({ force: true })
      expect(fetches).toBe(2)
    }))
  })

  test("concurrent refreshes join the one in flight, even a forced one", async () => {
    const filePath = await createTempFilePath()
    let fetches = 0
    const release = Effect.runSync(Deferred.make<void>())
    await withUsageLimits(filePath, {
      now: () => new Date(NOW),
      fetchClaudeUsage: async () => {
        fetches += 1
        await Effect.runPromise(Deferred.await(release))
        return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } }
      },
    }, (usageLimits) => Effect.gen(function* () {
      const first = yield* usageLimits.refresh().pipe(Effect.forkScoped)
      const second = yield* usageLimits.refresh({ force: true }).pipe(Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }))

    expect(fetches).toBe(1)
  })

  test("pushed events update state without a prior full read", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await withUsageLimits(filePath, { now: () => new Date(NOW) }, (usageLimits) => Effect.gen(function* () {
      yield* usageLimits.recordClaudeRateLimitPush({ rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1784736000 })
      yield* usageLimits.recordCodexRateLimitPush({ limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300 } })
      return yield* usageLimits.snapshot
    }))

    const claude = snapshot.providers.find((p) => p.provider === "claude")
    const codex = snapshot.providers.find((p) => p.provider === "codex")
    expect(claude?.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 42, source: "turn_push" })
    expect(codex?.windows[0]).toMatchObject({ id: "codex:primary", usedPercent: 12, source: "turn_push" })

    const persisted = JSON.parse(await readFile(filePath, "utf8"))
    expect(persisted.providers.codex.windows[0]).toMatchObject({ id: "codex:primary", usedPercent: 12 })
  })
})


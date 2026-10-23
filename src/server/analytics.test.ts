import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LOG_PREFIX } from "../shared/branding"
import { Analytics, getLaunchAnalyticsProperties, isAnalyticsDisabledByEnv, type AnalyticsOptions } from "./analytics"
import { AppSettings } from "./app-settings"
import { makeFakeAppSettings } from "./app-settings.fake"
import { runTest } from "./effect/testing"

const originalLogAnalytics = process.env.KANNA_LOG_ANALYTICS

function restoreAnalyticsLoggingEnv() {
  if (originalLogAnalytics === undefined) {
    delete process.env.KANNA_LOG_ANALYTICS
    return
  }
  process.env.KANNA_LOG_ANALYTICS = originalLogAnalytics
}

/**
 * Runs `body` with an `Analytics` whose settings say `analyticsEnabled` for
 * user `anon_123`, then waits for every queued event to be sent.
 */
function withAnalytics(
  options: AnalyticsOptions & { analyticsEnabled?: boolean },
  body: (analytics: Analytics["Service"]) => Effect.Effect<void>,
) {
  const settings = makeFakeAppSettings(
    { analyticsEnabled: options.analyticsEnabled ?? true },
    { analyticsUserId: "anon_123" },
  )
  return runTest(Effect.gen(function* () {
    const analytics = yield* Analytics
    yield* body(analytics)
    yield* analytics.flush
  }).pipe(Effect.provide(Analytics.layer(options).pipe(Layer.provide(Layer.succeed(AppSettings, settings))))))
}

describe("getLaunchAnalyticsProperties", () => {
  test("expands launch flags into app_launch properties", () => {
    expect(getLaunchAnalyticsProperties({
      port: 4000,
      host: "0.0.0.0",
      openBrowser: false,
      share: "quick",
      password: "secret",
      strictPort: true,
    })).toEqual({
      custom_port_enabled: true,
      no_open_enabled: true,
      password_enabled: true,
      strict_port_enabled: true,
      remote_enabled: true,
      host_enabled: false,
      share_quick_enabled: true,
      share_token_enabled: false,
      cloud_enabled: false,
    })
  })

  test("cloud launches stamp cloud_enabled", () => {
    expect(getLaunchAnalyticsProperties({
      port: 3210,
      host: "127.0.0.1",
      openBrowser: true,
      share: false,
      password: null,
      strictPort: false,
      cloud: true,
    }).cloud_enabled).toBe(true)
  })
})

describe("isAnalyticsDisabledByEnv", () => {
  test("test runs, CI and explicit opt-outs disable analytics", () => {
    expect(isAnalyticsDisabledByEnv({ NODE_ENV: "test" })).toBe(true)
    expect(isAnalyticsDisabledByEnv({ CI: "true" })).toBe(true)
    expect(isAnalyticsDisabledByEnv({ CI: "1" })).toBe(true)
    expect(isAnalyticsDisabledByEnv({ KANNA_DISABLE_ANALYTICS: "1" })).toBe(true)
    expect(isAnalyticsDisabledByEnv({ DO_NOT_TRACK: "1" })).toBe(true)
  })

  test("a normal launch keeps analytics, as do falsy flag values", () => {
    expect(isAnalyticsDisabledByEnv({})).toBe(false)
    expect(isAnalyticsDisabledByEnv({ NODE_ENV: "production" })).toBe(false)
    expect(isAnalyticsDisabledByEnv({ CI: "false", DO_NOT_TRACK: "0", KANNA_DISABLE_ANALYTICS: "" })).toBe(false)
  })
})

describe("Analytics", () => {
  test("posts the userId, event name, and shared properties", async () => {
    const originalLog = console.log
    const calls: Array<{ url: string; init?: RequestInit }> = []
    console.log = () => {}

    try {
      await withAnalytics({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "dev",
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      }, (analytics) => analytics.track("message_sent"))

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://kanna.sh/api/t")
      expect(calls[0]?.init?.method).toBe("POST")
      expect(calls[0]?.init?.headers).toEqual({
        "content-type": "application/json",
      })
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        userId: "anon_123",
        environment: "dev",
        event: {
          name: "message_sent",
          properties: {
            current_version: "0.33.9",
            environment: "dev",
          },
        },
      })
    } finally {
      console.log = originalLog
    }
  })

  test("posts app_launch with launch flags as properties", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await withAnalytics({
      endpoint: "https://kanna.sh/api/t",
      currentVersion: "0.33.9",
      environment: "prod",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    }, (analytics) => analytics.trackLaunch({
      port: 4000,
      host: "localhost",
      openBrowser: false,
      share: false,
      password: null,
      strictPort: true,
    }))

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      userId: "anon_123",
      environment: "prod",
      event: {
        name: "app_launch",
        properties: {
          current_version: "0.33.9",
          environment: "prod",
          custom_port_enabled: true,
          no_open_enabled: true,
          password_enabled: false,
          strict_port_enabled: true,
          remote_enabled: false,
          host_enabled: false,
          share_quick_enabled: false,
          share_token_enabled: false,
          cloud_enabled: false,
        },
      },
    })
  })

  test("sends events one at a time, in the order they were tracked", async () => {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    await withAnalytics({
      currentVersion: "0.33.9",
      environment: "prod",
      fetchImpl: async (_url, init) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Bun.sleep(5)
        order.push((JSON.parse(String(init?.body)) as { event: { name: string } }).event.name)
        inFlight -= 1
        return new Response(null, { status: 200 })
      },
    }, (analytics) => Effect.gen(function* () {
      yield* analytics.track("first")
      yield* analytics.track("second")
      yield* analytics.track("third")
    }))

    expect(order).toEqual(["first", "second", "third"])
    expect(maxInFlight).toBe(1)
  })

  test("skips requests when analytics is disabled", async () => {
    let called = false
    await withAnalytics({
      currentVersion: "0.33.9",
      environment: "prod",
      analyticsEnabled: false,
      fetchImpl: async () => {
        called = true
        return new Response(null, { status: 200 })
      },
    }, (analytics) => analytics.track("message_sent"))

    expect(called).toBe(false)
  })

  test("does not warn when analytics request logging is disabled and the request fails", async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    delete process.env.KANNA_LOG_ANALYTICS

    try {
      await withAnalytics({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "dev",
        fetchImpl: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      }, (analytics) => analytics.track("message_sent"))

      expect(warnings).toHaveLength(0)
    } finally {
      console.warn = originalWarn
      restoreAnalyticsLoggingEnv()
    }
  })

  test("warns when analytics request logging is enabled and the request fails", async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    process.env.KANNA_LOG_ANALYTICS = "1"

    try {
      await withAnalytics({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "prod",
        fetchImpl: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      }, (analytics) => analytics.track("message_sent"))

      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.[0]).toBe(LOG_PREFIX)
      expect(warnings[0]?.[1]).toBe("Failed to send analytics event:")
      expect(warnings[0]?.[2]).toBe("message_sent")
      expect(warnings[0]?.[3]).toBeInstanceOf(Error)
      expect(warnings[0]?.[3]).toMatchObject({
        _tag: "@kanna/server/analytics/AnalyticsRequestError",
        eventName: "message_sent",
        status: 400,
      })
    } finally {
      console.warn = originalWarn
      restoreAnalyticsLoggingEnv()
    }
  })

  test("warns when the request cannot be made at all", async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    process.env.KANNA_LOG_ANALYTICS = "1"

    try {
      await withAnalytics({
        currentVersion: "0.33.9",
        environment: "prod",
        fetchImpl: async () => {
          throw new TypeError("fetch failed")
        },
      }, (analytics) => analytics.track("message_sent"))

      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.[3]).toMatchObject({
        _tag: "@kanna/server/analytics/AnalyticsRequestError",
        status: null,
      })
    } finally {
      console.warn = originalWarn
      restoreAnalyticsLoggingEnv()
    }
  })

  test("logs when analytics request logging is enabled and the request succeeds", async () => {
    const originalLog = console.log
    const logs: unknown[][] = []
    console.log = (...args: unknown[]) => {
      logs.push(args)
    }
    process.env.KANNA_LOG_ANALYTICS = "1"

    try {
      await withAnalytics({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "dev",
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }, (analytics) => analytics.track("message_sent"))

      expect(logs).toHaveLength(1)
      expect(logs[0]).toEqual([
        LOG_PREFIX,
        "Sent analytics event:",
        "message_sent",
        200,
      ])
    } finally {
      console.log = originalLog
      restoreAnalyticsLoggingEnv()
    }
  })

  test("does not log when analytics request logging is disabled and the request succeeds", async () => {
    const originalLog = console.log
    const logs: unknown[][] = []
    console.log = (...args: unknown[]) => {
      logs.push(args)
    }
    delete process.env.KANNA_LOG_ANALYTICS

    try {
      await withAnalytics({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "prod",
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }, (analytics) => analytics.track("message_sent"))

      expect(logs).toHaveLength(0)
    } finally {
      console.log = originalLog
      restoreAnalyticsLoggingEnv()
    }
  })
})

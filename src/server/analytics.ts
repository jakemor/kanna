import { Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { ANALYTICS_ENDPOINT } from "../shared/analytics"
import { PROD_SERVER_PORT } from "../shared/ports"
import type { ShareMode } from "../shared/share"
import { isTokenShareMode } from "../shared/share"
import { AppSettings } from "./app-settings"
import { Machine } from "./platform/machine"

interface AnalyticsRequestBody {
  userId: string
  environment: AnalyticsEnvironment
  event: {
    name: string
    properties: Record<string, unknown>
  }
}

export interface LaunchAnalyticsOptions {
  port: number
  host: string
  openBrowser: boolean
  share: ShareMode
  password: string | null
  strictPort: boolean
  cloud?: boolean
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type AnalyticsEnvironment = "dev" | "prod"

export interface AnalyticsOptions {
  currentVersion: string
  environment: AnalyticsEnvironment
  endpoint?: string
  fetchImpl?: FetchLike
}


/** An analytics event did not reach the endpoint. */
export class AnalyticsRequestError extends Schema.TaggedError<AnalyticsRequestError>()(
  "@kanna/server/analytics/AnalyticsRequestError",
  {
    eventName: Schema.String,
    endpoint: Schema.String,
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

/**
 * Anonymous usage events, sent when the user has analytics on (read from
 * `AppSettings` at each event). `track` returns once the event is queued:
 * events go out one at a time, in order, in the background, and a failed send
 * is dropped (logged only with `KANNA_LOG_ANALYTICS=1`).
 */
export class Analytics extends Context.Service<Analytics, {
  readonly track: (eventName: string, properties?: Record<string, unknown>) => Effect.Effect<void>
  readonly trackLaunch: (options: LaunchAnalyticsOptions) => Effect.Effect<void>
  /** Waits until every event queued so far has been sent or dropped. */
  readonly flush: Effect.Effect<void>
}>()("@kanna/server/Analytics") {
  static readonly layer = (options: AnalyticsOptions) => Layer.effect(this, makeAnalytics(options))
}

const makeAnalytics = Effect.fn("Analytics.make")(function* (options: AnalyticsOptions) {
  const settings = yield* AppSettings
  const machine = yield* Machine
  const isAnalyticsLoggingEnabled = () => machine.env.get("KANNA_LOG_ANALYTICS") === "1"
  const scope = yield* Effect.scope
  const endpoint = options.endpoint ?? ANALYTICS_ENDPOINT
  const fetchImpl = options.fetchImpl ?? fetch

  const send = Effect.fn("Analytics.send")(function* (body: AnalyticsRequestBody) {
    const eventName = body.event.name
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      }),
      catch: (cause) => new AnalyticsRequestError({ eventName, endpoint, status: null, cause }),
    })
    if (!response.ok) {
      return yield* new AnalyticsRequestError({
        eventName,
        endpoint,
        status: response.status,
        cause: new Error(`Analytics request failed with status ${response.status}`),
      })
    }
    if (isAnalyticsLoggingEnabled()) {
      yield* Effect.logInfo("Sent analytics event:", eventName, response.status)
    }
  })

  // The tail of the send chain: each event waits for the one before it, so
  // they reach the endpoint in the order they were tracked.
  const initialTail = yield* Deferred.make<void>()
  yield* Deferred.succeed(initialTail, undefined)
  const tail = yield* Ref.make(initialTail)

  const track = Effect.fn("Analytics.track")(function* (eventName: string, properties?: Record<string, unknown>) {
    const { analyticsEnabled, analyticsUserId } = yield* settings.state
    if (!analyticsEnabled || !analyticsUserId) {
      return
    }

    const body: AnalyticsRequestBody = {
      userId: analyticsUserId,
      environment: options.environment,
      event: {
        name: eventName,
        properties: {
          current_version: options.currentVersion,
          environment: options.environment,
          ...(properties ?? {}),
        },
      },
    }

    const done = yield* Deferred.make<void>()
    const previous = yield* Ref.getAndSet(tail, done)
    yield* Deferred.await(previous).pipe(
      Effect.andThen(send(body)),
      Effect.catchTag("@kanna/server/analytics/AnalyticsRequestError", (error) =>
        isAnalyticsLoggingEnabled()
          ? Effect.logWarning("Failed to send analytics event:", eventName, error)
          : Effect.void),
      Effect.ensuring(Deferred.succeed(done, undefined)),
      Effect.forkIn(scope),
    )
  })

  return Analytics.of({
    track,
    trackLaunch: (launch) => track("app_launch", getLaunchAnalyticsProperties(launch)),
    flush: Ref.get(tail).pipe(Effect.flatMap(Deferred.await)),
  })
})

export function getLaunchAnalyticsProperties(options: LaunchAnalyticsOptions) {
  return {
    custom_port_enabled: options.port !== PROD_SERVER_PORT,
    no_open_enabled: !options.openBrowser,
    password_enabled: Boolean(options.password),
    strict_port_enabled: options.strictPort,
    remote_enabled: options.host === "0.0.0.0",
    host_enabled: options.host !== "0.0.0.0" && options.host !== "127.0.0.1" && options.host !== "localhost",
    share_quick_enabled: options.share === "quick",
    share_token_enabled: isTokenShareMode(options.share),
    cloud_enabled: options.cloud ?? false,
  }
}

/** Tracks nothing: for callers (and tests) that run without analytics. */
export const NoopAnalytics: Analytics["Service"] = {
  track: () => Effect.void,
  trackLaunch: () => Effect.void,
  flush: Effect.void,
}

/**
 * Tests and CI start real servers, each with a fresh data dir and so a fresh
 * anonymous id, and every run landed in production analytics as a new install
 * that lived under a minute. `bun test` sets NODE_ENV=test and CI providers
 * set CI. KANNA_DISABLE_ANALYTICS=1 or DO_NOT_TRACK=1 covers anything else
 * that boots Kanna unattended.
 */
export function isAnalyticsDisabledByEnv(env: Record<string, string | undefined>) {
  const isSet = (value: string | undefined) => Boolean(value) && value !== "0" && value !== "false"
  return env.NODE_ENV === "test"
    || isSet(env.CI)
    || isSet(env.KANNA_DISABLE_ANALYTICS)
    || isSet(env.DO_NOT_TRACK)
}


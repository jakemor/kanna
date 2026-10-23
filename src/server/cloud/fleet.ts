/**
 * The Fleet (the account's machines) for this machine's own UI:
 * `GET /api/cloud/fleet` on localhost, for the sidebar's picker and Kanna for
 * Mac's Fleet menu. Neither has a kanna.sh session there, so the machine asks
 * the control plane with its own credentials (`GET {controlUrl}/fleet`).
 *
 * Kept outside CloudApiClient on purpose: it's the one call a UI drives, so
 * it caches, and every fake client in the tests stays as it is.
 */

import { Clock, Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import type { CloudLocalFleetResponse } from "../../shared/cloud-api"
import type { CloudIdentity } from "./identity"
import { CloudFleetResponse } from "./schemas"

/** The picker and the Mac app each poll; kanna.sh sees one call per window. */
const FLEET_CACHE_MS = 15_000

class CloudFleetRequestError extends Schema.TaggedError<CloudFleetRequestError>()(
  "@kanna/server/cloud/fleet/CloudFleetRequestError",
  {
    controlUrl: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeFleet = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudFleetResponse))

export interface CloudFleetOptions {
  fetchImpl?: typeof fetch
}

/**
 * The account's machines, cached for 15s per machine token. Calls that
 * arrive while a request is out share it. Never fails: if kanna.sh doesn't
 * answer, the Fleet is this machine alone.
 */
export class CloudFleet extends Context.Service<CloudFleet, {
  readonly get: (identity: CloudIdentity | null) => Effect.Effect<CloudLocalFleetResponse>
}>()("@kanna/server/CloudFleet") {
  static readonly layer = (options: CloudFleetOptions = {}) => Layer.effect(this, makeCloudFleet(options))
}

const makeCloudFleet = Effect.fn("CloudFleet.make")(function* (options: CloudFleetOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const scope = yield* Effect.scope
  let cached: Option.Option<{ token: string; at: number; value: CloudLocalFleetResponse }> = Option.none()
  let inflight: Option.Option<Deferred.Deferred<CloudLocalFleetResponse>> = Option.none()

  const load = Effect.fn("CloudFleet.load")(function* (identity: CloudIdentity) {
    // This machine alone, if kanna.sh doesn't answer: the picker still has
    // something true to show.
    const fallback: CloudLocalFleetResponse = { self: identity.subdomain, machines: [] }
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchImpl(`${identity.controlUrl}/fleet`, {
        headers: { Authorization: `Bearer ${identity.machineToken}`, Accept: "application/json" },
        signal,
      }),
      catch: (cause) => new CloudFleetRequestError({ controlUrl: identity.controlUrl, cause }),
    })
    if (!response.ok) return fallback
    const payload = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new CloudFleetRequestError({ controlUrl: identity.controlUrl, cause }),
    }).pipe(Effect.flatMap(decodeFleet))
    const fleet: CloudLocalFleetResponse = {
      self: payload.self ?? identity.subdomain,
      machines: [...payload.machines],
    }
    return fleet
  }, (effect, identity) => effect.pipe(
    Effect.catchTags({
      "@kanna/server/cloud/fleet/CloudFleetRequestError": () =>
        Effect.succeed<CloudLocalFleetResponse>({ self: identity.subdomain, machines: [] }),
      SchemaError: () => Effect.succeed<CloudLocalFleetResponse>({ self: identity.subdomain, machines: [] }),
    }),
  ))

  const get = Effect.fn("CloudFleet.get")(function* (identity: CloudIdentity | null) {
    if (!identity) {
      const unpaired: CloudLocalFleetResponse = { self: null, machines: [] }
      return unpaired
    }
    const now = yield* Clock.currentTimeMillis
    if (
      Option.isSome(cached) &&
      cached.value.token === identity.machineToken &&
      now - cached.value.at < FLEET_CACHE_MS
    ) {
      return cached.value.value
    }
    if (Option.isSome(inflight)) {
      return yield* Deferred.await(inflight.value)
    }

    // The request runs in the service's scope, not the caller's: a caller
    // that goes away doesn't cancel it for the others waiting on it.
    const deferred = yield* Deferred.make<CloudLocalFleetResponse>()
    inflight = Option.some(deferred)
    yield* load(identity).pipe(
      Effect.tap((value) => Clock.currentTimeMillis.pipe(
        Effect.map((at) => {
          cached = Option.some({ token: identity.machineToken, at, value })
        }),
      )),
      Effect.onExit((exit) => Effect.sync(() => {
        inflight = Option.none()
      }).pipe(Effect.andThen(Deferred.done(deferred, exit)))),
      Effect.forkIn(scope),
    )
    return yield* Deferred.await(deferred)
  })

  return { get }
})

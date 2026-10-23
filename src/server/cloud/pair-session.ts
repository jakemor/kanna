/**
 * Device-code pairing, machine side: ask the control plane for a claim code,
 * hand the URL to whoever is looking at the UI (link + QR), and poll until a
 * signed-in browser claims it. The polling lives here — not in the browser —
 * so pairing completes even if the user finishes on their phone and the tab
 * that started it is long gone.
 *
 * The api client is DI'd and time comes from Effect's Clock, so the loop is
 * testable without network or real time.
 */

import { Clock, Duration, Effect, Fiber, Option, Ref, Schedule } from "effect"
import { createCloudApiClient, describeError, type CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { Machine } from "../platform/machine"

export type PairSessionStatus = "idle" | "waiting" | "paired" | "expired" | "error"

/** The client-facing shape (served by `GET /api/cloud/pair-session`). */
export interface PairSessionSnapshot {
  status: PairSessionStatus
  /** Open this in any browser to finish pairing (also rendered as a QR). */
  claimUrl?: string
  /** Unix ms — the claim URL stops working after this. */
  expiresAt?: number
  /** Set once paired: this machine's public address. */
  appOrigin?: string
  error?: string
}

export interface PairSessionDeps<R = never> {
  /** Display name suggested to the claim form (this machine's hostname). */
  machineName: string
  /** Persist credentials + bring the machine online. Failures surface as "error". */
  onPaired: (identity: CloudIdentity) => Effect.Effect<void, Error, R>
  /** Default: the control plane, honouring the machine's control URL override. */
  createApiClient?: () => CloudApiClient
}

export interface PairSessionManager {
  /** Idempotent: reuses the live session instead of burning codes on re-open. */
  readonly start: Effect.Effect<PairSessionSnapshot>
  readonly status: Effect.Effect<PairSessionSnapshot>
  /** Stops polling. The snapshot stays as it was. */
  readonly stop: Effect.Effect<void>
}

/** Transient control-plane failures tolerated before giving up on a session. */
const MAX_CONSECUTIVE_POLL_FAILURES = 10
const FALLBACK_POLL_INTERVAL_MS = 2_000

type PollOutcome = "pending" | "done"

/**
 * A pairing session manager. Whatever `onPaired` needs is taken from the
 * caller's context now, so the poll loop can run it later on its own.
 */
export const createPairSessionManager = <R = never>(
  deps: PairSessionDeps<R>,
): Effect.Effect<PairSessionManager, never, R | Machine> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const machine = yield* Machine
    const createApiClient = deps.createApiClient ?? (() => createCloudApiClient({ env: machine.env.snapshot() }))
    const snapshot = yield* Ref.make<PairSessionSnapshot>({ status: "idle" })
    /** Bumped per session so a stale `start` can tell it has been superseded. */
    let generation = 0
    let poller: Option.Option<Fiber.Fiber<void>> = Option.none()

    const isLive = (current: PairSessionSnapshot) =>
      Clock.currentTimeMillis.pipe(Effect.map((now) =>
        current.status === "waiting" && typeof current.expiresAt === "number" && current.expiresAt > now))

    const stopPolling = Effect.suspend(() => {
      const fiber = poller
      poller = Option.none()
      return Option.isSome(fiber) ? Fiber.interrupt(fiber.value) : Effect.void
    })

    const poll = Effect.fn("PairSession.poll")(function* (
      client: CloudApiClient,
      deviceToken: string,
      pollIntervalMs: number,
      expiresAt: number,
    ) {
      const failures = yield* Ref.make(0)

      const pollOnce: Effect.Effect<PollOutcome> = Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) >= expiresAt) {
          yield* Ref.set(snapshot, { status: "expired" })
          return "done"
        }

        const result = yield* client.pollDeviceCode(deviceToken).pipe(
          Effect.tap(() => Ref.set(failures, 0)),
          Effect.map(Option.some),
          Effect.catchTags({
            "@kanna/server/cloud/api-client/CloudApiError": (error) =>
              // The session is gone for good (expired server-side, or redeemed).
              error.status === 404 || error.status === 410
                ? Ref.set(snapshot, { status: "expired" }).pipe(Effect.as(Option.none()))
                : pollFailed(error),
            "@kanna/server/cloud/api-client/CloudNetworkError": pollFailed,
          }),
        )
        if (Option.isNone(result)) return yield* Ref.get(snapshot).pipe(Effect.map(outcomeOf))
        if (result.value.status !== "claimed" || !result.value.pairing) return "pending"

        const pairing = result.value.pairing
        const identity: CloudIdentity = {
          controlUrl: client.controlUrl,
          machineToken: pairing.machineToken,
          proxySecret: pairing.proxySecret,
          subdomain: pairing.subdomain,
          appOrigin: pairing.appOrigin,
          tunnelToken: pairing.tunnelToken,
          tunnelHost: pairing.tunnelHost,
          enabled: true,
        }
        const activated = yield* Effect.result(deps.onPaired(identity).pipe(Effect.provideContext(context)))
        if (activated._tag === "Failure") {
          const error = describeError(activated.failure)
          yield* Ref.set(snapshot, { status: "error", error })
          yield* Effect.logWarning(`cloud: pairing succeeded but activation failed: ${error}`)
          return "done"
        }
        yield* Ref.set(snapshot, { status: "paired", appOrigin: pairing.appOrigin })
        yield* Effect.logInfo(`cloud: paired! this machine is now ${pairing.appOrigin}`)
        return "done"
      })

      function pollFailed(error: Error) {
        return Ref.updateAndGet(failures, (count) => count + 1).pipe(
          Effect.flatMap((count) => count >= MAX_CONSECUTIVE_POLL_FAILURES
            ? Ref.set(snapshot, { status: "error", error: error.message })
            : Effect.void),
          Effect.as(Option.none()),
        )
      }

      // Waits an interval before each poll, the first included.
      const interval = Duration.millis(pollIntervalMs)
      yield* Effect.sleep(interval)
      yield* pollOnce.pipe(
        Effect.repeat({ schedule: Schedule.spaced(interval), until: (outcome) => outcome === "done" }),
      )
    })

    const start = Effect.gen(function* () {
      const current = yield* Ref.get(snapshot)
      if (current.status === "paired" || (yield* isLive(current))) {
        return current
      }

      const session = ++generation
      yield* stopPolling
      const client = createApiClient()
      const issued = yield* client.requestDeviceCode(deps.machineName).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          "@kanna/server/cloud/api-client/CloudApiError": (error) => requestFailed(error),
          "@kanna/server/cloud/api-client/CloudNetworkError": (error) => requestFailed(error),
        }),
      )
      if (Option.isNone(issued)) return yield* Ref.get(snapshot)
      if (session !== generation) return yield* Ref.get(snapshot)

      const waiting: PairSessionSnapshot = {
        status: "waiting",
        claimUrl: issued.value.claimUrl,
        expiresAt: issued.value.expiresAt,
      }
      yield* Ref.set(snapshot, waiting)
      const fiber = yield* poll(
        client,
        issued.value.deviceToken,
        issued.value.pollIntervalMs > 0 ? issued.value.pollIntervalMs : FALLBACK_POLL_INTERVAL_MS,
        issued.value.expiresAt,
      ).pipe(Effect.forkDetach)
      poller = Option.some(fiber)
      return waiting
    }).pipe(Effect.withSpan("PairSession.start"))

    function requestFailed(error: Error) {
      return Ref.set(snapshot, { status: "error", error: error.message }).pipe(Effect.as(Option.none()))
    }

    const stop = Effect.suspend(() => {
      generation += 1
      return stopPolling
    }).pipe(Effect.withSpan("PairSession.stop"))

    const manager: PairSessionManager = { start, status: Ref.get(snapshot), stop }
    return manager
  })

function outcomeOf(snapshot: PairSessionSnapshot): PollOutcome {
  return snapshot.status === "waiting" ? "pending" : "done"
}

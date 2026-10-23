import { Effect, Layer, type Scope } from "effect"
import { ServerPlatform } from "./runtime"

/** The platform services, as the server gets them. */
export const TestPlatform = ServerPlatform

/**
 * Runs an Effect test body under `bun test`: scoped, so layers and forked
 * fibers it opens are released when the test ends, with the platform
 * services provided. Kanna keeps `bun test` rather than @effect/vitest, so
 * this stands in for `it.effect` / `it.scoped`.
 */
export const runTest = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof TestPlatform> | Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestPlatform)))

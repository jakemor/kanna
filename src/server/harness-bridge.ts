import { Effect, Exit, Scope, Stream } from "effect"
import { runKanna } from "./effect/bridge"
import type { HarnessTurn, HarnessTurnEffect } from "./harness-types"

/** Open a provider turn in its own scope without converting its stream to an iterator. */
export const openHarnessTurn = Effect.fn("Harness.openTurn")(function* <E, SE, IE, AE>(
  startTurn: Effect.Effect<HarnessTurnEffect<E, IE, AE>, SE, Scope.Scope>,
) {
  return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Scope.make()
    const turn = yield* restore(Scope.provide(startTurn, scope)).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    )
    let closed = false
    return {
      ...turn,
      close: Effect.suspend(() => {
        if (closed) return Effect.void
        closed = true
        return Scope.close(scope, Exit.void)
      }),
    }
  }))
})

/**
 * Compatibility for older tests and callers that still consume `HarnessTurn`.
 * `startTurn` runs in a scope this owns;
 * `close()` closes it, which stops the provider and ends the stream.
 *
 * The coordinator now uses `openHarnessTurn` and reads the Effect stream.
 */
export async function toHarnessTurn<E, SE, IE, AE>(
  startTurn: Effect.Effect<HarnessTurnEffect<E, IE, AE>, SE, Scope.Scope>,
): Promise<HarnessTurn> {
  const scope = await runKanna(Scope.make())
  const turn = await runKanna(Scope.provide(startTurn, scope)).catch(async (error: unknown) => {
    await runKanna(Scope.close(scope, Exit.void))
    throw error
  })
  let closed = false
  return {
    provider: turn.provider,
    stream: Stream.toAsyncIterable(turn.events),
    ...(turn.accountInfo ? { getAccountInfo: () => runKanna(turn.accountInfo!) } : {}),
    interrupt: () => runKanna(turn.interrupt),
    close: () => {
      if (closed) return
      closed = true
      void runKanna(Scope.close(scope, Exit.void))
    },
  }
}

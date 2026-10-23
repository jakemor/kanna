import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Schema, Stream } from "effect"
import { toHarnessTurn } from "./harness-bridge"
import type { HarnessEvent } from "./harness-types"

class TurnFailed extends Schema.TaggedError<TurnFailed>()("@kanna/server/harness-bridge.test/TurnFailed", {
  message: Schema.String,
}) {}

const token = (sessionToken: string): HarnessEvent => ({ type: "session_token", sessionToken })

describe("toHarnessTurn", () => {
  test("streams the turn's events and closes its scope on close()", async () => {
    let released = false
    const turn = await toHarnessTurn(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { released = true }))
      return { provider: "codex" as const, events: Stream.make(token("a"), token("b")), interrupt: Effect.void }
    }))

    const seen: string[] = []
    for await (const event of turn.stream) seen.push(event.sessionToken ?? "")
    expect(seen).toEqual(["a", "b"])
    expect(released).toBe(false)

    turn.close()
    turn.close()
    await Bun.sleep(0)
    expect(released).toBe(true)
  })

  test("throws the stream's failure from the iterator", async () => {
    const turn = await toHarnessTurn(Effect.succeed({
      provider: "grok" as const,
      events: Stream.concat(Stream.make(token("a")), Stream.fail(new TurnFailed({ message: "boom" }))),
      interrupt: Effect.void,
    }))

    const seen: string[] = []
    const failure = await (async () => {
      for await (const event of turn.stream) seen.push(event.sessionToken ?? "")
    })().then(() => null, (error: unknown) => error)
    expect(seen).toEqual(["a"])
    expect(failure).toBeInstanceOf(TurnFailed)
    turn.close()
  })

  test("releases what a failed start acquired and rethrows", async () => {
    let released = false
    const failure = await toHarnessTurn(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { released = true }))
      return yield* new TurnFailed({ message: "no session" })
    })).then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(TurnFailed)
    expect(released).toBe(true)
  })

  test("interrupt() runs the turn's interrupt and accountInfo is passed through", async () => {
    const interrupted = Effect.runSync(Deferred.make<void>())
    const turn = await toHarnessTurn(Effect.succeed({
      provider: "pi" as const,
      events: Stream.fromEffect(Deferred.await(interrupted).pipe(Effect.as(token("done")))),
      accountInfo: Effect.succeed(null),
      interrupt: Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
    }))

    expect(await turn.getAccountInfo?.()).toBeNull()
    await turn.interrupt()
    const seen: string[] = []
    for await (const event of turn.stream) seen.push(event.sessionToken ?? "")
    expect(seen).toEqual(["done"])
    turn.close()
  })
})

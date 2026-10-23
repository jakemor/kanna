import { Effect, Stream, SubscriptionRef } from "effect"
import type { KeybindingsSnapshot } from "../shared/types"
import type { Keybindings } from "./keybindings"

/** An in-memory `Keybindings` for tests that hand one to the router. */
export function makeFakeKeybindings(initial: KeybindingsSnapshot): Keybindings["Service"] {
  const ref = Effect.runSync(SubscriptionRef.make(initial))
  return {
    filePath: "/tmp/kanna-fake-keybindings.json",
    snapshot: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    reload: Effect.void,
    write: (bindings) =>
      SubscriptionRef.updateAndGet(ref, (current) => ({ ...current, bindings: bindings as KeybindingsSnapshot["bindings"] })),
  }
}

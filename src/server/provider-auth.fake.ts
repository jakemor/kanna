import { Effect, Stream, SubscriptionRef } from "effect"
import type { LlmProviderSnapshot, ProviderAuthSnapshot } from "../shared/types"
import type { ProviderAuth } from "./provider-auth"

/**
 * An in-memory `ProviderAuth` for tests that hand one to the router. Every
 * call is recorded in `calls` (`"refresh"`, `"start:gh"`, `"submit:claude:abc"`,
 * …); `setSnapshot` replaces the snapshot and emits it on `changes`. An
 * OpenRouter exchange returns `openRouterSnapshot`.
 */
export function makeFakeProviderAuth(
  initial: ProviderAuthSnapshot,
  options: { readonly openRouterSnapshot?: LlmProviderSnapshot } = {},
): {
  readonly providerAuth: ProviderAuth["Service"]
  readonly calls: string[]
  readonly setSnapshot: (snapshot: ProviderAuthSnapshot) => void
} {
  const ref = Effect.runSync(SubscriptionRef.make(initial))
  const calls: string[] = []
  const record = (call: string) => Effect.sync(() => {
    calls.push(call)
  })
  return {
    calls,
    setSnapshot: (snapshot) => Effect.runSync(SubscriptionRef.set(ref, snapshot)),
    providerAuth: {
      snapshot: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
      refresh: () => record("refresh"),
      probeService: (service) => record(`probe:${service}`),
      install: (service) => record(`install:${service}`),
      startLogin: (service) => record(`start:${service}`),
      submitLoginCode: (service, code) => record(`submit:${service}:${code}`),
      cancelLogin: (service) => record(`cancel:${service}`),
      startOpenRouterAuth: (callbackUrl) => Effect.succeed({
        authUrl: `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=x&code_challenge_method=S256`,
      }),
      exchangeOpenRouterCode: (code) => record(`exchange:${code}`).pipe(
        Effect.andThen(options.openRouterSnapshot
          ? Effect.succeed(options.openRouterSnapshot)
          : Effect.die(new Error("makeFakeProviderAuth: no openRouterSnapshot given"))),
      ),
    },
  }
}

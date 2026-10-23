import { Effect } from "effect"
import { TestPlatform } from "../effect/testing"
import type { PlatformServices } from "./index"

/**
 * The Bun platform services as a context, for tests that hand a platform to
 * plain constructors (`createWsRouter`).
 */
export const testPlatformContext = Effect.runSync(Effect.context<PlatformServices>().pipe(Effect.provide(TestPlatform)))

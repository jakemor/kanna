import { Effect } from "effect"
import type { Analytics } from "./analytics"

/** An `Analytics` that records event names in `events`, for tests that assert what was tracked. */
export function makeFakeAnalytics(): { analytics: Analytics["Service"]; events: string[] } {
  const events: string[] = []
  const track = (eventName: string) => Effect.sync(() => {
    events.push(eventName)
  })
  return {
    events,
    analytics: {
      track,
      trackLaunch: () => track("app_launch"),
      flush: Effect.void,
    },
  }
}

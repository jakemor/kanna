import { describe, expect, test } from "bun:test"
import type { AutoContinueEvent } from "./events"

describe("AutoContinueEvent", () => {
  test("covers the five lifecycle kinds", () => {
    const kinds: AutoContinueEvent["kind"][] = [
      "auto_continue_proposed",
      "auto_continue_accepted",
      "auto_continue_rescheduled",
      "auto_continue_cancelled",
      "auto_continue_fired",
    ]
    expect(kinds.length).toBe(5)
  })

  test("proposed event carries reset + tz metadata", () => {
    const event: AutoContinueEvent = {
      v: 3,
      kind: "auto_continue_proposed",
      timestamp: 1_000,
      chatId: "c1",
      scheduleId: "s1",
      detectedAt: 1_000,
      resetAt: 2_000,
      tz: "Asia/Saigon",
      turnId: "t1",
    }
    expect(event.tz).toBe("Asia/Saigon")
  })
})

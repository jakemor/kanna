import { describe, expect, test } from "bun:test"
import { deriveChatSchedules } from "./read-model"
import type { AutoContinueEvent } from "./events"

function proposed(chatId: string, scheduleId: string, at = 1_000): AutoContinueEvent {
  return {
    v: 3,
    kind: "auto_continue_proposed",
    timestamp: at,
    chatId,
    scheduleId,
    detectedAt: at,
    resetAt: at + 10_000,
    tz: "Asia/Saigon",
    turnId: "turn-1",
  }
}

function accepted(chatId: string, scheduleId: string, at = 2_000, source: "user" | "auto_setting" = "user"): AutoContinueEvent {
  return {
    v: 3,
    kind: "auto_continue_accepted",
    timestamp: at,
    chatId,
    scheduleId,
    scheduledAt: at + 10_000,
    tz: "Asia/Saigon",
    source,
    resetAt: at + 10_000,
    detectedAt: at,
  }
}

describe("deriveChatSchedules", () => {
  test("empty event list returns empty map + null live", () => {
    const result = deriveChatSchedules([])
    expect(result.schedules).toEqual({})
    expect(result.liveScheduleId).toBeNull()
  })

  test("proposed event yields state=proposed with liveScheduleId set", () => {
    const result = deriveChatSchedules([proposed("c1", "s1")])
    expect(result.schedules["s1"].state).toBe("proposed")
    expect(result.schedules["s1"].scheduledAt).toBeNull()
    expect(result.liveScheduleId).toBe("s1")
  })

  test("accept after propose promotes to scheduled", () => {
    const result = deriveChatSchedules([proposed("c1", "s1"), accepted("c1", "s1")])
    expect(result.schedules["s1"].state).toBe("scheduled")
    expect(result.schedules["s1"].scheduledAt).toBe(12_000)
    expect(result.liveScheduleId).toBe("s1")
  })

  test("accept with source=auto_setting without prior proposed still produces scheduled", () => {
    const result = deriveChatSchedules([accepted("c1", "s1", 1_500, "auto_setting")])
    expect(result.schedules["s1"].state).toBe("scheduled")
    expect(result.schedules["s1"].resetAt).toBe(11_500)
    expect(result.liveScheduleId).toBe("s1")
  })

  test("cancelled schedule is terminal and not live", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1"),
      accepted("c1", "s1"),
      { v: 3, kind: "auto_continue_cancelled", timestamp: 3_000, chatId: "c1", scheduleId: "s1", reason: "user" },
    ])
    expect(result.schedules["s1"].state).toBe("cancelled")
    expect(result.liveScheduleId).toBeNull()
  })

  test("fired schedule is terminal and retains scheduledAt", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1"),
      accepted("c1", "s1"),
      { v: 3, kind: "auto_continue_fired", timestamp: 12_000, chatId: "c1", scheduleId: "s1", firedAt: 12_000 },
    ])
    expect(result.schedules["s1"].state).toBe("fired")
    expect(result.schedules["s1"].scheduledAt).toBe(12_000)
    expect(result.liveScheduleId).toBeNull()
  })

  test("live schedule tracks most recent non-terminal", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1", 1_000),
      { v: 3, kind: "auto_continue_cancelled", timestamp: 1_100, chatId: "c1", scheduleId: "s1", reason: "user" },
      proposed("c1", "s2", 2_000),
    ])
    expect(result.schedules["s1"].state).toBe("cancelled")
    expect(result.schedules["s2"].state).toBe("proposed")
    expect(result.liveScheduleId).toBe("s2")
  })

  test("reschedule updates scheduledAt without changing state", () => {
    const result = deriveChatSchedules([
      proposed("c1", "s1"),
      accepted("c1", "s1"),
      { v: 3, kind: "auto_continue_rescheduled", timestamp: 2_500, chatId: "c1", scheduleId: "s1", scheduledAt: 20_000 },
    ])
    expect(result.schedules["s1"].state).toBe("scheduled")
    expect(result.schedules["s1"].scheduledAt).toBe(20_000)
  })

  test("events for different chats produce independent results", () => {
    const events = [proposed("c1", "s1"), proposed("c2", "s2")]
    expect(deriveChatSchedules(events, "c1").liveScheduleId).toBe("s1")
    expect(deriveChatSchedules(events, "c2").liveScheduleId).toBe("s2")
  })
})

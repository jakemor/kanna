import { describe, expect, test } from "bun:test"
import { ScheduleManager, type Clock } from "./schedule-manager"
import type { AutoContinueEvent } from "./events"

class FakeClock implements Clock {
  private current = 0
  private scheduled: Array<{ fireAt: number; fn: () => void; id: number }> = []
  private nextId = 1

  now() {
    return this.current
  }

  setTimeout(fn: () => void, delayMs: number): number {
    const id = this.nextId
    this.nextId += 1
    this.scheduled.push({ fireAt: this.current + Math.max(0, delayMs), fn, id })
    return id
  }

  clearTimeout(id: number): void {
    this.scheduled = this.scheduled.filter((entry) => entry.id !== id)
  }

  advance(ms: number) {
    this.current += ms
    const due = this.scheduled.filter((entry) => entry.fireAt <= this.current)
    this.scheduled = this.scheduled.filter((entry) => entry.fireAt > this.current)
    for (const { fn } of due) fn()
  }

  pending() {
    return this.scheduled.length
  }
}

function event(kind: AutoContinueEvent["kind"], overrides: Partial<AutoContinueEvent> = {}): AutoContinueEvent {
  const base = { v: 3 as const, timestamp: 0, chatId: "c1", scheduleId: "s1" }
  switch (kind) {
    case "auto_continue_proposed":
      return { ...base, kind, detectedAt: 0, resetAt: 1_000, tz: "UTC", turnId: "t1", ...overrides } as AutoContinueEvent
    case "auto_continue_accepted":
      return { ...base, kind, scheduledAt: 1_000, tz: "UTC", source: "user", resetAt: 1_000, detectedAt: 0, ...overrides } as AutoContinueEvent
    case "auto_continue_rescheduled":
      return { ...base, kind, scheduledAt: 2_000, ...overrides } as AutoContinueEvent
    case "auto_continue_cancelled":
      return { ...base, kind, reason: "user", ...overrides } as AutoContinueEvent
    case "auto_continue_fired":
      return { ...base, kind, firedAt: 1_000, ...overrides } as AutoContinueEvent
  }
}

describe("ScheduleManager", () => {
  test("proposed event does not arm a timer", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (chatId, scheduleId) => { fired.push(`${chatId}:${scheduleId}`) },
    })
    manager.onEvent(event("auto_continue_proposed"))
    expect(clock.pending()).toBe(0)
    expect(fired).toEqual([])
  })

  test("accepted event arms a timer that fires at scheduledAt", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (chatId, scheduleId) => { fired.push(`${chatId}:${scheduleId}`) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    expect(clock.pending()).toBe(1)
    clock.advance(1_000)
    expect(fired).toEqual(["c1:s1"])
  })

  test("rescheduled replaces the pending timer", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    manager.onEvent(event("auto_continue_rescheduled", { scheduledAt: 3_000 }))
    clock.advance(1_000)
    expect(fired).toEqual([])
    clock.advance(2_000)
    expect(fired).toEqual(["s1"])
  })

  test("cancelled clears the pending timer", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    manager.onEvent(event("auto_continue_cancelled"))
    clock.advance(1_000)
    expect(fired).toEqual([])
  })

  test("rehydrate arms future schedules and fires past-due ones", async () => {
    const clock = new FakeClock()
    clock.advance(5_000)
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.rehydrate([
      event("auto_continue_accepted", { scheduleId: "past", scheduledAt: 1_000 }),
      event("auto_continue_accepted", { scheduleId: "future", scheduledAt: 10_000 }),
    ])
    await Promise.resolve()
    expect(fired).toEqual(["past"])
    expect(clock.pending()).toBe(1)
    clock.advance(5_000)
    expect(fired).toEqual(["past", "future"])
  })

  test("rehydrate skips terminal states", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.rehydrate([
      event("auto_continue_accepted", { scheduleId: "done", scheduledAt: 1_000 }),
      event("auto_continue_fired", { scheduleId: "done" }),
      event("auto_continue_accepted", { scheduleId: "cancelled", scheduledAt: 1_000 }),
      event("auto_continue_cancelled", { scheduleId: "cancelled" }),
    ])
    clock.advance(10_000)
    expect(fired).toEqual([])
  })

  test("firing a timer does not double-fire on subsequent events", () => {
    const clock = new FakeClock()
    const fired: string[] = []
    const manager = new ScheduleManager({
      clock,
      fire: async (_, id) => { fired.push(id) },
    })
    manager.onEvent(event("auto_continue_accepted", { scheduledAt: 1_000 }))
    clock.advance(1_000)
    manager.onEvent(event("auto_continue_fired"))
    expect(fired).toEqual(["s1"])
  })
})

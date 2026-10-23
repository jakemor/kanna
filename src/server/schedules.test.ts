import { describe, expect, test } from "bun:test"
import type { ChatSchedule } from "../shared/types"
import { Effect, Exit, Result, Scope } from "effect"
import {
  computeFirstRun,
  computeNextRun,
  makeScheduleRunner,
  MAX_RECORDED_RUNS,
  MIN_SCHEDULE_INTERVAL_MS,
  parseTimeOfDay,
  type ScheduleFireResult,
} from "./schedules"
import { runTest } from "./effect/testing"

const HOUR = 60 * 60 * 1_000

function schedule(overrides: Partial<ChatSchedule> = {}): ChatSchedule {
  return {
    id: "s1",
    name: "Check",
    content: "check the deploy",
    target: { kind: "chat", chatId: "chat-1" },
    trigger: { kind: "interval", everyMs: HOUR },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 1_000,
    runCount: 0,
    ...overrides,
  }
}

function memoryStore(initial: ChatSchedule[]) {
  const byId = new Map(initial.map((entry) => [entry.id, entry]))
  return {
    byId,
    listSchedules: () => [...byId.values()],
    getSchedule: (id: string) => byId.get(id) ?? null,
    setSchedule: (next: ChatSchedule) => Effect.sync(() => {
      byId.set(next.id, next)
      return next
    }),
  }
}

/**
 * A runner in a scope of its own, driven from Promise test code. `fire`
 * stays an async function, adapted the way the orchestrator adapts its own.
 */
function makeTestRunner(deps: {
  store: ReturnType<typeof memoryStore>
  now?: () => number
  fire: (schedule: ChatSchedule) => Promise<ScheduleFireResult>
  onError?: (schedule: ChatSchedule, error: unknown) => void
}) {
  const scope = Effect.runSync(Scope.make())
  const runner = Effect.runSync(Scope.provide(makeScheduleRunner({
    ...deps,
    fire: (entry) => Effect.tryPromise({ try: () => deps.fire(entry), catch: (error) => error }),
  }), scope))
  return {
    tick: () => Effect.runPromise(runner.tick),
    dispose: () => Effect.runSync(Scope.close(scope, Exit.void)),
  }
}

describe("computeNextRun", () => {
  test("a one-shot runs once, and never after its time", () => {
    expect(computeNextRun({ kind: "once", at: 5_000 }, 1_000)).toBe(5_000)
    expect(computeNextRun({ kind: "once", at: 5_000 }, 5_000)).toBeNull()
  })

  test("a new one-shot keeps a time that has just passed", () => {
    expect(computeFirstRun({ kind: "once", at: 900 }, 1_000)).toBe(900)
  })

  test("an interval counts from the run, and has a floor", () => {
    expect(computeNextRun({ kind: "interval", everyMs: HOUR }, 10_000)).toBe(10_000 + HOUR)
    expect(computeNextRun({ kind: "interval", everyMs: 5 }, 10_000)).toBe(10_000 + MIN_SCHEDULE_INTERVAL_MS)
  })

  test("a daily time picks today when it is still ahead, else tomorrow", () => {
    const morning = new Date(2026, 0, 5, 8, 0, 0).getTime()
    const evening = new Date(2026, 0, 5, 20, 0, 0).getTime()
    expect(computeNextRun({ kind: "daily", timeOfDay: "09:30" }, morning)).toBe(new Date(2026, 0, 5, 9, 30, 0).getTime())
    expect(computeNextRun({ kind: "daily", timeOfDay: "09:30" }, evening)).toBe(new Date(2026, 0, 6, 9, 30, 0).getTime())
  })

  test("weekdays skip to the next listed day", () => {
    // 2026-01-05 is a Monday. Only Wednesdays (3) are listed.
    const monday = new Date(2026, 0, 5, 12, 0, 0).getTime()
    expect(computeNextRun({ kind: "daily", timeOfDay: "09:00", weekdays: [3] }, monday))
      .toBe(new Date(2026, 0, 7, 9, 0, 0).getTime())
    // On the day itself, after the time: a week on.
    const wednesdayNoon = new Date(2026, 0, 7, 12, 0, 0).getTime()
    expect(computeNextRun({ kind: "daily", timeOfDay: "09:00", weekdays: [3] }, wednesdayNoon))
      .toBe(new Date(2026, 0, 14, 9, 0, 0).getTime())
  })

  test("rejects a malformed time of day", () => {
    expect(parseTimeOfDay("25:00")).toBeNull()
    expect(parseTimeOfDay("9am")).toBeNull()
    expect(parseTimeOfDay("9:05")).toEqual({ hours: 9, minutes: 5 })
    expect(computeNextRun({ kind: "daily", timeOfDay: "nope" }, 0)).toBeNull()
  })
})

describe("ScheduleRunner", () => {
  test("a long absence runs a schedule once, not once per missed slot", async () => {
    const store = memoryStore([schedule({ nextRunAt: 1_000 })])
    const fired: string[] = []
    // Ten intervals late.
    const now = 1_000 + 10 * HOUR
    const runner = makeTestRunner({
      store,
      now: () => now,
      fire: async (entry) => {
        fired.push(entry.id)
        return { outcome: "sent", chatId: "chat-1" }
      },
    })
    await runner.tick()
    await runner.tick()
    runner.dispose()
    expect(fired).toEqual(["s1"])
    expect(store.byId.get("s1")).toMatchObject({ runCount: 1, nextRunAt: now + HOUR, lastRunAt: now, lastRunChatId: "chat-1" })
  })

  test("a one-shot turns itself off after it runs", async () => {
    const store = memoryStore([schedule({ trigger: { kind: "once", at: 1_000 } })])
    const runner = makeTestRunner({ store, now: () => 2_000, fire: async () => ({ outcome: "sent", chatId: "chat-1" }) })
    await runner.tick()
    runner.dispose()
    expect(store.byId.get("s1")).toMatchObject({ enabled: false, nextRunAt: null, runCount: 1 })
  })

  test("maxRuns ends a repeating schedule, and a skipped run does not count", async () => {
    const store = memoryStore([schedule({ maxRuns: 2 })])
    let now = 1_000
    const results: ScheduleFireResult[] = [{ outcome: "skipped" }, { outcome: "sent", chatId: "c" }, { outcome: "sent", chatId: "c" }]
    const runner = makeTestRunner({ store, now: () => now, fire: async () => results.shift()! })
    await runner.tick()
    expect(store.byId.get("s1")).toMatchObject({ runCount: 0, enabled: true })
    now += HOUR
    await runner.tick()
    expect(store.byId.get("s1")).toMatchObject({ runCount: 1, enabled: true })
    now += HOUR
    await runner.tick()
    runner.dispose()
    expect(store.byId.get("s1")).toMatchObject({ runCount: 2, enabled: false, nextRunAt: null })
  })

  test("each run is remembered with how it went, up to a limit", async () => {
    const store = memoryStore([schedule()])
    let now = 1_000
    const results: Array<ScheduleFireResult | Error> = [
      { outcome: "sent", chatId: "c1" },
      { outcome: "skipped" },
      new Error("provider missing"),
    ]
    const runner = makeTestRunner({
      store,
      now: () => now,
      fire: async () => {
        const next = results.shift()!
        if (next instanceof Error) throw next
        return next
      },
    })
    for (let run = 0; run < 3; run += 1) {
      await runner.tick()
      now += HOUR
    }
    expect(store.byId.get("s1")?.runs).toEqual([
      { at: 1_000, outcome: "sent", chatId: "c1" },
      { at: 1_000 + HOUR, outcome: "skipped" },
      { at: 1_000 + 2 * HOUR, outcome: "failed" },
    ])

    // Old runs drop off the front, so the record cannot grow without end.
    results.push(...Array.from({ length: MAX_RECORDED_RUNS + 5 }, (): ScheduleFireResult => ({ outcome: "sent", chatId: "c" })))
    for (let run = 0; run < MAX_RECORDED_RUNS + 5; run += 1) {
      await runner.tick()
      now += HOUR
    }
    runner.dispose()
    const runs = store.byId.get("s1")!.runs!
    expect(runs).toHaveLength(MAX_RECORDED_RUNS)
    expect(runs[runs.length - 1]).toEqual({ at: now - HOUR, outcome: "sent", chatId: "c" })
  })

  test("a schedule whose target is gone turns itself off", async () => {
    const store = memoryStore([schedule()])
    const runner = makeTestRunner({ store, now: () => 5_000, fire: async () => ({ outcome: "gone" }) })
    await runner.tick()
    runner.dispose()
    expect(store.byId.get("s1")).toMatchObject({ enabled: false, nextRunAt: null, runCount: 0 })
  })

  test("a failed run still moves on to the next slot", async () => {
    const store = memoryStore([schedule()])
    const errors: unknown[] = []
    const runner = makeTestRunner({
      store,
      now: () => 5_000,
      fire: async () => { throw new Error("provider missing") },
      onError: (_entry, error) => errors.push(error),
    })
    await runner.tick()
    runner.dispose()
    expect(errors).toHaveLength(1)
    expect(store.byId.get("s1")).toMatchObject({ enabled: true, nextRunAt: 5_000 + HOUR, runCount: 0 })
  })

  test("paused and not-yet-due schedules do not run", async () => {
    const store = memoryStore([
      schedule({ id: "paused", enabled: false }),
      schedule({ id: "later", nextRunAt: 9_999_999 }),
    ])
    const fired: string[] = []
    const runner = makeTestRunner({
      store,
      now: () => 5_000,
      fire: async (entry) => {
        fired.push(entry.id)
        return { outcome: "sent", chatId: "c" }
      },
    })
    await runner.tick()
    runner.dispose()
    expect(fired).toEqual([])
  })

  test("onError gets the error the run threw", async () => {
    const store = memoryStore([schedule()])
    const thrown = new Error("provider missing")
    const errors: unknown[] = []
    const runner = makeTestRunner({ store, now: () => 5_000, fire: async () => { throw thrown }, onError: (_entry, error) => errors.push(error) })
    await runner.tick()
    runner.dispose()
    expect(errors).toEqual([thrown])
  })

  test("the timer fires a due schedule once started, and not before", async () => {
    const fired = await runTest(Effect.gen(function* () {
      const store = memoryStore([schedule({ nextRunAt: 0 })])
      const fired: string[] = []
      const runner = yield* makeScheduleRunner({
        store,
        fire: (entry) => Effect.sync(() => {
          fired.push(entry.id)
          return { outcome: "sent", chatId: "c" } as const
        }),
      })
      yield* Effect.sleep("30 millis")
      expect(fired).toEqual([])
      yield* runner.start
      yield* Effect.sleep("30 millis")
      return fired
    }))
    expect(fired).toEqual(["s1"])
  })

  test("closing the scope stops the timer", async () => {
    const fired: string[] = []
    await runTest(Effect.gen(function* () {
      const store = memoryStore([schedule({ nextRunAt: Date.now() + 40 })])
      const runner = yield* makeScheduleRunner({
        store,
        fire: (entry) => Effect.sync(() => {
          fired.push(entry.id)
          return { outcome: "sent", chatId: "c" } as const
        }),
      })
      yield* runner.start
    }))
    await Bun.sleep(80)
    expect(fired).toEqual([])
  })

  test("a schedule that cannot be written back fails the pass", async () => {
    const result = await runTest(Effect.gen(function* () {
      const store = memoryStore([schedule()])
      const runner = yield* makeScheduleRunner({
        store: { ...store, setSchedule: () => Effect.fail("disk full" as const) },
        now: () => 5_000,
        fire: () => Effect.succeed({ outcome: "skipped" } as const),
      })
      return yield* Effect.result(runner.tick)
    }))
    expect(Result.isFailure(result) && result.failure).toBe("disk full")
  })
})

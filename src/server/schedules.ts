import { Cause, Effect, Exit, type Fiber, type Scope } from "effect"
import type { ChatSchedule, ScheduleRun, ScheduleTrigger } from "../shared/types"

/** A schedule fires no more often than this. An agent's typo should not start a chat every second. */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000

/**
 * The longest a single timer is armed for. `setTimeout` overflows past about
 * 24.8 days and fires at once, and a machine that slept wakes with its timers
 * late, so the runner re-reads the clock at least this often.
 */
const MAX_TIMER_MS = 60 * 60 * 1_000

/** How many past runs a schedule remembers. */
export const MAX_RECORDED_RUNS = 20

export function parseTimeOfDay(timeOfDay: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return { hours, minutes }
}

/** When `trigger` fires next, strictly after `after`. Null when it never will again. */
export function computeNextRun(trigger: ScheduleTrigger, after: number): number | null {
  if (trigger.kind === "once") return trigger.at > after ? trigger.at : null
  if (trigger.kind === "interval") return after + Math.max(MIN_SCHEDULE_INTERVAL_MS, trigger.everyMs)

  const time = parseTimeOfDay(trigger.timeOfDay)
  if (!time) return null
  const weekdays = trigger.weekdays?.length ? new Set(trigger.weekdays) : null
  const candidate = new Date(after)
  // Eight days covers "the same weekday, next week" when today's slot has passed.
  for (let day = 0; day < 8; day += 1) {
    // Set on every step, not once: a daylight-saving change moves the wall
    // clock, and the schedule follows the wall clock.
    candidate.setHours(time.hours, time.minutes, 0, 0)
    if (candidate.getTime() > after && (!weekdays || weekdays.has(candidate.getDay()))) {
      return candidate.getTime()
    }
    candidate.setDate(candidate.getDate() + 1)
  }
  return null
}

/**
 * The first run of a new schedule. A one-shot keeps its own time even when
 * that has passed, so "at 9:00" set at 9:00:02 still runs.
 */
export function computeFirstRun(trigger: ScheduleTrigger, now: number): number | null {
  return trigger.kind === "once" ? trigger.at : computeNextRun(trigger, now)
}

/** `sent` names the chat the message went to. `skipped` and `gone` send nothing. */
export type ScheduleFireResult =
  | { outcome: "sent"; chatId: string }
  /** The previous run is still going. */
  | { outcome: "skipped" }
  /** The chat or project it targets no longer exists. */
  | { outcome: "gone" }

export interface ScheduleRunnerDeps<E = never, FireError = never> {
  store: {
    listSchedules: () => ChatSchedule[]
    getSchedule: (scheduleId: string) => ChatSchedule | null
    setSchedule: (schedule: ChatSchedule) => Effect.Effect<ChatSchedule, E>
  }
  /** A failure here is a failed run (`onError`), not a failed pass. */
  fire: (schedule: ChatSchedule) => Effect.Effect<ScheduleFireResult, FireError>
  onFired?: (schedule: ChatSchedule, result: ScheduleFireResult) => void
  onError?: (schedule: ChatSchedule, error: unknown) => void
  now?: () => number
}

/**
 * Fires due schedules off one timer, armed for the earliest of them.
 *
 * The next run is always computed from the time of firing, never from the
 * time it was due. A machine that was off or asleep for a week runs each
 * schedule once when it comes back, not once per missed slot.
 */
export interface ScheduleRunner<E = never> {
  /** Arms the timer. Nothing fires before this. */
  readonly start: Effect.Effect<void>
  /** Call after a schedule is created, changed or deleted. */
  readonly refresh: Effect.Effect<void>
  /**
   * Fires everything due now. Exposed so tests need no real timers. Fails
   * only when writing a schedule back fails.
   */
  readonly tick: Effect.Effect<void, E>
}

/**
 * A runner that stops when its scope closes: the timer is cleared and no
 * pass starts after that. A pass already firing finishes, as its message may
 * be on its way and the schedule has to record that it ran.
 */
export const makeScheduleRunner = Effect.fn("ScheduleRunner.make")(function* <E = never, FireError = never>(
  deps: ScheduleRunnerDeps<E, FireError>,
): Effect.fn.Return<ScheduleRunner<E>, never, Scope.Scope> {
  // Detached, not scoped: closing the scope must not wait on (or cut short)
  // a pass in flight. The finalizer below is what stops the timer.
  let timer: Fiber.Fiber<void> | null = null
  let ticking = false
  let disposed = false
  const now = () => deps.now?.() ?? Date.now()

  const runOne = Effect.fnUntraced(function* (listed: ChatSchedule, at: number) {
    // Read again: an earlier schedule in this pass may have run long
    // enough for this one to be changed or deleted.
    const schedule = deps.store.getSchedule(listed.id)
    if (!schedule?.enabled || schedule.nextRunAt == null || schedule.nextRunAt > at) return

    const fired = yield* Effect.exit(Effect.suspend(() => deps.fire(schedule)))
    const failed = Exit.isFailure(fired)
    if (Exit.isFailure(fired)) deps.onError?.(schedule, Cause.squash(fired.cause))
    const result: ScheduleFireResult = Exit.isSuccess(fired) ? fired.value : { outcome: "skipped" }

    // A skipped run does not count against `maxRuns`: nothing was sent.
    const runCount = schedule.runCount + (result.outcome === "sent" ? 1 : 0)
    const exhausted = schedule.maxRuns != null && runCount >= schedule.maxRuns
    const nextRunAt = result.outcome === "gone" || exhausted ? null : computeNextRun(schedule.trigger, at)
    const current = deps.store.getSchedule(schedule.id)
    if (!current) return
    yield* deps.store.setSchedule({
      ...current,
      runCount,
      nextRunAt,
      // Nothing left to run reads as off, so a list shows it as finished.
      enabled: nextRunAt != null,
      ...(result.outcome === "sent" ? { lastRunAt: at, lastRunChatId: result.chatId } : {}),
      // A target that is gone ends the schedule; it is not a run.
      ...(result.outcome === "gone" ? {} : {
        runs: [...(current.runs ?? []), {
          at,
          outcome: failed ? "failed" : result.outcome,
          ...(result.outcome === "sent" ? { chatId: result.chatId } : {}),
        } satisfies ScheduleRun].slice(-MAX_RECORDED_RUNS),
      }),
    })
    deps.onFired?.(schedule, result)
  })

  const tick: Effect.Effect<void, E> = Effect.suspend(() => {
    if (ticking || disposed) return Effect.void
    ticking = true
    const at = now()
    const due = deps.store.listSchedules()
      .filter((schedule) => schedule.enabled && schedule.nextRunAt != null && schedule.nextRunAt <= at)
    return Effect.forEach(due, (listed) => runOne(listed, at), { discard: true }).pipe(
      Effect.ensuring(Effect.suspend(() => {
        ticking = false
        return arm
      })),
    )
  }).pipe(Effect.withSpan("ScheduleRunner.tick"))

  const arm: Effect.Effect<void> = Effect.suspend(() => {
    timer?.interruptUnsafe()
    timer = null
    if (disposed) return Effect.void
    let earliest: number | null = null
    for (const schedule of deps.store.listSchedules()) {
      if (!schedule.enabled || schedule.nextRunAt == null) continue
      if (earliest == null || schedule.nextRunAt < earliest) earliest = schedule.nextRunAt
    }
    if (earliest == null) return Effect.void
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - now()))
    return Effect.sleep(delay).pipe(
      // No longer the timer once it fires: the pass re-arms, and must not
      // interrupt the fiber it is running on.
      Effect.andThen(Effect.sync(() => { timer = null })),
      Effect.andThen(tick.pipe(
        Effect.catchCause((cause) => Effect.logWarning("A schedule pass failed:", Cause.squash(cause))),
      )),
      Effect.forkDetach,
      Effect.map((fiber) => { timer = fiber }),
    )
  })

  yield* Effect.addFinalizer(() => Effect.sync(() => {
    disposed = true
    timer?.interruptUnsafe()
    timer = null
  }))

  return {
    start: arm,
    // A pass in progress arms the timer itself when it ends.
    refresh: Effect.suspend(() => ticking ? Effect.void : arm),
    tick,
  }
})

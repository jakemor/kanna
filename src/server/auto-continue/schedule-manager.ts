import type { AutoContinueEvent } from "./events"
import { deriveChatSchedules } from "./read-model"

export interface Clock {
  now(): number
  setTimeout(fn: () => void, delayMs: number): number
  clearTimeout(id: number): void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
}

export interface ScheduleManagerArgs {
  clock?: Clock
  fire: (chatId: string, scheduleId: string) => Promise<void>
  onError?: (error: unknown) => void
}

export class ScheduleManager {
  private readonly clock: Clock
  private readonly fireFn: ScheduleManagerArgs["fire"]
  private readonly onError: (error: unknown) => void
  private readonly timers = new Map<string, number>()
  private readonly pendingByScheduleId = new Map<string, { chatId: string; scheduledAt: number }>()

  constructor(args: ScheduleManagerArgs) {
    this.clock = args.clock ?? realClock
    this.fireFn = args.fire
    this.onError = args.onError ?? ((error) => console.error("[kanna/schedule-manager]", error))
  }

  rehydrate(events: readonly AutoContinueEvent[]) {
    const byChat = new Map<string, AutoContinueEvent[]>()
    for (const event of events) {
      const list = byChat.get(event.chatId) ?? []
      list.push(event)
      byChat.set(event.chatId, list)
    }
    for (const [chatId, chatEvents] of byChat.entries()) {
      const projection = deriveChatSchedules(chatEvents, chatId)
      for (const schedule of Object.values(projection.schedules)) {
        if (schedule.state !== "scheduled") continue
        if (schedule.scheduledAt === null) continue
        this.arm(chatId, schedule.scheduleId, schedule.scheduledAt)
      }
    }
  }

  onEvent(event: AutoContinueEvent) {
    switch (event.kind) {
      case "auto_continue_proposed":
        return
      case "auto_continue_accepted":
        this.arm(event.chatId, event.scheduleId, event.scheduledAt)
        return
      case "auto_continue_rescheduled":
        this.arm(event.chatId, event.scheduleId, event.scheduledAt)
        return
      case "auto_continue_cancelled":
      case "auto_continue_fired":
        this.clear(event.scheduleId)
        return
      default: {
        const _exhaustive: never = event
        void _exhaustive
        return
      }
    }
  }

  private arm(chatId: string, scheduleId: string, scheduledAt: number) {
    this.clear(scheduleId)
    this.pendingByScheduleId.set(scheduleId, { chatId, scheduledAt })
    const delay = scheduledAt - this.clock.now()

    const run = async () => {
      this.timers.delete(scheduleId)
      this.pendingByScheduleId.delete(scheduleId)
      try {
        await this.fireFn(chatId, scheduleId)
      } catch (error) {
        this.onError(error)
      }
    }

    // Past-due schedules fire out-of-band via microtask rather than clock.setTimeout.
    // This keeps clock.pending() reflecting only genuinely future timers.
    if (delay <= 0) {
      void Promise.resolve().then(run)
      return
    }

    const timerId = this.clock.setTimeout(() => { void run() }, delay)
    this.timers.set(scheduleId, timerId)
  }

  private clear(scheduleId: string) {
    const timerId = this.timers.get(scheduleId)
    if (timerId !== undefined) {
      this.clock.clearTimeout(timerId)
      this.timers.delete(scheduleId)
    }
    this.pendingByScheduleId.delete(scheduleId)
  }

  shutdown() {
    for (const timerId of this.timers.values()) {
      this.clock.clearTimeout(timerId)
    }
    this.timers.clear()
    this.pendingByScheduleId.clear()
  }
}

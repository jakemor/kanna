import type { AutoContinueSchedule } from "../../shared/types"
import type { AutoContinueEvent } from "./events"

export interface ChatSchedulesProjection {
  schedules: Record<string, AutoContinueSchedule>
  liveScheduleId: string | null
}

const EMPTY: ChatSchedulesProjection = { schedules: {}, liveScheduleId: null }

export function deriveChatSchedules(
  events: readonly AutoContinueEvent[],
  chatId?: string
): ChatSchedulesProjection {
  const schedules: Record<string, AutoContinueSchedule> = {}
  for (const event of events) {
    if (chatId && event.chatId !== chatId) continue
    applyOne(schedules, event)
  }

  let liveScheduleId: string | null = null
  let liveOrder = -1
  let order = 0
  for (const event of events) {
    order += 1
    if (chatId && event.chatId !== chatId) continue
    const schedule = schedules[event.scheduleId]
    if (!schedule) continue
    if (schedule.state !== "proposed" && schedule.state !== "scheduled") continue
    if (order > liveOrder) {
      liveOrder = order
      liveScheduleId = schedule.scheduleId
    }
  }

  return schedules === EMPTY.schedules && liveScheduleId === null
    ? EMPTY
    : { schedules, liveScheduleId }
}

function applyOne(schedules: Record<string, AutoContinueSchedule>, event: AutoContinueEvent): void {
  switch (event.kind) {
    case "auto_continue_proposed":
      schedules[event.scheduleId] = {
        scheduleId: event.scheduleId,
        state: "proposed",
        scheduledAt: null,
        tz: event.tz,
        resetAt: event.resetAt,
        detectedAt: event.detectedAt,
      }
      return
    case "auto_continue_accepted":
      schedules[event.scheduleId] = {
        scheduleId: event.scheduleId,
        state: "scheduled",
        scheduledAt: event.scheduledAt,
        tz: event.tz,
        resetAt: event.resetAt,
        detectedAt: event.detectedAt,
      }
      return
    case "auto_continue_rescheduled": {
      const existing = schedules[event.scheduleId]
      if (!existing) return
      schedules[event.scheduleId] = { ...existing, scheduledAt: event.scheduledAt }
      return
    }
    case "auto_continue_cancelled": {
      const existing = schedules[event.scheduleId]
      if (!existing) return
      schedules[event.scheduleId] = { ...existing, state: "cancelled" }
      return
    }
    case "auto_continue_fired": {
      const existing = schedules[event.scheduleId]
      if (!existing) {
        schedules[event.scheduleId] = {
          scheduleId: event.scheduleId,
          state: "fired",
          scheduledAt: event.firedAt,
          tz: "system",
          resetAt: event.firedAt,
          detectedAt: event.firedAt,
        }
        return
      }
      schedules[event.scheduleId] = { ...existing, state: "fired", scheduledAt: event.firedAt }
      return
    }
  }
}

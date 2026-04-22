export type AutoContinueEvent =
  | {
      v: 3
      kind: "auto_continue_proposed"
      timestamp: number
      chatId: string
      scheduleId: string
      detectedAt: number
      resetAt: number
      tz: string
      turnId: string
    }
  | {
      v: 3
      kind: "auto_continue_accepted"
      timestamp: number
      chatId: string
      scheduleId: string
      scheduledAt: number
      tz: string
      source: "user" | "auto_setting"
      resetAt: number
      detectedAt: number
    }
  | {
      v: 3
      kind: "auto_continue_rescheduled"
      timestamp: number
      chatId: string
      scheduleId: string
      scheduledAt: number
    }
  | {
      v: 3
      kind: "auto_continue_cancelled"
      timestamp: number
      chatId: string
      scheduleId: string
      reason: "user" | "chat_deleted"
    }
  | {
      v: 3
      kind: "auto_continue_fired"
      timestamp: number
      chatId: string
      scheduleId: string
      firedAt: number
    }

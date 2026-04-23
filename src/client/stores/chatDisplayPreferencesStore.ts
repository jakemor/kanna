import { create } from "zustand"
import { persist } from "zustand/middleware"

export const DEFAULT_SHOW_TOKEN_COUNT = true
export const DEFAULT_SHOW_ELAPSED_TIME = true
export const DEFAULT_MIN_ELAPSED_TIME_MS = 1_000
export const MIN_MIN_ELAPSED_TIME_MS = 0
export const MAX_MIN_ELAPSED_TIME_MS = 10_000

export const DEFAULT_MIN_TURN_DISPLAY_MS = 60_000
export const MIN_MIN_TURN_DISPLAY_MS = 0
export const MAX_MIN_TURN_DISPLAY_MS = 600_000

function clampMinElapsedTime(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_MIN_ELAPSED_TIME_MS
  return Math.min(MAX_MIN_ELAPSED_TIME_MS, Math.max(MIN_MIN_ELAPSED_TIME_MS, Math.round(value)))
}

function clampMinTurnDisplay(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_MIN_TURN_DISPLAY_MS
  return Math.min(MAX_MIN_TURN_DISPLAY_MS, Math.max(MIN_MIN_TURN_DISPLAY_MS, Math.round(value)))
}

export interface ChatDisplayPreferencesState {
  showTokenCount: boolean
  showElapsedTime: boolean
  minElapsedTimeMs: number
  minTurnDisplayMs: number
  setShowTokenCount: (value: boolean) => void
  setShowElapsedTime: (value: boolean) => void
  setMinElapsedTimeMs: (value: number) => void
  setMinTurnDisplayMs: (value: number) => void
}

export const useChatDisplayPreferencesStore = create<ChatDisplayPreferencesState>()(
  persist(
    (set) => ({
      showTokenCount: DEFAULT_SHOW_TOKEN_COUNT,
      showElapsedTime: DEFAULT_SHOW_ELAPSED_TIME,
      minElapsedTimeMs: DEFAULT_MIN_ELAPSED_TIME_MS,
      minTurnDisplayMs: DEFAULT_MIN_TURN_DISPLAY_MS,
      setShowTokenCount: (value) => set({ showTokenCount: value }),
      setShowElapsedTime: (value) => set({ showElapsedTime: value }),
      setMinElapsedTimeMs: (value) => set({ minElapsedTimeMs: clampMinElapsedTime(value) }),
      setMinTurnDisplayMs: (value) => set({ minTurnDisplayMs: clampMinTurnDisplay(value) }),
    }),
    {
      name: "chat-display-preferences",
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as Partial<ChatDisplayPreferencesState> | undefined
        return {
          showTokenCount: typeof state?.showTokenCount === "boolean" ? state.showTokenCount : DEFAULT_SHOW_TOKEN_COUNT,
          showElapsedTime: typeof state?.showElapsedTime === "boolean" ? state.showElapsedTime : DEFAULT_SHOW_ELAPSED_TIME,
          minElapsedTimeMs: clampMinElapsedTime(state?.minElapsedTimeMs ?? DEFAULT_MIN_ELAPSED_TIME_MS),
          minTurnDisplayMs: clampMinTurnDisplay(state?.minTurnDisplayMs ?? DEFAULT_MIN_TURN_DISPLAY_MS),
        }
      },
    }
  )
)

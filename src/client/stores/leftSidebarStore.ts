import { create } from "zustand"
import { persist } from "zustand/middleware"

export const DEFAULT_LEFT_SIDEBAR_WIDTH_PX = 315
export const LEFT_SIDEBAR_MIN_WIDTH_PX = 240
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 520

interface LeftSidebarState {
  widthPx: number
  setWidth: (widthPx: number) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function clampLeftSidebarWidth(widthPx: number) {
  if (!Number.isFinite(widthPx)) return DEFAULT_LEFT_SIDEBAR_WIDTH_PX
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH_PX, Math.max(LEFT_SIDEBAR_MIN_WIDTH_PX, Math.round(widthPx)))
}

export function migrateLeftSidebarStore(persistedState: unknown) {
  if (!isRecord(persistedState)) {
    return { widthPx: DEFAULT_LEFT_SIDEBAR_WIDTH_PX }
  }

  return {
    widthPx: clampLeftSidebarWidth(
      typeof persistedState.widthPx === "number" ? persistedState.widthPx : DEFAULT_LEFT_SIDEBAR_WIDTH_PX
    ),
  }
}

export const useLeftSidebarStore = create<LeftSidebarState>()(
  persist(
    (set) => ({
      widthPx: DEFAULT_LEFT_SIDEBAR_WIDTH_PX,
      setWidth: (widthPx) => set({ widthPx: clampLeftSidebarWidth(widthPx) }),
    }),
    {
      name: "left-sidebar-layout",
      version: 1,
      migrate: migrateLeftSidebarStore,
    }
  )
)

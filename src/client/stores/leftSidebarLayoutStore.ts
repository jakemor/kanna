import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface LeftSidebarLayout {
  size: number
}

interface LeftSidebarLayoutState {
  layout: LeftSidebarLayout
  setSize: (size: number) => void
}

export const LEFT_SIDEBAR_MIN_WIDTH_PX = 225
export const LEFT_SIDEBAR_MAX_WIDTH_PX = 480
export const DEFAULT_LEFT_SIDEBAR_SIZE = 18
export const LEFT_SIDEBAR_MIN_SIZE_PERCENT = 5
export const LEFT_SIDEBAR_MAX_SIZE_PERCENT = 50

function clampSize(size: number) {
  if (!Number.isFinite(size)) return DEFAULT_LEFT_SIDEBAR_SIZE
  return Math.max(LEFT_SIDEBAR_MIN_SIZE_PERCENT, Math.min(LEFT_SIDEBAR_MAX_SIZE_PERCENT, size))
}

export function migrateLeftSidebarLayoutStore(persistedState: unknown) {
  if (!persistedState || typeof persistedState !== "object") {
    return { layout: { size: DEFAULT_LEFT_SIDEBAR_SIZE } }
  }

  const state = persistedState as { layout?: Partial<LeftSidebarLayout> }
  return {
    layout: {
      size: clampSize(state.layout?.size ?? DEFAULT_LEFT_SIDEBAR_SIZE),
    },
  }
}

export const useLeftSidebarLayoutStore = create<LeftSidebarLayoutState>()(
  persist(
    (set) => ({
      layout: { size: DEFAULT_LEFT_SIDEBAR_SIZE },
      setSize: (size) => set({ layout: { size: clampSize(size) } }),
    }),
    {
      name: "left-sidebar-layout",
      version: 1,
      migrate: migrateLeftSidebarLayoutStore,
    }
  )
)

export const DEFAULT_LEFT_SIDEBAR_LAYOUT: LeftSidebarLayout = {
  size: DEFAULT_LEFT_SIDEBAR_SIZE,
}

export function getDefaultLeftSidebarLayout() {
  return { ...DEFAULT_LEFT_SIDEBAR_LAYOUT }
}

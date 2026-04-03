import { create } from "zustand"
import { persist } from "zustand/middleware"

interface TaskPanelState {
  isVisible: boolean
  /** Task explicitly chosen by the user (null = auto-select newest). */
  selectedTaskId: string | null
  /** Whether the user has manually picked a task in this panel session. */
  hasUserSelected: boolean
  mainSizes: [number, number]
  toggleVisibility: () => void
  setVisible: (visible: boolean) => void
  /** User explicitly selects a task — opens the panel and remembers the choice. */
  selectTask: (taskId: string | null) => void
  /** Open panel without an explicit selection — auto-selects newest. */
  openPanel: () => void
  setMainSizes: (sizes: [number, number]) => void
}

export const useTaskPanelStore = create<TaskPanelState>()(
  persist(
    (set, get) => ({
      isVisible: false,
      selectedTaskId: null,
      hasUserSelected: false,
      mainSizes: [70, 30],
      toggleVisibility: () => {
        const { isVisible } = get()
        if (isVisible) {
          // Closing — reset user selection so next open auto-selects newest
          set({ isVisible: false, hasUserSelected: false, selectedTaskId: null })
        } else {
          // Opening — don't set selectedTaskId, let the panel auto-select
          set({ isVisible: true, hasUserSelected: false, selectedTaskId: null })
        }
      },
      setVisible: (visible) => {
        if (!visible) {
          set({ isVisible: false, hasUserSelected: false, selectedTaskId: null })
        } else {
          set({ isVisible: true })
        }
      },
      selectTask: (taskId) => set({ selectedTaskId: taskId, hasUserSelected: true, isVisible: true }),
      openPanel: () => set({ isVisible: true, hasUserSelected: false, selectedTaskId: null }),
      setMainSizes: (sizes) => set({ mainSizes: sizes }),
    }),
    { name: "task-panel" }
  )
)

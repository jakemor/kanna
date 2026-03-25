import { create } from "zustand"
import { persist } from "zustand/middleware"

interface FeatureSettingsState {
  folderGroupsEnabled: boolean
  kanbanStatusesEnabled: boolean
  commitKannaDirectory: boolean
  setFolderGroupsEnabled: (enabled: boolean) => void
  setKanbanStatusesEnabled: (enabled: boolean) => void
  setCommitKannaDirectory: (enabled: boolean) => void
}

export const useFeatureSettingsStore = create<FeatureSettingsState>()(
  persist(
    (set) => ({
      folderGroupsEnabled: false,
      kanbanStatusesEnabled: true,
      commitKannaDirectory: true,
      setFolderGroupsEnabled: (enabled) => set({ folderGroupsEnabled: enabled }),
      setKanbanStatusesEnabled: (enabled) => set({ kanbanStatusesEnabled: enabled }),
      setCommitKannaDirectory: (enabled) => set({ commitKannaDirectory: enabled }),
    }),
    {
      name: "feature-settings",
    }
  )
)

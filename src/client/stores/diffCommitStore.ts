import { create } from "zustand"
import { persist } from "zustand/middleware"

interface DiffCommitState {
  checkedPathsByProjectId: Record<string, Record<string, boolean>>
  reconcileProject: (projectId: string, paths: string[]) => void
  setChecked: (projectId: string, path: string, checked: boolean) => void
  setAllChecked: (projectId: string, paths: string[], checked: boolean) => void
}

export const useDiffCommitStore = create<DiffCommitState>()(
  persist(
    (set) => ({
      checkedPathsByProjectId: {},
      reconcileProject: (projectId, paths) => set((state) => {
        const current = state.checkedPathsByProjectId[projectId] ?? {}
        const next = Object.fromEntries(paths.map((path) => [path, current[path] ?? true]))
        if (
          Object.keys(current).length === Object.keys(next).length
          && Object.entries(next).every(([path, checked]) => current[path] === checked)
        ) {
          return state
        }
        return {
          checkedPathsByProjectId: {
            ...state.checkedPathsByProjectId,
            [projectId]: next,
          },
        }
      }),
      setChecked: (projectId, path, checked) => set((state) => ({
        checkedPathsByProjectId: {
          ...state.checkedPathsByProjectId,
          [projectId]: {
            ...(state.checkedPathsByProjectId[projectId] ?? {}),
            [path]: checked,
          },
        },
      })),
      setAllChecked: (projectId, paths, checked) => set((state) => ({
        checkedPathsByProjectId: {
          ...state.checkedPathsByProjectId,
          [projectId]: {
            ...(state.checkedPathsByProjectId[projectId] ?? {}),
            ...Object.fromEntries(paths.map((path) => [path, checked])),
          },
        },
      })),
    }),
    {
      name: "diff-commit-selections",
      version: 2,
    }
  )
)

import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface ProjectRightSidebarLayout {
  isVisible: boolean
  size: number
}

interface RightSidebarState {
  projects: Record<string, ProjectRightSidebarLayout>
  toggleVisibility: (projectId: string) => void
  setSize: (projectId: string, size: number) => void
  clearProject: (projectId: string) => void
}

export const RIGHT_SIDEBAR_MIN_SIZE_PERCENT = 20
export const RIGHT_SIDEBAR_MAX_SIZE_PERCENT = 50
export const DEFAULT_RIGHT_SIDEBAR_SIZE = 30
export const RIGHT_SIDEBAR_MIN_WIDTH_PX = 300

function clampSize(size: number) {
  if (!Number.isFinite(size)) return DEFAULT_RIGHT_SIDEBAR_SIZE
  return Math.min(RIGHT_SIDEBAR_MAX_SIZE_PERCENT, Math.max(RIGHT_SIDEBAR_MIN_SIZE_PERCENT, size))
}

function createDefaultProjectLayout(): ProjectRightSidebarLayout {
  return {
    isVisible: false,
    size: RIGHT_SIDEBAR_MIN_SIZE_PERCENT,
  }
}

function getProjectLayout(projects: Record<string, ProjectRightSidebarLayout>, projectId: string): ProjectRightSidebarLayout {
  return projects[projectId] ?? createDefaultProjectLayout()
}

export function migrateRightSidebarStore(persistedState: unknown) {
  if (!persistedState || typeof persistedState !== "object") {
    return { projects: {} }
  }

  const state = persistedState as { projects?: Record<string, Partial<ProjectRightSidebarLayout>> }
  const projects = Object.fromEntries(
    Object.entries(state.projects ?? {}).map(([projectId, layout]) => [
      projectId,
      {
        isVisible: false,
        size: clampSize(layout.size ?? DEFAULT_RIGHT_SIDEBAR_SIZE),
      },
    ])
  )

  return { projects }
}

export const useRightSidebarStore = create<RightSidebarState>()(
  persist(
    (set) => ({
      projects: {},
      toggleVisibility: (projectId) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: {
              ...getProjectLayout(state.projects, projectId),
              isVisible: !getProjectLayout(state.projects, projectId).isVisible,
            },
          },
        })),
      setSize: (projectId, size) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: {
              ...getProjectLayout(state.projects, projectId),
              size: clampSize(size),
            },
          },
        })),
      clearProject: (projectId) =>
        set((state) => {
          const { [projectId]: _removed, ...rest } = state.projects
          return { projects: rest }
        }),
    }),
    {
      name: "right-sidebar-layouts",
      version: 2,
      migrate: migrateRightSidebarStore,
    }
  )
)

export const DEFAULT_PROJECT_RIGHT_SIDEBAR_LAYOUT: ProjectRightSidebarLayout = {
  isVisible: false,
  size: RIGHT_SIDEBAR_MIN_SIZE_PERCENT,
}

export function getDefaultProjectRightSidebarLayout() {
  return {
    ...DEFAULT_PROJECT_RIGHT_SIDEBAR_LAYOUT,
  }
}

import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface ProjectRightSidebarVisibilityState {
  rightPanel: "hidden" | "git" | "browser"
}

export interface ProjectRightSidebarUiState {
  viewMode: "changes" | "history"
  collapsedPaths: Record<string, boolean>
  summary: string
  description: string
}

export interface ProjectBrowserPanelState {
  address: string
  history: string[]
  historyIndex: number
  zoom: number
}

interface RightSidebarState {
  size: number
  projects: Record<string, ProjectRightSidebarVisibilityState>
  projectUi: Record<string, ProjectRightSidebarUiState>
  projectBrowser: Record<string, ProjectBrowserPanelState>
  togglePanel: (projectId: string, panel: Exclude<ProjectRightSidebarVisibilityState["rightPanel"], "hidden">) => void
  hidePanel: (projectId: string) => void
  setSize: (size: number) => void
  navigateBrowser: (projectId: string, address: string) => void
  setBrowserZoom: (projectId: string, zoom: number) => void
  reconcileCollapsedPaths: (projectId: string, paths: string[]) => void
  toggleCollapsedPath: (projectId: string, path: string) => void
  setViewMode: (projectId: string, viewMode: ProjectRightSidebarUiState["viewMode"]) => void
  setCommitDraft: (projectId: string, draft: Pick<ProjectRightSidebarUiState, "summary" | "description">) => void
  clearCommitDraft: (projectId: string) => void
  clearProject: (projectId: string) => void
}

export const DEFAULT_RIGHT_SIDEBAR_SIZE = 420
export const RIGHT_SIDEBAR_MIN_WIDTH_PX = 370

function clampSize(size: number) {
  if (!Number.isFinite(size)) return DEFAULT_RIGHT_SIDEBAR_SIZE
  return Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, size)
}

function createDefaultProjectVisibilityState(): ProjectRightSidebarVisibilityState {
  return {
    rightPanel: "hidden",
  }
}

function createDefaultProjectUiState(): ProjectRightSidebarUiState {
  return {
    viewMode: "history",
    collapsedPaths: {},
    summary: "",
    description: "",
  }
}

function createDefaultProjectBrowserState(): ProjectBrowserPanelState {
  return {
    address: "",
    history: [],
    historyIndex: -1,
    zoom: 1,
  }
}

function normalizeBrowserAddress(address: string) {
  const trimmed = address.trim()
  if (!trimmed) return ""
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function clampZoom(zoom: number) {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(2, Math.max(0.5, Math.round(zoom * 10) / 10))
}

function getProjectVisibilityState(
  projects: Record<string, ProjectRightSidebarVisibilityState>,
  projectId: string
): ProjectRightSidebarVisibilityState {
  return projects[projectId] ?? createDefaultProjectVisibilityState()
}

function getProjectBrowserState(
  projectBrowser: Record<string, ProjectBrowserPanelState>,
  projectId: string
): ProjectBrowserPanelState {
  return projectBrowser[projectId] ?? createDefaultProjectBrowserState()
}

export function migrateRightSidebarStore(persistedState: unknown) {
  if (!persistedState || typeof persistedState !== "object") {
    return { size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, projectBrowser: {} }
  }

  const state = persistedState as {
    size?: number
    projects?: Record<string, Partial<{ isVisible: boolean, rightPanel: ProjectRightSidebarVisibilityState["rightPanel"], size: number }>>
    projectUi?: Record<string, ProjectRightSidebarUiState>
    projectBrowser?: Record<string, Partial<ProjectBrowserPanelState>>
  }
  const projects = Object.fromEntries(
    Object.entries(state.projects ?? {}).map(([projectId, layout]) => [
      projectId,
      {
        rightPanel: layout.rightPanel ?? (layout.isVisible ? "git" : "hidden"),
      },
    ])
  )

  const projectBrowser = Object.fromEntries(
    Object.entries(state.projectBrowser ?? {}).map(([projectId, browserState]) => {
      const address = normalizeBrowserAddress(browserState.address ?? "")
      const history = (browserState.history ?? []).map(normalizeBrowserAddress).filter(Boolean)
      const historyIndex = Math.min(history.length - 1, Math.max(-1, browserState.historyIndex ?? (history.length - 1)))
      return [
        projectId,
        {
          address,
          history,
          historyIndex,
          zoom: clampZoom(browserState.zoom ?? 1),
        },
      ]
    })
  )

  return { size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects, projectUi: state.projectUi ?? {}, projectBrowser }
}

export const useRightSidebarStore = create<RightSidebarState>()(
  persist(
    (set) => ({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {},
      projectUi: {},
      projectBrowser: {},
      togglePanel: (projectId, panel) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: {
              ...getProjectVisibilityState(state.projects, projectId),
              rightPanel: getProjectVisibilityState(state.projects, projectId).rightPanel === panel ? "hidden" : panel,
            },
          },
        })),
      hidePanel: (projectId) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: {
              ...getProjectVisibilityState(state.projects, projectId),
              rightPanel: "hidden",
            },
          },
        })),
      setSize: (size) => set({ size: clampSize(size) }),
      navigateBrowser: (projectId, address) => set((state) => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const nextAddress = normalizeBrowserAddress(address)
        if (!nextAddress) {
          return {
            projectBrowser: {
              ...state.projectBrowser,
              [projectId]: {
                ...current,
                address: "",
              },
            },
          }
        }

        if (current.address === nextAddress) return state

        const previousHistory = current.history.slice(0, current.historyIndex + 1)
        const history = previousHistory[previousHistory.length - 1] === nextAddress
          ? previousHistory
          : [...previousHistory, nextAddress]

        return {
          projectBrowser: {
            ...state.projectBrowser,
            [projectId]: {
              ...current,
              address: nextAddress,
              history,
              historyIndex: history.length - 1,
            },
          },
        }
      }),
      setBrowserZoom: (projectId, zoom) => set((state) => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const nextZoom = clampZoom(zoom)
        if (current.zoom === nextZoom) return state
        return {
          projectBrowser: {
            ...state.projectBrowser,
            [projectId]: {
              ...current,
              zoom: nextZoom,
            },
          },
        }
      }),
      reconcileCollapsedPaths: (projectId, paths) => set((state) => {
        const current = state.projectUi[projectId] ?? createDefaultProjectUiState()
        const nextCollapsedPaths = Object.fromEntries(paths.map((path) => [path, current.collapsedPaths[path] ?? true]))
        if (
          Object.keys(current.collapsedPaths).length === Object.keys(nextCollapsedPaths).length
          && Object.entries(nextCollapsedPaths).every(([path, collapsed]) => current.collapsedPaths[path] === collapsed)
        ) {
          return state
        }
        return {
          projectUi: {
            ...state.projectUi,
            [projectId]: {
              ...current,
              collapsedPaths: nextCollapsedPaths,
            },
          },
        }
      }),
      toggleCollapsedPath: (projectId, path) => set((state) => {
        const current = state.projectUi[projectId] ?? createDefaultProjectUiState()
        return {
          projectUi: {
            ...state.projectUi,
            [projectId]: {
              ...current,
              collapsedPaths: {
                ...current.collapsedPaths,
                [path]: !(current.collapsedPaths[path] ?? true),
              },
            },
          },
        }
      }),
      setViewMode: (projectId, viewMode) => set((state) => {
        const current = state.projectUi[projectId] ?? createDefaultProjectUiState()
        if (current.viewMode === viewMode) return state
        return {
          projectUi: {
            ...state.projectUi,
            [projectId]: {
              ...current,
              viewMode,
            },
          },
        }
      }),
      setCommitDraft: (projectId, draft) => set((state) => {
        const current = state.projectUi[projectId] ?? createDefaultProjectUiState()
        if (current.summary === draft.summary && current.description === draft.description) return state
        return {
          projectUi: {
            ...state.projectUi,
            [projectId]: {
              ...current,
              summary: draft.summary,
              description: draft.description,
            },
          },
        }
      }),
      clearCommitDraft: (projectId) => set((state) => {
        const current = state.projectUi[projectId] ?? createDefaultProjectUiState()
        if (!current.summary && !current.description) return state
        return {
          projectUi: {
            ...state.projectUi,
            [projectId]: {
              ...current,
              summary: "",
              description: "",
            },
          },
        }
      }),
      clearProject: (projectId) =>
        set((state) => {
          const { [projectId]: _removedLayout, ...restProjects } = state.projects
          const { [projectId]: _removedUi, ...restProjectUi } = state.projectUi
          const { [projectId]: _removedBrowser, ...restProjectBrowser } = state.projectBrowser
          return { projects: restProjects, projectUi: restProjectUi, projectBrowser: restProjectBrowser }
        }),
    }),
    {
      name: "right-sidebar-layouts",
      version: 7,
      migrate: migrateRightSidebarStore,
    }
  )
)

export const DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE: ProjectRightSidebarVisibilityState = {
  rightPanel: "hidden",
}

export function getDefaultRightSidebarVisibilityState() {
  return {
    ...DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE,
  }
}

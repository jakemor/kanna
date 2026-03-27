import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface TerminalPaneLayout {
  id: string
  title: string
  size: number
}

export interface ProjectTerminalLayout {
  isVisible: boolean
  mainSizes: [number, number]
  terminals: TerminalPaneLayout[]
  nextTerminalIndex: number
}

interface TerminalLayoutState {
  projects: Record<string, ProjectTerminalLayout>
  addTerminal: (projectId: string, afterTerminalId?: string) => void
  removeTerminal: (projectId: string, terminalId: string) => void
  toggleVisibility: (projectId: string) => void
  resetMainSizes: (projectId: string) => void
  setMainSizes: (projectId: string, sizes: number[]) => void
  setTerminalSizes: (projectId: string, sizes: number[]) => void
  clearProject: (projectId: string) => void
}

export const DEFAULT_TERMINAL_MAIN_SIZES: [number, number] = [68, 32]

function createDefaultProjectLayout(): ProjectTerminalLayout {
  return {
    isVisible: false,
    mainSizes: [...DEFAULT_TERMINAL_MAIN_SIZES],
    terminals: [],
    nextTerminalIndex: 0,
  }
}

function getProjectLayout(projects: Record<string, ProjectTerminalLayout>, projectId: string): ProjectTerminalLayout {
  return projects[projectId] ?? createDefaultProjectLayout()
}

function normalizeSizes(values: number[]): number[] {
  if (values.length === 0) return []
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0)
  if (!Number.isFinite(total) || total <= 0) {
    return Array.from({ length: values.length }, () => 100 / values.length)
  }
  return values.map((value) => (Math.max(value, 0) / total) * 100)
}

function labelForTerminalIndex(index: number): string {
  let value = index
  let suffix = ""
  do {
    suffix = String.fromCharCode(65 + (value % 26)) + suffix
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return `Terminal ${suffix}`
}

function scaleForAdditionalTerminal(terminals: TerminalPaneLayout[]): TerminalPaneLayout[] {
  if (terminals.length === 0) return terminals
  const nextCount = terminals.length + 1
  return terminals.map((terminal) => ({
    ...terminal,
    size: (terminal.size * terminals.length) / nextCount,
  }))
}

function withProjectLayout(
  projects: Record<string, ProjectTerminalLayout>,
  projectId: string,
  update: (layout: ProjectTerminalLayout) => ProjectTerminalLayout
) {
  return {
    ...projects,
    [projectId]: update(getProjectLayout(projects, projectId)),
  }
}

export const useTerminalLayoutStore = create<TerminalLayoutState>()(
  persist(
    (set) => ({
      projects: {},
      addTerminal: (projectId, afterTerminalId) =>
        set((state) => ({
          projects: withProjectLayout(state.projects, projectId, (layout) => {
            const existing = scaleForAdditionalTerminal(layout.terminals)
            const nextTerminal: TerminalPaneLayout = {
              id: globalThis.crypto?.randomUUID?.() ?? `terminal-${Date.now()}-${layout.nextTerminalIndex}`,
              title: labelForTerminalIndex(layout.nextTerminalIndex),
              size: 100 / (existing.length + 1),
            }
            const insertIndex = afterTerminalId
              ? Math.max(existing.findIndex((terminal) => terminal.id === afterTerminalId) + 1, 0)
              : existing.length
            return {
              ...layout,
              isVisible: true,
              nextTerminalIndex: layout.nextTerminalIndex + 1,
              terminals: [
                ...existing.slice(0, insertIndex),
                nextTerminal,
                ...existing.slice(insertIndex),
              ],
            }
          }),
        })),
      removeTerminal: (projectId, terminalId) =>
        set((state) => ({
          projects: withProjectLayout(state.projects, projectId, (layout) => {
            const remaining = layout.terminals.filter((terminal) => terminal.id !== terminalId)
            if (remaining.length === 0) {
              return {
                ...layout,
                isVisible: false,
                terminals: [],
              }
            }
            const normalizedSizes = normalizeSizes(remaining.map((terminal) => terminal.size))
            return {
              ...layout,
              terminals: remaining.map((terminal, index) => ({
                ...terminal,
                size: normalizedSizes[index] ?? 100 / remaining.length,
              })),
            }
          }),
        })),
      toggleVisibility: (projectId) =>
        set((state) => ({
          projects: withProjectLayout(state.projects, projectId, (layout) => ({
            ...layout,
            isVisible: layout.terminals.length > 0 ? !layout.isVisible : false,
          })),
        })),
      resetMainSizes: (projectId) =>
        set((state) => ({
          projects: withProjectLayout(state.projects, projectId, (layout) => ({
            ...layout,
            mainSizes: [...DEFAULT_TERMINAL_MAIN_SIZES],
          })),
        })),
      setMainSizes: (projectId, sizes) =>
        set((state) => {
          if (sizes.length !== 2) return state
          const normalized = normalizeSizes(sizes) as [number, number]
          return {
            projects: withProjectLayout(state.projects, projectId, (layout) => ({
              ...layout,
              mainSizes: normalized,
            })),
          }
        }),
      setTerminalSizes: (projectId, sizes) =>
        set((state) => ({
          projects: withProjectLayout(state.projects, projectId, (layout) => {
            if (sizes.length !== layout.terminals.length) return layout
            const normalizedSizes = normalizeSizes(sizes)
            return {
              ...layout,
              terminals: layout.terminals.map((terminal, index) => ({
                ...terminal,
                size: normalizedSizes[index] ?? terminal.size,
              })),
            }
          }),
        })),
      clearProject: (projectId) =>
        set((state) => {
          const { [projectId]: _removed, ...rest } = state.projects
          return { projects: rest }
        }),
    }),
    {
      name: "terminal-layouts",
      version: 1,
    }
  )
)

export const DEFAULT_PROJECT_TERMINAL_LAYOUT: ProjectTerminalLayout = {
  isVisible: false,
  mainSizes: [...DEFAULT_TERMINAL_MAIN_SIZES],
  terminals: [],
  nextTerminalIndex: 0,
}

export function getDefaultProjectTerminalLayout() {
  return {
    ...DEFAULT_PROJECT_TERMINAL_LAYOUT,
    mainSizes: [...DEFAULT_PROJECT_TERMINAL_LAYOUT.mainSizes],
    terminals: [],
  }
}

import { create } from "zustand"
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware"

const MAX_PROJECTS = 20
const STORAGE_KEY = "diff-commit-selections"

interface DiffCommitState {
  checkedPathsByProjectId: Record<string, Record<string, boolean>>
  projectOrder: string[]
  reconcileProject: (projectId: string, paths: string[]) => void
  setChecked: (projectId: string, path: string, checked: boolean) => void
  setAllChecked: (projectId: string, paths: string[], checked: boolean) => void
}

const isQuotaError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  return err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED"
}

const touchOrder = (order: string[], projectId: string): string[] => {
  if (order[order.length - 1] === projectId) return order
  const filtered = order.filter((id) => id !== projectId)
  filtered.push(projectId)
  return filtered
}

const evictStale = (
  paths: Record<string, Record<string, boolean>>,
  order: string[]
): { paths: Record<string, Record<string, boolean>>; order: string[] } => {
  if (order.length <= MAX_PROJECTS) return { paths, order }
  const dropCount = order.length - MAX_PROJECTS
  const dropped = new Set(order.slice(0, dropCount))
  const nextOrder = order.slice(dropCount)
  const nextPaths: Record<string, Record<string, boolean>> = {}
  for (const [id, value] of Object.entries(paths)) {
    if (!dropped.has(id)) nextPaths[id] = value
  }
  return { paths: nextPaths, order: nextOrder }
}

const quotaSafeStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  removeItem: (name) => localStorage.removeItem(name),
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value)
      return
    } catch (err) {
      if (!isQuotaError(err)) throw err
    }
    try {
      const parsed = JSON.parse(value) as {
        state?: { projectOrder?: string[]; checkedPathsByProjectId?: Record<string, Record<string, boolean>> }
      }
      const state = parsed?.state
      if (state?.projectOrder?.length && state.checkedPathsByProjectId) {
        while (state.projectOrder.length > 1) {
          const oldest = state.projectOrder.shift()
          if (oldest) delete state.checkedPathsByProjectId[oldest]
          try {
            localStorage.setItem(name, JSON.stringify(parsed))
            return
          } catch (retryErr) {
            if (!isQuotaError(retryErr)) throw retryErr
          }
        }
      }
    } catch {
      // fall through to last-resort clear
    }
    try {
      localStorage.removeItem(name)
    } catch {
      // give up silently — the in-memory store still works
    }
  },
}

export const useDiffCommitStore = create<DiffCommitState>()(
  persist(
    (set) => ({
      checkedPathsByProjectId: {},
      projectOrder: [],
      reconcileProject: (projectId, paths) => set((state) => {
        const current = state.checkedPathsByProjectId[projectId] ?? {}
        const next = Object.fromEntries(paths.map((path) => [path, current[path] ?? true]))
        const pathsUnchanged =
          Object.keys(current).length === Object.keys(next).length
          && Object.entries(next).every(([path, checked]) => current[path] === checked)
        const isMostRecent = state.projectOrder[state.projectOrder.length - 1] === projectId
        if (pathsUnchanged && isMostRecent) return state
        const nextPathsMap = pathsUnchanged
          ? state.checkedPathsByProjectId
          : { ...state.checkedPathsByProjectId, [projectId]: next }
        const nextOrder = touchOrder(state.projectOrder, projectId)
        const evicted = evictStale(nextPathsMap, nextOrder)
        return {
          checkedPathsByProjectId: evicted.paths,
          projectOrder: evicted.order,
        }
      }),
      setChecked: (projectId, path, checked) => set((state) => {
        const nextProjectPaths = {
          ...(state.checkedPathsByProjectId[projectId] ?? {}),
          [path]: checked,
        }
        const nextOrder = touchOrder(state.projectOrder, projectId)
        const evicted = evictStale(
          { ...state.checkedPathsByProjectId, [projectId]: nextProjectPaths },
          nextOrder
        )
        return {
          checkedPathsByProjectId: evicted.paths,
          projectOrder: evicted.order,
        }
      }),
      setAllChecked: (projectId, paths, checked) => set((state) => {
        const nextProjectPaths = {
          ...(state.checkedPathsByProjectId[projectId] ?? {}),
          ...Object.fromEntries(paths.map((path) => [path, checked])),
        }
        const nextOrder = touchOrder(state.projectOrder, projectId)
        const evicted = evictStale(
          { ...state.checkedPathsByProjectId, [projectId]: nextProjectPaths },
          nextOrder
        )
        return {
          checkedPathsByProjectId: evicted.paths,
          projectOrder: evicted.order,
        }
      }),
    }),
    {
      name: STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => quotaSafeStorage),
      // Only persist explicitly-unchecked paths; `true` is the default at read time,
      // so storing it is wasted bytes that grow without bound on large monorepos.
      partialize: (state) => ({
        projectOrder: state.projectOrder,
        checkedPathsByProjectId: Object.fromEntries(
          Object.entries(state.checkedPathsByProjectId).map(([id, paths]) => [
            id,
            Object.fromEntries(Object.entries(paths).filter(([, checked]) => checked === false)),
          ])
        ),
      }),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<DiffCommitState>
        const checkedPathsByProjectId = state.checkedPathsByProjectId ?? {}
        if (version < 3) {
          return {
            checkedPathsByProjectId,
            projectOrder: Object.keys(checkedPathsByProjectId),
          } as DiffCommitState
        }
        return {
          checkedPathsByProjectId,
          projectOrder: state.projectOrder ?? Object.keys(checkedPathsByProjectId),
        } as DiffCommitState
      },
    }
  )
)

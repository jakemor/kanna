import { useCallback } from "react"
import { create } from "zustand"
import { SIDEBAR_PINNED_EXPANDED_STORAGE_KEY } from "../lib/storageKeys"

/**
 * Which sidebar sections you have opened or folded, against their defaults.
 *
 * Held here rather than in the lists themselves because the lists come and
 * go: opening a channel replaces the channel list with that project's chats,
 * and going back mounts the channel list anew. In a component's own state
 * every such trip would put each section back to its default.
 *
 * One set of overrides per list (`scope`), keyed by the section's stable key.
 *
 * In memory, so a reload starts from the defaults, except for Pinned, which
 * is kept in this browser. The other sections are named for what is in them
 * today (a date, "Relevant"), and a fold that outlived the day would hide
 * tomorrow's chats under the same name. Pinned is the same thing every day,
 * and folding it is a standing choice.
 */

type SectionOverrides = Readonly<Record<string, boolean>>

interface SidebarSectionState {
  overrides: Readonly<Record<string, SectionOverrides>>
  setExpanded: (scope: string, sectionKey: string, expanded: boolean) => void
}

const NO_OVERRIDES: SectionOverrides = {}

/**
 * The sections whose fold is remembered across reloads, and where. One
 * storage key each, holding a map of list to expanded.
 */
const PERSISTED_SECTIONS: Readonly<Record<string, string>> = {
  pinned: SIDEBAR_PINNED_EXPANDED_STORAGE_KEY,
}

function readStoredOverrides(): Record<string, SectionOverrides> {
  if (typeof window === "undefined") return {}
  const overrides: Record<string, Record<string, boolean>> = {}
  for (const [sectionKey, storageKey] of Object.entries(PERSISTED_SECTIONS)) {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}")
      if (!parsed || typeof parsed !== "object") continue
      for (const [scope, expanded] of Object.entries(parsed)) {
        if (typeof expanded === "boolean") (overrides[scope] ??= {})[sectionKey] = expanded
      }
    } catch {
      // Unreadable: that section starts from its default.
    }
  }
  return overrides
}

function persistOverrides(sectionKey: string, overrides: Readonly<Record<string, SectionOverrides>>) {
  const storageKey = PERSISTED_SECTIONS[sectionKey]
  if (typeof window === "undefined" || !storageKey) return
  const stored = Object.fromEntries(
    Object.entries(overrides).flatMap(([scope, sections]) => (
      sectionKey in sections ? [[scope, sections[sectionKey]]] : []
    ))
  )
  window.localStorage.setItem(storageKey, JSON.stringify(stored))
}

const useSidebarSectionStore = create<SidebarSectionState>()((set) => ({
  overrides: readStoredOverrides(),
  setExpanded: (scope, sectionKey, expanded) => set((state) => {
    const overrides = {
      ...state.overrides,
      [scope]: { ...state.overrides[scope], [sectionKey]: expanded },
    }
    persistOverrides(sectionKey, overrides)
    return { overrides }
  }),
}))

/** A list's overrides, and the setter for one of its sections. */
export function useSectionOverrides(scope: string) {
  const overrides = useSidebarSectionStore((state) => state.overrides[scope] ?? NO_OVERRIDES)
  const setStoreExpanded = useSidebarSectionStore((state) => state.setExpanded)
  const setExpanded = useCallback(
    (sectionKey: string, expanded: boolean) => setStoreExpanded(scope, sectionKey, expanded),
    [scope, setStoreExpanded]
  )
  return [overrides, setExpanded] as const
}

/** Folds or opens a list's section from outside a component: what its toggle does, for tests and commands. */
export function setSectionExpanded(scope: string, sectionKey: string, expanded: boolean) {
  useSidebarSectionStore.getState().setExpanded(scope, sectionKey, expanded)
}

/** A section's override as the store holds it now, or undefined for its default. */
export function sectionExpanded(scope: string, sectionKey: string): boolean | undefined {
  return useSidebarSectionStore.getState().overrides[scope]?.[sectionKey]
}

import { create } from "zustand"
import type { SidebarView } from "../components/chat-ui/sidebar/SidebarViewSwitcher"
import { SIDEBAR_VIEW_STORAGE_KEY } from "../lib/storageKeys"

/**
 * Which view the sidebar is in. A store rather than the sidebar's own state so
 * the view outlives the sidebar component and can be read outside it.
 */

type ReturnView = Exclude<SidebarView, "archived">

interface SidebarViewState {
  view: SidebarView
  /**
   * Where Archived hands you back to. Archived is somewhere you visit and get
   * returned from, so it is never persisted: what's stored is this, across
   * reloads as well as within a session.
   */
  returnView: ReturnView
  setView: (view: SidebarView) => void
  /** Back to the view you were in before Archived. A no-op from anywhere else. */
  leaveArchived: () => void
}

/**
 * Channels for anyone who hasn't picked. "recents" has to be read back as
 * itself: it was the old default, and someone who chose it must keep it.
 */
export function parseStoredSidebarView(stored: string | null): ReturnView {
  return stored === "recents" || stored === "projects" || stored === "channels" ? stored : "channels"
}

function readStoredSidebarView(): ReturnView {
  if (typeof window === "undefined") return "channels"
  return parseStoredSidebarView(window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY))
}

export const useSidebarViewStore = create<SidebarViewState>()((set) => ({
  view: readStoredSidebarView(),
  returnView: readStoredSidebarView(),

  setView: (view) => {
    if (view === "archived") {
      set({ view })
      return
    }
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view)
    set({ view, returnView: view })
  },

  leaveArchived: () => set((state) => (state.view === "archived" ? { view: state.returnView } : state)),
}))

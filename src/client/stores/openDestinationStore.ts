import { create } from "zustand"
import { OPEN_EXTERNAL_SELECT_STORAGE_KEY } from "../lib/storageKeys"

/**
 * The destination the navbar's "Open in…" split button last opened, kept in a
 * store rather than the navbar's own state so the context menus elsewhere can
 * name the same editor the button would use. Persisted under the key the
 * navbar has always used, so an existing choice survives this move.
 *
 * The raw string is stored, not an `OpenAppValue`: this module is imported by
 * the menu that owns that type, and validating here would invert that.
 */
interface OpenDestinationState {
  value: string | null
  setValue: (value: string) => void
}

function readStoredValue() {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(OPEN_EXTERNAL_SELECT_STORAGE_KEY)
  } catch {
    // Private-mode Safari and friends: remembering the choice is a nicety.
    return null
  }
}

export const useOpenDestinationStore = create<OpenDestinationState>()((set) => ({
  value: readStoredValue(),
  setValue: (value) => {
    try {
      window.localStorage.setItem(OPEN_EXTERNAL_SELECT_STORAGE_KEY, value)
    } catch {
      // Not persisted, but still honoured for this session.
    }
    set({ value })
  },
}))

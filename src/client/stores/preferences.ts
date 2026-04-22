import { create } from "zustand"
import { persist } from "zustand/middleware"

interface PreferencesState {
  autoResumeOnRateLimit: boolean
  setAutoResumeOnRateLimit: (value: boolean) => void
}

interface PersistedPreferencesState {
  autoResumeOnRateLimit?: boolean
}

function migratePreferencesState(
  persistedState: Partial<PersistedPreferencesState> | undefined,
): Pick<PreferencesState, "autoResumeOnRateLimit"> {
  return {
    autoResumeOnRateLimit: Boolean(persistedState?.autoResumeOnRateLimit),
  }
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      autoResumeOnRateLimit: false,
      setAutoResumeOnRateLimit: (value) => set({ autoResumeOnRateLimit: value }),
    }),
    {
      name: "kanna-preferences",
      version: 1,
      migrate: (persistedState) => migratePreferencesState(
        persistedState as Partial<PersistedPreferencesState> | undefined,
      ),
    },
  ),
)

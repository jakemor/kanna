import { create } from "zustand"
import { mergeProviderDefaultsPatch } from "../../shared/provider-preferences"
import type { AppSettingsPatch, AppSettingsSnapshot } from "../../shared/types"

interface AppSettingsStoreState {
  settings: AppSettingsSnapshot | null
  setFromServer: (settings: AppSettingsSnapshot) => void
  applyOptimisticPatch: (patch: AppSettingsPatch) => void
}

export function mergeAppSettingsPatch(
  settings: AppSettingsSnapshot,
  patch: AppSettingsPatch
): AppSettingsSnapshot {
  return {
    ...settings,
    ...patch,
    terminal: {
      ...settings.terminal,
      ...patch.terminal,
    },
    editor: {
      ...settings.editor,
      ...patch.editor,
    },
    // Same deep-merge the server applies in app-settings.ts applyPatch, so the
    // optimistic snapshot matches what the ack will confirm.
    providerDefaults: mergeProviderDefaultsPatch(settings.providerDefaults, patch.providerDefaults),
  }
}

export const useAppSettingsStore = create<AppSettingsStoreState>()((set) => ({
  settings: null,
  setFromServer: (settings) => set({ settings }),
  applyOptimisticPatch: (patch) =>
    set((state) => ({
      settings: state.settings ? mergeAppSettingsPatch(state.settings, patch) : state.settings,
    })),
}))

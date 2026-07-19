import { useCallback, useEffect, useState } from "react"
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  FaveModel,
  KeybindingsSnapshot,
  LlmProviderSnapshot,
  LlmProviderValidationResult,
} from "../../shared/types"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import { useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import type { KannaSocket, SocketStatus } from "./socket"

// App-settings/LLM-provider/keybindings snapshot subscriptions, runtime store
// fan-out, and the one-time legacy browser-localStorage settings migration.

const LEGACY_THEME_STORAGE_KEY = "lever-theme"
const LEGACY_CHAT_SOUND_STORAGE_KEY = "chat-sound-preferences"
const LEGACY_TERMINAL_STORAGE_KEY = "terminal-preferences"
const LEGACY_CHAT_PREFERENCES_STORAGE_KEY = "chat-preferences"

function readPersistedZustandState(key: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown }
    return parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)
      ? parsed.state as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function readLegacyBrowserSettingsPatch(): AppSettingsPatch | null {
  if (typeof window === "undefined") return null

  const patch: AppSettingsPatch = {}
  const theme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (theme === "light" || theme === "dark" || theme === "system") {
    patch.theme = theme
  }

  const chatSoundState = readPersistedZustandState(LEGACY_CHAT_SOUND_STORAGE_KEY)
  if (chatSoundState?.chatSoundPreference === "never" || chatSoundState?.chatSoundPreference === "unfocused" || chatSoundState?.chatSoundPreference === "always") {
    patch.chatSoundPreference = chatSoundState.chatSoundPreference
  }
  if (
    chatSoundState?.chatSoundId === "blow"
    || chatSoundState?.chatSoundId === "bottle"
    || chatSoundState?.chatSoundId === "frog"
    || chatSoundState?.chatSoundId === "funk"
    || chatSoundState?.chatSoundId === "glass"
    || chatSoundState?.chatSoundId === "ping"
    || chatSoundState?.chatSoundId === "pop"
    || chatSoundState?.chatSoundId === "purr"
    || chatSoundState?.chatSoundId === "tink"
  ) {
    patch.chatSoundId = chatSoundState.chatSoundId
  }

  const terminalState = readPersistedZustandState(LEGACY_TERMINAL_STORAGE_KEY)
  if (terminalState) {
    patch.terminal = {}
    if (typeof terminalState.scrollbackLines === "number") {
      patch.terminal.scrollbackLines = terminalState.scrollbackLines
    }
    if (typeof terminalState.minColumnWidth === "number") {
      patch.terminal.minColumnWidth = terminalState.minColumnWidth
    }
    const editorPatch: NonNullable<AppSettingsPatch["editor"]> = {}
    if (
      terminalState.editorPreset === "cursor"
      || terminalState.editorPreset === "vscode"
      || terminalState.editorPreset === "xcode"
      || terminalState.editorPreset === "windsurf"
      || terminalState.editorPreset === "custom"
    ) {
      editorPatch.preset = terminalState.editorPreset
    }
    if (typeof terminalState.editorCommandTemplate === "string") {
      editorPatch.commandTemplate = terminalState.editorCommandTemplate
    }
    if (Object.keys(editorPatch).length > 0) {
      patch.editor = editorPatch
    }
  }

  const chatPreferencesState = readPersistedZustandState(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
  if (chatPreferencesState?.defaultProvider === "last_used" || chatPreferencesState?.defaultProvider === "claude" || chatPreferencesState?.defaultProvider === "codex") {
    patch.defaultProvider = chatPreferencesState.defaultProvider
  }
  if (chatPreferencesState?.providerDefaults && typeof chatPreferencesState.providerDefaults === "object") {
    patch.providerDefaults = chatPreferencesState.providerDefaults as AppSettingsPatch["providerDefaults"]
  }

  patch.browserSettingsMigrated = true
  return Object.keys(patch).length > 1 ? patch : null
}

function clearLegacyBrowserSettings() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_CHAT_SOUND_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_TERMINAL_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_CHAT_PREFERENCES_STORAGE_KEY)
}

function syncRuntimeStoresFromAppSettings(snapshot: AppSettingsSnapshot) {
  useAppSettingsStore.getState().setFromServer(snapshot)
  const terminalPreferences = useTerminalPreferencesStore.getState()
  terminalPreferences.setScrollbackLines(snapshot.terminal.scrollbackLines)
  terminalPreferences.setMinColumnWidth(snapshot.terminal.minColumnWidth)
  terminalPreferences.setEditorPreset(snapshot.editor.preset)
  terminalPreferences.setEditorCommandTemplate(snapshot.editor.commandTemplate)

  const chatSoundPreferences = useChatSoundPreferencesStore.getState()
  chatSoundPreferences.setChatSoundPreference(snapshot.chatSoundPreference)
  chatSoundPreferences.setChatSoundId(snapshot.chatSoundId)

  useChatPreferencesStore.getState().syncProviderDefaults(snapshot.defaultProvider, snapshot.providerDefaults)
}

export function useAppSettingsSync(params: {
  socket: KannaSocket
  connectionStatus: SocketStatus
  setCommandError: (message: string | null) => void
}) {
  const { socket, connectionStatus, setCommandError } = params
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettingsSnapshot | null>(null)
  const [llmProvider, setLlmProvider] = useState<LlmProviderSnapshot | null>(null)

  useEffect(() => {
    return socket.subscribe<KeybindingsSnapshot>({ type: "keybindings" }, (snapshot) => {
      setKeybindings(snapshot)
      setCommandError(null)
    })
  }, [setCommandError, socket])

  useEffect(() => {
    return socket.subscribe<AppSettingsSnapshot>({ type: "app-settings" }, (snapshot) => {
      setAppSettings(snapshot)
      syncRuntimeStoresFromAppSettings(snapshot)
      setCommandError(null)
    })
  }, [setCommandError, socket])

  const handleReadAppSettings = useCallback(async () => {
    try {
      const snapshot = await socket.command<AppSettingsSnapshot>({ type: "settings.readAppSettings" })
      setAppSettings(snapshot)
      syncRuntimeStoresFromAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [setCommandError, socket])

  const handleWriteAppSettings = useCallback(async (patch: AppSettingsPatch) => {
    try {
      useAppSettingsStore.getState().applyOptimisticPatch(patch)
      const snapshot = await socket.command<AppSettingsSnapshot>({
        type: "settings.writeAppSettingsPatch",
        patch,
      })
      setAppSettings(snapshot)
      syncRuntimeStoresFromAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      await handleReadAppSettings()
      throw error
    }
  }, [handleReadAppSettings, setCommandError, socket])

  const handleReadLlmProvider = useCallback(async () => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({ type: "settings.readLlmProvider" })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [setCommandError, socket])

  const handleWriteLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>
  ) => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({
        type: "settings.writeLlmProvider",
        provider: value.provider,
        apiKey: value.apiKey,
        model: value.model,
        baseUrl: value.baseUrl,
        faveModels: value.faveModels,
      })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [setCommandError, socket])

  // Save only the fave models (the Default Models list), leaving the rest of
  // the Model Registry settings at their last-committed values.
  const handleWriteFaveModels = useCallback(async (faveModels: FaveModel[]) => {
    if (!llmProvider) return
    await handleWriteLlmProvider({
      provider: llmProvider.provider,
      apiKey: llmProvider.apiKey,
      model: llmProvider.model,
      baseUrl: llmProvider.baseUrl,
      faveModels,
    })
  }, [handleWriteLlmProvider, llmProvider])

  const handleValidateLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    return await socket.command<LlmProviderValidationResult>({
      type: "settings.validateLlmProvider",
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadAppSettings()
  }, [connectionStatus, handleReadAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    if (appSettings?.browserSettingsMigrated !== false) return
    const patch = readLegacyBrowserSettingsPatch()
    if (!patch) return
    void handleWriteAppSettings(patch)
      .then(clearLegacyBrowserSettings)
      .catch(() => undefined)
  }, [appSettings?.browserSettingsMigrated, connectionStatus, handleWriteAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadLlmProvider()
  }, [connectionStatus, handleReadLlmProvider])

  return {
    keybindings,
    appSettings,
    llmProvider,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleWriteFaveModels,
    handleValidateLlmProvider,
  }
}

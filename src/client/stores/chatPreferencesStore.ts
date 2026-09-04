import { create } from "zustand"
import {
  chatModeToFlags,
  type AgentProvider,
  type ChatMode,
  type ChatProviderPreferences,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type DefaultProviderPreference,
  type PiModelOptions,
  type ProviderPreference,
  type ProviderModelOptionsByProvider,
} from "../../shared/types"
import {
  createDefaultProviderDefaults,
  normalizeClaudePreference,
  normalizeCodexPreference,
  normalizeCursorPreference,
  normalizePiPreference,
  normalizeProviderDefaults,
  normalizeProviderPreference,
  PROVIDER_NORMALIZERS,
  type ProviderModelOptionsInput,
  type ProviderPreferenceInput,
} from "../../shared/provider-preferences"
import { findSidebarChat } from "./sidebarStore"

export type { ChatProviderPreferences, DefaultProviderPreference, ProviderPreference }
// The normalizers live in shared/provider-preferences (also used by the server's
// settings-file normalization); re-exported here for existing importers/tests.
export {
  createDefaultProviderDefaults,
  normalizeClaudePreference,
  normalizeCodexPreference,
  normalizeCursorPreference,
  normalizePiPreference,
  normalizeProviderDefaults,
  normalizeProviderPreference,
}

export type ComposerState = {
  [TProvider in AgentProvider]: {
    provider: TProvider
    model: string
    modelOptions: ProviderModelOptionsByProvider[TProvider]
    planMode: boolean
    autoPlan: boolean
  }
}[AgentProvider]

export const NEW_CHAT_COMPOSER_ID = "__new__"

export function normalizeDefaultProvider(value?: string): DefaultProviderPreference {
  if (value === "claude" || value === "codex" || value === "cursor" || value === "pi") return value
  return "last_used"
}

function composerStateForProvider(provider: AgentProvider, value?: ProviderPreferenceInput): ComposerState {
  // The normalizer record is keyed by provider, so the provider tag always matches
  // its normalized modelOptions shape; TS can't prove that across the union.
  return { provider, ...normalizeProviderPreference(provider, value) } as ComposerState
}

type PersistedComposerState = ProviderPreferenceInput & { provider: AgentProvider }

type LegacyPersistedChatPreferencesState = Partial<{
  defaultProvider: string
  providerDefaults: Partial<Record<AgentProvider, ProviderPreferenceInput>>
  composerState: PersistedComposerState
  liveProvider: AgentProvider
  livePreferences: Partial<Record<"claude" | "codex", ProviderPreferenceInput>>
}>

type PersistedChatPreferencesState = LegacyPersistedChatPreferencesState & Partial<{
  chatStates: Record<string, PersistedComposerState | ComposerState>
  legacyComposerState: PersistedComposerState | ComposerState | null
}>

function logChatPreferences(message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[chat-preferences] ${message}`)
    return
  }

  console.info(`[chat-preferences] ${message}`, details)
}

function composerFromProviderDefaults(
  provider: AgentProvider,
  providerDefaults: ChatProviderPreferences
): ComposerState {
  return composerStateForProvider(provider, providerDefaults[provider])
}

/**
 * What the server knows a chat last ran with — the sidebar row's provider and
 * model. Nothing else survives a reload on this side, so this is what an
 * existing chat is seeded from. Settings defaults are for chats that have
 * never run; a chat that has picks up where it left off, on every device.
 */
export interface ComposerSeed {
  provider: AgentProvider
  model?: string
}

function composerFromChatSeed(seed: ComposerSeed, providerDefaults: ChatProviderPreferences): ComposerState {
  // Options (effort, context window…) aren't recorded per chat, so those still
  // come from the provider's defaults; the model is the chat's own.
  return composerStateForProvider(seed.provider, {
    ...providerDefaults[seed.provider],
    ...(seed.model ? { model: seed.model } : {}),
  })
}

function cloneComposerState(state: ComposerState): ComposerState {
  return { ...state, modelOptions: { ...state.modelOptions } } as ComposerState
}

function sameComposerState(left: ComposerState | undefined, right: ComposerState): boolean {
  if (!left || left.provider !== right.provider) return false
  if (left.model !== right.model || left.planMode !== right.planMode) return false
  if (left.autoPlan !== right.autoPlan) return false

  const leftOptions: Record<string, unknown> = { ...left.modelOptions }
  const rightOptions: Record<string, unknown> = { ...right.modelOptions }
  const keys = new Set([...Object.keys(leftOptions), ...Object.keys(rightOptions)])
  return [...keys].every((key) => leftOptions[key] === rightOptions[key])
}

function normalizeComposerState(
  value: PersistedComposerState | undefined,
  providerDefaults: ChatProviderPreferences,
  legacyLiveProvider?: AgentProvider,
  legacyLivePreferences?: LegacyPersistedChatPreferencesState["livePreferences"]
): ComposerState {
  // Persisted data is untrusted: only dispatch on providers we actually know.
  const provider = value?.provider
  if (provider && provider in PROVIDER_NORMALIZERS) {
    return composerStateForProvider(provider, value)
  }

  if (legacyLiveProvider === "claude" || legacyLiveProvider === "codex") {
    return composerStateForProvider(legacyLiveProvider, legacyLivePreferences?.[legacyLiveProvider])
  }

  return composerFromProviderDefaults("claude", providerDefaults)
}

function normalizePersistedComposerState(
  value: PersistedComposerState | ComposerState | undefined,
  providerDefaults: ChatProviderPreferences
): ComposerState | null {
  if (!value) return null
  return normalizeComposerState(value, providerDefaults)
}

function normalizeChatStates(
  value: Record<string, PersistedComposerState | ComposerState> | undefined,
  providerDefaults: ChatProviderPreferences
): Record<string, ComposerState> {
  if (!value) return {}

  return Object.fromEntries(
    Object.entries(value).map(([chatId, composerState]) => [
      chatId,
      normalizeComposerState(composerState, providerDefaults),
    ])
  )
}

function createComposerStateForNewChat(args: {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  sourceState?: ComposerState | null
  legacyComposerState?: ComposerState | null
}): ComposerState {
  if (args.defaultProvider === "last_used") {
    if (args.sourceState) {
      return cloneComposerState(args.sourceState)
    }

    if (args.legacyComposerState) {
      return cloneComposerState(args.legacyComposerState)
    }

    return composerFromProviderDefaults("claude", args.providerDefaults)
  }

  return composerFromProviderDefaults(args.defaultProvider, args.providerDefaults)
}

/**
 * The seed for a chat with nothing stored, read from the sidebar snapshot.
 * Every path that materialises state for a chat — including the mutation
 * helpers, which never see the hook's reactive seed — must start from the
 * chat's own record, or a Shift+Tab on a chat you just reloaded would pin it
 * to the default provider on its way to toggling the mode.
 */
function seedForChat(chatId: string): ComposerSeed | null {
  if (chatId === NEW_CHAT_COMPOSER_ID) return null
  const row = findSidebarChat(chatId)
  if (!row?.provider) return null
  return { provider: row.provider, ...(row.model ? { model: row.model } : {}) }
}

function getStoredComposerState(
  state: Pick<ChatPreferencesState, "chatStates" | "defaultProvider" | "providerDefaults" | "legacyComposerState">,
  chatId: string,
  seed: ComposerSeed | null = seedForChat(chatId)
): ComposerState {
  const existingState = state.chatStates[chatId]
  if (existingState) {
    return existingState
  }
  if (seed) {
    return composerFromChatSeed(seed, state.providerDefaults)
  }

  return createComposerStateForNewChat({
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    legacyComposerState: state.legacyComposerState,
  })
}

function withChatComposerState(
  state: Pick<ChatPreferencesState, "chatStates" | "defaultProvider" | "providerDefaults" | "legacyComposerState">,
  chatId: string,
  transform: (composerState: ComposerState) => ComposerState
) {
  const currentComposerState = getStoredComposerState(state, chatId)
  return {
    chatStates: {
      ...state.chatStates,
      [chatId]: transform(currentComposerState),
    },
  }
}

interface ChatPreferencesState {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  chatStates: Record<string, ComposerState>
  /**
   * Chats where the user explicitly picked a different harness than the
   * chat's current provider — the switch (with server-side handoff) applies
   * on the next send. Deliberately not persisted: chat states seeded from
   * defaults must never read as an intentional switch.
   */
  pendingProviderSwitches: Record<string, true>
  legacyComposerState: ComposerState | null
  setDefaultProvider: (provider: DefaultProviderPreference) => void
  syncProviderDefaults: (defaultProvider: DefaultProviderPreference, providerDefaults: ChatProviderPreferences) => void
  setProviderDefaultModel: (provider: AgentProvider, model: string) => void
  setProviderDefaultModelOptions: <TProvider extends AgentProvider>(
    provider: TProvider,
    modelOptions: Partial<ProviderModelOptionsByProvider[TProvider]>
  ) => void
  setProviderDefaultMode: (provider: AgentProvider, mode: ChatMode) => void
  /** `seed` is the chat's own record (see ComposerSeed); used only when nothing is stored for it. */
  getComposerState: (chatId: string, seed?: ComposerSeed | null) => ComposerState
  initializeComposerForChat: (chatId: string, options?: { sourceState?: ComposerState | null }) => void
  setComposerState: (chatId: string, composerState: ComposerState) => void
  setChatComposerProvider: (chatId: string, provider: AgentProvider) => void
  setChatComposerModel: (chatId: string, model: string) => void
  setChatComposerModelOptions: (
    chatId: string,
    modelOptions: Partial<ClaudeModelOptions> | Partial<CodexModelOptions> | Partial<CursorModelOptions> | Partial<PiModelOptions>
  ) => void
  setChatComposerMode: (chatId: string, mode: ChatMode) => void
  /**
   * Clears plan mode while leaving `autoPlan` untouched — used when a plan is
   * approved, so an Auto Plan user returns to Auto Plan rather than dropping
   * to Full Access.
   */
  clearChatComposerPlanMode: (chatId: string) => void
  resetChatComposerFromProvider: (chatId: string, provider: AgentProvider) => void
  markPendingProviderSwitch: (chatId: string) => void
  clearPendingProviderSwitch: (chatId: string) => void
}

export function migrateChatPreferencesState(
  persistedState: PersistedChatPreferencesState | undefined
): Pick<ChatPreferencesState, "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"> {
  const providerDefaults = normalizeProviderDefaults(persistedState?.providerDefaults)
  const legacyComposerState = normalizePersistedComposerState(
    persistedState?.legacyComposerState ?? persistedState?.composerState,
    providerDefaults
  )
  const legacyLiveComposerState = persistedState?.liveProvider
    ? normalizeComposerState(
      undefined,
      providerDefaults,
      persistedState.liveProvider,
      persistedState?.livePreferences
    )
    : null

  return {
    defaultProvider: normalizeDefaultProvider(persistedState?.defaultProvider),
    providerDefaults,
    chatStates: normalizeChatStates(persistedState?.chatStates, providerDefaults),
    legacyComposerState: legacyComposerState ?? legacyLiveComposerState,
  }
}

export const useChatPreferencesStore = create<ChatPreferencesState>()(
  (set, get) => ({
    defaultProvider: "last_used",
    providerDefaults: createDefaultProviderDefaults(),
    chatStates: {},
    pendingProviderSwitches: {},
    legacyComposerState: null,
    setDefaultProvider: (defaultProvider) => set({ defaultProvider }),
    syncProviderDefaults: (defaultProvider, providerDefaults) =>
      set((state) => {
        const oldNewChatFallback = createComposerStateForNewChat({
          defaultProvider: state.defaultProvider,
          providerDefaults: state.providerDefaults,
          legacyComposerState: state.legacyComposerState,
        })
        const nextNewChatFallback = createComposerStateForNewChat({
          defaultProvider,
          providerDefaults,
          legacyComposerState: state.legacyComposerState,
        })
        // Only the new-chat composer follows a change of defaults, and only
        // while it is still untouched. A chat that has run keeps what it ran
        // with: defaults are for starting chats, not for changing them.
        const newChatState = state.chatStates[NEW_CHAT_COMPOSER_ID]
        const chatStates = newChatState && sameComposerState(newChatState, oldNewChatFallback)
          ? { ...state.chatStates, [NEW_CHAT_COMPOSER_ID]: nextNewChatFallback }
          : state.chatStates

        return {
          defaultProvider,
          providerDefaults,
          chatStates,
        }
      }),
      setProviderDefaultModel: (provider, model) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: normalizeProviderPreference(provider, { ...state.providerDefaults[provider], model }),
          },
        })),
      setProviderDefaultModelOptions: (provider, modelOptions) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: normalizeProviderPreference(provider, {
              ...state.providerDefaults[provider],
              modelOptions: {
                ...state.providerDefaults[provider].modelOptions,
                ...modelOptions,
              } as ProviderModelOptionsInput,
            }),
          },
        })),
      setProviderDefaultMode: (provider, mode) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: {
              ...state.providerDefaults[provider],
              ...chatModeToFlags(mode, state.providerDefaults[provider].autoPlan),
            },
          },
        })),
      getComposerState: (chatId, seed) => cloneComposerState(getStoredComposerState(get(), chatId, seed)),
      initializeComposerForChat: (chatId, options) =>
        set((state) => {
          if (state.chatStates[chatId]) {
            return state
          }

          const composerState = createComposerStateForNewChat({
            defaultProvider: state.defaultProvider,
            providerDefaults: state.providerDefaults,
            sourceState: options?.sourceState,
            legacyComposerState: state.legacyComposerState,
          })

          logChatPreferences("initializeComposerForChat", { chatId, composerState })

          return {
            chatStates: {
              ...state.chatStates,
              [chatId]: composerState,
            },
          }
        }),
      setComposerState: (chatId, composerState) =>
        set((state) => ({
          chatStates: {
            ...state.chatStates,
            // Claude/Codex states are re-normalized (model aliases, effort clamps);
            // Cursor/Pi states are historically stored as provided.
            [chatId]: composerState.provider === "claude" || composerState.provider === "codex"
              ? composerStateForProvider(composerState.provider, composerState)
              : cloneComposerState(composerState),
          },
        })),
      setChatComposerProvider: (chatId, provider) =>
        set((state) => withChatComposerState(state, chatId, () => composerFromProviderDefaults(provider, state.providerDefaults))),
      setChatComposerModel: (chatId, model) =>
        set((state) => withChatComposerState(state, chatId, (composerState) =>
          composerStateForProvider(composerState.provider, { ...composerState, model })
        )),
      setChatComposerModelOptions: (chatId, modelOptions) =>
        set((state) => withChatComposerState(state, chatId, (composerState) =>
          composerStateForProvider(composerState.provider, {
            ...composerState,
            modelOptions: { ...composerState.modelOptions, ...modelOptions } as ProviderModelOptionsInput,
          })
        )),
      setChatComposerMode: (chatId, mode) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => ({
          ...composerState,
          ...chatModeToFlags(mode, composerState.autoPlan),
        }))),
      clearChatComposerPlanMode: (chatId) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => ({
          ...composerState,
          planMode: false,
        }))),
      resetChatComposerFromProvider: (chatId, provider) =>
        set((state) => ({
          chatStates: {
            ...state.chatStates,
            [chatId]: composerFromProviderDefaults(provider, state.providerDefaults),
          },
        })),
      markPendingProviderSwitch: (chatId) =>
        set((state) => (
          state.pendingProviderSwitches[chatId]
            ? state
            : { pendingProviderSwitches: { ...state.pendingProviderSwitches, [chatId]: true } }
        )),
      clearPendingProviderSwitch: (chatId) =>
        set((state) => {
          if (!state.pendingProviderSwitches[chatId]) return state
          const { [chatId]: _cleared, ...rest } = state.pendingProviderSwitches
          return { pendingProviderSwitches: rest }
        }),
  })
)

import { create } from "zustand"
import {
  type AgentProvider,
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

function cloneComposerState(state: ComposerState): ComposerState {
  return { ...state, modelOptions: { ...state.modelOptions } } as ComposerState
}

function sameComposerState(left: ComposerState | undefined, right: ComposerState): boolean {
  if (!left || left.provider !== right.provider) return false
  if (left.model !== right.model || left.planMode !== right.planMode) return false

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

function getStoredComposerState(
  state: Pick<ChatPreferencesState, "chatStates" | "defaultProvider" | "providerDefaults" | "legacyComposerState">,
  chatId: string
): ComposerState {
  const existingState = state.chatStates[chatId]
  if (existingState) {
    return existingState
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
  legacyComposerState: ComposerState | null
  setDefaultProvider: (provider: DefaultProviderPreference) => void
  syncProviderDefaults: (defaultProvider: DefaultProviderPreference, providerDefaults: ChatProviderPreferences) => void
  setProviderDefaultModel: (provider: AgentProvider, model: string) => void
  setProviderDefaultModelOptions: <TProvider extends AgentProvider>(
    provider: TProvider,
    modelOptions: Partial<ProviderModelOptionsByProvider[TProvider]>
  ) => void
  setProviderDefaultPlanMode: (provider: AgentProvider, planMode: boolean) => void
  getComposerState: (chatId: string) => ComposerState
  initializeComposerForChat: (chatId: string, options?: { sourceState?: ComposerState | null }) => void
  setComposerState: (chatId: string, composerState: ComposerState) => void
  setChatComposerProvider: (chatId: string, provider: AgentProvider) => void
  setChatComposerModel: (chatId: string, model: string) => void
  setChatComposerModelOptions: (
    chatId: string,
    modelOptions: Partial<ClaudeModelOptions> | Partial<CodexModelOptions> | Partial<CursorModelOptions> | Partial<PiModelOptions>
  ) => void
  setChatComposerPlanMode: (chatId: string, planMode: boolean) => void
  resetChatComposerFromProvider: (chatId: string, provider: AgentProvider) => void
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
        const chatStates = Object.fromEntries(
          Object.entries(state.chatStates).map(([chatId, composerState]) => [
            chatId,
            sameComposerState(composerState, oldNewChatFallback) ? nextNewChatFallback : composerState,
          ])
        )

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
      setProviderDefaultPlanMode: (provider, planMode) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: {
              ...state.providerDefaults[provider],
              planMode,
            },
          },
        })),
      getComposerState: (chatId) => cloneComposerState(getStoredComposerState(get(), chatId)),
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
      setChatComposerPlanMode: (chatId, planMode) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => ({
          ...composerState,
          planMode,
        }))),
      resetChatComposerFromProvider: (chatId, provider) =>
        set((state) => ({
          chatStates: {
            ...state.chatStates,
            [chatId]: composerFromProviderDefaults(provider, state.providerDefaults),
          },
        })),
  })
)

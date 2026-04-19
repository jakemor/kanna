import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  normalizeClaudeContextWindow,
  normalizeClaudeModelId,
  isClaudeOpusModelId,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  type AgentProvider,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type ProviderModelOptionsByProvider,
} from "../../shared/types"

export interface ProviderPreference<TModelOptions> {
  model: string
  modelOptions: TModelOptions
  planMode: boolean
}

export type DefaultProviderPreference = "last_used" | AgentProvider

export type ChatProviderPreferences = {
  claude: ProviderPreference<ClaudeModelOptions>
  codex: ProviderPreference<CodexModelOptions>
}

export type ComposerState =
  | {
    provider: "claude"
    model: string
    modelOptions: ClaudeModelOptions
    planMode: boolean
  }
  | {
    provider: "codex"
    model: string
    modelOptions: CodexModelOptions
    planMode: boolean
  }

export const NEW_CHAT_COMPOSER_ID = "__new__"

type LegacyPersistedChatPreferencesState = Partial<{
  defaultProvider: string
  providerDefaults: {
    claude?: {
      model?: string
      effort?: string
      modelOptions?: Partial<ClaudeModelOptions>
      planMode?: boolean
    }
    codex?: {
      model?: string
      effort?: string
      modelOptions?: Partial<CodexModelOptions>
      planMode?: boolean
    }
  }
  composerState: PersistedComposerState
  liveProvider: AgentProvider
  livePreferences: {
    claude?: {
      model?: string
      effort?: string
      modelOptions?: Partial<ClaudeModelOptions>
      planMode?: boolean
    }
    codex?: {
      model?: string
      effort?: string
      modelOptions?: Partial<CodexModelOptions>
      planMode?: boolean
    }
  }
}>

type PersistedComposerState =
  | {
    provider: "claude"
    model?: string
    effort?: string
    modelOptions?: Partial<ClaudeModelOptions>
    planMode?: boolean
  }
  | {
    provider: "codex"
    model?: string
    effort?: string
    modelOptions?: Partial<CodexModelOptions>
    planMode?: boolean
  }

type PersistedChatPreferencesState = Pick<
  ChatPreferencesState,
  "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"
> & LegacyPersistedChatPreferencesState

function normalizeCodexModel(model?: string) {
  return model === "gpt-5-codex" ? "gpt-5.3-codex" : (model ?? "gpt-5.4")
}

function normalizeDefaultProvider(value?: string): DefaultProviderPreference {
  if (value === "claude" || value === "codex") return value
  return "last_used"
}

function normalizeClaudePreference(value?: {
  model?: string
  effort?: string
  modelOptions?: Partial<ClaudeModelOptions>
  planMode?: boolean
}): ProviderPreference<ClaudeModelOptions> {
  const reasoningEffort = value?.modelOptions?.reasoningEffort
  const normalizedEffort = isClaudeReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : isClaudeReasoningEffort(value?.effort)
      ? value.effort
      : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort
  const model = normalizeClaudeModelId(value?.model)
  const contextWindow = normalizeClaudeContextWindow(model, value?.modelOptions?.contextWindow)

  return {
    model,
    modelOptions: {
      reasoningEffort: !isClaudeOpusModelId(model) && normalizedEffort === "max" ? "high" : normalizedEffort,
      contextWindow,
    },
    planMode: Boolean(value?.planMode),
  }
}

function normalizeCodexPreference(value?: {
  model?: string
  effort?: string
  modelOptions?: Partial<CodexModelOptions>
  planMode?: boolean
}): ProviderPreference<CodexModelOptions> {
  const reasoningEffort = value?.modelOptions?.reasoningEffort
  return {
    model: normalizeCodexModel(value?.model),
    modelOptions: {
      reasoningEffort: isCodexReasoningEffort(reasoningEffort)
        ? reasoningEffort
        : isCodexReasoningEffort(value?.effort)
          ? value.effort
          : DEFAULT_CODEX_MODEL_OPTIONS.reasoningEffort,
      fastMode: typeof value?.modelOptions?.fastMode === "boolean"
        ? value.modelOptions.fastMode
        : DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
    },
    planMode: Boolean(value?.planMode),
  }
}

function createDefaultProviderDefaults(): ChatProviderPreferences {
  return {
    claude: {
      model: "claude-opus-4-7",
      modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
      planMode: false,
    },
    codex: {
      model: "gpt-5.4",
      modelOptions: { ...DEFAULT_CODEX_MODEL_OPTIONS },
      planMode: false,
    },
  }
}

function normalizeProviderDefaults(value?: {
  claude?: {
    model?: string
    effort?: string
    modelOptions?: Partial<ClaudeModelOptions>
    planMode?: boolean
  }
  codex?: {
    model?: string
    effort?: string
    modelOptions?: Partial<CodexModelOptions>
    planMode?: boolean
  }
}): ChatProviderPreferences {
  return {
    claude: normalizeClaudePreference(value?.claude),
    codex: normalizeCodexPreference(value?.codex),
  }
}

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
  if (provider === "claude") {
    const preference = providerDefaults.claude
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: { ...preference.modelOptions },
      planMode: preference.planMode,
    }
  }

  const preference = providerDefaults.codex
  return {
    provider: "codex",
    model: preference.model,
    modelOptions: { ...preference.modelOptions },
    planMode: preference.planMode,
  }
}

function cloneComposerState(state: ComposerState): ComposerState {
  return state.provider === "claude"
    ? {
      provider: "claude",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
    }
    : {
      provider: "codex",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
    }
}

function normalizeComposerState(
  value: PersistedComposerState | undefined,
  providerDefaults: ChatProviderPreferences,
  legacyLiveProvider?: AgentProvider,
  legacyLivePreferences?: LegacyPersistedChatPreferencesState["livePreferences"]
): ComposerState {
  if (value?.provider === "claude") {
    const preference = normalizeClaudePreference(value)
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
    }
  }

  if (value?.provider === "codex") {
    const preference = normalizeCodexPreference(value)
    return {
      provider: "codex",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
    }
  }

  if (legacyLiveProvider === "claude") {
    const preference = normalizeClaudePreference(legacyLivePreferences?.claude)
    return {
      provider: "claude",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
    }
  }

  if (legacyLiveProvider === "codex") {
    const preference = normalizeCodexPreference(legacyLivePreferences?.codex)
    return {
      provider: "codex",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
    }
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
    modelOptions: Partial<ClaudeModelOptions> | Partial<CodexModelOptions>
  ) => void
  setChatComposerPlanMode: (chatId: string, planMode: boolean) => void
  resetChatComposerFromProvider: (chatId: string, provider: AgentProvider) => void
}

export function migrateChatPreferencesState(
  persistedState: Partial<PersistedChatPreferencesState> | undefined
): Pick<ChatPreferencesState, "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"> {
  const providerDefaults = normalizeProviderDefaults(persistedState?.providerDefaults)
  const legacyComposerState = normalizePersistedComposerState(
    persistedState?.legacyComposerState ?? persistedState?.composerState,
    providerDefaults
  )

  return {
    defaultProvider: normalizeDefaultProvider(persistedState?.defaultProvider),
    providerDefaults,
    chatStates: normalizeChatStates(persistedState?.chatStates, providerDefaults),
    legacyComposerState: legacyComposerState ?? normalizeComposerState(
      undefined,
      providerDefaults,
      persistedState?.liveProvider,
      persistedState?.livePreferences
    ),
  }
}

export const useChatPreferencesStore = create<ChatPreferencesState>()(
  persist(
    (set, get) => ({
      defaultProvider: "last_used",
      providerDefaults: createDefaultProviderDefaults(),
      chatStates: {},
      legacyComposerState: {
        provider: "claude",
        model: "claude-opus-4-7",
        modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
        planMode: false,
      },
      setDefaultProvider: (defaultProvider) => set({ defaultProvider }),
      setProviderDefaultModel: (provider, model) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: provider === "claude"
              ? normalizeClaudePreference({
                ...state.providerDefaults.claude,
                model,
              })
              : normalizeCodexPreference({
                ...state.providerDefaults.codex,
                model,
              }),
          },
        })),
      setProviderDefaultModelOptions: (provider, modelOptions) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: provider === "claude"
              ? normalizeClaudePreference({
                ...state.providerDefaults.claude,
                modelOptions: {
                  ...state.providerDefaults.claude.modelOptions,
                  ...modelOptions as Partial<ClaudeModelOptions>,
                },
              })
              : normalizeCodexPreference({
                ...state.providerDefaults.codex,
                modelOptions: {
                  ...state.providerDefaults.codex.modelOptions,
                  ...modelOptions as Partial<CodexModelOptions>,
                },
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
            [chatId]: composerState.provider === "claude"
              ? {
                provider: "claude",
                model: normalizeClaudePreference(composerState).model,
                modelOptions: normalizeClaudePreference(composerState).modelOptions,
                planMode: composerState.planMode,
              }
              : cloneComposerState(composerState),
          },
        })),
      setChatComposerProvider: (chatId, provider) =>
        set((state) => withChatComposerState(state, chatId, () => composerFromProviderDefaults(provider, state.providerDefaults))),
      setChatComposerModel: (chatId, model) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          composerState.provider === "claude"
            ? {
              provider: "claude",
              model: normalizeClaudePreference({
                ...composerState,
                model,
              }).model,
              modelOptions: normalizeClaudePreference({
                ...composerState,
                model,
              }).modelOptions,
              planMode: composerState.planMode,
            }
            : {
              provider: "codex",
              model,
              modelOptions: normalizeCodexPreference({
                ...composerState,
                model,
              }).modelOptions,
              planMode: composerState.planMode,
            }
        ))),
      setChatComposerModelOptions: (chatId, modelOptions) =>
        set((state) => withChatComposerState(state, chatId, (composerState) => (
          composerState.provider === "claude"
            ? {
              provider: "claude",
              model: composerState.model,
              modelOptions: normalizeClaudePreference({
                ...composerState,
                modelOptions: {
                  ...composerState.modelOptions,
                  ...modelOptions as Partial<ClaudeModelOptions>,
                },
              }).modelOptions,
              planMode: composerState.planMode,
            }
            : {
              provider: "codex",
              model: composerState.model,
              modelOptions: normalizeCodexPreference({
                ...composerState,
                modelOptions: {
                  ...composerState.modelOptions,
                  ...modelOptions as Partial<CodexModelOptions>,
                },
              }).modelOptions,
              planMode: composerState.planMode,
            }
        ))),
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
    }),
    {
      name: "chat-preferences",
      version: 6,
      migrate: (persistedState) => migrateChatPreferencesState(persistedState as Partial<PersistedChatPreferencesState> | undefined),
    }
  )
)

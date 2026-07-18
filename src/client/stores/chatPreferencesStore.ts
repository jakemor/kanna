import { create } from "zustand"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_CURSOR_MODEL_OPTIONS,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_MODEL_OPTIONS,
  normalizeClaudeContextWindow,
  normalizeClaudeFastMode,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  normalizeCodexReasoningEffort,
  normalizeCursorModelId,
  normalizePiModelId,
  normalizePiReasoningEffort,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isPiReasoningEffort,
  supportsClaudeMaxReasoningEffort,
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
import { assertNever } from "../../shared/assert"

export type { ChatProviderPreferences, DefaultProviderPreference, ProviderPreference }

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
  | {
    provider: "cursor"
    model: string
    modelOptions: CursorModelOptions
    planMode: boolean
  }
  | {
    provider: "pi"
    model: string
    modelOptions: PiModelOptions
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
  | {
    provider: "cursor"
    model?: string
    modelOptions?: Partial<CursorModelOptions>
    planMode?: boolean
  }
  | {
    provider: "pi"
    model?: string
    effort?: string
    modelOptions?: Partial<PiModelOptions>
    planMode?: boolean
  }

type PersistedChatPreferencesState = Pick<
  ChatPreferencesState,
  "defaultProvider" | "providerDefaults" | "chatStates" | "legacyComposerState"
> & LegacyPersistedChatPreferencesState

export function normalizeDefaultProvider(value?: string): DefaultProviderPreference {
  if (value === "claude" || value === "codex" || value === "cursor" || value === "pi") return value
  return "last_used"
}

// Loose model-options shape accepted by the provider preference normalizers. Each
// normalizer validates the fields it cares about, so options from any provider (or
// raw persisted data) are accepted and coerced.
type ProviderModelOptionsInput = {
  reasoningEffort?:
    | ClaudeModelOptions["reasoningEffort"]
    | CodexModelOptions["reasoningEffort"]
    | PiModelOptions["reasoningEffort"]
  contextWindow?: ClaudeModelOptions["contextWindow"]
  fastMode?: boolean
}

export function normalizeClaudePreference(value?: {
  model?: string
  effort?: string
  modelOptions?: ProviderModelOptionsInput
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
      reasoningEffort: !supportsClaudeMaxReasoningEffort(model) && normalizedEffort === "max" ? "high" : normalizedEffort,
      contextWindow,
      fastMode: normalizeClaudeFastMode(model, value?.modelOptions?.fastMode),
    },
    planMode: Boolean(value?.planMode),
  }
}

export function normalizeCodexPreference(value?: {
  model?: string
  effort?: string
  modelOptions?: ProviderModelOptionsInput
  planMode?: boolean
}): ProviderPreference<CodexModelOptions> {
  const model = normalizeCodexModelId(value?.model)
  const reasoningEffort = value?.modelOptions?.reasoningEffort
  return {
    model,
    modelOptions: {
      reasoningEffort: normalizeCodexReasoningEffort(
        model,
        isCodexReasoningEffort(reasoningEffort) ? reasoningEffort : value?.effort,
      ),
      fastMode: typeof value?.modelOptions?.fastMode === "boolean"
        ? value.modelOptions.fastMode
        : DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
    },
    planMode: Boolean(value?.planMode),
  }
}

export function normalizeCursorPreference(value?: {
  model?: string
  modelOptions?: ProviderModelOptionsInput
  planMode?: boolean
}): ProviderPreference<CursorModelOptions> {
  return {
    model: normalizeCursorModelId(value?.model),
    modelOptions: {
      fastMode: typeof value?.modelOptions?.fastMode === "boolean"
        ? value.modelOptions.fastMode
        : DEFAULT_CURSOR_MODEL_OPTIONS.fastMode,
    },
    planMode: false,
  }
}

export function normalizePiPreference(value?: {
  model?: string
  effort?: string
  modelOptions?: ProviderModelOptionsInput
  planMode?: boolean
}): ProviderPreference<PiModelOptions> {
  const reasoningEffort = value?.modelOptions?.reasoningEffort
  return {
    model: normalizePiModelId(value?.model),
    modelOptions: {
      reasoningEffort: normalizePiReasoningEffort(
        isPiReasoningEffort(reasoningEffort) ? reasoningEffort : value?.effort,
      ),
    },
    planMode: false,
  }
}

type ProviderPreferenceInput = {
  model?: string
  effort?: string
  modelOptions?: ProviderModelOptionsInput
  planMode?: boolean
}

// Exhaustive provider dispatch: adding a provider to AgentProvider forces a new case
// here (via assertNever) instead of silently falling through to one provider's branch.
export function normalizeProviderPreference(
  provider: AgentProvider,
  value?: ProviderPreferenceInput
): ChatProviderPreferences[AgentProvider] {
  switch (provider) {
    case "claude":
      return normalizeClaudePreference(value)
    case "codex":
      return normalizeCodexPreference(value)
    case "cursor":
      return normalizeCursorPreference(value)
    case "pi":
      return normalizePiPreference(value)
    default:
      return assertNever(provider)
  }
}

function composerStateForProvider(provider: AgentProvider, value?: ProviderPreferenceInput): ComposerState {
  switch (provider) {
    case "claude":
      return { provider, ...normalizeClaudePreference(value) }
    case "codex":
      return { provider, ...normalizeCodexPreference(value) }
    case "cursor":
      return { provider, ...normalizeCursorPreference(value) }
    case "pi":
      return { provider, ...normalizePiPreference(value) }
    default:
      return assertNever(provider)
  }
}

export function createDefaultProviderDefaults(): ChatProviderPreferences {
  return {
    claude: {
      model: "claude-opus-4-8",
      modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
      planMode: false,
    },
    codex: {
      model: "gpt-5.6-sol",
      modelOptions: { ...DEFAULT_CODEX_MODEL_OPTIONS },
      planMode: false,
    },
    cursor: {
      model: "composer-2.5",
      modelOptions: { ...DEFAULT_CURSOR_MODEL_OPTIONS },
      planMode: false,
    },
    pi: {
      model: DEFAULT_PI_MODEL,
      modelOptions: { ...DEFAULT_PI_MODEL_OPTIONS },
      planMode: false,
    },
  }
}

export function normalizeProviderDefaults(value?: {
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
  cursor?: {
    model?: string
    modelOptions?: Partial<CursorModelOptions>
    planMode?: boolean
  }
  pi?: {
    model?: string
    effort?: string
    modelOptions?: Partial<PiModelOptions>
    planMode?: boolean
  }
}): ChatProviderPreferences {
  return {
    claude: normalizeClaudePreference(value?.claude),
    codex: normalizeCodexPreference(value?.codex),
    cursor: normalizeCursorPreference(value?.cursor),
    pi: normalizePiPreference(value?.pi),
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
  return composerStateForProvider(provider, providerDefaults[provider])
}

function cloneComposerState(state: ComposerState): ComposerState {
  if (state.provider === "claude") {
    return {
      provider: "claude",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
    }
  }
  if (state.provider === "cursor") {
    return {
      provider: "cursor",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
    }
  }
  if (state.provider === "pi") {
    return {
      provider: "pi",
      model: state.model,
      modelOptions: { ...state.modelOptions },
      planMode: state.planMode,
    }
  }
  return {
    provider: "codex",
    model: state.model,
    modelOptions: { ...state.modelOptions },
    planMode: state.planMode,
  }
}

function sameComposerState(left: ComposerState | undefined, right: ComposerState): boolean {
  if (!left || left.provider !== right.provider) return false
  if (left.model !== right.model || left.planMode !== right.planMode) return false

  if (left.provider === "claude" && right.provider === "claude") {
    return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort
      && left.modelOptions.contextWindow === right.modelOptions.contextWindow
      && left.modelOptions.fastMode === right.modelOptions.fastMode
  }

  if (left.provider === "codex" && right.provider === "codex") {
    return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort
      && left.modelOptions.fastMode === right.modelOptions.fastMode
  }

  if (left.provider === "cursor" && right.provider === "cursor") {
    return left.modelOptions.fastMode === right.modelOptions.fastMode
  }

  if (left.provider === "pi" && right.provider === "pi") {
    return left.modelOptions.reasoningEffort === right.modelOptions.reasoningEffort
  }

  return false
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

  if (value?.provider === "cursor") {
    const preference = normalizeCursorPreference(value)
    return {
      provider: "cursor",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
    }
  }

  if (value?.provider === "pi") {
    const preference = normalizePiPreference(value)
    return {
      provider: "pi",
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
  persistedState: Partial<PersistedChatPreferencesState> | undefined
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
            [chatId]: composerState.provider === "claude"
              ? {
                provider: "claude",
                model: normalizeClaudePreference(composerState).model,
                modelOptions: normalizeClaudePreference(composerState).modelOptions,
                planMode: composerState.planMode,
              }
              : composerState.provider === "codex"
                ? {
                  provider: "codex",
                  model: normalizeCodexPreference(composerState).model,
                  modelOptions: normalizeCodexPreference(composerState).modelOptions,
                  planMode: composerState.planMode,
                }
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

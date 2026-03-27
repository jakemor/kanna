import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_CURSOR_MODEL_OPTIONS,
  DEFAULT_GEMINI_MODEL_OPTIONS,
  normalizeCursorModelId,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isGeminiThinkingMode,
  type AgentProvider,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type GeminiModelOptions,
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
  gemini: ProviderPreference<GeminiModelOptions>
  cursor: ProviderPreference<CursorModelOptions>
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
  | {
    provider: "gemini"
    model: string
    modelOptions: GeminiModelOptions
    planMode: boolean
  }
  | {
    provider: "cursor"
    model: string
    modelOptions: CursorModelOptions
    planMode: boolean
  }

type PersistedChatPreferencesState = Pick<
  ChatPreferencesState,
  "defaultProvider" | "providerDefaults" | "composerState" | "showProviderIconsInSideTray"
> & Partial<{
  liveProvider: AgentProvider
  livePreferences: ChatProviderPreferences
}>

function normalizeCodexModel(model?: string) {
  return model === "gpt-5-codex" ? "gpt-5.3-codex" : (model ?? "gpt-5.4")
}

function normalizeDefaultProvider(value?: string): DefaultProviderPreference {
  if (value === "claude" || value === "codex" || value === "gemini" || value === "cursor") return value
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
  const model = value?.model ?? "opus"

  return {
    model,
    modelOptions: {
      reasoningEffort: model !== "opus" && normalizedEffort === "max" ? "high" : normalizedEffort,
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

function normalizeGeminiPreference(value?: {
  model?: string
  modelOptions?: Partial<GeminiModelOptions>
  planMode?: boolean
}): ProviderPreference<GeminiModelOptions> {
  return {
    model: value?.model ?? "auto-gemini-2.5",
    modelOptions: {
      thinkingMode: isGeminiThinkingMode(value?.modelOptions?.thinkingMode)
        ? value.modelOptions.thinkingMode
        : DEFAULT_GEMINI_MODEL_OPTIONS.thinkingMode,
    },
    planMode: Boolean(value?.planMode),
  }
}

function normalizeCursorPreference(value?: {
  model?: string
  modelOptions?: Partial<CursorModelOptions>
  planMode?: boolean
}): ProviderPreference<CursorModelOptions> {
  void value?.modelOptions
  return {
    model: normalizeCursorModelId(value?.model ?? DEFAULT_CURSOR_MODEL),
    modelOptions: { ...DEFAULT_CURSOR_MODEL_OPTIONS },
    planMode: Boolean(value?.planMode),
  }
}

function createDefaultProviderDefaults(): ChatProviderPreferences {
  return {
    claude: {
      model: "opus",
      modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
      planMode: false,
    },
    codex: {
      model: "gpt-5.4",
      modelOptions: { ...DEFAULT_CODEX_MODEL_OPTIONS },
      planMode: false,
    },
    gemini: {
      model: "auto-gemini-2.5",
      modelOptions: { ...DEFAULT_GEMINI_MODEL_OPTIONS },
      planMode: false,
    },
    cursor: {
      model: DEFAULT_CURSOR_MODEL,
      modelOptions: { ...DEFAULT_CURSOR_MODEL_OPTIONS },
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
  gemini?: {
    model?: string
    modelOptions?: Partial<GeminiModelOptions>
    planMode?: boolean
  }
  cursor?: {
    model?: string
    modelOptions?: Partial<CursorModelOptions>
    planMode?: boolean
  }
}): ChatProviderPreferences {
  return {
    claude: normalizeClaudePreference(value?.claude),
    codex: normalizeCodexPreference(value?.codex),
    gemini: normalizeGeminiPreference(value?.gemini),
    cursor: normalizeCursorPreference(value?.cursor),
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

  if (provider === "gemini") {
    const preference = providerDefaults.gemini
    return {
      provider: "gemini",
      model: preference.model,
      modelOptions: { ...preference.modelOptions },
      planMode: preference.planMode,
    }
  }

  if (provider === "cursor") {
    const preference = providerDefaults.cursor
    return {
      provider: "cursor",
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

function normalizeComposerState(
  value: PersistedChatPreferencesState["composerState"] | undefined,
  providerDefaults: ChatProviderPreferences,
  legacyLiveProvider?: AgentProvider,
  legacyLivePreferences?: ChatProviderPreferences
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

  if (value?.provider === "gemini") {
    const preference = normalizeGeminiPreference(value)
    return {
      provider: "gemini",
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

  if (legacyLiveProvider === "cursor") {
    const preference = normalizeCursorPreference(legacyLivePreferences?.cursor)
    return {
      provider: "cursor",
      model: preference.model,
      modelOptions: preference.modelOptions,
      planMode: preference.planMode,
    }
  }

  return composerFromProviderDefaults("claude", providerDefaults)
}

interface ChatPreferencesState {
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  composerState: ComposerState
  showProviderIconsInSideTray: boolean
  setDefaultProvider: (provider: DefaultProviderPreference) => void
  setProviderDefaultModel: (provider: AgentProvider, model: string) => void
  setProviderDefaultModelOptions: <TProvider extends AgentProvider>(
    provider: TProvider,
    modelOptions: Partial<ProviderModelOptionsByProvider[TProvider]>
  ) => void
  setProviderDefaultPlanMode: (provider: AgentProvider, planMode: boolean) => void
  setShowProviderIconsInSideTray: (show: boolean) => void
  setComposerProvider: (provider: AgentProvider) => void
  setComposerModel: (model: string) => void
  setComposerModelOptions: (
    modelOptions: Partial<ClaudeModelOptions> | Partial<CodexModelOptions> | Partial<GeminiModelOptions> | Partial<CursorModelOptions>
  ) => void
  setComposerPlanMode: (planMode: boolean) => void
  resetComposerFromProvider: (provider: AgentProvider) => void
  initializeComposerForNewChat: () => void
}

export function migrateChatPreferencesState(
  persistedState: Partial<PersistedChatPreferencesState> | undefined
): Pick<ChatPreferencesState, "defaultProvider" | "providerDefaults" | "composerState" | "showProviderIconsInSideTray"> {
  const providerDefaults = normalizeProviderDefaults(persistedState?.providerDefaults)

  return {
    defaultProvider: normalizeDefaultProvider(persistedState?.defaultProvider),
    providerDefaults,
    showProviderIconsInSideTray: persistedState?.showProviderIconsInSideTray === true,
    composerState: normalizeComposerState(
      persistedState?.composerState,
      providerDefaults,
      persistedState?.liveProvider,
      persistedState?.livePreferences
    ),
  }
}

export const useChatPreferencesStore = create<ChatPreferencesState>()(
  persist(
    (set) => ({
      defaultProvider: "last_used",
      providerDefaults: createDefaultProviderDefaults(),
      showProviderIconsInSideTray: false,
      composerState: {
        provider: "claude",
        model: "opus",
        modelOptions: { ...DEFAULT_CLAUDE_MODEL_OPTIONS },
        planMode: false,
      },
      setDefaultProvider: (defaultProvider) => set({ defaultProvider }),
      setShowProviderIconsInSideTray: (showProviderIconsInSideTray) => set({ showProviderIconsInSideTray }),
      setProviderDefaultModel: (provider, model) =>
        set((state) => ({
          providerDefaults: {
            ...state.providerDefaults,
            [provider]: provider === "claude"
              ? normalizeClaudePreference({
                ...state.providerDefaults.claude,
                model,
              })
              : provider === "gemini"
                ? normalizeGeminiPreference({
                  ...state.providerDefaults.gemini,
                  model,
                })
                : provider === "cursor"
                  ? normalizeCursorPreference({
                    ...state.providerDefaults.cursor,
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
              : provider === "gemini"
                ? normalizeGeminiPreference({
                  ...state.providerDefaults.gemini,
                  modelOptions: {
                    ...state.providerDefaults.gemini.modelOptions,
                    ...modelOptions as Partial<GeminiModelOptions>,
                  },
                })
                : provider === "cursor"
                  ? normalizeCursorPreference({
                    ...state.providerDefaults.cursor,
                    modelOptions: {
                      ...state.providerDefaults.cursor.modelOptions,
                      ...modelOptions as Partial<CursorModelOptions>,
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
      setComposerProvider: (provider) =>
        set((state) => ({
          composerState: {
            ...state.composerState,
            provider,
          } as ComposerState,
        })),
      setComposerModel: (model) =>
        set((state) => {
          if (state.composerState.provider === "claude") {
            return {
              composerState: {
                provider: "claude",
                model,
                modelOptions: normalizeClaudePreference({
                  ...state.composerState,
                  model,
                }).modelOptions,
                planMode: state.composerState.planMode,
              } as ComposerState,
            }
          }
          if (state.composerState.provider === "gemini") {
            return {
              composerState: {
                provider: "gemini",
                model,
                modelOptions: normalizeGeminiPreference({
                  ...state.composerState,
                  model,
                }).modelOptions,
                planMode: state.composerState.planMode,
              } as ComposerState,
            }
          }
          if (state.composerState.provider === "cursor") {
            return {
              composerState: {
                provider: "cursor",
                model,
                modelOptions: normalizeCursorPreference({
                  ...state.composerState,
                  model,
                }).modelOptions,
                planMode: state.composerState.planMode,
              } as ComposerState,
            }
          }
          return {
            composerState: {
              provider: "codex",
              model,
              modelOptions: normalizeCodexPreference({
                ...state.composerState,
                model,
              }).modelOptions,
              planMode: state.composerState.planMode,
            } as ComposerState,
          }
        }),
      setComposerModelOptions: (modelOptions) =>
        set((state) => {
          if (state.composerState.provider === "claude") {
            return {
              composerState: {
                provider: "claude",
                model: state.composerState.model,
                modelOptions: normalizeClaudePreference({
                  ...state.composerState,
                  modelOptions: {
                    ...state.composerState.modelOptions,
                    ...modelOptions as Partial<ClaudeModelOptions>,
                  },
                }).modelOptions,
                planMode: state.composerState.planMode,
              } as ComposerState,
            }
          }
          if (state.composerState.provider === "gemini") {
            return {
              composerState: {
                provider: "gemini",
                model: state.composerState.model,
                modelOptions: normalizeGeminiPreference({
                  ...state.composerState,
                  modelOptions: {
                    ...state.composerState.modelOptions,
                    ...modelOptions as Partial<GeminiModelOptions>,
                  },
                }).modelOptions,
                planMode: state.composerState.planMode,
              } as ComposerState,
            }
          }
          if (state.composerState.provider === "cursor") {
            return {
              composerState: {
                provider: "cursor",
                model: state.composerState.model,
                modelOptions: normalizeCursorPreference({
                  ...state.composerState,
                  modelOptions: {
                    ...state.composerState.modelOptions,
                    ...modelOptions as Partial<CursorModelOptions>,
                  },
                }).modelOptions,
                planMode: state.composerState.planMode,
              } as ComposerState,
            }
          }
          return {
            composerState: {
              provider: "codex",
              model: state.composerState.model,
              modelOptions: normalizeCodexPreference({
                ...state.composerState,
                modelOptions: {
                  ...state.composerState.modelOptions,
                  ...modelOptions as Partial<CodexModelOptions>,
                },
              }).modelOptions,
              planMode: state.composerState.planMode,
            } as ComposerState,
          }
        }),
      setComposerPlanMode: (planMode) =>
        set((state) => ({
          composerState: {
            ...state.composerState,
            planMode,
          },
        })),
      resetComposerFromProvider: (provider) =>
        set((state) => ({
          composerState: composerFromProviderDefaults(provider, state.providerDefaults),
        })),
      initializeComposerForNewChat: () =>
        set((state) => {
          if (state.defaultProvider === "last_used") {
            logChatPreferences("initializeComposerForNewChat:last_used", {
              defaultProvider: state.defaultProvider,
              composerState: state.composerState,
              providerDefaults: state.providerDefaults,
            })
            return { composerState: { ...state.composerState } }
          }

          const nextComposerState = composerFromProviderDefaults(state.defaultProvider, state.providerDefaults)
          logChatPreferences("initializeComposerForNewChat:explicit_default", {
            defaultProvider: state.defaultProvider,
            composerState: nextComposerState,
            providerDefaults: state.providerDefaults,
          })

          return {
            composerState: nextComposerState,
          }
        }),
    }),
    {
      name: "chat-preferences",
      version: 5,
      migrate: (persistedState) => migrateChatPreferencesState(persistedState as Partial<PersistedChatPreferencesState> | undefined),
    }
  )
)

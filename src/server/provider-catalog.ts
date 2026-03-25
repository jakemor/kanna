import type {
  AgentProvider,
  ClaudeModelOptions,
  CodexModelOptions,
  GeminiModelOptions,
  ModelOptions,
  ProviderCatalogEntry,
  ProviderModelOption,
  ServiceTier,
} from "../shared/types"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  DEFAULT_GEMINI_MODEL_OPTIONS,
  PROVIDERS,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isGeminiThinkingMode,
} from "../shared/types"

const HARD_CODED_CODEX_MODELS: ProviderModelOption[] = [
  { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportsEffort: false },
]

const HARD_CODED_GEMINI_MODELS: ProviderModelOption[] = [
  { id: "auto-gemini-3", label: "Auto (Gemini 3)", supportsEffort: false },
  { id: "auto-gemini-2.5", label: "Auto (Gemini 2.5)", supportsEffort: false },
  { id: "gemini-3.1-pro-preview", label: "3.1 Pro Preview", supportsEffort: false },
  { id: "gemini-3-pro-preview", label: "3 Pro Preview", supportsEffort: false },
  { id: "gemini-3-flash-preview", label: "3 Flash Preview", supportsEffort: false },
  { id: "gemini-2.5-pro", label: "2.5 Pro", supportsEffort: false },
  { id: "gemini-2.5-flash", label: "2.5 Flash", supportsEffort: false },
  { id: "gemini-2.5-flash-lite", label: "2.5 Flash Lite", supportsEffort: false },
]

export const SERVER_PROVIDERS: ProviderCatalogEntry[] = PROVIDERS.map((provider) => {
  if (provider.id === "codex") {
    return {
      ...provider,
      defaultModel: "gpt-5.4",
      models: HARD_CODED_CODEX_MODELS,
    }
  }
  if (provider.id === "gemini") {
    return {
      ...provider,
      defaultModel: "auto-gemini-2.5",
      models: HARD_CODED_GEMINI_MODELS,
    }
  }
  return provider
})

export function getServerProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = SERVER_PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

export function normalizeServerModel(provider: AgentProvider, model?: string): string {
  const catalog = getServerProviderCatalog(provider)
  if (model && catalog.models.some((candidate) => candidate.id === model)) {
    return model
  }
  return catalog.defaultModel
}

export function normalizeClaudeModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): ClaudeModelOptions {
  const reasoningEffort = modelOptions?.claude?.reasoningEffort
  return {
    reasoningEffort: isClaudeReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isClaudeReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort,
  }
}

export function normalizeCodexModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): CodexModelOptions {
  const reasoningEffort = modelOptions?.codex?.reasoningEffort
  return {
    reasoningEffort: isCodexReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isCodexReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CODEX_MODEL_OPTIONS.reasoningEffort,
    fastMode: typeof modelOptions?.codex?.fastMode === "boolean"
      ? modelOptions.codex.fastMode
      : DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
  }
}

export function normalizeGeminiModelOptions(modelOptions?: ModelOptions): GeminiModelOptions {
  return {
    thinkingMode: isGeminiThinkingMode(modelOptions?.gemini?.thinkingMode)
      ? modelOptions.gemini.thinkingMode
      : DEFAULT_GEMINI_MODEL_OPTIONS.thinkingMode,
  }
}

export function codexServiceTierFromModelOptions(modelOptions: CodexModelOptions): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}

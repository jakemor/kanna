import type {
  AgentProvider,
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  ClaudeContextWindow,
  ModelOptions,
  PiModelOptions,
  ProviderCatalogEntry,
  ProviderModelOption,
  ServiceTier,
} from "../shared/types"
import {
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CURSOR_MODEL_OPTIONS,
  PROVIDERS,
  normalizeClaudeContextWindow,
  normalizeClaudeFastMode,
  normalizeCodexReasoningEffort,
  normalizePiReasoningEffort,
  normalizeProviderModelId,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isPiReasoningEffort,
  supportsProviderFastMode,
} from "../shared/types"

export interface ClaudeSdkModelInfo {
  value: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

function createServerProviders(): ProviderCatalogEntry[] {
  return structuredClone(PROVIDERS)
}

export const SERVER_PROVIDERS: ProviderCatalogEntry[] = createServerProviders()

export function resetServerProvidersForTests() {
  SERVER_PROVIDERS.splice(0, SERVER_PROVIDERS.length, ...createServerProviders())
}

function modelFamily(value: string) {
  const match = value.match(/^(?:claude-)?([a-z]+)(?:-|$)/i)
  return match?.[1]?.toLowerCase() ?? value.toLowerCase()
}

function sdkModelMatchScore(model: ClaudeSdkModelInfo, option: ProviderModelOption) {
  const modelValue = model.value.toLowerCase()
  if (modelValue === option.id.toLowerCase()) return 3
  if (option.aliases?.some((alias) => alias.toLowerCase() === modelValue)) return 2
  const optionKeys = [option.id, ...(option.aliases ?? [])].map(modelFamily)
  return optionKeys.includes(modelFamily(model.value)) ? 1 : 0
}

function findSdkModelForOption(models: readonly ClaudeSdkModelInfo[], option: ProviderModelOption) {
  let bestModel: ClaudeSdkModelInfo | undefined
  let bestScore = 0
  for (const model of models) {
    const score = sdkModelMatchScore(model, option)
    if (score > bestScore) {
      bestModel = model
      bestScore = score
    }
  }
  return bestModel
}

export function applyClaudeSdkModels(models: readonly ClaudeSdkModelInfo[]) {
  const claudeIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "claude")
  const claudeProvider = SERVER_PROVIDERS[claudeIndex]
  if (!claudeProvider) return false

  const nextModels = claudeProvider.models.map((option) => {
    const sdkModel = findSdkModelForOption(models, option)
    if (!sdkModel) return option
    return {
      ...option,
      label: sdkModel.displayName?.trim() || option.label,
      supportsEffort: sdkModel.supportsEffort ?? option.supportsEffort,
      supportsFastMode: sdkModel.supportsFastMode ?? option.supportsFastMode,
    }
  })

  if (JSON.stringify(nextModels) === JSON.stringify(claudeProvider.models)) {
    return false
  }

  SERVER_PROVIDERS.splice(claudeIndex, 1, {
    ...claudeProvider,
    models: nextModels,
  })
  return true
}

/**
 * Replace the pi provider's model list with the user's fave models from the
 * Model Registry settings (label + id). An empty list restores the built-in
 * suggestions. The catalog is only a picker — any model id remains valid.
 * Returns true when the catalog changed (callers should broadcast).
 */
export function applyPiFaveModels(faveModels: ReadonlyArray<{ label: string; id: string }>): boolean {
  const piIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "pi")
  const piProvider = SERVER_PROVIDERS[piIndex]
  if (!piProvider) return false

  const staticEntry = PROVIDERS.find((provider) => provider.id === "pi")
  const nextModels: ProviderModelOption[] = faveModels.length > 0
    ? faveModels.map((fave) => ({
      id: fave.id,
      label: fave.label || fave.id,
      supportsEffort: true,
    }))
    : structuredClone(staticEntry?.models ?? [])
  const nextDefaultModel = faveModels.length > 0
    ? faveModels[0]!.id
    : staticEntry?.defaultModel ?? piProvider.defaultModel

  if (
    nextDefaultModel === piProvider.defaultModel
    && JSON.stringify(nextModels) === JSON.stringify(piProvider.models)
  ) {
    return false
  }

  SERVER_PROVIDERS.splice(piIndex, 1, {
    ...piProvider,
    defaultModel: nextDefaultModel,
    models: nextModels,
  })
  return true
}

export function getServerProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = SERVER_PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

export function normalizeServerModel(provider: AgentProvider, model?: string): string {
  const catalog = getServerProviderCatalog(provider)
  const normalizedModel = normalizeProviderModelId(provider, model, catalog.defaultModel)
  // Pi accepts arbitrary OpenRouter model ids — the catalog is only a suggestion list.
  if (provider === "pi") {
    return normalizedModel
  }
  if (catalog.models.some((candidate) => candidate.id === normalizedModel)) {
    return normalizedModel
  }
  return catalog.defaultModel
}

export function normalizeClaudeModelOptions(
  model: string,
  modelOptions?: ModelOptions,
  legacyEffort?: string
): ClaudeModelOptions {
  const reasoningEffort = modelOptions?.claude?.reasoningEffort
  return {
    reasoningEffort: isClaudeReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isClaudeReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort,
    contextWindow: normalizeClaudeContextWindow(model, modelOptions?.claude?.contextWindow as ClaudeContextWindow | undefined),
    fastMode: normalizeClaudeFastMode(model, modelOptions?.claude?.fastMode),
  }
}

export function normalizeCodexModelOptions(
  model: string,
  modelOptions?: ModelOptions,
  legacyEffort?: string,
): CodexModelOptions {
  const reasoningEffort = modelOptions?.codex?.reasoningEffort
  return {
    reasoningEffort: normalizeCodexReasoningEffort(
      model,
      isCodexReasoningEffort(reasoningEffort) ? reasoningEffort : legacyEffort,
    ),
    // Spawn-time gating: fast mode only reaches models that support it
    // (per Codex docs: GPT-5.6/5.5/5.4 — not 5.3 Codex or Spark).
    fastMode: supportsProviderFastMode("codex", model) && modelOptions?.codex?.fastMode === true,
  }
}

// Claude and Codex both express fast mode as a "fast" service tier at spawn time.
export function serviceTierFromModelOptions(modelOptions: { fastMode: boolean }): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}

export function normalizePiModelOptions(
  modelOptions?: ModelOptions,
  legacyEffort?: string,
): PiModelOptions {
  const reasoningEffort = modelOptions?.pi?.reasoningEffort
  return {
    reasoningEffort: normalizePiReasoningEffort(
      isPiReasoningEffort(reasoningEffort) ? reasoningEffort : legacyEffort,
    ),
  }
}

export function normalizeCursorModelOptions(modelOptions?: ModelOptions): CursorModelOptions {
  return {
    fastMode: typeof modelOptions?.cursor?.fastMode === "boolean"
      ? modelOptions.cursor.fastMode
      : DEFAULT_CURSOR_MODEL_OPTIONS.fastMode,
  }
}

// Cursor encodes "fast" in the model id itself (composer-2.5 vs composer-2.5-fast),
// so we apply the suffix at spawn time rather than tracking a separate service tier.
export function cursorModelIdForOptions(baseModel: string, modelOptions: CursorModelOptions): string {
  if (!modelOptions.fastMode) return baseModel
  return baseModel.endsWith("-fast") ? baseModel : `${baseModel}-fast`
}

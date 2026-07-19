import type {
  AgentProvider,
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  ClaudeContextWindow,
  FaveModel,
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
  withPiFaveModels,
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

// The Agent SDK annotates some display names with their window, e.g.
// "Opus 4.8 (1M context)". Kanna surfaces the window separately, so drop the
// trailing parenthetical rather than duplicating it in the model label.
function sanitizeSdkDisplayName(displayName: string): string {
  return displayName.replace(/\s*\([^)]*context[^)]*\)\s*$/i, "").trim()
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
      label: (sdkModel.displayName ? sanitizeSdkDisplayName(sdkModel.displayName) : "") || option.label,
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
 * defaults. The catalog is only a picker — any model id remains valid.
 * Returns true when the catalog changed (callers should broadcast).
 */
export function applyPiFaveModels(faveModels: ReadonlyArray<FaveModel>): boolean {
  const piIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "pi")
  const piProvider = SERVER_PROVIDERS[piIndex]
  if (!piProvider) return false

  // withPiFaveModels leaves an empty list untouched, so route empties through
  // the static catalog to restore the built-in defaults.
  const nextProvider = withPiFaveModels(faveModels.length > 0 ? SERVER_PROVIDERS : PROVIDERS, faveModels)
    .find((provider) => provider.id === "pi")
  if (!nextProvider) return false

  if (
    nextProvider.defaultModel === piProvider.defaultModel
    && JSON.stringify(nextProvider.models) === JSON.stringify(piProvider.models)
  ) {
    return false
  }

  SERVER_PROVIDERS.splice(piIndex, 1, {
    ...piProvider,
    defaultModel: nextProvider.defaultModel,
    models: structuredClone(nextProvider.models),
  })
  return true
}

export interface CursorCliModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

// The Cursor list is long and flat, so group it by model family for the picker.
// Order requested by product: composer, then Anthropic, OpenAI/GPT, Kimi, GLM,
// Grok, Gemini, then everything else (e.g. "auto"). Grok ids are prefixed
// "cursor-grok-…", so match on substring rather than prefix.
function cursorModelGroupRank(id: string): number {
  if (id.startsWith("composer")) return 0
  if (id.startsWith("claude")) return 1
  if (id.startsWith("gpt")) return 2
  if (id.startsWith("kimi")) return 3
  if (id.startsWith("glm")) return 4
  if (id.includes("grok")) return 5
  if (id.startsWith("gemini")) return 6
  return 7
}

/**
 * Replace the cursor provider's model list with the account's live list from
 * `cursor-agent --list-models`. The CLI reports fast variants as separate
 * "<id>-fast" entries; those collapse into `supportsFastMode` on the base
 * model because Kanna exposes fast as a toggle (see cursorModelIdForOptions).
 * Returns true when the catalog changed (callers should broadcast).
 */
export function applyCursorModels(models: ReadonlyArray<CursorCliModelInfo>): boolean {
  const cursorIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "cursor")
  const cursorProvider = SERVER_PROVIDERS[cursorIndex]
  if (!cursorProvider) return false

  const ids = new Set(models.map((model) => model.id))
  const nextModels: ProviderModelOption[] = []
  for (const model of models) {
    // A "-fast" variant of another listed model folds into that model's toggle.
    if (model.id.endsWith("-fast") && ids.has(model.id.slice(0, -"-fast".length))) continue
    nextModels.push({
      id: model.id,
      label: model.label,
      supportsEffort: false,
      ...(ids.has(`${model.id}-fast`) ? { supportsFastMode: true } : {}),
    })
  }
  if (nextModels.length === 0) return false

  // Group by model family for the picker. Array.sort is stable, so each family
  // keeps the CLI's original ordering (which groups a model's effort variants).
  nextModels.sort((a, b) => cursorModelGroupRank(a.id) - cursorModelGroupRank(b.id))

  // Keep Kanna's default when the account still has it; otherwise fall back to
  // the CLI-marked default (e.g. "auto"), then the first listed model.
  const cliDefault = models.find((model) => model.isDefault)?.id
  const defaultModel = nextModels.some((model) => model.id === cursorProvider.defaultModel)
    ? cursorProvider.defaultModel
    : nextModels.find((model) => model.id === cliDefault)?.id ?? nextModels[0]!.id

  if (
    defaultModel === cursorProvider.defaultModel
    && JSON.stringify(nextModels) === JSON.stringify(cursorProvider.models)
  ) {
    return false
  }

  SERVER_PROVIDERS.splice(cursorIndex, 1, {
    ...cursorProvider,
    defaultModel,
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
  // Pi accepts arbitrary OpenRouter model ids, and Cursor's valid ids are
  // whatever the CLI reports (applyCursorModels) — for both, the catalog is
  // only a picker, so unknown ids pass through for the provider to validate.
  if (provider === "pi" || provider === "cursor") {
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
// A stale fastMode preference is dropped for models the CLI lists without a fast
// variant; models missing from the catalog keep the preference (the CLI validates).
export function cursorModelIdForOptions(baseModel: string, modelOptions: CursorModelOptions): string {
  if (!modelOptions.fastMode) return baseModel
  if (baseModel.endsWith("-fast")) return baseModel
  const option = getServerProviderCatalog("cursor").models.find((candidate) => candidate.id === baseModel)
  if (option && !option.supportsFastMode) return baseModel
  return `${baseModel}-fast`
}

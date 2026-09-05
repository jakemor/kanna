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
  CLAUDE_CONTEXT_WINDOW_OPTIONS,
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CURSOR_MODEL_OPTIONS,
  PROVIDERS,
  codexReasoningEffortLabel,
  deriveModelLabel,
  withPiFaveModels,
  normalizeClaudeContextWindow,
  normalizeClaudeFastMode,
  normalizeCodexReasoningEffort,
  normalizePiReasoningEffort,
  normalizeProviderModelId,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isPiReasoningEffort,
  modelIdFamily,
  supportsProviderFastMode,
} from "../shared/types"

export interface ClaudeSdkModelInfo {
  value: string
  /** Canonical wire id the row's value resolves to (e.g. "sonnet" → "claude-sonnet-5"). */
  resolvedModel?: string
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

/**
 * Rebuild the Claude picker from the SDK's supportedModels() list — the Claude
 * analog of applyCursorModels. Rows group by the family of the model they
 * resolve to, so role rows ("default" → claude-sonnet-5) and "[1m]" window
 * variants fold into their family's entry instead of appearing as their own.
 * One entry per family, keyed by the family alias (what Kanna stores and
 * spawns with) and labeled from the resolved wire id ("Sonnet 5") — the SDK's
 * display names ("Default (recommended)", versionless "Opus") are ignored.
 * Static catalog entries seed per-family metadata the SDK doesn't report
 * (context window options, max-effort support, fable's fixed 1M window).
 * Returns true when the catalog changed (callers should broadcast).
 */
export function applyClaudeSdkModels(models: readonly ClaudeSdkModelInfo[]) {
  const claudeIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "claude")
  const claudeProvider = SERVER_PROVIDERS[claudeIndex]
  if (!claudeProvider) return false

  const staticModels = PROVIDERS.find((provider) => provider.id === "claude")?.models ?? []

  const familyGroups = new Map<string, { rows: ClaudeSdkModelInfo[]; has1m: boolean }>()
  for (const row of models) {
    const wireId = row.resolvedModel ?? row.value
    const family = modelIdFamily(wireId)
    const group = familyGroups.get(family) ?? { rows: [], has1m: false }
    group.rows.push(row)
    if (row.value.includes("[1m]") || wireId.includes("[1m]")) group.has1m = true
    familyGroups.set(family, group)
  }
  if (familyGroups.size === 0) return false

  // Known families keep the static catalog's order; new ones append in SDK order.
  const orderedFamilies = [
    ...staticModels.map((option) => option.id).filter((id) => familyGroups.has(id)),
    ...[...familyGroups.keys()].filter((family) => !staticModels.some((option) => option.id === family)),
  ]

  const nextModels: ProviderModelOption[] = orderedFamilies.map((family) => {
    const group = familyGroups.get(family)!
    // Prefer the row named after the family over role rows ("default").
    const row = group.rows.find((candidate) => modelIdFamily(candidate.value) === family) ?? group.rows[0]!
    const staticOption = staticModels.find((option) => option.id === family)
    const contextWindowOptions = group.has1m
      ? [...CLAUDE_CONTEXT_WINDOW_OPTIONS]
      : staticOption?.contextWindowOptions
    return {
      id: family,
      label: deriveModelLabel(row.resolvedModel ?? row.value),
      supportsEffort: row.supportsEffort ?? staticOption?.supportsEffort ?? true,
      ...(contextWindowOptions ? { contextWindowOptions: [...contextWindowOptions] } : {}),
      ...(staticOption?.contextWindowTokens ? { contextWindowTokens: staticOption.contextWindowTokens } : {}),
      ...(staticOption?.supportsMaxReasoningEffort ? { supportsMaxReasoningEffort: true } : {}),
      ...((row.supportsFastMode ?? staticOption?.supportsFastMode) !== undefined
        ? { supportsFastMode: row.supportsFastMode ?? staticOption?.supportsFastMode }
        : {}),
    }
  })

  // The "default" role row marks the harness's recommended model.
  const defaultRow = models.find((row) => row.value === "default")
  const defaultFamily = defaultRow ? modelIdFamily(defaultRow.resolvedModel ?? defaultRow.value) : undefined
  const defaultModel = defaultFamily && familyGroups.has(defaultFamily) && defaultFamily !== "default"
    ? defaultFamily
    : claudeProvider.defaultModel

  if (
    defaultModel === claudeProvider.defaultModel
    && JSON.stringify(nextModels) === JSON.stringify(claudeProvider.models)
  ) {
    return false
  }

  SERVER_PROVIDERS.splice(claudeIndex, 1, {
    ...claudeProvider,
    defaultModel,
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

/** The fields of an app-server `model/list` row the catalog reads. */
export interface CodexAppServerModelInfo {
  /** The slug `thread/start` takes (e.g. "gpt-6-astra"). */
  model: string
  displayName?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: ReadonlyArray<{ reasoningEffort: string; description?: string }>
  additionalSpeedTiers?: ReadonlyArray<string>
  serviceTiers?: ReadonlyArray<{ id: string; name?: string }>
}

/**
 * Picker label from the app-server's display name. It hyphenates every word
 * ("GPT-5.6-Sol", "GPT-6-Astra"); keep the hyphen that joins the family to
 * its version and space the rest, matching the static labels ("GPT-5.6 Sol").
 */
function codexModelLabel(model: CodexAppServerModelInfo): string {
  const displayName = model.displayName?.trim()
  if (!displayName) return deriveModelLabel(model.model)
  return displayName.replace(/(?<!^[A-Za-z]+)-/g, " ")
}

/**
 * Replace the codex provider's model list with the account's live list from
 * the app-server (`model/list`) — the Codex analog of applyCursorModels. Each
 * row carries its own effort list, default effort and speed tiers, so a model
 * OpenAI rolls out mid-session shows up with the right controls without a
 * Kanna release. Static catalog entries only seed aliases (legacy ids that
 * migrate to a row). Returns true when the catalog changed (callers should
 * broadcast).
 */
export function applyCodexModels(models: ReadonlyArray<CodexAppServerModelInfo>): boolean {
  const codexIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "codex")
  const codexProvider = SERVER_PROVIDERS[codexIndex]
  if (!codexProvider) return false

  const staticModels = PROVIDERS.find((provider) => provider.id === "codex")?.models ?? []
  const nextModels: ProviderModelOption[] = []
  for (const model of models) {
    const id = model.model.trim()
    if (!id || nextModels.some((existing) => existing.id === id)) continue
    const efforts = (model.supportedReasoningEfforts ?? [])
      .map((option) => option.reasoningEffort.trim())
      .filter((effort, index, all) => effort.length > 0 && all.indexOf(effort) === index)
    const supportedReasoningEfforts = efforts.map((effort) => {
      const description = model.supportedReasoningEfforts
        ?.find((option) => option.reasoningEffort.trim() === effort)?.description?.trim()
      return { id: effort, label: codexReasoningEffortLabel(effort), ...(description ? { description } : {}) }
    })
    const defaultReasoningEffort = efforts.includes(model.defaultReasoningEffort?.trim() ?? "")
      ? model.defaultReasoningEffort!.trim()
      : efforts[0]
    // Kanna spawns fast mode as the "fast" service tier. Newer servers list it
    // under serviceTiers (id "priority", named "Fast"); older ones under the
    // deprecated additionalSpeedTiers.
    const supportsFastMode = (model.additionalSpeedTiers ?? []).includes("fast")
      || (model.serviceTiers ?? []).some((tier) => tier.id === "fast" || tier.id === "priority")
    const staticOption = staticModels.find((option) => option.id === id)
    nextModels.push({
      id,
      label: codexModelLabel(model),
      supportsEffort: supportedReasoningEfforts.length > 0,
      ...(staticOption?.aliases ? { aliases: [...staticOption.aliases] } : {}),
      ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      supportsFastMode,
    })
  }
  if (nextModels.length === 0) return false

  // Keep Kanna's default when the account still has it; otherwise the
  // server-marked default, then the first listed model.
  const serverDefault = models.find((model) => model.isDefault)?.model.trim()
  const defaultModel = nextModels.some((model) => model.id === codexProvider.defaultModel)
    ? codexProvider.defaultModel
    : nextModels.find((model) => model.id === serverDefault)?.id ?? nextModels[0]!.id

  if (
    defaultModel === codexProvider.defaultModel
    && JSON.stringify(nextModels) === JSON.stringify(codexProvider.models)
  ) {
    return false
  }

  SERVER_PROVIDERS.splice(codexIndex, 1, {
    ...codexProvider,
    defaultModel,
    models: nextModels,
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
  // Pi accepts arbitrary OpenRouter model ids; the other three's valid ids are
  // whatever the harness reports at runtime (applyClaudeSdkModels /
  // applyCodexModels / applyCursorModels) — the catalog is only a picker, so
  // unknown ids pass through for the provider to validate.
  return normalizeProviderModelId(provider, model, catalog.defaultModel)
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
  // The live catalog (applyCodexModels) decides what each model supports; a
  // model it does not list keeps the static row's rules, or the shared
  // defaults when there is none.
  const liveModels = getServerProviderCatalog("codex").models
  const liveOption = liveModels.find((candidate) => candidate.id === normalizeProviderModelId("codex", model))
  return {
    reasoningEffort: normalizeCodexReasoningEffort(
      model,
      isCodexReasoningEffort(reasoningEffort) ? reasoningEffort : legacyEffort,
      liveModels,
    ),
    // Spawn-time gating: fast mode only reaches models that advertise the
    // tier, so a stale preference never fails a turn on a model without it.
    fastMode: (liveOption ? Boolean(liveOption.supportsFastMode) : supportsProviderFastMode("codex", model))
      && modelOptions?.codex?.fastMode === true,
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

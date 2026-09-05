import { afterEach, describe, expect, test } from "bun:test"
import {
  SERVER_PROVIDERS,
  applyClaudeSdkModels,
  applyCursorModels,
  applyPiFaveModels,
  cursorModelIdForOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeServerModel,
  resetServerProvidersForTests,
  serviceTierFromModelOptions,
} from "./provider-catalog"
import { DEFAULT_PI_FAVE_MODELS, DEFAULT_PI_MODEL, resolveClaudeApiModelId } from "../shared/types"

describe("provider catalog normalization", () => {
  afterEach(() => {
    resetServerProvidersForTests()
  })

  test("applyPiFaveModels replaces the pi picker and default model", () => {
    const changed = applyPiFaveModels([
      { label: "Fast Kimi", id: "moonshotai/kimi-k2.5:nitro" },
      { label: "Sonnet", id: "anthropic/claude-sonnet-5" },
    ])
    expect(changed).toBe(true)

    const pi = SERVER_PROVIDERS.find((provider) => provider.id === "pi")
    expect(pi?.defaultModel).toBe("moonshotai/kimi-k2.5:nitro")
    expect(pi?.models.map((model) => [model.id, model.label])).toEqual([
      ["moonshotai/kimi-k2.5:nitro", "Fast Kimi"],
      ["anthropic/claude-sonnet-5", "Sonnet"],
    ])

    // Arbitrary ids still pass through the server model normalizer.
    expect(normalizeServerModel("pi", "someone/else")).toBe("someone/else")
    // Re-applying the same faves reports no change.
    expect(applyPiFaveModels([
      { label: "Fast Kimi", id: "moonshotai/kimi-k2.5:nitro" },
      { label: "Sonnet", id: "anthropic/claude-sonnet-5" },
    ])).toBe(false)
  })

  test("applyPiFaveModels with an empty list restores the built-in defaults", () => {
    applyPiFaveModels([{ label: "Only", id: "x/y" }])
    const changed = applyPiFaveModels([])
    expect(changed).toBe(true)

    const pi = SERVER_PROVIDERS.find((provider) => provider.id === "pi")
    expect(pi?.defaultModel).toBe(DEFAULT_PI_MODEL)
    expect(pi?.models.map((model) => model.id)).toEqual(DEFAULT_PI_FAVE_MODELS.map((fave) => fave.id))
  })

  test("maps legacy Claude effort into shared model options", () => {
    expect(normalizeClaudeModelOptions("claude-opus-4-8", undefined, "max")).toEqual({
      reasoningEffort: "max",
      contextWindow: "1m",
      fastMode: false,
    })
  })

  test("normalizes Claude fast mode only for supported models", () => {
    const opus = normalizeClaudeModelOptions("claude-opus-4-8", {
      claude: { reasoningEffort: "high", fastMode: true },
    })
    expect(opus.fastMode).toBe(true)
    expect(serviceTierFromModelOptions(opus)).toBe("fast")

    // Sonnet does not support fast mode — the flag is dropped.
    expect(normalizeClaudeModelOptions("claude-sonnet-4-6", {
      claude: { reasoningEffort: "high", fastMode: true },
    }).fastMode).toBe(false)

    expect(serviceTierFromModelOptions(normalizeClaudeModelOptions("claude-opus-4-8", undefined))).toBeUndefined()
  })

  test("normalizes Claude context window only for supported models", () => {
    expect(normalizeClaudeModelOptions("claude-sonnet-4-6", {
      claude: {
        reasoningEffort: "medium",
        contextWindow: "1m",
      },
    })).toEqual({
      reasoningEffort: "medium",
      contextWindow: "1m",
      fastMode: false,
    })

    expect(normalizeClaudeModelOptions("claude-haiku-4-5-20251001", {
      claude: {
        reasoningEffort: "medium",
        contextWindow: "1m",
      },
    })).toMatchObject({
      reasoningEffort: "medium",
    })
  })

  test("normalizes Codex model options and fast mode defaults", () => {
    expect(normalizeCodexModelOptions("gpt-5.6-sol", undefined)).toEqual({
      reasoningEffort: "medium",
      fastMode: false,
    })

    expect(normalizeCodexModelOptions("gpt-6-astra", {
      codex: { reasoningEffort: "ultra", fastMode: true },
    })).toEqual({
      reasoningEffort: "ultra",
      fastMode: true,
    })

    const normalized = normalizeCodexModelOptions("gpt-5.6-terra", {
      codex: {
        reasoningEffort: "xhigh",
        fastMode: true,
      },
    })

    expect(normalized).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    })
    expect(serviceTierFromModelOptions(normalized)).toBe("fast")

    // Fast mode is stripped at spawn time for models the Codex docs don't
    // list as supported (GPT-5.3 Codex, Codex Spark).
    expect(normalizeCodexModelOptions("gpt-5.3-codex", {
      codex: { reasoningEffort: "high", fastMode: true },
    }).fastMode).toBe(false)
    expect(normalizeCodexModelOptions("gpt-5.3-codex-spark", {
      codex: { reasoningEffort: "high", fastMode: true },
    }).fastMode).toBe(false)

    expect(normalizeCodexModelOptions("gpt-5.6-sol", {
      codex: { reasoningEffort: "ultra" },
    }).reasoningEffort).toBe("ultra")
    expect(normalizeCodexModelOptions("gpt-5.6-luna", {
      codex: { reasoningEffort: "ultra" },
    }).reasoningEffort).toBe("max")
    expect(normalizeCodexModelOptions("gpt-5.6-luna", undefined, "minimal").reasoningEffort).toBe("low")
  })

  test("normalizes Cursor model options and applies the fast model suffix", () => {
    expect(normalizeCursorModelOptions(undefined)).toEqual({ fastMode: false })
    expect(normalizeCursorModelOptions({ cursor: { fastMode: true } })).toEqual({ fastMode: true })

    expect(cursorModelIdForOptions("composer-2.5", { fastMode: false })).toBe("composer-2.5")
    expect(cursorModelIdForOptions("composer-2.5", { fastMode: true })).toBe("composer-2.5-fast")
    // Idempotent if the base id already carries the suffix.
    expect(cursorModelIdForOptions("composer-2.5-fast", { fastMode: true })).toBe("composer-2.5-fast")
  })

  test("resolves the Cursor default model through the server catalog", () => {
    // Exercises the catalog lookup + default fallback (throws if "cursor" is unregistered).
    expect(normalizeServerModel("cursor")).toBe("composer-2.5")
    expect(normalizeServerModel("cursor", "composer-2.5-fast")).toBe("composer-2.5")
    // Runtime-discovered ids (cursor-agent --list-models) pass through even
    // when the catalog overlay hasn't been applied — the CLI validates them.
    expect(normalizeServerModel("cursor", "gpt-5.3-codex-high")).toBe("gpt-5.3-codex-high")
  })

  test("applyCursorModels collapses -fast variants into the fast-mode toggle", () => {
    const listed = [
      { id: "auto", label: "Auto", isDefault: true },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
      { id: "claude-fable-5-thinking-high", label: "Fable 5 1M Thinking" },
    ]
    expect(applyCursorModels(listed)).toBe(true)

    const cursor = SERVER_PROVIDERS.find((provider) => provider.id === "cursor")
    // Kanna's default survives because the account still has it.
    expect(cursor?.defaultModel).toBe("composer-2.5")
    // Sorted by family: composer, then Anthropic, then "others" (auto).
    expect(cursor?.models.map((model) => [model.id, Boolean(model.supportsFastMode)])).toEqual([
      ["composer-2.5", true],
      ["claude-fable-5-thinking-high", false],
      ["auto", false],
    ])

    // The fast suffix only applies to models with a listed -fast variant.
    expect(cursorModelIdForOptions("composer-2.5", { fastMode: true })).toBe("composer-2.5-fast")
    expect(cursorModelIdForOptions("auto", { fastMode: true })).toBe("auto")
    // Models missing from the catalog keep the preference (the CLI validates).
    expect(cursorModelIdForOptions("gpt-5.2", { fastMode: true })).toBe("gpt-5.2-fast")

    // Re-applying the same list reports no change.
    expect(applyCursorModels(listed)).toBe(false)
  })

  test("applyCursorModels groups models by family and preserves CLI order within a group", () => {
    // Intentionally interleaved input across families and generations.
    applyCursorModels([
      { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol High" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
      { id: "auto", label: "Auto", isDefault: true },
      { id: "claude-opus-4-8-max", label: "Opus 4.8 Max" },
      { id: "cursor-grok-4.5-high", label: "Grok 4.5" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7" },
      { id: "gpt-5.6-sol-low", label: "GPT-5.6 Sol Low" },
      { id: "glm-5.2-max", label: "GLM 5.2 Max" },
    ])
    const cursor = SERVER_PROVIDERS.find((provider) => provider.id === "cursor")
    expect(cursor?.models.map((model) => model.id)).toEqual([
      "composer-2.5",
      "claude-opus-4-8-max",
      // GPT family keeps its original relative order (High before Low).
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-low",
      "kimi-k2.7-code",
      "glm-5.2-max",
      "cursor-grok-4.5-high",
      "gemini-3.1-pro",
      "auto",
    ])
  })

  test("applyCursorModels falls back to the CLI-marked default and ignores empty lists", () => {
    expect(applyCursorModels([])).toBe(false)

    applyCursorModels([
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "auto", label: "Auto", isDefault: true },
    ])
    const cursor = SERVER_PROVIDERS.find((provider) => provider.id === "cursor")
    expect(cursor?.defaultModel).toBe("auto")
  })

  test("normalizes server model ids through the shared alias catalog", () => {
    expect(normalizeServerModel("codex")).toBe("gpt-5.6-sol")
    expect(normalizeServerModel("codex", "gpt-6-astra")).toBe("gpt-6-astra")
    expect(normalizeServerModel("claude", "fable")).toBe("fable")
    expect(normalizeServerModel("claude", "opus")).toBe("opus")
    // Version-pinned ids persisted by older Kanna versions fold into the alias.
    expect(normalizeServerModel("claude", "claude-opus-4-8")).toBe("opus")
    expect(normalizeServerModel("claude", "claude-haiku-4-5-20251001")).toBe("haiku")
    expect(normalizeServerModel("codex", "gpt-5-codex")).toBe("gpt-5.3-codex")
    expect(normalizeServerModel("codex", "gpt-5.6")).toBe("gpt-5.6-sol")
  })

  test("resolves Claude API model ids for 1m context window", () => {
    expect(resolveClaudeApiModelId("opus", "1m")).toBe("opus[1m]")
    expect(resolveClaudeApiModelId("fable", "200k")).toBe("fable")
    expect(resolveClaudeApiModelId("sonnet", "200k")).toBe("sonnet")
    // Version-pinned ids still resolve their window via the family alias.
    expect(resolveClaudeApiModelId("claude-opus-4-8", "1m")).toBe("claude-opus-4-8[1m]")

    // A stored "1m" preference never leaks a [1m] suffix onto models without
    // context window options — it's clamped at resolution time.
    expect(resolveClaudeApiModelId("fable", "1m")).toBe("fable")
    expect(resolveClaudeApiModelId("haiku", "1m")).toBe("haiku")
  })

  test("rebuilds the Claude picker from the SDK model list, labeled by resolved model", () => {
    // A real supportedModels() shape: a "default" role row sharing its
    // resolved model with the "sonnet" row, versionless display names, no
    // fable row on this account.
    expect(applyClaudeSdkModels([
      { value: "default", resolvedModel: "claude-sonnet-5", displayName: "Default (recommended)", supportsEffort: true },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: true },
      { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", supportsEffort: true, supportsFastMode: true },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    ])).toBe(true)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    // One entry per family in static-catalog order; the "default" role row
    // folds into sonnet instead of appearing as its own entry, and fable is
    // absent because the account has no fable row.
    expect(claude?.models.map((model) => [model.id, model.label])).toEqual([
      ["opus", "Opus 5"],
      ["sonnet", "Sonnet 5"],
      ["haiku", "Haiku 4.5"],
    ])
    // The recommended ("default") row drives the default model.
    expect(claude?.defaultModel).toBe("sonnet")
    // Static per-family metadata the SDK doesn't report is preserved.
    const opus = claude?.models.find((model) => model.id === "opus")
    expect(opus?.supportsMaxReasoningEffort).toBe(true)
    expect(opus?.supportsFastMode).toBe(true)
    expect(opus?.contextWindowOptions?.map((option) => option.id)).toEqual(["1m", "200k"])
    expect(claude?.models.find((model) => model.id === "haiku")?.contextWindowOptions).toBeUndefined()
  })

  test("Claude rebuild keeps fable's fixed window, folds [1m] rows, and admits new families", () => {
    expect(applyClaudeSdkModels([
      { value: "fable", resolvedModel: "claude-fable-5", displayName: "Fable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: true },
      { value: "sonnet[1m]", resolvedModel: "claude-sonnet-5[1m]", displayName: "Sonnet (1M context)", supportsEffort: true },
      // A family Kanna has never heard of still gets a picker entry.
      { value: "nova", resolvedModel: "claude-nova-2", displayName: "Nova" },
    ])).toBe(true)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    expect(claude?.models.map((model) => [model.id, model.label])).toEqual([
      ["fable", "Fable 5"],
      ["sonnet", "Sonnet 5"],
      ["nova", "Nova 2"],
    ])
    // Fable keeps its pinned fixed window; the [1m] variant row collapses
    // into sonnet's context window selector rather than its own entry.
    expect(claude?.models.find((model) => model.id === "fable")?.contextWindowTokens).toBe(1_000_000)
    expect(claude?.models.find((model) => model.id === "sonnet")?.contextWindowOptions?.map((option) => option.id))
      .toEqual(["1m", "200k"])
    // No "default" row → the default model is left alone.
    expect(claude?.defaultModel).toBe("sonnet")

    // Re-applying the same list reports no change.
    expect(applyClaudeSdkModels([
      { value: "fable", resolvedModel: "claude-fable-5", displayName: "Fable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: true },
      { value: "sonnet[1m]", resolvedModel: "claude-sonnet-5[1m]", displayName: "Sonnet (1M context)", supportsEffort: true },
      { value: "nova", resolvedModel: "claude-nova-2", displayName: "Nova" },
    ])).toBe(false)
  })
})

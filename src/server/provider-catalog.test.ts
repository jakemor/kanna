import { afterEach, describe, expect, test } from "bun:test"
import {
  SERVER_PROVIDERS,
  applyClaudeSdkModels,
  applyPiFaveModels,
  cursorModelIdForOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeServerModel,
  resetServerProvidersForTests,
  serviceTierFromModelOptions,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"

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

  test("applyPiFaveModels with an empty list restores the built-in suggestions", () => {
    applyPiFaveModels([{ label: "Only", id: "x/y" }])
    const changed = applyPiFaveModels([])
    expect(changed).toBe(true)

    const pi = SERVER_PROVIDERS.find((provider) => provider.id === "pi")
    expect(pi?.defaultModel).toBe("moonshotai/kimi-k2.6")
    expect(pi?.models.some((model) => model.id === "moonshotai/kimi-k2.6")).toBe(true)
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
  })

  test("normalizes server model ids through the shared alias catalog", () => {
    expect(normalizeServerModel("codex")).toBe("gpt-5.6-sol")
    expect(normalizeServerModel("claude", "fable")).toBe("fable")
    expect(normalizeServerModel("claude", "opus")).toBe("claude-opus-4-8")
    expect(normalizeServerModel("codex", "gpt-5-codex")).toBe("gpt-5.3-codex")
    expect(normalizeServerModel("codex", "gpt-5.6")).toBe("gpt-5.6-sol")
  })

  test("resolves Claude API model ids for 1m context window", () => {
    expect(resolveClaudeApiModelId("claude-opus-4-8", "1m")).toBe("claude-opus-4-8[1m]")
    expect(resolveClaudeApiModelId("fable", "200k")).toBe("fable")
    expect(resolveClaudeApiModelId("claude-sonnet-4-6", "200k")).toBe("claude-sonnet-4-6")

    // A stored "1m" preference never leaks a [1m] suffix onto models without
    // context window options — it's clamped at resolution time.
    expect(resolveClaudeApiModelId("fable", "1m")).toBe("fable")
    expect(resolveClaudeApiModelId("claude-haiku-4-5-20251001", "1m")).toBe("claude-haiku-4-5-20251001")
  })

  test("overlays Claude model labels from the Agent SDK model catalog", () => {
    expect(applyClaudeSdkModels([
      { value: "claude-fable-5[1m]", displayName: "Fable from SDK", supportsEffort: true },
      { value: "claude-opus-4-7", displayName: "Opus 4.7", supportsEffort: true },
      { value: "claude-opus-4-8", displayName: "Opus from SDK", supportsEffort: true },
    ])).toBe(true)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    expect(claude?.models.find((model) => model.id === "fable")?.label).toBe("Fable from SDK")
    expect(claude?.models.find((model) => model.id === "claude-opus-4-8")?.label).toBe("Opus from SDK")
  })
})

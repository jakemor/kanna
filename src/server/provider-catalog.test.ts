import { afterEach, describe, expect, test } from "bun:test"
import {
  SERVER_PROVIDERS,
  applyClaudeSdkModels,
  codexServiceTierFromModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
  resetServerProvidersForTests,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"

describe("provider catalog normalization", () => {
  afterEach(() => {
    resetServerProvidersForTests()
  })

  test("maps legacy Claude effort into shared model options", () => {
    expect(normalizeClaudeModelOptions("claude-opus-4-8", undefined, "max")).toEqual({
      reasoningEffort: "max",
      contextWindow: "200k",
    })
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
    expect(codexServiceTierFromModelOptions(normalized)).toBe("fast")

    expect(normalizeCodexModelOptions("gpt-5.6-sol", {
      codex: { reasoningEffort: "ultra" },
    }).reasoningEffort).toBe("ultra")
    expect(normalizeCodexModelOptions("gpt-5.6-luna", {
      codex: { reasoningEffort: "ultra" },
    }).reasoningEffort).toBe("max")
    expect(normalizeCodexModelOptions("gpt-5.6-luna", undefined, "minimal").reasoningEffort).toBe("low")
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

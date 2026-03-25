import { describe, expect, test } from "bun:test"
import {
  codexServiceTierFromModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeGeminiModelOptions,
} from "./provider-catalog"

describe("provider catalog normalization", () => {
  test("maps legacy Claude effort into shared model options", () => {
    expect(normalizeClaudeModelOptions(undefined, "max")).toEqual({
      reasoningEffort: "max",
    })
  })

  test("normalizes Codex model options and fast mode defaults", () => {
    expect(normalizeCodexModelOptions(undefined)).toEqual({
      reasoningEffort: "high",
      fastMode: false,
    })

    const normalized = normalizeCodexModelOptions({
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
  })

  test("normalizes Gemini thinking mode independently", () => {
    expect(normalizeGeminiModelOptions(undefined)).toEqual({
      thinkingMode: "standard",
    })

    expect(normalizeGeminiModelOptions({
      gemini: {
        thinkingMode: "high",
      },
    })).toEqual({
      thinkingMode: "high",
    })
  })
})

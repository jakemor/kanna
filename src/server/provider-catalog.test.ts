import { describe, expect, test } from "bun:test"
import {
  codexServiceTierFromModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeGeminiModelOptions,
  normalizeServerModel,
} from "./provider-catalog"
import { DEFAULT_CURSOR_MODEL } from "../shared/types"

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

  test("normalizes Cursor fast mode independently", () => {
    expect(normalizeCursorModelOptions(undefined)).toEqual({
    })

    expect(normalizeCursorModelOptions({
      cursor: {},
    })).toEqual({
    })
  })

  test("maps legacy Cursor model ids to ACP model ids", () => {
    expect(normalizeServerModel("cursor", "gemini-3.1-pro")).toBe("gemini-3.1-pro[]")
    expect(normalizeServerModel("cursor", "claude-4.6-opus-high-thinking")).toBe(DEFAULT_CURSOR_MODEL)
  })
})

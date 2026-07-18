import { describe, expect, test } from "bun:test"
import {
  deriveClaudeModelLabel,
  deriveModelLabel,
  getCodexReasoningOptions,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  normalizeCodexReasoningEffort,
  isCodexReasoningEffort,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("shared model normalization", () => {
  test("derives fallback Claude model labels from model ids", () => {
    expect(deriveClaudeModelLabel("fable")).toBe("Fable")
    expect(deriveClaudeModelLabel("claude-opus-4-8")).toBe("Opus")
    expect(deriveClaudeModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku")
  })

  test("normalizes Claude aliases via the provider catalog", () => {
    expect(normalizeClaudeModelId("fable")).toBe("fable")
    expect(normalizeClaudeModelId("opus")).toBe("claude-opus-4-8")
    expect(normalizeClaudeModelId("sonnet")).toBe("claude-sonnet-4-6")
    expect(normalizeClaudeModelId("haiku")).toBe("claude-haiku-4-5-20251001")
  })

  test("normalizes legacy Codex aliases and defaults to the latest catalog model", () => {
    expect(normalizeCodexModelId()).toBe("gpt-5.6-sol")
    expect(normalizeCodexModelId("gpt-5.6")).toBe("gpt-5.6-sol")
    expect(normalizeCodexModelId("gpt-5.6-terra")).toBe("gpt-5.6-terra")
    expect(normalizeCodexModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5.3-codex")
    expect(normalizeCodexModelId("not-a-real-model")).toBe("gpt-5.6-sol")
  })

  test("exposes model-specific GPT-5.6 reasoning efforts", () => {
    expect(getCodexReasoningOptions("gpt-5.6-sol").map((option) => option.id)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ])
    expect(getCodexReasoningOptions("gpt-5.6-terra").map((option) => option.id)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ])
    expect(getCodexReasoningOptions("gpt-5.6-luna").map((option) => option.id)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ])
  })

  test("preserves all 17 supported GPT-5.6 model and reasoning combinations", () => {
    const combinations = [
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
      ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
      ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
    ] as const

    expect(combinations.reduce((count, [, efforts]) => count + efforts.length, 0)).toBe(17)
    for (const [model, efforts] of combinations) {
      for (const effort of efforts) {
        expect(normalizeCodexReasoningEffort(model, effort)).toBe(effort)
      }
    }
  })

  test("normalizes unsupported GPT-5.6 reasoning efforts", () => {
    expect(normalizeCodexReasoningEffort("gpt-5.6-sol", "minimal")).toBe("low")
    expect(normalizeCodexReasoningEffort("gpt-5.6-luna", "ultra")).toBe("max")
    expect(normalizeCodexReasoningEffort("gpt-5.6-terra", "ultra")).toBe("ultra")
    expect(normalizeCodexReasoningEffort("gpt-5.6-sol", "unknown")).toBe("medium")
  })

  test("recognizes public and legacy Codex reasoning values", () => {
    expect(isCodexReasoningEffort("max")).toBe(true)
    expect(isCodexReasoningEffort("ultra")).toBe(true)
    expect(isCodexReasoningEffort("minimal")).toBe(true)
    expect(getCodexReasoningOptions("gpt-5.6-sol").find((option) => option.id === "xhigh")?.label).toBe("Extra High")
    expect(getCodexReasoningOptions("gpt-5.6-sol").find((option) => option.id === "ultra")?.description).toBe("Delegates to subagents more")
  })

  test("uses declarative metadata for Claude max-effort support", () => {
    expect(supportsClaudeMaxReasoningEffort("claude-opus-4-8")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("fable")).toBe(false)
    expect(supportsClaudeMaxReasoningEffort("claude-sonnet-4-6")).toBe(false)
  })

  test("derives display labels from bare model ids", () => {
    expect(deriveModelLabel("lab/kimi-k2.5:nitro")).toBe("Kimi K2.5")
    expect(deriveModelLabel("gpt-5.6-sol")).toBe("GPT 5.6 Sol")
    expect(deriveModelLabel("openai/gpt-5.6")).toBe("GPT 5.6")
    expect(deriveModelLabel("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5")
    expect(deriveModelLabel("deepseek/deepseek-v4-pro")).toBe("Deepseek V4 Pro")
    expect(deriveModelLabel("z-ai/glm-5.2")).toBe("GLM 5.2")
  })
})

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TRANSCRIPT_DETAIL,
  resolveTranscriptDetail,
  supportsThinkingDetail,
  transcriptDetailProvider,
  transcriptDetailOptions,
} from "./transcriptDetail"

describe("transcript detail by provider", () => {
  test("every harness that records reasoning keeps the thinking level", () => {
    expect(supportsThinkingDetail("claude")).toBe(true)
    expect(supportsThinkingDetail("cursor")).toBe(true)
    expect(supportsThinkingDetail("pi")).toBe(true)
    expect(supportsThinkingDetail("codex")).toBe(false)
  })

  test("a chat with no provider yet keeps every level", () => {
    expect(supportsThinkingDetail(null)).toBe(true)
    expect(transcriptDetailOptions(null)).toContain("thinking")
  })

  test("the picker drops thinking only for codex", () => {
    expect(transcriptDetailOptions("codex")).toEqual(["summary", "normal", "verbose"])
    expect(transcriptDetailOptions("claude")).toContain("thinking")
    expect(transcriptDetailOptions("cursor")).toContain("thinking")
    expect(transcriptDetailOptions("pi")).toContain("thinking")
  })

  test("a stored thinking level falls back when the chat switches provider", () => {
    expect(resolveTranscriptDetail("thinking", "codex")).toBe(DEFAULT_TRANSCRIPT_DETAIL)
    expect(resolveTranscriptDetail("thinking", "claude")).toBe("thinking")
    expect(resolveTranscriptDetail("thinking", "cursor")).toBe("thinking")
  })

  test("every other level survives a provider switch", () => {
    for (const provider of ["claude", "codex", "cursor", "pi"] as const) {
      expect(resolveTranscriptDetail("verbose", provider)).toBe("verbose")
      expect(resolveTranscriptDetail("summary", provider)).toBe("summary")
    }
  })

  test("active provider wins over a staged provider", () => {
    expect(transcriptDetailProvider("claude", "codex")).toBe("claude")
  })

  test("selected provider supplies the value before a chat starts", () => {
    expect(transcriptDetailProvider(null, "codex")).toBe("codex")
  })
})

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { runTest } from "./effect/testing"
import { fallbackTitleFromMessage, generateTitleForChatDetailed } from "./generate-title"
import { QuickResponse, QuickResponseRequestError } from "./quick-response"

const shouldRunLiveTests = process.env.KANNA_RUN_LIVE_TITLE_TESTS === "1"
const LIVE_MESSAGE = "Please help me debug a websocket reconnection issue in a Bun server app"

const unexpected = (provider: "claude" | "codex", message: string) =>
  Effect.fail(new QuickResponseRequestError({ provider, message, cause: null }))

if (shouldRunLiveTests) {
  describe("live title generation", () => {
    test("generates a title with Claude", async () => {
      const result = await runTest(generateTitleForChatDetailed(LIVE_MESSAGE, process.cwd()).pipe(
        Effect.provide(QuickResponse.layer({
          runCodexStructured: () => unexpected("codex", "Codex fallback should not be used in the Claude live title test"),
        })),
      ))

      expect(result.usedFallback).toBe(false)
      expect(result.failureMessage).toBeNull()
      expect(typeof result.title).toBe("string")
      expect(result.title).not.toBe(fallbackTitleFromMessage(LIVE_MESSAGE))
    }, 15_000)

    test("generates a title with Codex", async () => {
      // The layer's own CodexAppServer, killed when the test's scope closes.
      const result = await runTest(generateTitleForChatDetailed(LIVE_MESSAGE, process.cwd()).pipe(
        Effect.provide(QuickResponse.layer({
          runClaudeStructured: () => unexpected("claude", "Claude should not be used in the Codex live title test"),
        })),
      ))

      expect(result.usedFallback).toBe(false)
      expect(result.failureMessage).toBeNull()
      expect(typeof result.title).toBe("string")
      expect(result.title).not.toBe(fallbackTitleFromMessage(LIVE_MESSAGE))
    }, 15_000)
  })
}

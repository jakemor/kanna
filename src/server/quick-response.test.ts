import { homedir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import type { LlmProviderSnapshot } from "../shared/types"
import { CodexRequestError } from "./codex-app-server"
import { runTest } from "./effect/testing"
import { fallbackTitleFromMessage, generateTitleForChatDetailed } from "./generate-title"
import { LlmProviderFileError } from "./llm-provider"
import {
  getQuickResponseWorkspace,
  QuickResponse,
  QuickResponseRequestError,
  type QuickResponseOptions,
  type QuickResponseProvider,
} from "./quick-response"

function llmProvider(overrides: Partial<LlmProviderSnapshot> = {}): Effect.Effect<LlmProviderSnapshot> {
  return Effect.succeed({
    provider: "openai",
    apiKey: "",
    model: "",
    baseUrl: "",
    resolvedBaseUrl: "https://api.openai.com/v1",
    faveModels: [],
    enabled: false,
    warning: null,
    filePathDisplay: "~/.kanna/llm-provider.json",
    ...overrides,
  })
}

const fails = (provider: QuickResponseProvider, message: string) =>
  Effect.fail(new QuickResponseRequestError({ provider, message, cause: new Error(message) }))

const TITLE_ARGS = {
  cwd: "/tmp/project",
  task: "title generation",
  prompt: "Generate a title",
  schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  parse: (value: unknown) => {
    const output = value && typeof value === "object" ? value as { title?: unknown } : {}
    return typeof output.title === "string" ? output.title : null
  },
}

/** A title through `QuickResponse` built from `options`. */
function generateTitle(options: QuickResponseOptions) {
  return runTest(Effect.gen(function* () {
    const quickResponse = yield* QuickResponse
    return yield* quickResponse.generateStructured(TITLE_ARGS)
  }).pipe(Effect.provide(QuickResponse.layer(options))))
}

function chatTitle(messageContent: string, options: QuickResponseOptions) {
  return runTest(generateTitleForChatDetailed(messageContent, "/tmp/project").pipe(
    Effect.provide(QuickResponse.layer(options)),
  ))
}

describe("QuickResponse", () => {
  test("returns the SDK structured result when configured and it validates", async () => {
    const result = await generateTitle({
      readLlmProvider: llmProvider({ apiKey: "test-key", model: "gpt-5-mini", enabled: true }),
      runOpenAIStructured: () => Effect.succeed({ title: "SDK title" }),
      runClaudeStructured: () => Effect.succeed({ title: "Claude title" }),
      runCodexStructured: () => Effect.succeed({ title: "Codex title" }),
    })

    expect(result).toBe("SDK title")
  })

  test("returns the Claude structured result when it validates", async () => {
    const result = await generateTitle({
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => Effect.succeed({ title: "Claude title" }),
      runCodexStructured: () => Effect.succeed({ title: "Codex title" }),
    })

    expect(result).toBe("Claude title")
  })

  test("falls back to Codex when Claude fails validation", async () => {
    const result = await generateTitle({
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => Effect.succeed({ bad: true }),
      runCodexStructured: () => Effect.succeed({ title: "Codex title" }),
    })

    expect(result).toBe("Codex title")
  })

  test("falls back when the caller's parser throws", async () => {
    const result = await runTest(Effect.gen(function* () {
      const quickResponse = yield* QuickResponse
      return yield* quickResponse.generateStructuredWithDiagnostics({
        ...TITLE_ARGS,
        parse: (value) => {
          if (value && typeof value === "object" && "bad" in value) throw new Error("invalid title")
          return TITLE_ARGS.parse(value)
        },
      })
    }).pipe(Effect.provide(QuickResponse.layer({
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => Effect.succeed({ bad: true }),
      runCodexStructured: () => Effect.succeed({ title: "Codex title" }),
    }))))

    expect(result.value).toBe("Codex title")
    expect(result.failures).toEqual([{ provider: "claude", reason: "claude returned invalid structured output for title generation" }])
  })

  test("falls back to Codex when Claude throws", async () => {
    const result = await generateTitle({
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => fails("claude", "Not authenticated"),
      runCodexStructured: () => Effect.succeed({ title: "Codex title" }),
    })

    expect(result).toBe("Codex title")
  })

  test("uses the Kanna app data root as the quick-response workspace", async () => {
    const previousProfile = process.env.KANNA_RUNTIME_PROFILE
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    try {
      let claudeCwd = ""
      await generateTitle({
        readLlmProvider: llmProvider({ filePathDisplay: "~/.kanna-dev/llm-provider.json" }),
        runClaudeStructured: (args) => Effect.sync(() => {
          claudeCwd = args.cwd
          return { title: "Claude title" }
        }),
      })

      expect(claudeCwd).toBe(getQuickResponseWorkspace(process.env, homedir()))
      expect(claudeCwd.endsWith("/.kanna-dev")).toBe(true)
    } finally {
      if (previousProfile === undefined) {
        delete process.env.KANNA_RUNTIME_PROFILE
      } else {
        process.env.KANNA_RUNTIME_PROFILE = previousProfile
      }
    }
  })

  test("uses gpt-5.4-mini for Codex title generation fallback", async () => {
    const requests: Array<{ cwd: string; prompt: string; model?: string }> = []
    const result = await generateTitle({
      readLlmProvider: llmProvider(),
      codexManager: {
        generateStructured: (args) => Effect.sync(() => {
          requests.push(args)
          return "{\"title\":\"Codex title\"}"
        }),
      },
      runClaudeStructured: () => Effect.succeed(null),
    })

    expect(result).toBe("Codex title")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe("gpt-5.4-mini")
  })

  test("reads Codex's answer out of a fenced JSON block", async () => {
    const result = await generateTitle({
      readLlmProvider: llmProvider(),
      codexManager: {
        generateStructured: () => Effect.succeed("Here you go:\n```json\n{\"title\":\"Fenced title\"}\n```"),
      },
      runClaudeStructured: () => Effect.succeed(null),
    })

    expect(result).toBe("Fenced title")
  })

  test("a Codex app-server that throws is a failure, not a crash", async () => {
    const result = await runTest(Effect.gen(function* () {
      const quickResponse = yield* QuickResponse
      return yield* quickResponse.generateStructuredWithDiagnostics(TITLE_ARGS)
    }).pipe(Effect.provide(QuickResponse.layer({
      readLlmProvider: llmProvider(),
      codexManager: {
        generateStructured: () =>
          Effect.fail(new CodexRequestError({ chatId: "quick-1", method: "turn/start", message: "app-server exited" })),
      },
      runClaudeStructured: () => Effect.succeed(null),
    }))))

    expect(result).toEqual({
      value: null,
      failures: [
        { provider: "claude", reason: "claude returned no result for title generation" },
        { provider: "codex", reason: "codex failed title generation: app-server exited" },
      ],
    })
  })

  test("falls through to Claude when the SDK is not configured", async () => {
    let openAICalls = 0
    const result = await generateTitle({
      readLlmProvider: llmProvider(),
      runOpenAIStructured: () => Effect.sync(() => {
        openAICalls += 1
        return { title: "SDK title" }
      }),
      runClaudeStructured: () => Effect.succeed({ title: "Claude title" }),
    })

    expect(result).toBe("Claude title")
    expect(openAICalls).toBe(0)
  })

  test("a later provider never runs once one has answered", async () => {
    let codexCalls = 0
    await generateTitle({
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => Effect.succeed({ title: "Claude title" }),
      runCodexStructured: () => Effect.sync(() => {
        codexCalls += 1
        return { title: "Codex title" }
      }),
    })

    expect(codexCalls).toBe(0)
  })

  test("an unreadable provider file fails the request", async () => {
    const result = await runTest(Effect.result(Effect.gen(function* () {
      const quickResponse = yield* QuickResponse
      return yield* quickResponse.generateStructured(TITLE_ARGS)
    }).pipe(Effect.provide(QuickResponse.layer({
      readLlmProvider: Effect.fail(new LlmProviderFileError({ operation: "read", filePath: "/tmp/llm.json", cause: null })),
    })))))

    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/llm-provider/LlmProviderFileError")
  })
})

describe("generateTitleForChat", () => {
  test("sanitizes generated titles", async () => {
    const { title } = await chatTitle("hello", {
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => Effect.succeed({ title: "   Example\nTitle   " }),
    })

    expect(title).toBe("Example Title")
  })

  test("rejects invalid generated titles", async () => {
    const { title } = await chatTitle("hello", {
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => Effect.succeed({ title: "   " }),
      runCodexStructured: () => Effect.succeed({ title: "New Chat" }),
    })

    expect(title).toBe("hello")
  })

  test("falls back to the first 35 characters of the message with ellipsis", async () => {
    const { title } = await chatTitle("This message is definitely longer than thirty five characters", {
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => fails("claude", "Not authenticated"),
      runCodexStructured: () => Effect.succeed(null),
    })

    expect(title).toBe("This message is definitely longer t...")
  })

  test("returns fallback metadata when providers fail", async () => {
    const result = await chatTitle("hello there", {
      readLlmProvider: llmProvider(),
      runClaudeStructured: () => fails("claude", "Not authenticated"),
      runCodexStructured: () => fails("codex", "Codex unavailable"),
    })

    expect(result).toEqual({
      title: "hello there",
      usedFallback: true,
      failureMessage: "claude failed conversation title generation: Not authenticated; codex failed conversation title generation: Codex unavailable",
    })
  })

  test("includes SDK failure details before Claude and Codex", async () => {
    const result = await chatTitle("hello there", {
      readLlmProvider: llmProvider({ apiKey: "test-key", model: "gpt-5-mini", enabled: true }),
      runOpenAIStructured: () => fails("openai", "SDK unavailable"),
      runClaudeStructured: () => fails("claude", "Not authenticated"),
      runCodexStructured: () => fails("codex", "Codex unavailable"),
    })

    expect(result.failureMessage).toBe(
      "openai failed conversation title generation: SDK unavailable; claude failed conversation title generation: Not authenticated; codex failed conversation title generation: Codex unavailable"
    )
  })
})

describe("fallbackTitleFromMessage", () => {
  test("normalizes whitespace", () => {
    expect(fallbackTitleFromMessage("  hello\n   world  ")).toBe("hello world")
  })

  test("returns null for blank input", () => {
    expect(fallbackTitleFromMessage("   \n  ")).toBeNull()
  })
})

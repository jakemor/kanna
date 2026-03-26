import { describe, expect, test } from "bun:test"
import { generateTitleForChat } from "./generate-title"
import { QuickResponseAdapter } from "./quick-response"

describe("QuickResponseAdapter", () => {
  test("returns the Claude structured result when it validates", async () => {
    const adapter = new QuickResponseAdapter({
      runClaudeStructured: async () => ({ title: "Claude title" }),
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Claude title")
  })

  test("falls back to Codex when Claude fails validation", async () => {
    const adapter = new QuickResponseAdapter({
      runClaudeStructured: async () => ({ bad: true }),
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Codex title")
  })

  test("falls back to Codex when Claude throws", async () => {
    const adapter = new QuickResponseAdapter({
      runClaudeStructured: async () => {
        throw new Error("Not authenticated")
      },
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Codex title")
  })
})

describe("generateTitleForChat", () => {
  test("sanitizes generated titles", async () => {
    const title = await generateTitleForChat(
      "hello",
      "/tmp/project",
      new QuickResponseAdapter({
        runClaudeStructured: async () => ({ title: "   Example\nTitle   " }),
      })
    )

    expect(title).toBe("Example Title")
  })

  test("rejects invalid generated titles", async () => {
    const title = await generateTitleForChat(
      "hello",
      "/tmp/project",
      new QuickResponseAdapter({
        runClaudeStructured: async () => ({ title: "   " }),
        runCodexStructured: async () => ({ title: "New Chat" }),
      })
    )

    expect(title).toBeNull()
  })
})

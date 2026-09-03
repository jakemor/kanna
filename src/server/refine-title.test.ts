import { describe, expect, test } from "bun:test"
import { QuickResponseAdapter } from "./quick-response"
import { buildTurnDigest, refineChatTitleDetailed } from "./refine-title"
import { timestamped } from "./transcript"

let nextId = 0
function entry<T extends Parameters<typeof timestamped>[0]>(partial: T) {
  nextId += 1
  return timestamped(partial, nextId)
}

function disabledLlmProvider() {
  return {
    provider: "openai" as const,
    apiKey: "",
    model: "",
    baseUrl: "",
    resolvedBaseUrl: "https://api.openai.com/v1",
    faveModels: [],
    enabled: false,
    warning: null,
    filePathDisplay: "~/.kanna/llm-provider.json",
  }
}

function adapterReturning(value: unknown, calls?: { prompts: string[] }) {
  return new QuickResponseAdapter({
    readLlmProvider: async () => disabledLlmProvider(),
    runClaudeStructured: async (args) => {
      calls?.prompts.push(args.prompt)
      return value
    },
    runCodexStructured: async () => null,
  })
}

describe("buildTurnDigest", () => {
  test("names the prompt, the work, and how the turn ended", () => {
    const digest = buildTurnDigest([
      entry({ kind: "user_prompt", content: "Look at   this slack thread please" }),
      entry({
        kind: "tool_call",
        tool: { kind: "tool", toolKind: "edit_file", toolName: "Edit", toolId: "t1", input: { filePath: "src/web-sdk/paywall.ts" } },
      }),
      entry({
        kind: "tool_call",
        tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t2", input: { command: "bun test", description: "Run the suite" } },
      }),
      entry({ kind: "assistant_text", text: "The web SDK dropped the paywall event." }),
    ])

    expect(digest).toContain("Look at this slack thread please")
    expect(digest).toContain("edited src/web-sdk/paywall.ts")
    expect(digest).toContain("ran Run the suite")
    expect(digest).toContain("The web SDK dropped the paywall event.")
  })

  test("collapses repeated tool calls and keeps the closing assistant text", () => {
    const digest = buildTurnDigest([
      entry({ kind: "assistant_text", text: "Let me look." }),
      ...Array.from({ length: 4 }, () => entry({
        kind: "tool_call",
        tool: { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t", input: { filePath: "/repo/src/a.ts" } },
      })),
      entry({ kind: "assistant_text", text: "Done." }),
    ])

    expect(digest.match(/read a\.ts/g)).toHaveLength(1)
    expect(digest).toContain("Done.")
  })

  test("is empty for a transcript with nothing to summarize", () => {
    expect(buildTurnDigest([])).toBe("")
    expect(buildTurnDigest([
      entry({ kind: "system_init", provider: "claude", model: "opus", tools: [], agents: [], slashCommands: [], mcpServers: [] }),
    ])).toBe("")
  })
})

describe("refineChatTitleDetailed", () => {
  const args = {
    currentTitle: "Investigate Slack Thread",
    digest: "The user asked:\nlook at this thread",
    cwd: "/tmp/project",
  }

  test("returns the proposed title when the model asks for a rename", async () => {
    const result = await refineChatTitleDetailed(
      args,
      adapterReturning({ rename: true, title: "  Web SDK\npaywall event drop  " })
    )

    expect(result.title).toBe("Web SDK paywall event drop")
    expect(result.failureMessage).toBeNull()
  })

  test("keeps the current title when the model declines", async () => {
    const result = await refineChatTitleDetailed(args, adapterReturning({ rename: false, title: "" }))

    expect(result.title).toBeNull()
    expect(result.failureMessage).toBeNull()
  })

  test("keeps the current title when the rename only restates it", async () => {
    const result = await refineChatTitleDetailed(
      args,
      adapterReturning({ rename: true, title: "investigate slack thread" })
    )

    expect(result.title).toBeNull()
  })

  test("does not call a provider when there is nothing to judge", async () => {
    const calls = { prompts: [] as string[] }
    const result = await refineChatTitleDetailed(
      { ...args, digest: "   " },
      adapterReturning({ rename: true, title: "Never asked" }, calls)
    )

    expect(result.title).toBeNull()
    expect(calls.prompts).toHaveLength(0)
  })

  test("passes the current title and the digest to the provider", async () => {
    const calls = { prompts: [] as string[] }
    await refineChatTitleDetailed(args, adapterReturning({ rename: false, title: "" }, calls))

    expect(calls.prompts[0]).toContain("Investigate Slack Thread")
    expect(calls.prompts[0]).toContain("look at this thread")
  })

  test("reports the failure when no provider answers", async () => {
    const result = await refineChatTitleDetailed(args, new QuickResponseAdapter({
      readLlmProvider: async () => disabledLlmProvider(),
      runClaudeStructured: async () => {
        throw new Error("not authenticated")
      },
      runCodexStructured: async () => null,
    }))

    expect(result.title).toBeNull()
    expect(result.failureMessage).toContain("not authenticated")
  })
})

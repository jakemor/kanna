import { describe, expect, test } from "bun:test"
import { QuickResponseAdapter } from "./quick-response"
import { generateCommitMessageDetailed } from "./generate-commit-message"

describe("generateCommitMessageDetailed", () => {
  test("returns sanitized generated subject and body", async () => {
    const result = await generateCommitMessageDetailed(
      {
        cwd: "/tmp/project",
        branchName: "feature/test",
        files: [{
          path: "app.ts",
          changeType: "modified",
          patch: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@\n-old\n+new\n",
        }],
      },
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => ({
          subject: "  Add login UI.\nextra line",
          body: "  - wire form\n- add validation  ",
        }),
      })
    )

    expect(result).toEqual({
      subject: "Add login UI",
      body: "- wire form\n- add validation",
      usedFallback: false,
      failureMessage: null,
    })
  })

  test("falls back when providers fail", async () => {
    const result = await generateCommitMessageDetailed(
      {
        cwd: "/tmp/project",
        branchName: "feature/test",
        files: [{
          path: "src/feature.ts",
          changeType: "modified",
          patch: "diff --git a/src/feature.ts b/src/feature.ts\n",
        }],
      },
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        runCodexStructured: async () => null,
      })
    )

    expect(result).toEqual({
      subject: "Update feature.ts",
      body: "",
      usedFallback: true,
      failureMessage: "claude failed commit message generation: Not authenticated; codex returned no result for commit message generation",
    })
  })
})

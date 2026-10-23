import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { LlmProviderSnapshot } from "../shared/types"
import { runTest } from "./effect/testing"
import { generateCommitMessageDetailed } from "./generate-commit-message"
import { QuickResponse, QuickResponseRequestError, type QuickResponseOptions } from "./quick-response"

const DISABLED_LLM_PROVIDER: LlmProviderSnapshot = {
  provider: "openai",
  apiKey: "",
  model: "",
  baseUrl: "",
  resolvedBaseUrl: "https://api.openai.com/v1",
  faveModels: [],
  enabled: false,
  warning: null,
  filePathDisplay: "~/.kanna/llm-provider.json",
}

function commitMessage(args: Parameters<typeof generateCommitMessageDetailed>[0], options: QuickResponseOptions) {
  return runTest(generateCommitMessageDetailed(args).pipe(Effect.provide(QuickResponse.layer(options))))
}

describe("generateCommitMessageDetailed", () => {
  test("returns sanitized generated subject and body", async () => {
    const result = await commitMessage(
      {
        cwd: "/tmp/project",
        branchName: "feature/test",
        files: [{
          path: "app.ts",
          changeType: "modified",
          patch: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@\n-old\n+new\n",
        }],
      },
      {
        readLlmProvider: Effect.succeed(DISABLED_LLM_PROVIDER),
        runClaudeStructured: () => Effect.succeed({
          subject: "  Add login UI.\nextra line",
          body: "  - wire form\n- add validation  ",
        }),
      }
    )

    expect(result).toEqual({
      subject: "Add login UI",
      body: "- wire form\n- add validation",
      usedFallback: false,
      failureMessage: null,
    })
  })

  test("falls back when providers fail", async () => {
    const result = await commitMessage(
      {
        cwd: "/tmp/project",
        branchName: "feature/test",
        files: [{
          path: "src/feature.ts",
          changeType: "modified",
          patch: "diff --git a/src/feature.ts b/src/feature.ts\n",
        }],
      },
      {
        readLlmProvider: Effect.succeed(DISABLED_LLM_PROVIDER),
        runClaudeStructured: () =>
          Effect.fail(new QuickResponseRequestError({ provider: "claude", message: "Not authenticated", cause: null })),
        runCodexStructured: () => Effect.succeed(null),
      }
    )

    expect(result).toEqual({
      subject: "Update feature.ts",
      body: "",
      usedFallback: true,
      failureMessage: "claude failed commit message generation: Not authenticated; codex returned no result for commit message generation",
    })
  })
})

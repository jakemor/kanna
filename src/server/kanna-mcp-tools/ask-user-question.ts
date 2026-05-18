import { z } from "zod"
import type { ToolCallbackService } from "../tool-callback"
import type { ToolHandlerContext, ToolHandlerResult } from "./tool-callback-shim"
import { gatedToolCall } from "./tool-callback-shim"

const QuestionSchema = z.object({
  text: z.string(),
  header: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })).min(2).max(4),
  multiSelect: z.boolean(),
})

const InputSchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(4),
})

export type AskUserQuestionInput = z.infer<typeof InputSchema>

export interface AskUserQuestionTool {
  name: "ask_user_question"
  schema: typeof InputSchema
  handler: (input: AskUserQuestionInput, ctx: ToolHandlerContext) => Promise<ToolHandlerResult>
}

export function createAskUserQuestionTool(deps: { toolCallback: ToolCallbackService }): AskUserQuestionTool {
  return {
    name: "ask_user_question",
    schema: InputSchema,
    async handler(input, ctx) {
      return gatedToolCall({
        toolCallback: deps.toolCallback,
        toolName: "mcp__kanna__ask_user_question",
        ctx,
        args: input as unknown as Record<string, unknown>,
        formatAnswer: (payload) => {
          // Fail fast — silently coercing an undefined payload to `{}` would
          // hide the real bug (an interactive tool being auto-allowed with
          // no user answer). The policy gate is supposed to force "ask" for
          // this tool (issue #215 follow-up); if we ever see an allow/answer
          // with no payload here, surface it loudly so it gets reported and
          // fixed instead of producing a silent empty UI answer downstream.
          if (payload === undefined || payload === null || typeof payload !== "object") {
            throw new Error(
              "mcp__kanna__ask_user_question: empty answer payload "
              + `(received ${payload === undefined ? "undefined" : typeof payload}). `
              + "This means the policy gate or tool-callback resolved the request without a user response — "
              + "interactive tools must always go through the ask/UI path. See issue #215.",
            )
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          }
        },
        formatDeny: (reason) => ({
          content: [{ type: "text" as const, text: `Denied: ${reason}` }],
          isError: true,
        }),
      })
    },
  }
}

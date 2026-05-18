import { z } from "zod"
import type { SubagentOrchestrator } from "../subagent-orchestrator"

const InputSchema = z.object({
  subagent_id: z.string().min(1).describe(
    "Subagent ID from the roster in the system prompt. Match the `id=...` token, not the human name.",
  ),
  prompt: z.string().min(1).describe(
    "Self-contained instructions for the subagent. Distill the relevant chat context, state the goal, list constraints, and end with the concrete deliverable you need back. The subagent does not see your chat history.",
  ),
})

export type DelegateSubagentInput = z.infer<typeof InputSchema>

export interface DelegateSubagentContext {
  chatId: string
  /** Subagent id of the caller when invoked from a subagent's own MCP — null for the main agent. */
  parentSubagentId: string | null
  /** Run id of the caller when invoked from a subagent — null for the main agent. */
  parentRunId: string | null
  /** Ancestor chain (oldest first, excludes the immediate caller). */
  ancestorSubagentIds: string[]
  /** Depth of the spawned run. Main agent → 1, subagent → its depth + 1. */
  depth: number
  /**
   * Resolves to the user message id the current turn is responding to.
   * Returns null when no turn is active — the tool then errors out rather
   * than fabricating a parent.
   */
  getParentUserMessageId: () => string | null
}

export interface DelegateSubagentTool {
  name: "delegate_subagent"
  schema: typeof InputSchema
  handler: (
    input: DelegateSubagentInput,
    ctx: DelegateSubagentContext,
  ) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>
}

const DESCRIPTION =
  "Hand off focused work to a specialized subagent listed in the system prompt. Blocks until the subagent finishes and returns its final reply as text. Brief the subagent like a smart colleague who just walked in: state the goal, what was tried, what to check, any constraints. The subagent cannot see your chat history — distill the context yourself."

export function createDelegateSubagentTool(deps: {
  orchestrator: SubagentOrchestrator
}): DelegateSubagentTool {
  return {
    name: "delegate_subagent",
    schema: InputSchema,
    async handler(input, ctx) {
      const parentUserMessageId = ctx.getParentUserMessageId()
      if (!parentUserMessageId) {
        return {
          content: [{
            type: "text" as const,
            text: "No active turn — delegate_subagent must be called inside a running chat turn.",
          }],
          isError: true,
        }
      }
      const outcome = await deps.orchestrator.delegateRun({
        chatId: ctx.chatId,
        parentUserMessageId,
        parentRunId: ctx.parentRunId,
        parentSubagentId: ctx.parentSubagentId,
        ancestorSubagentIds: ctx.ancestorSubagentIds,
        depth: ctx.depth,
        subagentId: input.subagent_id,
        prompt: input.prompt,
      })
      if (outcome.status === "completed") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "completed",
              run_id: outcome.runId,
              reply: outcome.text,
            }),
          }],
        }
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "failed",
            run_id: outcome.runId,
            error_code: outcome.errorCode,
            error_message: outcome.errorMessage,
          }),
        }],
        isError: true,
      }
    },
  }
}

export const DELEGATE_SUBAGENT_DESCRIPTION = DESCRIPTION

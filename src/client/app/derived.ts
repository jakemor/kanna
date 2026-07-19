import type { HydratedTranscriptMessage } from "../../shared/types"
import type { ProcessedToolCall } from "../components/messages/types"

export const SPECIAL_TOOL_NAMES = ["AskUserQuestion", "ExitPlanMode", "TodoWrite"] as const
const RESOLVED_TOOL_NAMES = new Set<string>(["TodoWrite"])

function findLatestUnresolvedToolId(messages: HydratedTranscriptMessage[], toolName: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== "tool") continue
    const toolCall = message as ProcessedToolCall
    if (toolCall.toolName === toolName && !toolCall.result) {
      return toolCall.id
    }
  }
  return null
}

function findLatestToolId(messages: HydratedTranscriptMessage[], toolName: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== "tool") continue
    const toolCall = message as ProcessedToolCall
    if (toolCall.toolName === toolName) {
      return toolCall.id
    }
  }
  return null
}

export function getLatestToolIds(messages: HydratedTranscriptMessage[]) {
  const ids: Record<string, string | null> = {}
  for (const toolName of SPECIAL_TOOL_NAMES) {
    ids[toolName] = RESOLVED_TOOL_NAMES.has(toolName)
      ? findLatestToolId(messages, toolName)
      : findLatestUnresolvedToolId(messages, toolName)
  }
  return ids
}

export function isProcessingStatus(status?: string) {
  return status === "starting" || status === "running" || status === "waiting_for_user"
}

export const canCancelStatus = isProcessingStatus

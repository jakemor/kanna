import { Effect } from "effect"
import { QuickResponse } from "./quick-response"
import { stripSystemMessages } from "../shared/message-preview"

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
} as const

function normalizeGeneratedTitle(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 80)
  if (!normalized || normalized === "New Chat") return null
  return normalized
}

/**
 * A title is made from what the user wrote. What Kanna put in the message for
 * the agent (`stripSystemMessages`) is no part of that: left in, a first
 * message carrying a block for the agent would be titled after its
 * instructions.
 */
export function fallbackTitleFromMessage(messageContent: string): string | null {
  const normalized = stripSystemMessages(messageContent).replace(/\s+/g, " ").trim()
  if (!normalized) return null
  if (normalized.length <= 35) return normalized
  return `${normalized.slice(0, 35)}...`
}

export interface GenerateChatTitleResult {
  title: string | null
  usedFallback: boolean
  failureMessage: string | null
}

function summarizeFailures(failures: Array<{ provider: "openai" | "claude" | "codex"; reason: string }>) {
  if (failures.length === 0) return null
  return failures.map((failure) => failure.reason).join("; ")
}

/** A title for a chat's first message, or one cut from the message when no model answers. */
export const generateTitleForChatDetailed = Effect.fn("GenerateTitle.forChat")(function* (
  messageContent: string,
  cwd: string,
) {
  const quickResponse = yield* QuickResponse
  const result = yield* quickResponse.generateStructuredWithDiagnostics<string>({
    cwd,
    task: "conversation title generation",
    prompt: `Generate a short, descriptive title (under 30 chars) for a conversation that starts with this message.\n\n${stripSystemMessages(messageContent)}`,
    schema: TITLE_SCHEMA,
    parse: (value) => {
      const output = value && typeof value === "object" ? value as { title?: unknown } : {}
      return normalizeGeneratedTitle(output.title)
    },
  })

  if (result.value) {
    return {
      title: result.value,
      usedFallback: false,
      failureMessage: null,
    } satisfies GenerateChatTitleResult
  }

  const fallbackTitle = fallbackTitleFromMessage(messageContent)
  return {
    title: fallbackTitle,
    usedFallback: true,
    failureMessage: summarizeFailures(result.failures),
  } satisfies GenerateChatTitleResult
})

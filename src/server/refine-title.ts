import path from "node:path"
import type { NormalizedToolCall, TranscriptEntry } from "../shared/types"
import { normalizeGeneratedTitle } from "./generate-title"
import { getSharedQuickResponseAdapter } from "./quick-response"

const REFINED_TITLE_SCHEMA = {
  type: "object",
  properties: {
    rename: { type: "boolean" },
    title: { type: "string" },
  },
  required: ["rename", "title"],
  additionalProperties: false,
} as const

const MAX_PROMPT_CHARS = 600
const MAX_ASSISTANT_TEXTS = 3
const MAX_ASSISTANT_CHARS = 500
const MAX_WORK_LINES = 12

function condense(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength).trimEnd()}...`
}

/**
 * One line naming what a tool call did — the specific noun (a path, a pattern,
 * a command) rather than the tool's name, since the point of the digest is to
 * tell the refiner *what* the turn was about.
 */
function describeToolCall(tool: NormalizedToolCall): string | null {
  switch (tool.toolKind) {
    case "read_file":
      return `read ${path.basename(tool.input.filePath)}`
    case "write_file":
      return `wrote ${tool.input.filePath}`
    case "edit_file":
      return `edited ${tool.input.filePath}`
    case "delete_file":
      return `deleted ${tool.input.filePath}`
    case "bash":
      return `ran ${condense(tool.input.description || tool.input.command, 80)}`
    case "grep":
      return `searched for ${condense(tool.input.pattern, 60)}`
    case "glob":
      return `globbed ${condense(tool.input.pattern, 60)}`
    case "web_search":
      return `web search: ${condense(tool.input.query, 60)}`
    case "skill":
      return `used the ${tool.input.skill} skill`
    case "subagent_task":
      return tool.input.subagentType ? `ran the ${tool.input.subagentType} agent` : null
    case "mcp_generic":
      return `called ${tool.input.server}/${tool.input.tool}`
    default:
      return null
  }
}

/**
 * What the turn was actually about, in a few hundred characters: the prompt
 * that opened it, the agent's closing words, and the files and commands it
 * touched. Built from header-form entries only — no tool bodies — so it stays
 * cheap and stays inside a small model's attention.
 */
export function buildTurnDigest(entries: TranscriptEntry[]): string {
  const sections: string[] = []

  const prompt = entries.find((entry) => entry.kind === "user_prompt" && !entry.hidden)
  if (prompt?.kind === "user_prompt" && prompt.content.trim()) {
    sections.push(`The user asked:\n${condense(prompt.content, MAX_PROMPT_CHARS)}`)
  }

  const work: string[] = []
  for (const entry of entries) {
    if (entry.kind !== "tool_call") continue
    const line = describeToolCall(entry.tool)
    if (line && !work.includes(line)) work.push(line)
  }
  if (work.length > 0) {
    sections.push(`The agent:\n${work.slice(0, MAX_WORK_LINES).map((line) => `- ${line}`).join("\n")}`)
  }

  // The last few assistant messages, not the first: an agent opens by restating
  // the prompt and closes by naming what it found, and the close is the part
  // the title is missing.
  const assistantTexts = entries
    .filter((entry) => entry.kind === "assistant_text" && entry.text.trim())
    .slice(-MAX_ASSISTANT_TEXTS)
    .map((entry) => condense((entry as { text: string }).text, MAX_ASSISTANT_CHARS))
  if (assistantTexts.length > 0) {
    sections.push(`The agent concluded:\n${assistantTexts.join("\n")}`)
  }

  return sections.join("\n\n")
}

export interface RefineChatTitleResult {
  /** The better title, or null when the current one should stand. */
  title: string | null
  failureMessage: string | null
}

function summarizeFailures(failures: Array<{ provider: "openai" | "claude" | "codex"; reason: string }>) {
  if (failures.length === 0) return null
  return failures.map((failure) => failure.reason).join("; ")
}

export interface RefineChatTitleArgs {
  currentTitle: string
  digest: string
  cwd: string
}

/**
 * Second look at a chat's title once its first turn has run.
 *
 * The first title is generated from the opening message alone, before any work
 * has happened, so it often names the action and not the subject ("Investigate
 * Slack thread" for a chat that turned out to be about the web SDK). This asks
 * a small model to replace it — but only when the current title would fail to
 * find the chat later. A title that already names the specific thing is left
 * exactly as it is.
 */
export async function refineChatTitleDetailed(
  args: RefineChatTitleArgs,
  adapter = getSharedQuickResponseAdapter()
): Promise<RefineChatTitleResult> {
  if (!args.digest.trim()) {
    return { title: null, failureMessage: null }
  }

  const result = await adapter.generateStructuredWithDiagnostics<{ title: string | null }>({
    cwd: args.cwd,
    task: "conversation title refinement",
    prompt: [
      `A chat in a coding tool is titled "${args.currentTitle}".`,
      "That title was generated from the user's opening message alone, before any of the work below had happened.",
      "",
      "Here is what the conversation turned out to be about:",
      "",
      args.digest,
      "",
      "Decide whether the title should change.",
      "Rename it only when it would be hard to find this chat by that title later — it names a generic action"
        + " (\"Investigate thread\", \"Fix bug\", \"Update code\") without naming the specific subject, or the work"
        + " turned out to be about something the title never mentions.",
      "Keep the title when it already names the specific thing that was worked on, even if you could phrase it better.",
      "",
      "When renaming, write a title under 40 characters that names the specific subject — the feature, component,"
        + " file, or product area — and what was done to it. No quotes, no trailing punctuation.",
      "When keeping the title, set rename to false and title to an empty string.",
    ].join("\n"),
    schema: REFINED_TITLE_SCHEMA,
    parse: (value) => {
      const output = value && typeof value === "object" ? value as { rename?: unknown; title?: unknown } : {}
      if (output.rename !== true) return { title: null }
      const title = normalizeGeneratedTitle(output.title)
      // A provider that asked for a rename but named nothing usable hasn't
      // answered: fall through to the next one rather than keeping quiet.
      if (!title) return null
      if (title.toLowerCase() === args.currentTitle.trim().toLowerCase()) return { title: null }
      return { title }
    },
  })

  return {
    title: result.value?.title ?? null,
    failureMessage: summarizeFailures(result.failures),
  }
}

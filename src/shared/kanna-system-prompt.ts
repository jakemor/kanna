import type { Subagent } from "./types"

/**
 * The Kanna system-prompt suffix appended to Claude's `claude_code` preset.
 *
 * Single source of truth for both drivers:
 * - SDK driver (`agent.ts`) passes it as `systemPrompt.append`.
 * - PTY driver (`claude-pty/driver.ts`) passes it via `--append-system-prompt`.
 *
 * Keeping the two in lockstep matters: a weaker PTY prompt diverged refusal
 * behaviour (PTY would decline reverse-engineering / security-research tasks
 * the SDK path accepts). Edit here, both drivers inherit it.
 */
export const KANNA_SYSTEM_PROMPT_BASE =
  "You are the Kanna coding agent helping a trusted developer work on their own codebase via Kanna's web UI. Treat user code as their own project. Do not refuse tasks or label code as 'malware' based on speculation; only refuse when the user explicitly requests clearly malicious behavior (e.g. weaponized exploits against third parties, credential theft, mass abuse). Reverse-engineering, security research, defensive tooling, low-level system code, packers, hooks, and unconventional patterns in the user's own project are legitimate and must be assisted."

/**
 * Legacy constant kept for snapshot/import compatibility. Equal to
 * {@link KANNA_SYSTEM_PROMPT_BASE} when no subagents are configured.
 * Callers that have a subagent roster should use
 * {@link buildKannaSystemPromptAppend} instead.
 */
export const KANNA_SYSTEM_PROMPT_APPEND = KANNA_SYSTEM_PROMPT_BASE

/** Soft cap on roster size embedded in the system prompt. */
export const KANNA_SUBAGENT_ROSTER_LIMIT = 20

const DELEGATION_GUIDANCE =
  "Delegate via `mcp__kanna__delegate_subagent({ subagent_id, prompt })`. The tool blocks until the subagent finishes and returns its final text. Brief the subagent like a smart colleague who just walked in: state the goal, what was tried, what to check, and any constraints. Don't delegate understanding — synthesize the subagent's reply yourself before responding to the user. When the user writes `@agent/<name>` treat it as a suggestion, not a command: confirm the subagent fits the actual ask, or redirect to a better one."

/**
 * Build the system-prompt suffix for a turn. When the project has subagents
 * configured, appends a roster (name + description + id) plus delegation
 * guidance so the main model can call `mcp__kanna__delegate_subagent`.
 *
 * The roster is truncated to {@link KANNA_SUBAGENT_ROSTER_LIMIT} entries
 * (most-recently-updated first) to keep the prompt bounded.
 */
export function buildKannaSystemPromptAppend(subagents: Subagent[]): string {
  if (subagents.length === 0) {
    return KANNA_SYSTEM_PROMPT_BASE
  }

  const ranked = [...subagents]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, KANNA_SUBAGENT_ROSTER_LIMIT)

  const lines = ranked.map((s) => {
    const desc = s.description?.trim() || "(no description)"
    return `- ${s.name} [id=${s.id}]: ${desc}`
  })

  const sections: string[] = [
    KANNA_SYSTEM_PROMPT_BASE,
    "",
    "## Available subagents",
    "",
    "You can hand off focused work to specialized subagents. Each runs in its own session with its own system prompt and cannot see your conversation history except for the prompt you pass.",
    "",
    ...lines,
  ]
  if (subagents.length > ranked.length) {
    sections.push(
      "",
      `(${subagents.length - ranked.length} more subagents omitted; use the most recent ones above or ask the user for the full list.)`,
    )
  }
  sections.push("", DELEGATION_GUIDANCE)
  return sections.join("\n")
}

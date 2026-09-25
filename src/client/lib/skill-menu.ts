import type { HarnessSkill } from "../../shared/types"

/**
 * Helpers for the composer's "/" skill menu. Pure functions so they can be
 * unit-tested; ChatInput owns the state and rendering.
 *
 * The menu opens while the caret sits inside a trigger token ("/name", or
 * "$name" on codex) that opens the message or follows whitespace, so a skill
 * can go anywhere in the prompt and a prompt can name several. The server
 * finds every "/name" at send time and hands each one to the harness
 * (harness-skills.ts).
 */

export const DEFAULT_SKILL_MENU_TRIGGERS: readonly string[] = ["/"]
/** Codex's native skill-mention sigil is "$" — accept it as a menu trigger too. */
export const CODEX_SKILL_MENU_TRIGGERS: readonly string[] = ["/", "$"]

export interface ActiveSkillMention {
  /** Index of the trigger in the value. */
  start: number
  /** Text typed between the trigger and the caret. */
  query: string
}

/**
 * The trigger token the caret sits in, when the skill menu should be open.
 * The trigger must open the message or follow whitespace, so `src/foo` never
 * opens it. A second "/" in the token means a path like `/etc/hosts`, and
 * "$" before a digit is a price, so neither opens it either.
 */
export function getActiveSkillMention(
  value: string,
  caretPosition: number,
  triggers: readonly string[] = DEFAULT_SKILL_MENU_TRIGGERS
): ActiveSkillMention | null {
  if (caretPosition < 1 || caretPosition > value.length) return null
  let start = caretPosition - 1
  while (start >= 0 && !/\s/.test(value[start]!)) start -= 1
  start += 1
  const trigger = value[start]
  if (trigger === undefined || !triggers.includes(trigger)) return null
  const token = value.slice(start + 1).match(/^[^\s]*/)?.[0] ?? ""
  if (token.includes("/") || token.includes("$")) return null
  if (trigger === "$" && /^\d/.test(token)) return null
  return { start, query: value.slice(start + 1, caretPosition) }
}

function scoreSkill(skill: HarnessSkill, query: string): number {
  if (query.length === 0) return 1
  const name = skill.name.toLowerCase()
  const lowered = query.toLowerCase()
  if (name === lowered) return 100
  if (name.startsWith(lowered)) return 80
  // Segment starts: "review" matching "code-review" / "skill:review".
  if (name.split(/[:./_-]/).some((part) => part.startsWith(lowered))) return 60
  if (name.includes(lowered)) return 40
  if (isSubsequence(lowered, name)) return 20
  if (skill.description.toLowerCase().includes(lowered)) return 10
  return 0
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return needle.length === 0
}

/**
 * Filter + rank skills for the menu. Rendered top-to-bottom in ASCENDING match
 * quality: the best match sits at the BOTTOM, adjacent to the input bar, so
 * the default selection is the item closest to where the user is typing.
 */
export function filterSkillMenuItems(skills: HarnessSkill[], query: string): HarnessSkill[] {
  return skills
    .map((skill, index) => ({ skill, index, score: scoreSkill(skill, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      left.score - right.score
      // Stable, deterministic order among equals: reverse-alphabetical so the
      // ascending render puts alphabetically-first names nearest the input.
      || right.skill.name.localeCompare(left.skill.name)
      || right.index - left.index)
    .map((entry) => entry.skill)
}

/**
 * Swap the trigger token under the caret for "/name", keeping the text around
 * it, and put the caret after the space that follows. Always completes to the
 * "/" form — "$" is only an input convenience; "/" is the canonical
 * invocation the server-side translation understands on every harness.
 */
export function applySkillCompletion(
  value: string,
  mention: ActiveSkillMention,
  skillName: string
): { value: string; caret: number } {
  const tokenEnd = mention.start + 1 + (value.slice(mention.start + 1).match(/^[^\s]*/)?.[0].length ?? 0)
  const rest = value.slice(tokenEnd)
  const inserted = rest.startsWith(" ") || rest.startsWith("\n") ? `/${skillName}` : `/${skillName} `
  return {
    value: `${value.slice(0, mention.start)}${inserted}${rest}`,
    caret: mention.start + skillName.length + 2,
  }
}

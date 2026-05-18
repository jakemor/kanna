import { describe, test, expect } from "bun:test"
import {
  KANNA_SUBAGENT_ROSTER_LIMIT,
  KANNA_SYSTEM_PROMPT_APPEND,
  KANNA_SYSTEM_PROMPT_BASE,
  buildKannaSystemPromptAppend,
} from "./kanna-system-prompt"
import type { Subagent } from "./types"

function fakeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: overrides.id ?? "sa-1",
    name: overrides.name ?? "codereview",
    description: overrides.description,
    provider: overrides.provider ?? "claude",
    model: overrides.model ?? "claude-opus-4-7",
    modelOptions: overrides.modelOptions ?? { reasoningEffort: "medium", contextWindow: "200k" },
    systemPrompt: overrides.systemPrompt ?? "you are a reviewer",
    contextScope: overrides.contextScope ?? "previous-assistant-reply",
    createdAt: overrides.createdAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
  }
}

describe("buildKannaSystemPromptAppend", () => {
  test("returns the static base unchanged when no subagents", () => {
    expect(buildKannaSystemPromptAppend([])).toBe(KANNA_SYSTEM_PROMPT_BASE)
  })

  test("KANNA_SYSTEM_PROMPT_APPEND equals the static base for back-compat", () => {
    expect(KANNA_SYSTEM_PROMPT_APPEND).toBe(KANNA_SYSTEM_PROMPT_BASE)
  })

  test("includes name, id, and description for each subagent", () => {
    const out = buildKannaSystemPromptAppend([
      fakeSubagent({ id: "sa-1", name: "codereview", description: "review PR diffs" }),
      fakeSubagent({ id: "sa-2", name: "dbexpert", description: "SQL and schema help" }),
    ])
    expect(out).toContain("- codereview [id=sa-1]: review PR diffs")
    expect(out).toContain("- dbexpert [id=sa-2]: SQL and schema help")
  })

  test("falls back to '(no description)' when description missing or blank", () => {
    const out = buildKannaSystemPromptAppend([
      fakeSubagent({ id: "sa-1", name: "anon", description: undefined }),
      fakeSubagent({ id: "sa-2", name: "blank", description: "   " }),
    ])
    expect(out).toContain("- anon [id=sa-1]: (no description)")
    expect(out).toContain("- blank [id=sa-2]: (no description)")
  })

  test("orders by updatedAt descending (most recent first)", () => {
    const out = buildKannaSystemPromptAppend([
      fakeSubagent({ id: "old", name: "oldsub", updatedAt: 1 }),
      fakeSubagent({ id: "new", name: "newsub", updatedAt: 100 }),
    ])
    const newIdx = out.indexOf("newsub")
    const oldIdx = out.indexOf("oldsub")
    expect(newIdx).toBeGreaterThan(-1)
    expect(oldIdx).toBeGreaterThan(-1)
    expect(newIdx).toBeLessThan(oldIdx)
  })

  test("truncates at KANNA_SUBAGENT_ROSTER_LIMIT and notes the omission", () => {
    const many = Array.from({ length: KANNA_SUBAGENT_ROSTER_LIMIT + 5 }, (_, i) =>
      fakeSubagent({ id: `sa-${i}`, name: `sub${i}`, updatedAt: i })
    )
    const out = buildKannaSystemPromptAppend(many)
    expect(out).toContain("5 more subagents omitted")
    // Newest 20 kept (indices 24..5), oldest 5 (4..0) omitted.
    expect(out).toContain("sub24")
    expect(out).not.toContain("sub4]:")
  })

  test("includes the static base verbatim as the first paragraph", () => {
    const out = buildKannaSystemPromptAppend([fakeSubagent()])
    expect(out.startsWith(KANNA_SYSTEM_PROMPT_BASE)).toBe(true)
  })

  test("includes delegation guidance mentioning the MCP tool name", () => {
    const out = buildKannaSystemPromptAppend([fakeSubagent()])
    expect(out).toContain("mcp__kanna__delegate_subagent")
    expect(out).toContain("@agent/")
  })
})

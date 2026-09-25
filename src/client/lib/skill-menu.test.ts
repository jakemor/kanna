import { describe, expect, test } from "bun:test"
import type { HarnessSkill } from "../../shared/types"
import { applySkillCompletion, CODEX_SKILL_MENU_TRIGGERS, filterSkillMenuItems, getActiveSkillMention } from "./skill-menu"

function skill(name: string, description = ""): HarnessSkill {
  return { name, description, source: "skill" }
}

function query(value: string, caret: number, triggers?: readonly string[]) {
  return getActiveSkillMention(value, caret, triggers)?.query ?? null
}

describe("getActiveSkillMention", () => {
  test("active while the caret is inside the leading /token", () => {
    expect(getActiveSkillMention("/", 1)).toEqual({ start: 0, query: "" })
    expect(query("/rev", 4)).toBe("rev")
    expect(query("/rev", 2)).toBe("r")
  })

  test("active mid-message and at the end", () => {
    expect(getActiveSkillMention("run /rev now", 8)).toEqual({ start: 4, query: "rev" })
    expect(query("first /review then /sim", 23)).toBe("sim")
    expect(query("line one\n/dep", 13)).toBe("dep")
  })

  test("inactive once the caret leaves the token", () => {
    expect(query("/review args", 8)).toBeNull()
    expect(query("/review ", 8)).toBeNull()
  })

  test("inactive for paths, slashes inside words and plain text", () => {
    expect(query("see /etc/hosts", 8)).toBeNull()
    expect(query("src/foo", 4)).toBeNull()
    expect(query("hello", 3)).toBeNull()
    expect(query("", 0)).toBeNull()
  })

  test("inactive when the caret sits before the slash", () => {
    expect(query("/rev", 0)).toBeNull()
  })

  test("$ triggers only with the codex trigger set", () => {
    expect(query("$dep", 4)).toBeNull()
    expect(query("$dep", 4, CODEX_SKILL_MENU_TRIGGERS)).toBe("dep")
    expect(query("/dep", 4, CODEX_SKILL_MENU_TRIGGERS)).toBe("dep")
    expect(query("$deploy args", 9, CODEX_SKILL_MENU_TRIGGERS)).toBeNull()
    expect(query("see $dep", 8, CODEX_SKILL_MENU_TRIGGERS)).toBe("dep")
    expect(query("costs $5", 8, CODEX_SKILL_MENU_TRIGGERS)).toBeNull()
  })
})

describe("filterSkillMenuItems", () => {
  test("orders ascending so the best match is last (adjacent to the input)", () => {
    const items = filterSkillMenuItems(
      [skill("verify"), skill("code-review"), skill("review")],
      "rev"
    )
    expect(items.map((entry) => entry.name).at(-1)).toBe("review")
    expect(items.map((entry) => entry.name)).toContain("code-review")
  })

  test("matches segment starts in namespaced names", () => {
    const items = filterSkillMenuItems([skill("skill:brave-search"), skill("deploy")], "brave")
    expect(items.map((entry) => entry.name)).toEqual(["skill:brave-search"])
  })

  test("falls back to description matches and drops non-matches", () => {
    const items = filterSkillMenuItems(
      [skill("alpha", "reviews pull requests"), skill("beta", "ships releases")],
      "pull"
    )
    expect(items.map((entry) => entry.name)).toEqual(["alpha"])
  })

  test("empty query keeps every skill", () => {
    expect(filterSkillMenuItems([skill("a"), skill("b")], "")).toHaveLength(2)
  })
})

function complete(value: string, caret: number, name: string, triggers = CODEX_SKILL_MENU_TRIGGERS) {
  return applySkillCompletion(value, getActiveSkillMention(value, caret, triggers)!, name)
}

describe("applySkillCompletion", () => {
  test("replaces the leading token and appends a space", () => {
    expect(complete("/rev", 4, "review")).toEqual({ value: "/review ", caret: 8 })
  })

  test("preserves existing argument text", () => {
    expect(complete("/rev main branch", 4, "review").value).toBe("/review main branch")
  })

  test("handles a bare slash", () => {
    expect(complete("/", 1, "skill:brave-search").value).toBe("/skill:brave-search ")
  })

  test("normalizes a $ trigger to the canonical / form", () => {
    expect(complete("$dep", 4, "deploy-helper").value).toBe("/deploy-helper ")
    expect(complete("$dep to prod", 4, "deploy-helper").value).toBe("/deploy-helper to prod")
  })

  test("completes the token under the caret, leaving other skills alone", () => {
    expect(complete("/review this then /sim", 22, "simplify")).toEqual({
      value: "/review this then /simplify ",
      caret: 28,
    })
    expect(complete("use /rev on main", 8, "review")).toEqual({ value: "use /review on main", caret: 12 })
  })
})

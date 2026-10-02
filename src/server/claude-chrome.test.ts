import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { claudeGlobalConfigPath, isClaudeInChromeEnabled } from "./claude-chrome"

async function configDir(contents: string | null) {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-claude-chrome-"))
  if (contents !== null) await writeFile(path.join(dir, ".claude.json"), contents)
  return { CLAUDE_CONFIG_DIR: dir }
}

describe("isClaudeInChromeEnabled", () => {
  test("reads the config from CLAUDE_CONFIG_DIR when set", () => {
    expect(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: "/x" })).toBe("/x/.claude.json")
  })

  test("on when Claude has it enabled by default", async () => {
    expect(await isClaudeInChromeEnabled(await configDir(JSON.stringify({ claudeInChromeDefaultEnabled: true })))).toBe(true)
  })

  test("off when disabled, absent, unreadable or missing", async () => {
    expect(await isClaudeInChromeEnabled(await configDir(JSON.stringify({ claudeInChromeDefaultEnabled: false })))).toBe(false)
    expect(await isClaudeInChromeEnabled(await configDir("{}"))).toBe(false)
    expect(await isClaudeInChromeEnabled(await configDir("{not json"))).toBe(false)
    expect(await isClaudeInChromeEnabled(await configDir(null))).toBe(false)
  })
})

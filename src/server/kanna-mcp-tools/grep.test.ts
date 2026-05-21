import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createGrepTool } from "./grep"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-grep-"))
  const store = createTestEventStore(dir)
  await store.initialize()
  const cleanup = async () => {
    await new Promise<void>((r) => setTimeout(r, 50))
    await rm(dir, { recursive: true, force: true })
  }
  return { store, dir, cleanup }
}

const ctx = (cwd: string) => ({
  chatId: "c",
  sessionId: "s",
  toolUseId: "tu",
  cwd,
  chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-allow" as const },
})

describe("mcp__kanna__grep", () => {
  test("finds lines matching pattern across multiple files", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createGrepTool({ toolCallback: svc })

      // Use a dedicated search dir separate from the event store dir
      const searchDir = path.join(dir, "search")
      await mkdir(searchDir)
      await writeFile(path.join(searchDir, "alpha.txt"), "hello world\nfoo bar\nhello again")
      await mkdir(path.join(searchDir, "sub"))
      await writeFile(path.join(searchDir, "sub", "beta.txt"), "nothing here\nhello sub\n")
      await writeFile(path.join(searchDir, "gamma.txt"), "no match")

      const result = await tool.handler({ path: searchDir, pattern: "hello" }, ctx(dir))
      expect(result.isError).toBeFalsy()
      const lines = result.content[0].text.split("\n").filter(Boolean)
      // Should find "hello world", "hello again", "hello sub"
      expect(lines.length).toBe(3)
      expect(lines.every((l) => l.includes("hello"))).toBe(true)
    } finally { await cleanup() }
  }, 30_000)

  test("path in readPathDeny → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createGrepTool({ toolCallback: svc })
      const result = await tool.handler({ path: "~/.ssh", pattern: "KEY" }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)
})

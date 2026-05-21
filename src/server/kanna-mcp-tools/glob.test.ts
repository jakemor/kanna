import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createGlobTool } from "./glob"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-glob-"))
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

describe("mcp__kanna__glob", () => {
  test("*.ts pattern → returns matching files only", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createGlobTool({ toolCallback: svc })

      // Create a mix of .ts and .txt files
      await writeFile(path.join(dir, "foo.ts"), "")
      await writeFile(path.join(dir, "bar.ts"), "")
      await writeFile(path.join(dir, "baz.txt"), "")
      await mkdir(path.join(dir, "sub"))
      await writeFile(path.join(dir, "sub", "qux.ts"), "")

      const result = await tool.handler({ path: dir, pattern: "**/*.ts" }, ctx(dir))
      expect(result.isError).toBeFalsy()
      const lines = result.content[0].text.split("\n").filter(Boolean)
      expect(lines.every((l) => l.endsWith(".ts"))).toBe(true)
      expect(lines.some((l) => l.includes("baz.txt"))).toBe(false)
      expect(lines.length).toBe(3)
    } finally { await cleanup() }
  }, 30_000)

  test("path in readPathDeny → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createGlobTool({ toolCallback: svc })
      const result = await tool.handler({ path: "~/.ssh", pattern: "*.pem" }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)
})

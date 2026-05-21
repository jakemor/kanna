import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createWriteTool } from "./write"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-write-"))
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

describe("mcp__kanna__write", () => {
  test("writes file content", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWriteTool({ toolCallback: svc })
      const filePath = path.join(dir, "subdir", "output.txt")
      const result = await tool.handler({ path: filePath, content: "written content" }, ctx(dir))
      expect(result.isError).toBeFalsy()
      const read = await readFile(filePath, "utf8")
      expect(read).toBe("written content")
    } finally { await cleanup() }
  }, 30_000)

  test("path in writePathDeny → isError", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWriteTool({ toolCallback: svc })
      const result = await tool.handler({ path: "~/.ssh/authorized_keys", content: "key data" }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)
})

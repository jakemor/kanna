import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createReadTool } from "./read"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-read-"))
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

describe("mcp__kanna__read", () => {
  test("reads existing file → content in result, no isError", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createReadTool({ toolCallback: svc })
      const filePath = path.join(dir, "hello.txt")
      await writeFile(filePath, "hello world")
      const result = await tool.handler({ path: filePath }, ctx(dir))
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toBe("hello world")
    } finally { await cleanup() }
  }, 30_000)

  test("path in readPathDeny (~/.ssh/id_rsa) → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createReadTool({ toolCallback: svc })
      const result = await tool.handler({ path: "~/.ssh/id_rsa" }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)

  test("missing file → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createReadTool({ toolCallback: svc })
      const result = await tool.handler({ path: path.join(dir, "does-not-exist.txt") }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)
})

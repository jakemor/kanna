import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createWebSearchTool } from "./websearch"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-websearch-"))
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

describe("mcp__kanna__websearch", () => {
  test("always returns isError + message contains 'unavailable'", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWebSearchTool({ toolCallback: svc })
      const result = await tool.handler({ query: "some search query" }, ctx(dir))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("unavailable")
    } finally { await cleanup() }
  }, 30_000)
})

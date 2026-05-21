import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createWebFetchTool } from "./webfetch"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-webfetch-"))
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

describe("mcp__kanna__webfetch", () => {
  test("fetches local server → result contains response body", async () => {
    const { store, dir, cleanup } = await newStore()
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("hello from server", { status: 200 })
      },
    })
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWebFetchTool({ toolCallback: svc })
      const result = await tool.handler({ url: `http://localhost:${server.port}/` }, ctx(dir))
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("hello from server")
    } finally {
      server.stop()
      await cleanup()
    }
  }, 30_000)

  test("bad URL → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWebFetchTool({ toolCallback: svc })
      const result = await tool.handler({ url: "not-a-url" }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)

  test("rejects file:// URL → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWebFetchTool({ toolCallback: svc })
      const result = await tool.handler({ url: "file:///etc/passwd" }, ctx(dir))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("scheme file: not allowed")
    } finally { await cleanup() }
  }, 30_000)

  test("rejects cloud metadata URL → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createWebFetchTool({ toolCallback: svc })
      const result = await tool.handler({ url: "http://169.254.169.254/latest/meta-data/" }, ctx(dir))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("not externally reachable")
    } finally { await cleanup() }
  }, 30_000)
})

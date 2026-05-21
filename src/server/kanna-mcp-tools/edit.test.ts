import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createEditTool } from "./edit"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-edit-"))
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

describe("mcp__kanna__edit", () => {
  test("exact replace works", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createEditTool({ toolCallback: svc })
      const filePath = path.join(dir, "target.txt")
      await writeFile(filePath, "hello world\nfoo bar")
      const result = await tool.handler(
        { path: filePath, oldString: "hello world", newString: "hi there" },
        ctx(dir),
      )
      expect(result.isError).toBeFalsy()
      const updated = await readFile(filePath, "utf8")
      expect(updated).toBe("hi there\nfoo bar")
    } finally { await cleanup() }
  }, 30_000)

  test("oldString not found → isError", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createEditTool({ toolCallback: svc })
      const filePath = path.join(dir, "target.txt")
      await writeFile(filePath, "hello world")
      const result = await tool.handler(
        { path: filePath, oldString: "not present", newString: "whatever" },
        ctx(dir),
      )
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("not found")
    } finally { await cleanup() }
  }, 30_000)

  test("path in writePathDeny → isError", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createEditTool({ toolCallback: svc })
      const result = await tool.handler(
        { path: "~/.ssh/config", oldString: "Host", newString: "Host2" },
        ctx(dir),
      )
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)

  test("$ characters in newString are inserted literally", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createEditTool({ toolCallback: svc })
      const filePath = path.join(dir, "dollar.txt")
      await writeFile(filePath, "foo bar")
      const result = await tool.handler(
        { path: filePath, oldString: "foo", newString: "$&-literal" },
        ctx(dir),
      )
      expect(result.isError).toBeFalsy()
      const updated = await readFile(filePath, "utf8")
      // Must contain literal "$&-literal", not "foo-literal"
      expect(updated).toBe("$&-literal bar")
    } finally { await cleanup() }
  }, 30_000)
})

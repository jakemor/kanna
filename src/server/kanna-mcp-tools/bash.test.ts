import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createTestEventStore } from "../storage/test-helpers"
import { createToolCallbackService } from "../tool-callback"
import { createBashTool } from "./bash"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-bash-"))
  const store = createTestEventStore(dir)
  await store.initialize()
  // Delay before removing dir so background persist tasks (fired by auto-allow/auto-deny)
  // have time to complete before the tmpdir is removed.
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

describe("mcp__kanna__bash", () => {
  test("auto-allowed verb (pwd) → stdout contains cwd, no isError", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createBashTool({ toolCallback: svc })
      const result = await tool.handler({ command: "pwd" }, ctx(dir))
      expect(result.isError).toBeFalsy()
      // pwd resolves symlinks; use realpath comparison
      const realDir = await Bun.spawn(["realpath", dir], { stdout: "pipe" })
      const realDirStr = (await new Response(realDir.stdout).text()).trim()
      const resultText = result.content[0].text
      expect(resultText).toContain(realDirStr)
    } finally { await cleanup() }
  }, 30_000)

  test("toolDenyList match (rm -rf /) → isError true", async () => {
    const { store, dir, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({ store, serverSecret: "k", now: () => 1, timeoutMs: 600_000 })
      const tool = createBashTool({ toolCallback: svc })
      const result = await tool.handler({ command: "rm -rf /" }, ctx(dir))
      expect(result.isError).toBe(true)
    } finally { await cleanup() }
  }, 30_000)
})

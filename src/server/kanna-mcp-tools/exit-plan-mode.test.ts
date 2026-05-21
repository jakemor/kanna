import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { createToolCallbackService } from "../tool-callback"
import { createTestEventStore } from "../storage/test-helpers"
import { createExitPlanModeTool } from "./exit-plan-mode"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-epm-"))
  const store = createTestEventStore(dir)
  await store.initialize()
  const cleanup = async () => {
    await new Promise<void>((r) => setTimeout(r, 50))
    await rm(dir, { recursive: true, force: true })
  }
  return { store, dir, cleanup }
}

const handlerCtx = () => ({
  chatId: "c",
  sessionId: "s",
  toolUseId: "tu",
  cwd: "/tmp",
  chatPolicy: POLICY_DEFAULT,
})

describe("mcp__kanna__exit_plan_mode", () => {
  test("confirmed answer → returns success content", async () => {
    const { store, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({
        store, serverSecret: "k", now: () => 1, timeoutMs: 600_000,
      })
      const tool = createExitPlanModeTool({ toolCallback: svc })
      const promise = tool.handler({ plan: "do x" }, handlerCtx())
      const pending = await store.listPendingToolRequests("c")
      await svc.answer(pending[0].id, { kind: "answer", payload: { confirmed: true } })
      const result = await promise
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("confirmed")
    } finally { await cleanup() }
  })

  test("rejected with message → isError true with message", async () => {
    const { store, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({
        store, serverSecret: "k", now: () => 1, timeoutMs: 600_000,
      })
      const tool = createExitPlanModeTool({ toolCallback: svc })
      const promise = tool.handler({ plan: "do x" }, handlerCtx())
      const pending = await store.listPendingToolRequests("c")
      await svc.answer(pending[0].id, { kind: "answer", payload: { confirmed: false, message: "tweak step 3" } })
      const result = await promise
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("tweak step 3")
    } finally { await cleanup() }
  })
})

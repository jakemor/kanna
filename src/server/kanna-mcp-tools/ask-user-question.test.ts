import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { EventStore } from "../event-store"
import { createToolCallbackService } from "../tool-callback"
import { createAskUserQuestionTool } from "./ask-user-question"

async function newStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-mcp-aq-"))
  const store = new EventStore(dir)
  await store.initialize()
  const cleanup = async () => {
    await new Promise<void>((r) => setTimeout(r, 50))
    await rm(dir, { recursive: true, force: true })
  }
  return { store, dir, cleanup }
}

const handlerCtx = () => ({
  chatId: "c1",
  sessionId: "s1",
  toolUseId: "tu1",
  cwd: "/tmp",
  chatPolicy: POLICY_DEFAULT,
})

describe("mcp__kanna__ask_user_question", () => {
  test("calls policy.evaluate then routes to tool-callback", async () => {
    const { store, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({
        store, serverSecret: "k", now: () => 1, timeoutMs: 600_000,
      })
      const tool = createAskUserQuestionTool({ toolCallback: svc })
      const inputArgs = {
        questions: [{
          text: "ok?",
          header: "OK",
          options: [{ label: "yes", description: "" }, { label: "no", description: "" }],
          multiSelect: false,
        }],
      }
      const promise = tool.handler(inputArgs, handlerCtx())
      const pending = await store.listPendingToolRequests("c1")
      expect(pending).toHaveLength(1)
      await svc.answer(pending[0].id, { kind: "answer", payload: { answers: { "ok?": "yes" } } })
      const result = await promise
      expect(result.content[0].type).toBe("text")
      expect(JSON.parse(result.content[0].text).answers).toEqual({ "ok?": "yes" })
      expect(result.isError).toBeFalsy()
    } finally { await cleanup() }
  })

  // Issue #215 follow-up: even under chatPolicy.defaultAction "auto-deny"
  // the tool must take the ask path (UI is the only meaningful outcome),
  // then deny only when the user / cancel resolves it that way.
  test("auto-deny chatPolicy still routes through ask (UI), denial only via cancel/cancelAllForChat", async () => {
    const { store, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({
        store, serverSecret: "k", now: () => 1, timeoutMs: 600_000,
      })
      const tool = createAskUserQuestionTool({ toolCallback: svc })
      const promise = tool.handler(
        {
          questions: [{
            text: "x",
            header: "X",
            options: [{ label: "a", description: "" }, { label: "b", description: "" }],
            multiSelect: false,
          }],
        },
        { ...handlerCtx(), chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-deny" } },
      )
      const pending = await store.listPendingToolRequests("c1")
      expect(pending).toHaveLength(1)
      await svc.cancelAllForChat("c1", "user-cancel")
      const result = await promise
      expect(result.isError).toBe(true)
      expect(result.content[0].type).toBe("text")
      expect(typeof result.content[0].text).toBe("string")
    } finally { await cleanup() }
  })

  // Issue #215 follow-up: fail fast on empty/undefined answer payload.
  // The earlier bug silently produced `text: JSON.stringify(undefined)` =
  // `text: undefined` and crashed the MCP SDK validator with -32602.
  // Coercing to `{}` would hide the underlying policy-gate bug (interactive
  // tool auto-allowed without user input). Instead the shim throws so the
  // failure is loud and the root cause is detectable.
  test("answer decision with no payload → throws loudly (no silent {} coercion)", async () => {
    const { store, cleanup } = await newStore()
    try {
      const svc = createToolCallbackService({
        store, serverSecret: "k", now: () => 1, timeoutMs: 600_000,
      })
      const tool = createAskUserQuestionTool({ toolCallback: svc })
      const promise = tool.handler(
        {
          questions: [{
            text: "ok?",
            header: "OK",
            options: [{ label: "yes", description: "" }, { label: "no", description: "" }],
            multiSelect: false,
          }],
        },
        handlerCtx(),
      )
      const pending = await store.listPendingToolRequests("c1")
      expect(pending).toHaveLength(1)
      // Resolve with kind:"allow" and no payload — the exact auto-allow
      // shape that previously slipped through.
      await svc.answer(pending[0].id, { kind: "allow" as const })
      await expect(promise).rejects.toThrow(/empty answer payload/i)
    } finally { await cleanup() }
  })
})

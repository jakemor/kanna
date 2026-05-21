import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POLICY_DEFAULT } from "../shared/permission-policy"
import { createToolCallbackService } from "./tool-callback"
import { createTestEventStore } from "./storage/test-helpers"

const tempDirs: string[] = []

afterEach(async () => {
  // Delay before rm so background persist tasks (fire-and-forget from auto-allow/auto-deny)
  // complete before the tmpdir vanishes. Prevents ENOENT unhandled errors in full-suite runs.
  await new Promise<void>((r) => setTimeout(r, 50))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function newTestStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-toolcb-"))
  tempDirs.push(dir)
  const store = createTestEventStore(dir)
  await store.initialize()
  return { store, dir }
}

const baseInput = {
  chatId: "chat-1",
  sessionId: "sess-1",
  toolUseId: "tu-1",
  toolName: "ask_user_question",
  args: { questions: [{ q: "ok?" }] },
  chatPolicy: POLICY_DEFAULT,
  cwd: "/tmp/project",
}

describe("tool-callback durable protocol", () => {
  test("auto-deny short-circuits with deny decision", async () => {
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    const res = await svc.submit({
      ...baseInput,
      toolName: "mcp__kanna__bash",
      args: { command: "rm -rf /" },
    })
    expect(res.decision.kind).toBe("deny")
    expect(res.status).toBe("answered")
  })

  test("ask verdict creates pending record and awaits answer()", async () => {
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    const pending = svc.submit(baseInput)
    const list = await store.listPendingToolRequests("chat-1")
    expect(list).toHaveLength(1)
    await svc.answer(list[0].id, { kind: "answer", payload: { answer: "yes" } })
    const res = await pending
    expect(res.status).toBe("answered")
    expect(res.decision.payload).toEqual({ answer: "yes" })
  })

  test("idempotent retry returns same decision without duplicating UI prompt", async () => {
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    const first = svc.submit(baseInput)
    const second = svc.submit(baseInput)
    expect(await store.listPendingToolRequests("chat-1")).toHaveLength(1)
    const list = await store.listPendingToolRequests("chat-1")
    await svc.answer(list[0].id, { kind: "answer", payload: 1 })
    expect((await first).decision.payload).toBe(1)
    expect((await second).decision.payload).toBe(1)
  })

  test("same toolUseId with mutated args → arg_mismatch fail closed", async () => {
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    void svc.submit(baseInput)
    const list = await store.listPendingToolRequests("chat-1")
    await svc.answer(list[0].id, { kind: "answer", payload: "first" })

    const mutated = svc.submit({ ...baseInput, args: { questions: [{ q: "different?" }] } })
    const res = await mutated
    expect(res.status).toBe("arg_mismatch")
    expect(res.decision.kind).toBe("deny")
    expect(res.mismatchReason).toContain("canonicalArgsHash")
  })

  test("same toolUseId across different chats does NOT trip arg_mismatch", async () => {
    // Regression: claude CLI generates toolUseId starting at "1" per session,
    // so toolUseId="2" recurs in every new chat. Keying seenToolUseIds by
    // toolUseId alone treated those as retries of the first chat and denied
    // every tool call after the first chat ever made one.
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    void svc.submit({ ...baseInput, chatId: "chat-A", sessionId: "sess-A", toolUseId: "2" })
    const listA = await store.listPendingToolRequests("chat-A")
    await svc.answer(listA[0].id, { kind: "answer", payload: "ok" })

    // Different chat, same toolUseId, different args — must not deny.
    const second = svc.submit({
      ...baseInput,
      chatId: "chat-B",
      sessionId: "sess-B",
      toolUseId: "2",
      args: { questions: [{ q: "from chat B" }] },
    })
    const listB = await store.listPendingToolRequests("chat-B")
    expect(listB).toHaveLength(1)
    await svc.answer(listB[0].id, { kind: "answer", payload: "B-ok" })
    const res = await second
    expect(res.status).toBe("answered")
    expect(res.decision.payload).toBe("B-ok")
  })

  test("cancelAllForChat resolves all pending as canceled", async () => {
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    const p = svc.submit(baseInput)
    await svc.cancelAllForChat("chat-1", "PTY shutdown")
    const res = await p
    expect(res.status).toBe("canceled")
  })

  test("timeout resolves pending as timeout/deny", async () => {
    const { store } = await newTestStore()
    let nowVal = 1_000
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => nowVal, timeoutMs: 100,
    })
    const p = svc.submit(baseInput)
    nowVal = 1_000 + 200
    await svc.tickTimeouts()
    const res = await p
    expect(res.status).toBe("timeout")
    expect(res.decision.kind).toBe("deny")
  })

  test("server-restart resolves persisted pending as session_closed", async () => {
    const { store } = await newTestStore()
    const svc1 = createToolCallbackService({ store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000 })
    void svc1.submit(baseInput)
    // Simulate restart: build a fresh service against the SAME store.
    // (in production a new EventStore would also replay; for this test re-use the same store)
    const svc2 = createToolCallbackService({ store, serverSecret: "secret", now: () => 2_000, timeoutMs: 600_000 })
    await svc2.recoverOnStartup()
    const list = await store.listPendingToolRequests("chat-1")
    expect(list).toHaveLength(0)
  })

  test("after timeout fires, a re-submit returns cached terminal result", async () => {
    const { store } = await newTestStore()
    let nowVal = 1_000
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => nowVal, timeoutMs: 100,
    })
    const first = svc.submit(baseInput)
    nowVal = 1_000 + 200
    await svc.tickTimeouts()
    const firstRes = await first
    expect(firstRes.status).toBe("timeout")

    // Re-submit with identical args — must return the cached timeout, not a new pending.
    const second = await svc.submit(baseInput)
    expect(second.status).toBe("timeout")
    expect(second.decision.kind).toBe("deny")
    const pending = await store.listPendingToolRequests("chat-1")
    expect(pending).toHaveLength(0)
  })

  test("arg_mismatch record is durably persisted before submit returns", async () => {
    const { store } = await newTestStore()
    const svc = createToolCallbackService({
      store, serverSecret: "secret", now: () => 1_000, timeoutMs: 600_000,
    })
    void svc.submit(baseInput)
    const list = await store.listPendingToolRequests("chat-1")
    await svc.answer(list[0].id, { kind: "answer", payload: "ok" })

    await svc.submit({ ...baseInput, args: { questions: [{ q: "diff" }] } })
    // After await returns, mismatch record must be persisted in store.
    const all = await store.scanAllToolRequests()
    const mismatch = all.find((r) => r.status === "arg_mismatch")
    expect(mismatch).toBeDefined()
    expect(mismatch?.toolUseId).toBe("tu-1")
  })
})

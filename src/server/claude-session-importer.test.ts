import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { importClaudeSessions } from "./claude-session-importer"

function fresh() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-data-"))
  const homeDir = mkdtempSync(path.join(tmpdir(), "kanna-home-"))
  const realProj = mkdtempSync(path.join(tmpdir(), "kanna-proj-"))
  return {
    dataDir,
    homeDir,
    realProj,
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
      rmSync(realProj, { recursive: true, force: true })
    },
  }
}

function seedSession(homeDir: string, realProj: string, sessionId: string) {
  const folderName = realProj.replace(/\//g, "-")
  const projDir = path.join(homeDir, ".claude", "projects", folderName)
  mkdirSync(projDir, { recursive: true })
  const line1 = JSON.stringify({
    type: "user",
    uuid: "u1",
    sessionId,
    cwd: realProj,
    timestamp: "2026-04-20T10:00:00.000Z",
    message: { role: "user", content: "hi" },
  })
  const line2 = JSON.stringify({
    type: "assistant",
    uuid: "a1",
    sessionId,
    cwd: realProj,
    timestamp: "2026-04-20T10:00:01.000Z",
    message: { role: "assistant", id: "m1", content: [{ type: "text", text: "hello" }] },
  })
  writeFileSync(path.join(projDir, `${sessionId}.jsonl`), `${line1}\n${line2}\n`, "utf8")
}

describe("importClaudeSessions", () => {
  test("imports a session, creating project + chat + messages", async () => {
    const ctx = fresh()
    try {
      seedSession(ctx.homeDir, ctx.realProj, "sess-aaa")
      const store = new EventStore(ctx.dataDir)
      await store.initialize()

      const result = await importClaudeSessions({ store, homeDir: ctx.homeDir })

      expect(result.imported).toBe(1)
      expect(result.skipped).toBe(0)
      expect(result.failed).toBe(0)

      const chats = [...store.state.chatsById.values()].filter((c) => !c.deletedAt)
      expect(chats.length).toBe(1)
      expect(chats[0].sessionToken).toBe("sess-aaa")
      expect(chats[0].provider).toBe("claude")
      expect(store.getMessages(chats[0].id).length).toBe(2)
    } finally {
      ctx.cleanup()
    }
  })

  test("re-import is a no-op (dedup by sessionToken)", async () => {
    const ctx = fresh()
    try {
      seedSession(ctx.homeDir, ctx.realProj, "sess-bbb")
      const store = new EventStore(ctx.dataDir)
      await store.initialize()

      await importClaudeSessions({ store, homeDir: ctx.homeDir })
      const second = await importClaudeSessions({ store, homeDir: ctx.homeDir })

      expect(second.imported).toBe(0)
      expect(second.skipped).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  test("skips session whose cwd no longer exists", async () => {
    const ctx = fresh()
    try {
      seedSession(ctx.homeDir, ctx.realProj, "sess-ccc")
      rmSync(ctx.realProj, { recursive: true, force: true })
      const store = new EventStore(ctx.dataDir)
      await store.initialize()

      const result = await importClaudeSessions({ store, homeDir: ctx.homeDir })
      expect(result.imported).toBe(0)
      expect(result.failed).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  test("derives title from array-form user text", async () => {
    const ctx = fresh()
    try {
      const folderName = ctx.realProj.replace(/\//g, "-")
      const projDir = path.join(ctx.homeDir, ".claude", "projects", folderName)
      mkdirSync(projDir, { recursive: true })
      const line = JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-array",
        cwd: ctx.realProj,
        timestamp: "2026-04-20T10:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "analyse this repo" }],
        },
      })
      const line2 = JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-array",
        cwd: ctx.realProj,
        timestamp: "2026-04-20T10:00:01.000Z",
        message: { role: "assistant", id: "m1", content: [{ type: "text", text: "sure" }] },
      })
      writeFileSync(path.join(projDir, "sess-array.jsonl"), `${line}\n${line2}\n`, "utf8")

      const store = new EventStore(ctx.dataDir)
      await store.initialize()
      const result = await importClaudeSessions({ store, homeDir: ctx.homeDir })
      expect(result.imported).toBe(1)

      const chats = [...store.state.chatsById.values()].filter((c) => !c.deletedAt)
      expect(chats.length).toBe(1)
      expect(chats[0].title).toBe("analyse this repo")
    } finally {
      ctx.cleanup()
    }
  })

  test("re-import with unchanged file is skipped (hash match)", async () => {
    const ctx = fresh()
    try {
      seedSession(ctx.homeDir, ctx.realProj, "sess-hash-1")
      const store = new EventStore(ctx.dataDir)
      await store.initialize()

      const first = await importClaudeSessions({ store, homeDir: ctx.homeDir })
      expect(first.imported).toBe(1)

      const second = await importClaudeSessions({ store, homeDir: ctx.homeDir })
      expect(second.imported).toBe(0)
      expect(second.updated).toBe(0)
      expect(second.skipped).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  test("re-import after JSONL grows appends new messages and counts as updated", async () => {
    const ctx = fresh()
    try {
      const folderName = ctx.realProj.replace(/\//g, "-")
      const projDir = path.join(ctx.homeDir, ".claude", "projects", folderName)
      mkdirSync(projDir, { recursive: true })
      const jsonlPath = path.join(projDir, "sess-grow.jsonl")

      const line1 = JSON.stringify({
        type: "user", uuid: "u1", sessionId: "sess-grow", cwd: ctx.realProj,
        timestamp: "2026-04-20T10:00:00.000Z",
        message: { role: "user", content: "first" },
      })
      const line2 = JSON.stringify({
        type: "assistant", uuid: "a1", sessionId: "sess-grow", cwd: ctx.realProj,
        timestamp: "2026-04-20T10:00:01.000Z",
        message: { role: "assistant", id: "m1", content: [{ type: "text", text: "hello" }] },
      })
      writeFileSync(jsonlPath, `${line1}\n${line2}\n`, "utf8")

      const store = new EventStore(ctx.dataDir)
      await store.initialize()

      const first = await importClaudeSessions({ store, homeDir: ctx.homeDir })
      expect(first.imported).toBe(1)
      const chats = [...store.state.chatsById.values()].filter((c) => !c.deletedAt)
      expect(chats.length).toBe(1)
      expect(store.getMessages(chats[0].id).length).toBe(2)

      // append a new turn
      const line3 = JSON.stringify({
        type: "user", uuid: "u2", sessionId: "sess-grow", cwd: ctx.realProj,
        timestamp: "2026-04-20T10:00:02.000Z",
        message: { role: "user", content: "second" },
      })
      const line4 = JSON.stringify({
        type: "assistant", uuid: "a2", sessionId: "sess-grow", cwd: ctx.realProj,
        timestamp: "2026-04-20T10:00:03.000Z",
        message: { role: "assistant", id: "m2", content: [{ type: "text", text: "world" }] },
      })
      writeFileSync(jsonlPath, `${line1}\n${line2}\n${line3}\n${line4}\n`, "utf8")

      const second = await importClaudeSessions({ store, homeDir: ctx.homeDir })
      expect(second.imported).toBe(0)
      expect(second.updated).toBe(1)
      expect(second.skipped).toBe(0)
      expect(store.getMessages(chats[0].id).length).toBe(4)
    } finally {
      ctx.cleanup()
    }
  })
})

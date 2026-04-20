import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import type { SnapshotFile } from "./events"
import { EventStore } from "./event-store"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const tempDirs: string[] = []

afterEach(async () => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-event-store-"))
  tempDirs.push(dir)
  return dir
}

function entry(kind: "user_prompt" | "assistant_text", createdAt: number, extra: Record<string, unknown> = {}): TranscriptEntry {
  const base = { _id: `${kind}-${createdAt}`, createdAt }
  if (kind === "user_prompt") {
    return { ...base, kind, content: String(extra.content ?? "") }
  }
  return { ...base, kind, text: String(extra.content ?? extra.text ?? "") }
}

describe("EventStore", () => {
  test("uses the runtime profile for the default data dir", () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.kanna-dev/data")
  })

  test("migrates legacy snapshot and messages log transcripts into per-chat files", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const messagesLogPath = join(dataDir, "messages.jsonl")
    const chatId = "chat-1"

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: chatId,
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        unread: false,
        provider: null,
        planMode: false,
        sessionToken: null,
        sourceHash: null,
        lastTurnOutcome: null,
      }],
      messages: [{
        chatId,
        entries: [
          entry("user_prompt", 100, { content: "hello" }),
        ],
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(messagesLogPath, `${JSON.stringify({
      v: 2,
      type: "message_appended",
      timestamp: 101,
      chatId,
      entry: entry("assistant_text", 101, { content: "world" }),
    })}\n`, "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const progress: string[] = []
    const migrated = await store.migrateLegacyTranscripts((message) => {
      progress.push(message)
    })

    expect(migrated).toBe(true)
    expect(progress.some((message) => message.includes("transcript migration detected"))).toBe(true)
    expect(progress.at(-1)).toContain("transcript migration complete")
    expect(store.getMessages(chatId)).toEqual([
      entry("user_prompt", 100, { content: "hello" }),
      entry("assistant_text", 101, { text: "world" }),
    ])

    const migratedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
    expect(migratedSnapshot.messages).toBeUndefined()
    expect(await readFile(messagesLogPath, "utf8")).toBe("")
    expect(await readFile(join(dataDir, "transcripts", `${chatId}.jsonl`), "utf8")).toContain('"kind":"assistant_text"')
  })

  test("appends new transcript entries only to the per-chat transcript file", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))
    await store.compact()

    expect(store.getMessages(chat.id)).toEqual([
      entry("user_prompt", 200, { content: "hello" }),
      entry("assistant_text", 201, { text: "world" }),
    ])
    expect(await readFile(join(dataDir, "messages.jsonl"), "utf8")).toBe("")

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.messages).toBeUndefined()
    expect(existsSync(join(dataDir, "transcripts", `${chat.id}.jsonl`))).toBe(true)
  })

  test("pages recent transcript history and older entries by cursor", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    for (let index = 1; index <= 5; index += 1) {
      await store.appendMessage(chat.id, entry(index % 2 === 0 ? "assistant_text" : "user_prompt", 200 + index, {
        content: `message-${index}`,
      }))
    }

    const recentPage = store.getRecentMessagesPage(chat.id, 2)
    expect(recentPage.messages.map((message) => message._id)).toEqual(["assistant_text-204", "user_prompt-205"])
    expect(recentPage.hasOlder).toBe(true)
    expect(recentPage.olderCursor).not.toBeNull()

    const olderPage = store.getMessagesPageBefore(chat.id, recentPage.olderCursor!, 2)
    expect(olderPage.messages.map((message) => message._id)).toEqual(["assistant_text-202", "user_prompt-203"])
    expect(olderPage.hasOlder).toBe(true)
    expect(olderPage.olderCursor).not.toBeNull()

    const oldestPage = store.getMessagesPageBefore(chat.id, olderPage.olderCursor!, 2)
    expect(oldestPage.messages.map((message) => message._id)).toEqual(["user_prompt-201"])
    expect(oldestPage.hasOlder).toBe(false)
    expect(oldestPage.olderCursor).toBeNull()
  })

  test("persists queued messages across restart and removes promoted entries", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const first = await store.enqueueMessage(chat.id, {
      content: "first queued",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
    })
    const second = await store.enqueueMessage(chat.id, {
      content: "second queued",
      attachments: [],
      provider: "claude",
      model: "claude-sonnet-4-6",
      planMode: true,
    })

    expect(store.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    await reloaded.removeQueuedMessage(chat.id, first.id)
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.id)).toEqual([second.id])
  })

  test("marks chats unread on completed turns and clears unread when marked read", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFinished(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.setChatReadState(chat.id, false)
    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFailed(chat.id, "boom")
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.recordTurnCancelled(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.unread).toBe(true)
  })

  test("preserves read state after a finished turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFinished(chat.id)
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("preserves read state after a failed turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFailed(chat.id, "boom")
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("prefers mark-read over turn completion when replay timestamps tie", async () => {
    const dataDir = await createTempDataDir()
    const chatsLogPath = join(dataDir, "chats.jsonl")
    const turnsLogPath = join(dataDir, "turns.jsonl")
    const projectId = "project-1"
    const chatId = "chat-1"
    const timestamp = 100

    await writeFile(chatsLogPath, [
      JSON.stringify({
        v: 2,
        type: "chat_created",
        timestamp,
        chatId,
        projectId,
        title: "Chat",
      }),
      JSON.stringify({
        v: 2,
        type: "chat_read_state_set",
        timestamp,
        chatId,
        unread: false,
      }),
      "",
    ].join("\n"), "utf8")
    await writeFile(turnsLogPath, [
      JSON.stringify({
        v: 2,
        type: "turn_finished",
        timestamp,
        chatId,
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat(chatId)?.unread).toBe(false)
  })

  test("loads chats without unread from older snapshots as read", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")

    const snapshot = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: "chat-1",
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        unread: false,
        provider: null,
        planMode: false,
        sessionToken: null,
        sourceHash: null,
        lastTurnOutcome: null,
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat("chat-1")?.unread).toBe(false)
  })

  test("persists sidebar project order across restart and compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const first = await store.openProject("/tmp/project-a")
    const second = await store.openProject("/tmp/project-b")

    await store.setSidebarProjectOrder([second.id, first.id])
    expect(store.state.sidebarProjectOrder).toEqual([second.id, first.id])

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.state.sidebarProjectOrder).toEqual([second.id, first.id])
  })

  test("prunes stale empty chats after thirty minutes", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const staleNow = chat.createdAt + 30 * 60 * 1000

    const pruned = await store.pruneStaleEmptyChats({ now: staleNow })

    expect(pruned).toEqual([chat.id])
    expect(store.getChat(chat.id)).toBeNull()
  })

  test("does not prune recent empty chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const pruned = await store.pruneStaleEmptyChats({ now: chat.createdAt + 30 * 60 * 1000 - 1 })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune chats once they have transcript messages", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "hello" }))

    const pruned = await store.pruneStaleEmptyChats({ now: chat.createdAt + 30 * 60 * 1000 })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune stale chats that are currently active", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const pruned = await store.pruneStaleEmptyChats({
      now: chat.createdAt + 30 * 60 * 1000,
      activeChatIds: [chat.id],
    })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })

  test("does not prune stale chats with protected draft state", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const pruned = await store.pruneStaleEmptyChats({
      now: chat.createdAt + 30 * 60 * 1000,
      protectedChatIds: [chat.id],
    })

    expect(pruned).toEqual([])
    expect(store.getChat(chat.id)?.id).toBe(chat.id)
  })
})

describe("recordSessionCommandsLoaded", () => {
  test("stores latest commands on chat record", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordSessionCommandsLoaded(chat.id, [
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
    ])

    expect(store.getChat(chat.id)?.slashCommands).toEqual([
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
    ])
  })

  test("replaces commands on subsequent load", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordSessionCommandsLoaded(chat.id, [
      { name: "a", description: "", argumentHint: "" },
    ])
    await store.recordSessionCommandsLoaded(chat.id, [
      { name: "b", description: "", argumentHint: "" },
    ])

    expect(store.getChat(chat.id)?.slashCommands).toEqual([
      { name: "b", description: "", argumentHint: "" },
    ])
  })

  test("skips redundant writes when commands are unchanged", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const turnsLogPath = join(dataDir, "turns.jsonl")

    const commands = [{ name: "review", description: "Review", argumentHint: "<pr>" }]
    await store.recordSessionCommandsLoaded(chat.id, commands)
    const afterFirst = (await readFile(turnsLogPath, "utf8")).trim().split("\n").length

    await store.recordSessionCommandsLoaded(chat.id, [...commands.map((c) => ({ ...c }))])
    const afterSecond = (await readFile(turnsLogPath, "utf8")).trim().split("\n").length

    expect(afterSecond).toBe(afterFirst)
  })

  test("compaction + reload preserves slashCommands on chat records", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const commands = [
      { name: "review", description: "Review PR", argumentHint: "<pr>" },
      { name: "help", description: "Show help", argumentHint: "" },
    ]
    await store.recordSessionCommandsLoaded(chat.id, commands)
    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.slashCommands).toEqual(commands)
  })
})

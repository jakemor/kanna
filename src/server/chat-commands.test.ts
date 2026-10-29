import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createChatCommands } from "./chat-commands"
import { EventStore } from "./event-store"
import { timestamped } from "./transcript"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-chat-commands-"))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(dataDir)
  const calls: string[] = []
  const tracked: string[] = []
  const agent = {
    send: async () => { calls.push("send"); return { chatId: "c" } },
    enqueue: async () => { calls.push("enqueue"); return { queuedMessageId: "q" } },
    steer: async () => { calls.push("steer") },
    dequeue: async () => { calls.push("dequeue") },
    cancel: async (chatId: string, options?: { cascade?: boolean }) => {
      calls.push(options?.cascade === false ? `cancel:${chatId}:turn-only` : `cancel:${chatId}`)
    },
    closeChat: async (chatId: string) => { calls.push(`close:${chatId}`) },
    forkChat: async () => ({ chatId: "fork" }),
  }
  const commands = createChatCommands({
    store,
    agent: agent as never,
    analytics: { track: (event: string) => { tracked.push(event) } } as never,
  })
  return { store, project, commands, calls, tracked }
}

describe("chat commands", () => {
  test("creating a chat says the sidebar and the project list changed", async () => {
    const { commands, project, store } = await setup()
    const outcome = await commands.create(project.id)
    expect(store.getChat(outcome.result.chatId)).not.toBeNull()
    expect(outcome.changed).toEqual({ sidebar: true, localProjects: true, chatIds: [outcome.result.chatId] })
  })

  test("a chat takes the id its client made for it, if that is a UUID nothing else has", async () => {
    const { commands, project, store } = await setup()
    const chatId = "0b9c4d0e-6f0a-4a57-9d55-1f3a6c1d2e77"
    const outcome = await commands.create(project.id, undefined, { chatId })
    expect(outcome.result.chatId).toBe(chatId)
    expect(store.getChat(chatId)).toMatchObject({ projectId: project.id, title: "New Chat" })

    await expect(commands.create(project.id, undefined, { chatId })).rejects.toThrow("Chat already exists")
    // The id becomes file names.
    for (const bad of ["../../etc/passwd", "chat-1", "", "0B9C4D0E-6F0A-4A57-9D55-1F3A6C1D2E77", `${chatId}/x`]) {
      await expect(commands.create(project.id, undefined, { chatId: bad })).rejects.toThrow("Invalid chat id")
    }
    // A deleted chat keeps its id.
    await commands.delete(chatId)
    await expect(commands.create(project.id, undefined, { chatId })).rejects.toThrow("Chat already exists")
  })

  test("a chat an agent creates carries its lineage and is not counted as the user's", async () => {
    const { commands, project, store, tracked } = await setup()
    const mine = await commands.create(project.id)
    const theirs = await commands.create(project.id, { createdByChatId: mine.result.chatId, parentChatId: mine.result.chatId })
    expect(store.getChat(theirs.result.chatId)).toMatchObject({ parentChatId: mine.result.chatId, createdByChatId: mine.result.chatId })
    expect(tracked).toEqual(["chat_created"])
  })

  test("a Grok chat cannot be made a delegator, and a delegator that went to Grok can stop", async () => {
    const { commands, project, store } = await setup()
    const grok = (await commands.create(project.id)).result.chatId
    await store.setChatProvider(grok, "grok")
    await expect(commands.setDelegator(grok, true)).rejects.toThrow("A Grok chat cannot be a delegator")
    expect(store.getChat(grok)).not.toHaveProperty("delegator")

    const switched = (await commands.create(project.id, undefined, { delegator: true })).result.chatId
    await store.setChatProvider(switched, "grok")
    await commands.setDelegator(switched, false)
    expect(store.getChat(switched)).not.toHaveProperty("delegator")
  })

  test("archiving an empty chat deletes it, and its own topic is pushed so open tabs see it go", async () => {
    const { commands, project, store } = await setup()
    const empty = (await commands.create(project.id)).result.chatId
    expect((await commands.archive(empty)).changed).toEqual({ sidebar: true, localProjects: true, chatIds: [empty] })
    expect(store.getChat(empty)).toBeNull()

    const used = (await commands.create(project.id)).result.chatId
    await store.appendMessage(used, timestamped({ kind: "user_prompt", content: "hello" }))
    expect((await commands.archive(used)).changed).toEqual({ sidebar: true, localProjects: true })
    expect(store.getChat(used)?.archivedAt).toBeDefined()
  })

  test("restoring a chat marks it done", async () => {
    const { commands, project, store } = await setup()
    const chatId = (await commands.create(project.id)).result.chatId
    await store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "hello" }))
    await commands.archive(chatId)
    await commands.unarchive(chatId)
    expect(store.getChat(chatId)?.archivedAt).toBeUndefined()
    expect(store.getChat(chatId)?.doneAt).toBeDefined()
  })

  test("deleting stops the chat before it removes it", async () => {
    const { commands, project, store, calls, tracked } = await setup()
    const chatId = (await commands.create(project.id)).result.chatId
    await commands.delete(chatId)
    expect(calls).toEqual([`cancel:${chatId}`, `close:${chatId}`])
    expect(store.getChat(chatId)).toBeNull()
    expect(tracked).toContain("chat_deleted")
  })

  test("a turn pushes its own state, so sending and stopping name no snapshots", async () => {
    const { commands } = await setup()
    expect((await commands.send({ type: "chat.send", chatId: "c", content: "hi" })).changed).toBeNull()
    expect((await commands.cancel("c")).changed).toBeNull()
    expect((await commands.enqueue({ type: "message.enqueue", chatId: "c", content: "hi" })).changed).toEqual({ sidebar: true, chatIds: ["c"] })
  })

  test("a stop takes its sub-chats unless it says cascade: false", async () => {
    const { commands, calls } = await setup()
    await commands.cancel("c")
    await commands.cancel("c", { cascade: true })
    await commands.cancel("c", { cascade: false })
    expect(calls).toEqual(["cancel:c", "cancel:c", "cancel:c:turn-only"])
  })
})

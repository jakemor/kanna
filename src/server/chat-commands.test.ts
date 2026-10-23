import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Result } from "effect"
import { makeFakeAnalytics } from "./analytics.fake"
import { ChatAgentError } from "./chat-agent"
import { makeFakeChatAgent } from "./chat-agent.fake"
import { createChatCommands } from "./chat-commands"
import { runTest } from "./effect/testing"
import { EventStore } from "./event-store"
import { timestamped } from "./transcript"

const setup = Effect.fn("test.setup")(function* (overrides?: Parameters<typeof makeFakeChatAgent>[0]) {
  const fs = yield* FileSystem.FileSystem
  const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "kanna-chat-commands-" })
  const store = yield* EventStore.make({ dataDir })
  const project = yield* store.openProject(dataDir)
  const { agent, calls } = makeFakeChatAgent(overrides)
  const { analytics, events: tracked } = makeFakeAnalytics()
  const commands = createChatCommands({ store, agent, analytics })
  return { store, project, commands, calls, tracked }
})

describe("chat commands", () => {
  test("creating a chat says the sidebar and the project list changed", () => runTest(Effect.gen(function* () {
    const { commands, project, store } = yield* setup()
    const outcome = yield* commands.create(project.id)
    expect(store.getChat(outcome.result.chatId)).not.toBeNull()
    expect(outcome.changed).toEqual({ sidebar: true, localProjects: true, chatIds: [outcome.result.chatId] })
  })))

  test("a chat takes the id its client made for it, if that is a UUID nothing else has", () => runTest(Effect.gen(function* () {
    const { commands, project, store } = yield* setup()
    const chatId = "0b9c4d0e-6f0a-4a57-9d55-1f3a6c1d2e77"
    const outcome = yield* commands.create(project.id, undefined, { chatId })
    expect(outcome.result.chatId).toBe(chatId)
    expect(store.getChat(chatId)).toMatchObject({ projectId: project.id, title: "New Chat" })

    const rejected = (id: string) => Effect.map(Effect.result(commands.create(project.id, undefined, { chatId: id })), (result) => {
      if (!Result.isFailure(result)) throw new Error(`created a chat with id ${JSON.stringify(id)}`)
      return result.failure
    })
    const taken = yield* rejected(chatId)
    expect(taken._tag).toBe("@kanna/server/event-store/EventStoreRejectedError")
    expect(taken.message).toBe("Chat already exists")
    // The id becomes file names.
    for (const bad of ["../../etc/passwd", "chat-1", "", "0B9C4D0E-6F0A-4A57-9D55-1F3A6C1D2E77", `${chatId}/x`]) {
      expect((yield* rejected(bad)).message).toBe("Invalid chat id")
    }
    // A deleted chat keeps its id.
    yield* commands.delete(chatId)
    expect((yield* rejected(chatId)).message).toBe("Chat already exists")
  })))

  test("a chat an agent creates carries its lineage and is not counted as the user's", () => runTest(Effect.gen(function* () {
    const { commands, project, store, tracked } = yield* setup()
    const mine = yield* commands.create(project.id)
    const theirs = yield* commands.create(project.id, { createdByChatId: mine.result.chatId, parentChatId: mine.result.chatId })
    expect(store.getChat(theirs.result.chatId)).toMatchObject({ parentChatId: mine.result.chatId, createdByChatId: mine.result.chatId })
    expect(tracked).toEqual(["chat_created"])
  })))

  test("archiving an empty chat deletes it, and its own topic is pushed so open tabs see it go", () => runTest(Effect.gen(function* () {
    const { commands, project, store } = yield* setup()
    const empty = (yield* commands.create(project.id)).result.chatId
    expect((yield* commands.archive(empty)).changed).toEqual({ sidebar: true, localProjects: true, chatIds: [empty] })
    expect(store.getChat(empty)).toBeNull()

    const used = (yield* commands.create(project.id)).result.chatId
    yield* store.appendMessage(used, timestamped({ kind: "user_prompt", content: "hello" }))
    expect((yield* commands.archive(used)).changed).toEqual({ sidebar: true, localProjects: true })
    expect(store.getChat(used)?.archivedAt).toBeDefined()
  })))

  test("restoring a chat marks it done", () => runTest(Effect.gen(function* () {
    const { commands, project, store } = yield* setup()
    const chatId = (yield* commands.create(project.id)).result.chatId
    yield* store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "hello" }))
    yield* commands.archive(chatId)
    yield* commands.unarchive(chatId)
    expect(store.getChat(chatId)?.archivedAt).toBeUndefined()
    expect(store.getChat(chatId)?.doneAt).toBeDefined()
  })))

  test("deleting stops the chat before it removes it", () => runTest(Effect.gen(function* () {
    const { commands, project, store, calls, tracked } = yield* setup()
    const chatId = (yield* commands.create(project.id)).result.chatId
    yield* commands.delete(chatId)
    expect(calls).toEqual([`cancel:${chatId}`, `close:${chatId}`])
    expect(store.getChat(chatId)).toBeNull()
    expect(tracked).toContain("chat_deleted")
  })))

  test("a turn pushes its own state, so sending and stopping name no snapshots", () => runTest(Effect.gen(function* () {
    const { commands } = yield* setup()
    expect((yield* commands.send({ type: "chat.send", chatId: "c", content: "hi" })).changed).toBeNull()
    expect((yield* commands.cancel("c")).changed).toBeNull()
    expect((yield* commands.enqueue({ type: "message.enqueue", chatId: "c", content: "hi" })).changed).toEqual({ sidebar: true, chatIds: ["c"] })
  })))

  test("a coordinator that refuses fails with its own words, and a delete it refuses keeps the chat", () => runTest(Effect.gen(function* () {
    const refusal = (operation: ChatAgentError["operation"], chatId: string) =>
      Effect.fail(new ChatAgentError({ operation, chatId, cause: new Error("Queued message not found") }))
    const { commands, project, store } = yield* setup({
      steer: (command) => refusal("steer", command.chatId),
      cancel: (chatId) => refusal("cancel", chatId),
    })
    const steered = yield* Effect.result(commands.steer({ type: "message.steer", chatId: "c", queuedMessageId: "q" }))
    if (!Result.isFailure(steered)) throw new Error("the steer went through")
    expect(steered.failure._tag).toBe("@kanna/server/chat-agent/ChatAgentError")
    expect(steered.failure.message).toBe("Queued message not found")

    const chatId = (yield* commands.create(project.id)).result.chatId
    expect(Result.isFailure(yield* Effect.result(commands.delete(chatId)))).toBe(true)
    expect(store.getChat(chatId)).not.toBeNull()
  })))
})

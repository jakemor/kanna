import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, FileSystem, Layer, Result, Scope } from "effect"
import { NoopAnalytics } from "./analytics"
import { ChatAgent, ChatAgentError } from "./chat-agent"
import { makeFakeChatAgent } from "./chat-agent.fake"
import { ChatCommands, createChatCommands, type ChatChange } from "./chat-commands"
import { runTest } from "./effect/testing"
import { EventStore } from "./event-store"
import { Orchestrator } from "./orchestrator"

/**
 * The service itself, through its layer, over the real store and chat
 * commands and a stand-in coordinator. The rules are tested end to end in
 * `orchestrator.test.ts`; these cover what the layer
 * adds: typed failures, and its lifetime.
 */

const setup = Effect.fn("test.setup")(function* (overrides?: Parameters<typeof makeFakeChatAgent>[0]) {
  const fs = yield* FileSystem.FileSystem
  const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "kanna-orchestrator-service-" })
  const store = yield* EventStore.make({ dataDir })
  const project = yield* store.openProject(dataDir)
  const { agent, calls } = makeFakeChatAgent(overrides)
  const pushes: ChatChange[] = []
  const layer = Orchestrator.layer({ push: (change) => { pushes.push(change) } }).pipe(
    Layer.provide(Layer.succeed(ChatCommands, createChatCommands({ store, agent, analytics: NoopAnalytics }))),
    Layer.provide(Layer.succeed(ChatAgent, agent)),
    Layer.provide(Layer.succeed(EventStore, store)),
  )
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const orchestrator = Context.get(yield* Layer.buildWithScope(layer, scope), Orchestrator)
  const root = (yield* store.createChat(project.id)).id
  return { store, project, orchestrator, calls, pushes, root, scope }
})

const failureOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.map(Effect.result(effect), (result) => {
  if (!Result.isFailure(result)) throw new Error("expected a failure")
  return result.failure
})

describe("the orchestrator service", () => {
  test("a refused action fails with its own error and the words the agent reads", () => runTest(Effect.gen(function* () {
    const { orchestrator, root, calls } = yield* setup()
    const self = yield* failureOf(orchestrator.sendMessage(root, { chatId: root, message: "hi" }))
    expect(self._tag).toBe("@kanna/server/orchestrator/ChatActionRefusedError")
    expect(self.message).toBe("A chat cannot message itself. Use set_schedule to send this chat a message later.")

    const missing = yield* failureOf(orchestrator.readChat({ chatId: "nope" }))
    expect(missing._tag).toBe("@kanna/server/orchestrator/ChatNotFoundError")
    expect(missing.message).toBe("Chat nope not found. list_chats shows the chats that exist.")

    const schedule = yield* failureOf(orchestrator.deleteSchedule("gone"))
    expect(schedule._tag).toBe("@kanna/server/orchestrator/ScheduleNotFoundError")
    expect(calls).toEqual([])
  })))

  test("a sub-chat whose turn does not start owes nothing, and the error says the chat exists", () => runTest(Effect.gen(function* () {
    const { orchestrator, root, store } = yield* setup({
      send: (command) => Effect.fail(new ChatAgentError({ operation: "send", chatId: command.chatId, cause: new Error("codex is not installed") })),
    })
    const failed = yield* failureOf(orchestrator.createChat(root, { message: "audit the parser" }))
    expect(failed._tag).toBe("@kanna/server/orchestrator/TurnNotStartedError")
    const child = store.listChatsByProject(store.getChat(root)!.projectId).find((chat) => chat.parentChatId === root)!
    expect(failed.message).toBe(`Chat ${child.id} exists, but its turn did not start: codex is not installed`)
    expect(store.getChat(child.id)?.reportOwed).toBeFalsy()
  })))

  test("closing the layer stops the schedule timer; until then a due schedule fires", () => runTest(Effect.gen(function* () {
    const running = yield* setup()
    yield* running.orchestrator.start
    yield* running.orchestrator.setSchedule(running.root, { message: "check the build", inMinutes: 0 })
    yield* Effect.sleep(50)
    expect(running.calls).toContain("send")

    const stopped = yield* setup()
    yield* stopped.orchestrator.start
    yield* Scope.close(stopped.scope, Exit.void)
    yield* stopped.orchestrator.setSchedule(stopped.root, { message: "check the build", inMinutes: 0 })
    yield* Effect.sleep(50)
    expect(stopped.calls).toEqual([])
  })))

  test("the coordinator's hooks never wait, so a synchronous caller can make them", () => runTest(Effect.gen(function* () {
    const { orchestrator, root, store, project } = yield* setup()
    const child = yield* store.createChat(project.id, { parentChatId: root, createdByChatId: root })
    yield* store.setReportOwed(child.id, true)
    // As the bridge runs them for the coordinator and the store's hooks.
    Effect.runSync(orchestrator.handleTurnStarted(child.id))
    Effect.runSync(orchestrator.handleChatSettled(child.id))
    Effect.runSync(orchestrator.handleChatStopped(root))
  })))
})

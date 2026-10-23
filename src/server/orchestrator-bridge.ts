import { Context, Effect, Exit, Layer, Scope } from "effect"
import type { MessageSource } from "../shared/types"
import type { AgentToAgentTurn } from "./agent-to-agent"
import { NoopAnalytics, type Analytics } from "./analytics"
import { ChatAgent, type CoordinatorLike } from "./chat-agent"
import { ChatCommands, createChatCommands, type ChatChange } from "./chat-commands"
import { runKanna, runKannaSync } from "./effect/bridge"
import { ServerPlatform } from "./effect/runtime"
import { EventStore } from "./event-store"
import type { EventStoreBridge } from "./event-store-bridge"
import { Orchestrator } from "./orchestrator"

type Service = Orchestrator["Service"]

/**
 * `Orchestrator` as the Promise code that has not moved to Effect yet calls
 * it: the coordinator (its hooks and the turn notices). The method names and
 * shapes are the old class's, so those callers are unchanged.
 *
 * Reads that answer from memory run with `runKannaSync`, writes with
 * `runKanna`; a failure throws (or rejects with) the service's own tagged
 * error, whose message is the text the agent or the user reads. Temporary,
 * like `event-store-bridge.ts`: it goes when its callers take
 * `Orchestrator["Service"]` (wave 4). See docs/effect-migration.md.
 */
export class ChatOrchestrator {
  constructor(readonly service: Service, private readonly close: () => void = () => {}) {}

  /** See `Orchestrator.start`. */
  start() { runKannaSync(this.service.start) }
  /** See `Orchestrator.stop`. Also closes the orchestrator `openChatOrchestrator` built. */
  dispose() {
    runKannaSync(this.service.stop)
    this.close()
  }

  // Reads
  countSubchatsHolding(chatId: string) { return this.service.countSubchatsHolding(chatId) }
  getChatsWaitingOnSubchats(unsettled: Iterable<string>) { return this.service.getChatsWaitingOnSubchats(unsettled) }
  getChildActivities(chatId: string) { return this.service.getChildActivities(chatId) }
  isAgentToAgent(chatId: string, source?: MessageSource) { return this.service.isAgentToAgent(chatId, source) }
  buildTurnNotices(chatId: string, source?: MessageSource, turn?: AgentToAgentTurn) {
    return runKannaSync(this.service.buildTurnNotices(chatId, source, turn))
  }
  getContext(actorChatId: string) { return runKannaSync(this.service.getContext(actorChatId)) }
  listChats(input: Parameters<Service["listChats"]>[0]) { return runKannaSync(this.service.listChats(input)) }
  readChat(input: Parameters<Service["readChat"]>[0]) { return runKanna(this.service.readChat(input)) }
  listSchedules(input: Parameters<Service["listSchedules"]>[0]) { return runKannaSync(this.service.listSchedules(input)) }

  // Writes, for an agent
  createChat(...args: Parameters<Service["createChat"]>) { return runKanna(this.service.createChat(...args)) }
  forkChat(...args: Parameters<Service["forkChat"]>) { return runKanna(this.service.forkChat(...args)) }
  sendMessage(...args: Parameters<Service["sendMessage"]>) { return runKanna(this.service.sendMessage(...args)) }
  cancelChat(actorChatId: string, chatId: string) { return runKanna(this.service.cancelChat(actorChatId, chatId)) }
  updateChat(...args: Parameters<Service["updateChat"]>) { return runKanna(this.service.updateChat(...args)) }
  updateQueuedMessage(...args: Parameters<Service["updateQueuedMessage"]>) { return runKanna(this.service.updateQueuedMessage(...args)) }
  setSchedule(...args: Parameters<Service["setSchedule"]>) { return runKanna(this.service.setSchedule(...args)) }
  deleteSchedule(scheduleId: string) { return runKanna(this.service.deleteSchedule(scheduleId)) }
  runDueSchedules() { return runKanna(this.service.runDueSchedules) }

  // The coordinator's hooks
  handleChatSettled(chatId: string) { runKannaSync(this.service.handleChatSettled(chatId)) }
  handleTurnStarted(chatId: string) { runKannaSync(this.service.handleTurnStarted(chatId)) }
  handleBackgroundWorkStarted(chatId: string) { runKannaSync(this.service.handleBackgroundWorkStarted(chatId)) }
  handleChatStopped(chatId: string) { runKannaSync(this.service.handleChatStopped(chatId)) }
  stopChildTask(chatId: string, taskId: string) { return runKanna(this.service.stopChildTask(chatId, taskId)) }
}

/**
 * Builds an orchestrator outside the server's runtime, over a store and a
 * coordinator that are still Promise code: for tests, as `openEventStore` is.
 * `dispose()` closes it.
 */
export async function openChatOrchestrator(args: {
  store: EventStoreBridge
  agent: CoordinatorLike
  push: (change: ChatChange) => void
  analytics?: Analytics["Service"]
  now?: () => number
  closeOutGraceMs?: number
}): Promise<ChatOrchestrator> {
  const scope = runKannaSync(Scope.make())
  const agent = ChatAgent.fromCoordinator(() => args.agent)
  const layer = Orchestrator.layer({ push: args.push, now: args.now, closeOutGraceMs: args.closeOutGraceMs }).pipe(
    Layer.provide(Layer.succeed(ChatCommands, createChatCommands({
      store: args.store.service,
      agent,
      analytics: args.analytics ?? NoopAnalytics,
    }))),
    Layer.provide(Layer.succeed(ChatAgent, agent)),
    Layer.provide(Layer.succeed(EventStore, args.store.service)),
    Layer.provide(ServerPlatform),
  )
  const service = await runKanna(Layer.buildWithScope(layer, scope).pipe(
    Effect.map((context) => Context.get(context, Orchestrator)),
  ))
  return new ChatOrchestrator(service, () => {
    void runKanna(Scope.close(scope, Exit.void))
  })
}

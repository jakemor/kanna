import { Effect } from "effect"
import type { AgentProvider, ChatSchedule, TranscriptEntry } from "../shared/types"
import { runKanna } from "./effect/bridge"
import { ServerPlatform } from "./effect/runtime"
import { EventStore, type EventStoreHooks, type EventStoreOptions, type StaleChatSweepOptions } from "./event-store"
import type { TouchedFile } from "./events"

type Service = EventStore["Service"]

/**
 * `EventStore` as the Promise code that has not moved to Effect yet calls it:
 * the agent, router, orchestrator, chat commands and their tests. Reads pass
 * straight through (they are synchronous on the service too); writes run
 * through `runKanna`. Temporary, like `effect/bridge.ts`: each caller takes
 * `EventStore["Service"]` directly when it migrates, and this file goes in
 * wave 4. See docs/effect-migration.md.
 *
 * A write starts when it is called, as it did before: `runKanna` runs the
 * effect synchronously up to its first asynchronous step, which is after the
 * write has taken its place on the store's write chain.
 */
export class EventStoreBridge {
  constructor(readonly service: Service) {}

  get dataDir() { return this.service.dataDir }
  get state() { return this.service.state }
  get stateVersion() { return this.service.stateVersion }

  /** See `EventStoreHooks`. */
  get onTurnEnded() { return this.service.hooks.onTurnEnded }
  set onTurnEnded(hook: EventStoreHooks["onTurnEnded"]) { this.service.hooks.onTurnEnded = hook }
  get onTurnStarted() { return this.service.hooks.onTurnStarted }
  set onTurnStarted(hook: EventStoreHooks["onTurnStarted"]) { this.service.hooks.onTurnStarted = hook }

  getProject(projectId: string) { return this.service.getProject(projectId) }
  getChat(chatId: string) { return this.service.getChat(chatId) }
  requireChat(chatId: string) { return this.service.requireChat(chatId) }
  listProjects() { return this.service.listProjects() }
  listChatsByProject(projectId: string) { return this.service.listChatsByProject(projectId) }
  getSidebarProjectOrder() { return this.service.getSidebarProjectOrder() }
  getSchedule(scheduleId: string) { return this.service.getSchedule(scheduleId) }
  listSchedules() { return this.service.listSchedules() }
  getQueuedMessages(chatId: string) { return this.service.getQueuedMessages(chatId) }
  getQueuedMessage(chatId: string, queuedMessageId: string) { return this.service.getQueuedMessage(chatId, queuedMessageId) }
  getMessages(chatId: string) { return runKanna(this.service.readMessages(chatId)) }
  getEntriesById(chatId: string, entryIds: string[]) { return runKanna(this.service.readEntriesById(chatId, entryIds)) }
  getEntryDebugRaw(chatId: string, entryId: string) { return this.service.getEntryDebugRaw(chatId, entryId) }
  getClientTranscript(chatId: string, fromIndex?: number) { return this.service.getClientTranscript(chatId, fromIndex) }
  getChatReadAnchor(chatId: string) { return this.service.getChatReadAnchor(chatId) }
  getInitialTranscriptWindowStart(chatId: string, assistantMessages: number) {
    return this.service.getInitialTranscriptWindowStart(chatId, assistantMessages)
  }
  widenTranscriptWindowStart(...args: Parameters<Service["widenTranscriptWindowStart"]>) {
    return this.service.widenTranscriptWindowStart(...args)
  }
  getRollingTranscriptWindowStart(chatId: string, currentStart: number, assistantMessages: number) {
    return this.service.getRollingTranscriptWindowStart(chatId, currentStart, assistantMessages)
  }
  getTranscriptLength(chatId: string) { return this.service.getTranscriptLength(chatId) }
  getEntryIdAt(chatId: string, index: number) { return this.service.getEntryIdAt(chatId, index) }
  getTranscriptPath(chatId: string) { return this.service.getTranscriptPath(chatId) }
  resolveTranscriptMediaPath(url: string) { return this.service.resolveTranscriptMediaPath(url) }
  getResourceCounts() { return this.service.getResourceCounts() }

  /** Warms the cache for legacy tests; production readers use scoped `retainTranscript`. */
  prepareTranscript(chatId: string) { return runKanna(this.service.retainTranscript(chatId).pipe(Effect.scoped)) }
  readMessages(chatId: string) { return runKanna(this.service.readMessages(chatId)) }
  readEntriesById(chatId: string, entryIds: string[]) { return runKanna(this.service.readEntriesById(chatId, entryIds)) }

  openProject(localPath: string, title?: string) { return runKanna(this.service.openProject(localPath, title)) }
  removeProject(projectId: string) { return runKanna(this.service.removeProject(projectId)) }
  renameProjectSidebarTitle(projectId: string, title: string) {
    return runKanna(this.service.renameProjectSidebarTitle(projectId, title))
  }
  setProjectPinned(projectId: string, pinned: boolean, pinnedAt?: number) {
    return runKanna(this.service.setProjectPinned(projectId, pinned, pinnedAt))
  }
  setSidebarProjectOrder(projectIds: string[]) { return runKanna(this.service.setSidebarProjectOrder(projectIds)) }
  createChat(...args: Parameters<Service["createChat"]>) { return runKanna(this.service.createChat(...args)) }
  forkChat(...args: Parameters<Service["forkChat"]>) { return runKanna(this.service.forkChat(...args)) }
  renameChat(chatId: string, title: string) { return runKanna(this.service.renameChat(chatId, title)) }
  deleteChat(chatId: string) { return runKanna(this.service.deleteChat(chatId)) }
  setChatPinned(chatId: string, pinned: boolean) { return runKanna(this.service.setChatPinned(chatId, pinned)) }
  archiveChat(chatId: string) { return runKanna(this.service.archiveChat(chatId)) }
  unarchiveChat(chatId: string) { return runKanna(this.service.unarchiveChat(chatId)) }
  pruneStaleEmptyChats(options?: StaleChatSweepOptions) { return runKanna(this.service.pruneStaleEmptyChats(options)) }
  autoArchiveStaleChats(options?: StaleChatSweepOptions) { return runKanna(this.service.autoArchiveStaleChats(options)) }
  deleteStaleChats(options?: StaleChatSweepOptions) { return runKanna(this.service.deleteStaleChats(options)) }
  setChatProvider(chatId: string, provider: AgentProvider) { return runKanna(this.service.setChatProvider(chatId, provider)) }
  setPlanMode(chatId: string, planMode: boolean) { return runKanna(this.service.setPlanMode(chatId, planMode)) }
  setAutoPlan(chatId: string, autoPlan: boolean) { return runKanna(this.service.setAutoPlan(chatId, autoPlan)) }
  setChatReadState(chatId: string, unread: boolean) { return runKanna(this.service.setChatReadState(chatId, unread)) }
  setChatDoneState(chatId: string, done: boolean) { return runKanna(this.service.setChatDoneState(chatId, done)) }
  setReportOwed(chatId: string, owed: boolean) { return runKanna(this.service.setReportOwed(chatId, owed)) }
  setChatDelegator(chatId: string, delegator: boolean) { return runKanna(this.service.setChatDelegator(chatId, delegator)) }
  setReportedThrough(chatId: string, through: number) { return runKanna(this.service.setReportedThrough(chatId, through)) }
  setChatParent(...args: Parameters<Service["setChatParent"]>) { return runKanna(this.service.setChatParent(...args)) }
  setSchedule(schedule: ChatSchedule) { return runKanna(this.service.setSchedule(schedule)) }
  deleteSchedule(scheduleId: string) { return runKanna(this.service.deleteSchedule(scheduleId)) }
  setChatReadAnchor(...args: Parameters<Service["setChatReadAnchor"]>) { return runKanna(this.service.setChatReadAnchor(...args)) }
  appendMessage(chatId: string, entry: TranscriptEntry) { return runKanna(this.service.appendMessage(chatId, entry)) }
  enqueueMessage(...args: Parameters<Service["enqueueMessage"]>) { return runKanna(this.service.enqueueMessage(...args)) }
  removeQueuedMessage(...args: Parameters<Service["removeQueuedMessage"]>) {
    return runKanna(this.service.removeQueuedMessage(...args))
  }
  recordTurnStarted(chatId: string, model?: string) { return runKanna(this.service.recordTurnStarted(chatId, model)) }
  recordFilesTouched(chatId: string, files: TouchedFile[]) { return runKanna(this.service.recordFilesTouched(chatId, files)) }
  recordTurnFinished(chatId: string) { return runKanna(this.service.recordTurnFinished(chatId)) }
  recordTurnFailed(chatId: string, error: string) { return runKanna(this.service.recordTurnFailed(chatId, error)) }
  recordTurnCancelled(chatId: string) { return runKanna(this.service.recordTurnCancelled(chatId)) }
  setTurnResumePending(chatId: string, pending: boolean) { return runKanna(this.service.setTurnResumePending(chatId, pending)) }
  setSessionToken(chatId: string, sessionToken: string | null) { return runKanna(this.service.setSessionToken(chatId, sessionToken)) }
  setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null, pendingForkAt?: string | null) {
    return runKanna(this.service.setPendingForkSessionToken(chatId, pendingForkSessionToken, pendingForkAt))
  }

  compact() { return runKanna(this.service.compact) }
  getLegacyTranscriptStats() { return runKanna(this.service.getLegacyTranscriptStats) }
  hasLegacyTranscriptData() { return runKanna(this.service.hasLegacyTranscriptData) }
  migrateLegacyTranscripts(onProgress?: (message: string) => void) {
    return runKanna(this.service.migrateLegacyTranscripts(onProgress))
  }
  slimTranscripts(options?: Parameters<Service["slimTranscripts"]>[0]) { return runKanna(this.service.slimTranscripts(options)) }
}

/**
 * Builds and loads a store outside the server's runtime, for the CLI's
 * `slim-transcripts` and for tests: what `new EventStore(dir)` followed by
 * `initialize()` used to be. The store holds no resources, so there is
 * nothing to close.
 */
export const openEventStore = async (dataDir?: string, options: Omit<EventStoreOptions, "dataDir"> = {}) =>
  new EventStoreBridge(await runKanna(EventStore.make({ ...options, ...(dataDir === undefined ? {} : { dataDir }) }).pipe(
    Effect.provide(ServerPlatform),
  )))

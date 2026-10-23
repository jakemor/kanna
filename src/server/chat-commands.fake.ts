import { Effect } from "effect"
import type { ChatRecord } from "./events"

const WRITES = [
  "createChat",
  "setChatDelegator",
  "renameChat",
  "setChatPinned",
  "archiveChat",
  "unarchiveChat",
  "deleteChat",
  "setChatReadState",
  "setChatDoneState",
] as const

type PromiseStore = Partial<Record<(typeof WRITES)[number], (...args: never[]) => Promise<unknown>>> & {
  state?: { chatsById: Map<string, ChatRecord> }
  getChat?: (chatId: string) => ChatRecord | null
}

/**
 * The store chat commands use (`createChatCommands`), over a test's
 * hand-written Promise store: the shape router tests give the router, which
 * builds its own commands from the Effect store. A write the fake lacks, or
 * one that throws, fails as a defect with the fake's own error, so its message
 * reaches the client as it did.
 */
export function fakeChatCommandsStore(store: PromiseStore) {
  const service: Record<string, unknown> = {
    getChat: (chatId: string) => store.getChat?.(chatId) ?? store.state?.chatsById.get(chatId) ?? null,
  }
  for (const name of WRITES) {
    service[name] = (...args: never[]) => Effect.promise(() => {
      const write = store[name]
      if (!write) return Promise.reject(new Error(`The fake store has no ${name}`))
      return write(...args)
    })
  }
  return service
}

const ROUTER_WRITES = [
  "pruneStaleEmptyChats",
  "autoArchiveStaleChats",
  "deleteStaleChats",
  "prepareTranscript",
  "openProject",
  "renameProjectSidebarTitle",
  "setProjectPinned",
  "removeProject",
  "setSidebarProjectOrder",
  "setChatReadAnchor",
  "readEntriesById",
  "readMessages",
] as const

/** Adapts Promise-shaped router test stores to the Effect EventStore service. */
export function fakeRouterStore<Store extends PromiseStore>(store: Store) {
  const service: Record<string, unknown> = { ...store, ...fakeChatCommandsStore(store) }
  for (const name of ROUTER_WRITES) {
    const method = (store as Record<string, unknown>)[name]
    if (typeof method !== "function") continue
    service[name] = (...args: unknown[]) => Effect.promise(() => Promise.resolve(method.apply(store, args)))
  }
  // The router holds transcripts with `retainTranscript`; a Promise store's
  // `prepareTranscript` stands in (it has nothing to evict).
  if (service.prepareTranscript && !service.retainTranscript) service.retainTranscript = service.prepareTranscript
  return service
}

import { Context, Effect, Layer } from "effect"
import type { ClientCommand } from "../shared/protocol"
import type { MessageSource } from "../shared/types"
import { Analytics } from "./analytics"
import { ChatAgent, type ChatAgentError } from "./chat-agent"
import {
  EventStore,
  type EventStoreFileError,
  type EventStoreNotFoundError,
  type EventStoreRejectedError,
} from "./event-store"

/**
 * What can be done to a chat, each action defined once.
 *
 * Two callers reach these: the WebSocket router, for the user, and the
 * orchestrator, for an agent using the Kanna tools. Both get the same effect
 * because both call the same function, so an action added here for one is
 * there for the other, and a rule added to one cannot be missing from the
 * other.
 *
 * An action does its work and says which snapshots it can have changed. The
 * caller pushes them: the router after it has acked, the orchestrator after
 * it has checked the rules that apply only to agents (`orchestrator.ts`).
 *
 * Who is acting shows in two places. `lineage` on a new chat names the chat
 * whose agent made it, and `source` on a message names who sent it when the
 * user did not. Both are absent for the user.
 *
 * A failure is the store's or the coordinator's own error, whose message is
 * what the client and the agents read.
 */

/** The snapshots an action can have changed. */
export interface ChatChange {
  sidebar?: boolean
  /** The home page's project list, which counts chats. */
  localProjects?: boolean
  chatIds?: string[]
}

export interface ChatCommandOutcome<TResult = undefined> {
  result: TResult
  /** Null when the action pushes by another route: a turn reports its own state as it runs. */
  changed: ChatChange | null
}

export interface ChatLineage {
  parentChatId?: string
  createdByChatId?: string
}

type Command<TType extends ClientCommand["type"]> = Extract<ClientCommand, { type: TType }>

type StoreWriteError = EventStoreNotFoundError | EventStoreFileError

export class ChatCommands extends Context.Service<ChatCommands, {
  readonly create: (
    projectId: string,
    lineage?: ChatLineage,
    options?: { delegator?: boolean; chatId?: string },
  ) => Effect.Effect<ChatCommandOutcome<{ chatId: string }>, StoreWriteError | EventStoreRejectedError>
  readonly fork: (chatId: string, lineage?: ChatLineage) => Effect.Effect<ChatCommandOutcome<{ chatId: string }>, ChatAgentError>
  readonly rename: (chatId: string, title: string) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  /**
   * Takes effect on the chat's next turn. A turn already running keeps the
   * instructions it started with.
   */
  readonly setDelegator: (chatId: string, delegator: boolean) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  readonly setPinned: (chatId: string, pinned: boolean) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  readonly archive: (chatId: string) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  readonly unarchive: (chatId: string) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  readonly delete: (chatId: string) => Effect.Effect<ChatCommandOutcome, StoreWriteError | ChatAgentError>
  readonly markRead: (chatId: string) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  readonly setDone: (chatId: string, done: boolean) => Effect.Effect<ChatCommandOutcome, StoreWriteError>
  /** Starts a turn when the chat is idle, and queues behind the running one otherwise. */
  readonly send: (
    command: Command<"chat.send">,
    extras?: { source?: MessageSource },
  ) => Effect.Effect<ChatCommandOutcome<{ chatId: string; queuedMessageId?: string; queued?: true }>, ChatAgentError>
  /** Queues a message, or with `steer` interrupts the running turn to deliver it now. */
  readonly enqueue: (
    command: Command<"message.enqueue">,
    extras?: { source?: MessageSource; effort?: string },
  ) => Effect.Effect<ChatCommandOutcome<{ queuedMessageId: string }>, ChatAgentError>
  readonly steer: (command: Command<"message.steer">) => Effect.Effect<ChatCommandOutcome, ChatAgentError>
  readonly dequeue: (command: Command<"message.dequeue">) => Effect.Effect<ChatCommandOutcome, ChatAgentError>
  readonly cancel: (chatId: string) => Effect.Effect<ChatCommandOutcome, ChatAgentError>
}>()("@kanna/server/ChatCommands") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    return createChatCommands({ store: yield* EventStore, agent: yield* ChatAgent, analytics: yield* Analytics })
  }))
}

interface ChatCommandsDeps {
  store: Pick<
    EventStore["Service"],
    | "createChat"
    | "setChatDelegator"
    | "renameChat"
    | "setChatPinned"
    | "getChat"
    | "archiveChat"
    | "unarchiveChat"
    | "deleteChat"
    | "setChatReadState"
    | "setChatDoneState"
  >
  agent: Pick<ChatAgent["Service"], "send" | "enqueue" | "steer" | "dequeue" | "cancel" | "closeChat" | "forkChat">
  analytics: Analytics["Service"]
}

function chatAndSidebar(chatId: string): ChatChange {
  return { sidebar: true, chatIds: [chatId] }
}

/**
 * The commands over the given services. What the layer builds; exported for
 * the router, which builds its own when it is not handed one (its tests).
 */
export function createChatCommands({ store, agent, analytics }: ChatCommandsDeps): ChatCommands["Service"] {
  return {
    create: Effect.fn("ChatCommands.create")(function* (projectId: string, lineage?: ChatLineage, options?: { delegator?: boolean; chatId?: string }) {
      yield* Effect.annotateCurrentSpan("projectId", projectId)
      const chat = yield* store.createChat(projectId, lineage, options)
      // The count is of chats people start.
      if (!lineage?.createdByChatId) yield* analytics.track("chat_created")
      return {
        result: { chatId: chat.id },
        // Adding a chat changes local-projects too (chatCount/lastOpenedAt).
        changed: { sidebar: true, localProjects: true, chatIds: [chat.id] },
      }
    }),

    fork: Effect.fn("ChatCommands.fork")(function* (chatId: string, lineage?: ChatLineage) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      const result = yield* agent.forkChat(chatId, lineage)
      return { result, changed: { sidebar: true, localProjects: true } }
    }),

    rename: Effect.fn("ChatCommands.rename")(function* (chatId: string, title: string) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* store.renameChat(chatId, title)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    }),

    setDelegator: Effect.fn("ChatCommands.setDelegator")(function* (chatId: string, delegator: boolean) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* store.setChatDelegator(chatId, delegator)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    }),

    setPinned: Effect.fn("ChatCommands.setPinned")(function* (chatId: string, pinned: boolean) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* store.setChatPinned(chatId, pinned)
      return { result: undefined, changed: { sidebar: true } }
    }),

    archive: Effect.fn("ChatCommands.archive")(function* (chatId: string) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      // Archiving a chat that never got a message is a hard delete — an
      // empty chat has nothing worth keeping in the Archived list.
      const chat = store.getChat(chatId)
      const hardDeleted = chat != null && !chat.hasMessages && !chat.lastMessageAt
      if (hardDeleted) {
        yield* store.deleteChat(chatId)
      } else {
        yield* store.archiveChat(chatId)
      }
      return {
        result: undefined,
        // Archiving removes the chat from local-projects' chat counts; a hard
        // delete must also refresh the chat's own topic (to null) so a tab
        // viewing it learns it's gone.
        changed: { sidebar: true, localProjects: true, ...(hardDeleted ? { chatIds: [chatId] } : {}) },
      }
    }),

    unarchive: Effect.fn("ChatCommands.unarchive")(function* (chatId: string) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* store.unarchiveChat(chatId)
      // Unarchiving is the explicit "Restore" action (viewing an archived
      // chat no longer unarchives it). Mark it done so restoring alone
      // doesn't resurface it as needing review; sending a message clears
      // the done state and brings it back to running.
      yield* store.setChatDoneState(chatId, true)
      return { result: undefined, changed: { sidebar: true, localProjects: true, chatIds: [chatId] } }
    }),

    delete: Effect.fn("ChatCommands.delete")(function* (chatId: string) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* agent.cancel(chatId)
      yield* agent.closeChat(chatId)
      yield* store.deleteChat(chatId)
      yield* analytics.track("chat_deleted")
      return {
        result: undefined,
        // The deleted chat's own topic must refresh (to null) so another tab
        // viewing it learns it's gone, and local-projects loses the chat.
        changed: { sidebar: true, localProjects: true, chatIds: [chatId] },
      }
    }),

    markRead: Effect.fn("ChatCommands.markRead")(function* (chatId: string) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* store.setChatReadState(chatId, false)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    }),

    setDone: Effect.fn("ChatCommands.setDone")(function* (chatId: string, done: boolean) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* store.setChatDoneState(chatId, done)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    }),

    send: Effect.fn("ChatCommands.send")(function* (command: Command<"chat.send">, extras?: { source?: MessageSource }) {
      if (command.chatId) yield* Effect.annotateCurrentSpan("chatId", command.chatId)
      const result = yield* agent.send(command, extras)
      return { result, changed: null }
    }),

    enqueue: Effect.fn("ChatCommands.enqueue")(function* (command: Command<"message.enqueue">, extras?: { source?: MessageSource; effort?: string }) {
      yield* Effect.annotateCurrentSpan("chatId", command.chatId)
      const result = yield* agent.enqueue(command, extras)
      return { result, changed: chatAndSidebar(command.chatId) }
    }),

    steer: Effect.fn("ChatCommands.steer")(function* (command: Command<"message.steer">) {
      yield* Effect.annotateCurrentSpan("chatId", command.chatId)
      yield* agent.steer(command)
      return { result: undefined, changed: chatAndSidebar(command.chatId) }
    }),

    dequeue: Effect.fn("ChatCommands.dequeue")(function* (command: Command<"message.dequeue">) {
      yield* Effect.annotateCurrentSpan("chatId", command.chatId)
      yield* agent.dequeue(command)
      return { result: undefined, changed: chatAndSidebar(command.chatId) }
    }),

    cancel: Effect.fn("ChatCommands.cancel")(function* (chatId: string) {
      yield* Effect.annotateCurrentSpan("chatId", chatId)
      yield* agent.cancel(chatId)
      return { result: undefined, changed: null }
    }),
  }
}

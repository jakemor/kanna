import type { ClientCommand } from "../shared/protocol"
import type { MessageSource } from "../shared/types"
import type { AgentCoordinator } from "./agent"
import type { AnalyticsReporter } from "./analytics"
import type { EventStore } from "./event-store"

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

interface ChatCommandsDeps {
  store: Pick<
    EventStore,
    | "createChat"
    | "renameChat"
    | "setChatPinned"
    | "getChat"
    | "archiveChat"
    | "unarchiveChat"
    | "deleteChat"
    | "setChatReadState"
    | "setChatDoneState"
  >
  agent: Pick<AgentCoordinator, "send" | "enqueue" | "steer" | "dequeue" | "cancel" | "closeChat" | "forkChat">
  analytics: AnalyticsReporter
}

function chatAndSidebar(chatId: string): ChatChange {
  return { sidebar: true, chatIds: [chatId] }
}

export function createChatCommands({ store, agent, analytics }: ChatCommandsDeps) {
  return {
    async create(projectId: string, lineage?: ChatLineage): Promise<ChatCommandOutcome<{ chatId: string }>> {
      const chat = await store.createChat(projectId, lineage)
      // The count is of chats people start.
      if (!lineage?.createdByChatId) analytics.track("chat_created")
      return {
        result: { chatId: chat.id },
        // Adding a chat changes local-projects too (chatCount/lastOpenedAt).
        changed: { sidebar: true, localProjects: true, chatIds: [chat.id] },
      }
    },

    async fork(chatId: string, lineage?: ChatLineage): Promise<ChatCommandOutcome<{ chatId: string }>> {
      const result = await agent.forkChat(chatId, lineage)
      return { result, changed: { sidebar: true, localProjects: true } }
    },

    async rename(chatId: string, title: string): Promise<ChatCommandOutcome> {
      await store.renameChat(chatId, title)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    },

    async setPinned(chatId: string, pinned: boolean): Promise<ChatCommandOutcome> {
      await store.setChatPinned(chatId, pinned)
      return { result: undefined, changed: { sidebar: true } }
    },

    async archive(chatId: string): Promise<ChatCommandOutcome> {
      // Archiving a chat that never got a message is a hard delete — an
      // empty chat has nothing worth keeping in the Archived list.
      const chat = store.getChat(chatId)
      const hardDeleted = chat != null && !chat.hasMessages && !chat.lastMessageAt
      if (hardDeleted) {
        await store.deleteChat(chatId)
      } else {
        await store.archiveChat(chatId)
      }
      return {
        result: undefined,
        // Archiving removes the chat from local-projects' chat counts; a hard
        // delete must also refresh the chat's own topic (to null) so a tab
        // viewing it learns it's gone.
        changed: { sidebar: true, localProjects: true, ...(hardDeleted ? { chatIds: [chatId] } : {}) },
      }
    },

    async unarchive(chatId: string): Promise<ChatCommandOutcome> {
      await store.unarchiveChat(chatId)
      // Unarchiving is the explicit "Restore" action (viewing an archived
      // chat no longer unarchives it). Mark it done so restoring alone
      // doesn't resurface it as needing review; sending a message clears
      // the done state and brings it back to running.
      await store.setChatDoneState(chatId, true)
      return { result: undefined, changed: { sidebar: true, localProjects: true, chatIds: [chatId] } }
    },

    async delete(chatId: string): Promise<ChatCommandOutcome> {
      await agent.cancel(chatId)
      await agent.closeChat(chatId)
      await store.deleteChat(chatId)
      analytics.track("chat_deleted")
      return {
        result: undefined,
        // The deleted chat's own topic must refresh (to null) so another tab
        // viewing it learns it's gone, and local-projects loses the chat.
        changed: { sidebar: true, localProjects: true, chatIds: [chatId] },
      }
    },

    async markRead(chatId: string): Promise<ChatCommandOutcome> {
      await store.setChatReadState(chatId, false)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    },

    async markUnread(chatId: string): Promise<ChatCommandOutcome> {
      await store.setChatReadState(chatId, true)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    },

    async setDone(chatId: string, done: boolean): Promise<ChatCommandOutcome> {
      await store.setChatDoneState(chatId, done)
      return { result: undefined, changed: chatAndSidebar(chatId) }
    },

    /** Starts a turn when the chat is idle, and queues behind the running one otherwise. */
    async send(command: Command<"chat.send">, extras?: { source?: MessageSource }) {
      const result = await agent.send(command, extras)
      return { result, changed: null } satisfies ChatCommandOutcome<typeof result>
    },

    /** Queues a message, or with `steer` interrupts the running turn to deliver it now. */
    async enqueue(command: Command<"message.enqueue">, extras?: { source?: MessageSource; effort?: string }) {
      const result = await agent.enqueue(command, extras)
      return { result, changed: chatAndSidebar(command.chatId) } satisfies ChatCommandOutcome<typeof result>
    },

    async steer(command: Command<"message.steer">): Promise<ChatCommandOutcome> {
      await agent.steer(command)
      return { result: undefined, changed: chatAndSidebar(command.chatId) }
    },

    async dequeue(command: Command<"message.dequeue">): Promise<ChatCommandOutcome> {
      await agent.dequeue(command)
      return { result: undefined, changed: chatAndSidebar(command.chatId) }
    },

    async cancel(chatId: string): Promise<ChatCommandOutcome> {
      await agent.cancel(chatId)
      return { result: undefined, changed: null }
    },
  }
}

export type ChatCommands = ReturnType<typeof createChatCommands>

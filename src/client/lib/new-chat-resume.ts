import type { SidebarThread } from "./thread-sections"

/**
 * How a new chat was asked for. A click on a project in the Channels view is
 * `project`: it goes to the project's new chat page, which is the one already
 * being written if there is one. Everything that says "New Chat" (a button, the row in a channel's
 * card, a menu item, the shortcut, the palette) is `explicit`, and makes one
 * every time.
 */
export type NewChatEntry = "project" | "explicit"

export type NewChatDecision =
  /** Make a chat, as New Chat does. */
  | { kind: "create" }
  /** A new chat in the project already holds a draft: go to it. */
  | { kind: "open"; chatId: string }
  /**
   * A draft was being written in a new chat that is gone (the server deletes
   * one that is never sent from, once no browser is connected to speak for
   * its draft). Make a chat and bring the draft over to it.
   */
  | { kind: "carry"; fromChatId: string }

type ProjectThread = Pick<SidebarThread, "chatId" | "projectId" | "archived" | "lastActivityAt" | "row">

export interface NewChatDrafts {
  /** Unsent text, by chat. */
  text: Readonly<Record<string, string>>
  /** Staged attachments, by chat. */
  attachments: Readonly<Record<string, readonly unknown[]>>
  /** When each draft was last changed. */
  touchedAt: Readonly<Record<string, number>>
  /** When each draft was begun, for drafts from before `touchedAt` was kept. */
  startedAt: Readonly<Record<string, number>>
}

/** Text, or attachments staged without any. Whitespace alone is neither. */
export function hasNewChatDraft(drafts: NewChatDrafts, chatId: string): boolean {
  return (drafts.text[chatId] ?? "").trim().length > 0 || (drafts.attachments[chatId]?.length ?? 0) > 0
}

/**
 * What asking for a new chat in a project does: resume which chat, or create.
 *
 * Only a new chat is resumed, and only for its draft. A new chat is one with
 * no messages that the user started, not one an agent started under its own. An empty chat with no
 * draft is left alone and a fresh one made, as before: there is nothing in it
 * to come back to, and it may be seconds from being cleared away. A chat with
 * messages and a draft is that chat's business, reached from its row.
 *
 * With several drafts, the one changed most recently.
 */
export function resolveProjectNewChat(args: {
  entry: NewChatEntry
  projectId: string
  /** The project's chats as the sidebar lists them, archived and empty ones included. */
  projectThreads: readonly ProjectThread[]
  /**
   * Whether the sidebar lists the chat at all, in any project, archived or
   * not. A chat it does not list is gone, but only once the sidebar has
   * loaded: pass `null` until then, and nothing is taken for gone.
   */
  isListed: ((chatId: string) => boolean) | null
  drafts: NewChatDrafts
  /** The chats this browser started as new chats, and each one's project. */
  startedChats: Readonly<Record<string, { projectId: string }>>
  /** Started chats whose `chat.create` is still in flight: not listed yet, and not gone. */
  startingChatIds: ReadonlySet<string>
}): NewChatDecision {
  const { entry, projectId, projectThreads, isListed, drafts, startedChats, startingChatIds } = args
  if (entry !== "project") return { kind: "create" }

  type Decision = Extract<NewChatDecision, { kind: "open" | "carry" }>
  const candidates: Array<{ decision: Decision; touchedAt: number; live: boolean }> = []
  const consider = (chatId: string, decision: Decision, live: boolean) => {
    if (!hasNewChatDraft(drafts, chatId)) return
    candidates.push({ decision, live, touchedAt: drafts.touchedAt[chatId] ?? drafts.startedAt[chatId] ?? 0 })
  }

  const listedHere = new Set<string>()
  for (const thread of projectThreads) {
    listedHere.add(thread.chatId)
    const chat = thread.row
    if (thread.archived || chat.lastMessageAt != null || chat.hidden) continue
    consider(chat.chatId, { kind: "open", chatId: chat.chatId }, true)
  }

  for (const [chatId, started] of Object.entries(startedChats)) {
    if (started.projectId !== projectId || listedHere.has(chatId)) continue
    if (startingChatIds.has(chatId)) {
      consider(chatId, { kind: "open", chatId }, true)
    } else if (isListed && !isListed(chatId)) {
      consider(chatId, { kind: "carry", fromChatId: chatId }, false)
    }
  }

  // A chat that is there wins a tie with one that has to be made again.
  candidates.sort((left, right) => right.touchedAt - left.touchedAt || Number(right.live) - Number(left.live))
  return candidates[0]?.decision ?? { kind: "create" }
}

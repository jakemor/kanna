import type { SidebarThread } from "./thread-sections"

/**
 * How a new chat was asked for. A click on a project in the Channels view is
 * `project`: it goes back to the chat in the project last viewed here, and
 * failing that to its new chat page, which is the one already being written
 * if there is one. Everything that says "New Chat" (a button, the row in a
 * channel's card, a menu item, the shortcut, the palette) is `explicit`, and
 * makes one every time.
 */
export type NewChatEntry = "project" | "explicit"

export type NewChatDecision =
  /** Make a chat, as New Chat does. */
  | { kind: "create" }
  /** Go to a chat that is there: the one last viewed, or a new chat holding a draft. */
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
 * What a click on a project does: go back to which chat, or create.
 *
 * The chat in the project last viewed in this browser comes first
 * (`viewedChatIds`), if the sidebar still lists it: not archived, not a
 * sub-chat shown under its parent (`hidden`), not deleted, and with a
 * message, as an empty chat is not listed. Failing that the one viewed
 * before it, and so on. A new chat holding a draft takes its place in that
 * order. With none of those, the project's new chat page, as below.
 *
 * Only a new chat is resumed for its draft. A new chat is one with
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
  /** The project's chats viewed in this browser, most recent first (`lastViewedChats`). */
  viewedChatIds: readonly string[]
}): NewChatDecision {
  const { entry, projectThreads, viewedChatIds } = args
  if (entry !== "project") return { kind: "create" }

  const drafted = resolveDraftedNewChat(args)
  const draftedChatId = drafted.kind === "open" ? drafted.chatId : drafted.kind === "carry" ? drafted.fromChatId : null
  const listed = new Set(projectThreads
    .filter((thread) => !thread.archived && !thread.row.hidden && thread.row.lastMessageAt != null)
    .map((thread) => thread.chatId))
  for (const chatId of viewedChatIds) {
    if (chatId === draftedChatId) return drafted
    if (listed.has(chatId)) return { kind: "open", chatId }
  }
  return drafted
}

/** The new chat page a project click comes back to, or a fresh one. See `resolveProjectNewChat`. */
function resolveDraftedNewChat(args: Parameters<typeof resolveProjectNewChat>[0]): Extract<NewChatDecision, { kind: "create" | "open" | "carry" }> {
  const { projectId, projectThreads, isListed, drafts, startedChats, startingChatIds } = args

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

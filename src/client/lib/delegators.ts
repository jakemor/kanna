import type { SidebarChatRow } from "../../shared/types"
import { isUnreadForUser, type SidebarThread } from "./thread-sections"

/**
 * Delegators on the client: a chat whose job is to hand work to the chats
 * under it (`SidebarChatRow.delegator`). The rules that are not drawing:
 * a project's delegators, which chats a delegator's list holds, and how many
 * of them want the user. React-free for tests.
 */

/**
 * A project's delegators, the one to reach for first at the head: the most
 * recently active. Archived ones are not offered: archiving a delegator is
 * putting it away.
 */
export function projectDelegators(threads: readonly SidebarThread[], projectId: string | null): SidebarThread[] {
  if (!projectId) return []
  return threads
    .filter((thread) => thread.projectId === projectId && Boolean(thread.row.delegator) && !thread.archived)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.chatId.localeCompare(right.chatId))
}

/**
 * The chats a delegator's list holds: the ones directly under it, archived
 * ones included (the list files them under Archived, as the sidebar does).
 *
 * Direct children only, not the whole tree. Every chat a delegator starts or
 * messages becomes its child, so its children are the chats it is running
 * and reporting on. A chat one of those started for itself reports to that
 * chat, which answers for it; listing it here would put work in front of the
 * user that the delegator never mentions. It is one step away, in its
 * parent's Tasks.
 */
export function delegatedThreads(threads: readonly SidebarThread[], delegatorChatId: string): SidebarThread[] {
  return threads.filter((thread) => thread.row.parentChatId === delegatorChatId)
}

/**
 * Whether a chat under a delegator wants the user: it is waiting on an
 * answer, or it has come to rest with something unread. A channel row's rule
 * (`ChannelList`). Most chats here are never unread: the delegator reports
 * what they did (`tracksUnread` on the server). An adopted chat still listed
 * in the sidebar is the user's own, and can be. The iOS app counts the same way.
 */
export function delegatedChatWantsUser(row: Pick<SidebarChatRow, "status" | "unread">): boolean {
  return row.status === "waiting_for_user" || isUnreadForUser(row)
}

/** How many of the chats under a delegator want the user. Archived ones are put away, and not counted. */
export function delegatedAttentionCount(
  rows: readonly Pick<SidebarChatRow, "parentChatId" | "status" | "unread">[],
  delegatorChatId: string,
): number {
  let count = 0
  for (const row of rows) {
    if (row.parentChatId === delegatorChatId && delegatedChatWantsUser(row)) count += 1
  }
  return count
}

/** A delegator that has not been named: the server calls every chat "New Chat" until its first message does. */
export function isUnnamedDelegator(title: string): boolean {
  return title.trim() === "" || title === "New Chat"
}

/**
 * What heads a delegator's list of chats: its name, which is the whole
 * header. An unnamed one is "Delegator", as on iOS: "New Chat" over a list
 * of chats would read as the list's own name. Also for a list whose
 * delegator the sidebar cannot name yet.
 */
export function delegatedListTitle(title: string | undefined): string {
  return title === undefined || isUnnamedDelegator(title) ? "Delegator" : title
}

import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { isUnreadForUser } from "../lib/thread-sections"

const BROWSER_CHAT_TITLE_MAX_LENGTH = 80

function getSidebarGroupChats(group: SidebarProjectGroup): SidebarChatRow[] {
  return [...group.chats, ...(group.archivedChats ?? [])]
}

/** See `isUnreadForUser`. A sub-chat that stops to ask something still counts as waiting, below. */
const countsAsUnread = isUnreadForUser

export function getNotificationTitleCount(sidebarData: SidebarData) {
  return sidebarData.projectGroups.reduce((count, group) => (
    count + group.chats.reduce((chatCount, chat) => (
      chatCount + (countsAsUnread(chat) ? 1 : 0) + (chat.status === "waiting_for_user" ? 1 : 0)
    ), 0)
  ), 0)
}

export function getBrowserWindowTitle(args: {
  appName: string
  sidebarData: SidebarData
  activeProjectId: string | null
  activeChatId: string | null
}) {
  const notificationCount = getNotificationTitleCount(args.sidebarData)
  const baseTitle = notificationCount > 0 ? `[${notificationCount}] ${args.appName}` : args.appName
  const projectGroupById = args.activeProjectId
    ? args.sidebarData.projectGroups.find((group) => group.groupKey === args.activeProjectId)
    : undefined
  const projectGroupByChat = args.activeChatId
    ? args.sidebarData.projectGroups.find((group) => (
        getSidebarGroupChats(group).some((chat) => chat.chatId === args.activeChatId)
      ))
    : undefined
  const projectGroup = projectGroupById ?? projectGroupByChat
  const projectTitle = projectGroup?.title?.trim()
  if (!projectGroup || !projectTitle) return baseTitle

  const chatTitle = args.activeChatId
    ? getSidebarGroupChats(projectGroup).find((chat) => chat.chatId === args.activeChatId)?.title.trim()
    : null
  if (!chatTitle) return `${baseTitle} : ${projectTitle} :`

  const browserChatTitle = chatTitle.length > BROWSER_CHAT_TITLE_MAX_LENGTH
    ? `${chatTitle.slice(0, BROWSER_CHAT_TITLE_MAX_LENGTH)}...`
    : chatTitle
  return `${baseTitle} : ${projectTitle} : ${browserChatTitle}`
}

interface ChatNotificationSnapshot {
  unreadCount: number
  waitingChatIds: Set<string>
}

export interface ChatNotificationEvent {
  chatId: string
  projectTitle: string
  chatTitle: string
  /**
   * The question or plan the chat is waiting on, when that is what changed.
   * `null` for a chat that only turned unread: the sidebar carries no message
   * previews, so the caller fetches one (`chat.getPreview`) before showing.
   */
  message: string | null
}

export function getChatNotificationSnapshot(sidebarData: SidebarData): ChatNotificationSnapshot {
  let unreadCount = 0
  const waitingChatIds = new Set<string>()

  for (const group of sidebarData.projectGroups) {
    for (const chat of group.chats) {
      if (countsAsUnread(chat)) unreadCount += 1
      if (chat.status === "waiting_for_user") {
        waitingChatIds.add(chat.chatId)
      }
    }
  }

  return { unreadCount, waitingChatIds }
}

export function getChatSoundBurstCount(previous: SidebarData | null, next: SidebarData): number {
  if (!previous) return 0

  const previousSnapshot = getChatNotificationSnapshot(previous)
  const nextSnapshot = getChatNotificationSnapshot(next)

  const unreadIncrease = Math.max(0, nextSnapshot.unreadCount - previousSnapshot.unreadCount)
  let newWaitingChats = 0
  for (const chatId of nextSnapshot.waitingChatIds) {
    if (!previousSnapshot.waitingChatIds.has(chatId)) {
      newWaitingChats += 1
    }
  }

  return unreadIncrease + newWaitingChats
}

/**
 * Per-chat, unlike the chime's net count: a chat read while another turned
 * unread still deserves its notification, and each one names its chat.
 */
export function getChatNotificationEvents(previous: SidebarData | null, next: SidebarData): ChatNotificationEvent[] {
  if (!previous) return []

  const previousChats = new Map<string, { unread: boolean; waiting: boolean }>()
  for (const group of previous.projectGroups) {
    for (const chat of group.chats) {
      previousChats.set(chat.chatId, {
        unread: countsAsUnread(chat),
        waiting: chat.status === "waiting_for_user",
      })
    }
  }

  const events: ChatNotificationEvent[] = []
  for (const group of next.projectGroups) {
    for (const chat of group.chats) {
      const previousChat = previousChats.get(chat.chatId) ?? { unread: false, waiting: false }

      const becameUnread = countsAsUnread(chat) && !previousChat.unread
      const becameWaiting = chat.status === "waiting_for_user" && !previousChat.waiting
      if (!becameUnread && !becameWaiting) continue

      events.push({
        chatId: chat.chatId,
        projectTitle: group.title?.trim() || group.localPath,
        chatTitle: chat.title.trim() || "Untitled chat",
        message: becameWaiting ? chat.pendingUserInputPreview ?? "Waiting for your response." : null,
      })
    }
  }

  return events
}

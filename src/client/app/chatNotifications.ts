import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"

const BROWSER_CHAT_TITLE_MAX_LENGTH = 80

function getSidebarGroupChats(group: SidebarProjectGroup): SidebarChatRow[] {
  return [...group.chats, ...(group.archivedChats ?? [])]
}

export function getNotificationTitleCount(sidebarData: SidebarData) {
  return sidebarData.projectGroups.reduce((count, group) => (
    count + group.chats.reduce((chatCount, chat) => (
      chatCount + (chat.unread ? 1 : 0) + (chat.status === "waiting_for_user" ? 1 : 0)
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
  const projectGroup = args.activeProjectId
    ? args.sidebarData.projectGroups.find((group) => group.groupKey === args.activeProjectId)
    : args.activeChatId
      ? args.sidebarData.projectGroups.find((group) => (
          getSidebarGroupChats(group).some((chat) => chat.chatId === args.activeChatId)
        ))
      : null
  const projectTitle = projectGroup?.title?.trim()
  if (!projectGroup || !projectTitle) return baseTitle

  const chatTitle = args.activeChatId
    ? getSidebarGroupChats(projectGroup).find((chat) => chat.chatId === args.activeChatId)?.title.trim()
    : null
  if (!chatTitle) return `${baseTitle} : ${projectTitle}`

  const browserChatTitle = chatTitle.length > BROWSER_CHAT_TITLE_MAX_LENGTH
    ? `${chatTitle.slice(0, BROWSER_CHAT_TITLE_MAX_LENGTH)}...`
    : chatTitle
  return `${baseTitle} : ${projectTitle} : ${browserChatTitle}`
}

interface ChatNotificationSnapshot {
  unreadCount: number
  waitingChatIds: Set<string>
}

export function getChatNotificationSnapshot(sidebarData: SidebarData): ChatNotificationSnapshot {
  let unreadCount = 0
  const waitingChatIds = new Set<string>()

  for (const group of sidebarData.projectGroups) {
    for (const chat of group.chats) {
      if (chat.unread) unreadCount += 1
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

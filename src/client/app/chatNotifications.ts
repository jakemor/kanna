import type { SidebarData } from "../../shared/types"

export function getNotificationTitleCount(sidebarData: SidebarData) {
  return sidebarData.projectGroups.reduce((count, group) => (
    count + group.chats.reduce((chatCount, chat) => (
      chatCount + (chat.unread ? 1 : 0) + (chat.status === "waiting_for_user" ? 1 : 0)
    ), 0)
  ), 0)
}

interface ChatNotificationSnapshot {
  unreadCount: number
  waitingChatIds: Set<string>
}

interface ChatNotificationEvent {
  chatId: string
  projectTitle: string
  chatTitle: string
  message: string
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

export function getChatNotificationEvents(previous: SidebarData | null, next: SidebarData): ChatNotificationEvent[] {
  if (!previous) return []

  const previousChats = new Map<string, { unread: boolean; waiting: boolean }>()
  for (const group of previous.projectGroups) {
    for (const chat of group.chats) {
      previousChats.set(chat.chatId, {
        unread: chat.unread,
        waiting: chat.status === "waiting_for_user",
      })
    }
  }

  const events: ChatNotificationEvent[] = []
  for (const group of next.projectGroups) {
    for (const chat of group.chats) {
      const previousChat = previousChats.get(chat.chatId) ?? { unread: false, waiting: false }

      const becameUnread = chat.unread && !previousChat.unread
      const becameWaiting = chat.status === "waiting_for_user" && !previousChat.waiting
      if (!becameUnread && !becameWaiting) continue

      // The read model keeps this preview synced to the latest assistant text for the chat.
      events.push({
        chatId: chat.chatId,
        projectTitle: group.title?.trim() || group.localPath,
        chatTitle: chat.title.trim() || "Untitled chat",
        message: chat.lastAssistantResponsePreview ?? "",
      })
    }
  }

  return events
}

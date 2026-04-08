import type { SidebarChatRow } from "../../shared/types"
import { SIDEBAR_RECENT_WINDOW_MS } from "./formatters"

export interface SidebarChatBuckets {
  collapsedChats: SidebarChatRow[]
  remainingChats: SidebarChatRow[]
}

export function getSidebarChatBuckets(
  chats: SidebarChatRow[],
  chatsPerProject: number,
  nowMs: number
): SidebarChatBuckets {
  const recentChats = chats.filter((chat) => isSidebarChatRecent(chat.lastMessageAt, nowMs))
  const collapsedChats = recentChats.length > 0
    ? recentChats.slice(0, chatsPerProject)
    : chats.slice(0, Math.min(5, chats.length))
  const collapsedChatIds = new Set(collapsedChats.map((chat) => chat.chatId))
  const remainingChats = chats.filter((chat) => !collapsedChatIds.has(chat.chatId))

  return { collapsedChats, remainingChats }
}

function isSidebarChatRecent(lastMessageAt: number | undefined, nowMs: number) {
  if (lastMessageAt === undefined) return false
  return Math.max(0, nowMs - lastMessageAt) < SIDEBAR_RECENT_WINDOW_MS
}

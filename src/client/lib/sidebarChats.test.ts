import { describe, expect, test } from "bun:test"
import type { SidebarChatRow } from "../../shared/types"
import { getSidebarChatBuckets } from "./sidebarChats"

const nowMs = 1_000_000
const hourMs = 60 * 60 * 1_000

function createChat(chatId: string, lastMessageAt?: number): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: "codex",
    lastMessageAt,
    hasAutomation: false,
  }
}

describe("getSidebarChatBuckets", () => {
  test("uses up to 10 chats from the last 24 hours for the collapsed slice", () => {
    const chats = [
      createChat("chat-1", nowMs - hourMs),
      createChat("chat-2", nowMs - 2 * hourMs),
      createChat("chat-3", nowMs - 25 * hourMs),
      createChat("chat-4"),
    ]

    expect(getSidebarChatBuckets(chats, 10, nowMs)).toEqual({
      collapsedChats: [chats[0], chats[1]],
      remainingChats: [chats[2], chats[3]],
    })
  })

  test("falls back to the most recent 5 chats when nothing is within 24 hours", () => {
    const chats = Array.from({ length: 7 }, (_, index) => (
      createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
    ))

    expect(getSidebarChatBuckets(chats, 10, nowMs)).toEqual({
      collapsedChats: chats.slice(0, 5),
      remainingChats: chats.slice(5),
    })
  })

  test("keeps additional recent chats in the remaining slice when there are more than 10", () => {
    const chats = Array.from({ length: 12 }, (_, index) => (
      createChat(`chat-${index + 1}`, nowMs - (index + 1) * hourMs)
    ))

    expect(getSidebarChatBuckets(chats, 10, nowMs)).toEqual({
      collapsedChats: chats.slice(0, 10),
      remainingChats: chats.slice(10),
    })
  })
})

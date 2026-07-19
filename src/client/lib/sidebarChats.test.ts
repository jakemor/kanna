import { describe, expect, test } from "bun:test"
import type { SidebarChatRow } from "../../shared/types"
import {
  getSidebarChatBuckets,
  getSidebarChatTimestamp,
} from "./sidebarChats"

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
  test("uses all chats from the last 24 hours for the collapsed slice", () => {
    const chats = [
      createChat("chat-1", nowMs - hourMs),
      createChat("chat-2", nowMs - 2 * hourMs),
      createChat("chat-3", nowMs - 25 * hourMs),
      createChat("chat-4"),
    ]

    expect(getSidebarChatBuckets(chats, nowMs)).toEqual({
      collapsedChats: [chats[0], chats[1], chats[3]],
      remainingChats: [chats[2]],
    })
  })

  test("treats a newly created chat with no last message as recent", () => {
    const chats = [
      createChat("chat-1"),
      createChat("chat-2", nowMs - 25 * hourMs),
    ]

    expect(getSidebarChatBuckets(chats, nowMs)).toEqual({
      collapsedChats: [chats[0]],
      remainingChats: [chats[1]],
    })
  })

  test("falls back to the most recent 5 chats when nothing is within 24 hours", () => {
    const chats = Array.from({ length: 7 }, (_, index) => (
      createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
    ))

    expect(getSidebarChatBuckets(chats, nowMs)).toEqual({
      collapsedChats: chats.slice(0, 5),
      remainingChats: chats.slice(5),
    })
  })

  test("does not move additional recent chats into the remaining slice", () => {
    const chats = Array.from({ length: 12 }, (_, index) => (
      createChat(`chat-${index + 1}`, nowMs - (index + 1) * hourMs)
    ))

    expect(getSidebarChatBuckets(chats, nowMs)).toEqual({
      collapsedChats: chats,
      remainingChats: [],
    })
  })
})

describe("getSidebarChatTimestamp", () => {
  test("falls back to the chat creation time when lastMessageAt is missing", () => {
    expect(getSidebarChatTimestamp(createChat("chat-1"))).toBe(1)
  })

  test("prefers lastMessageAt when it exists", () => {
    expect(getSidebarChatTimestamp(createChat("chat-1", 123))).toBe(123)
  })
})

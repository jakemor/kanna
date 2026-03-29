import { describe, expect, test } from "bun:test"
import {
  buildChatDeepLink,
  CHAT_SCROLL_TO_BOTTOM_QUERY_PARAM,
  shouldAutoScrollChatToBottom,
  shouldShowCompletionNotification,
} from "./pwa"

describe("buildChatDeepLink", () => {
  test("builds a deep link to the chat and requests bottom scrolling", () => {
    const url = buildChatDeepLink("https://kanna.example", "chat-123")

    expect(url).toBe(`https://kanna.example/chat/chat-123?${CHAT_SCROLL_TO_BOTTOM_QUERY_PARAM}=1`)
  })
})

describe("shouldAutoScrollChatToBottom", () => {
  test("returns true when the deep link requests bottom scroll", () => {
    expect(shouldAutoScrollChatToBottom("?scrollToBottom=1")).toBe(true)
  })

  test("returns false when the query param is absent", () => {
    expect(shouldAutoScrollChatToBottom("?foo=bar")).toBe(false)
  })
})

describe("shouldShowCompletionNotification", () => {
  test("does not notify when the active chat is visible", () => {
    expect(shouldShowCompletionNotification({
      chatId: "chat-1",
      activeChatId: "chat-1",
      documentVisibilityState: "visible",
    })).toBe(false)
  })

  test("notifies when the app is hidden", () => {
    expect(shouldShowCompletionNotification({
      chatId: "chat-1",
      activeChatId: "chat-1",
      documentVisibilityState: "hidden",
    })).toBe(true)
  })

  test("notifies when a different chat is open", () => {
    expect(shouldShowCompletionNotification({
      chatId: "chat-1",
      activeChatId: "chat-2",
      documentVisibilityState: "visible",
    })).toBe(true)
  })
})

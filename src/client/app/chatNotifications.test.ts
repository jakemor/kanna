import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getChatNotificationEvents, getChatNotificationSnapshot, getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"

function row(overrides: Partial<SidebarChatRow> & Pick<SidebarChatRow, "chatId">): SidebarChatRow {
  return {
    _id: overrides.chatId,
    _creationTime: 1,
    title: overrides.chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/p",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function sidebar(chats: SidebarChatRow[]): SidebarData {
  return { projectGroups: [{ groupKey: "p", title: "P", realTitle: "P", localPath: "/tmp/p", chats, previewChats: [], olderChats: [], defaultCollapsed: false }] }
}

// A sub-chat finishing is never announced: the server never marks it unread
// (`tracksUnread`), and its parent's report is the news.
describe("chat notifications and sub-chats", () => {
  test("an adopted chat finishing is, like any chat the sidebar lists", () => {
    const before = sidebar([row({ chatId: "parent" }), row({ chatId: "mine", parentChatId: "parent", adopted: true })])
    const after = sidebar([row({ chatId: "parent" }), row({ chatId: "mine", parentChatId: "parent", adopted: true, unread: true })])
    expect(getNotificationTitleCount(after)).toBe(1)
    expect(getChatNotificationSnapshot(after).unreadCount).toBe(1)
    expect(getChatSoundBurstCount(before, after)).toBe(1)
  })

  test("its parent finishing still is", () => {
    const before = sidebar([row({ chatId: "parent" }), row({ chatId: "child", parentChatId: "parent", hidden: true })])
    const after = sidebar([row({ chatId: "parent", unread: true }), row({ chatId: "child", parentChatId: "parent", hidden: true })])
    expect(getNotificationTitleCount(after)).toBe(1)
    expect(getChatNotificationEvents(before, after).map((event) => event.chatId)).toEqual(["parent"])
  })

  // The one thing a sub-chat does want the user for.
  test("a sub-chat that stops to ask something is announced", () => {
    const before = sidebar([row({ chatId: "child", parentChatId: "parent", hidden: true, status: "running" })])
    const after = sidebar([row({ chatId: "child", parentChatId: "parent", hidden: true, status: "waiting_for_user" })])
    expect(getNotificationTitleCount(after)).toBe(1)
    expect(getChatNotificationEvents(before, after).map((event) => event.chatId)).toEqual(["child"])
  })
})

describe("chat notifications and a chat waiting on a subagent", () => {
  // The turn that hands work off ends, and marks the chat unread, before the
  // work is in. The news is the reply that comes after it.
  const running = sidebar([row({ chatId: "chat", status: "running" })])
  const waiting = sidebar([row({ chatId: "chat", status: "waiting_on_subagent", unread: true })])
  const woken = sidebar([row({ chatId: "chat", status: "running", unread: true })])
  const done = sidebar([row({ chatId: "chat", unread: true })])

  test("its turn ending is not announced while the work it handed off is going", () => {
    expect(getNotificationTitleCount(waiting)).toBe(0)
    expect(getChatNotificationEvents(running, waiting)).toEqual([])
    expect(getChatSoundBurstCount(running, waiting)).toBe(0)
  })

  test("nor is the turn that work starts", () => {
    expect(getChatNotificationEvents(waiting, woken)).toEqual([])
    expect(getChatSoundBurstCount(waiting, woken)).toBe(0)
  })

  test("it is announced once, when the chat comes to rest", () => {
    // Either from the turn the work started, or straight from the wait when
    // the work ends without starting one.
    for (const before of [woken, waiting]) {
      expect(getChatNotificationEvents(before, done).map((event) => event.chatId)).toEqual(["chat"])
      expect(getChatSoundBurstCount(before, done)).toBe(1)
    }
    expect(getNotificationTitleCount(done)).toBe(1)
  })

  test("a question still gets through while a chat waits", () => {
    const asking = sidebar([row({ chatId: "chat", status: "waiting_for_user", unread: true })])
    expect(getChatNotificationEvents(waiting, asking).map((event) => event.chatId)).toEqual(["chat"])
  })
})

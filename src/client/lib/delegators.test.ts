import { describe, expect, test } from "bun:test"
import type { SidebarChatRow } from "../../shared/types"
import { delegatedAttentionCount, delegatedListTitle, delegatedThreads, projectDelegators } from "./delegators"
import type { SidebarThread } from "./thread-sections"

function thread(chatId: string, row: Partial<SidebarChatRow> = {}, extra: Partial<SidebarThread> = {}): SidebarThread {
  return {
    chatId,
    title: chatId,
    projectId: "p1",
    projectTitle: "kanna",
    projectLabel: { text: "kanna" } as SidebarThread["projectLabel"],
    archived: false,
    lastActivityAt: 0,
    row: { chatId, title: chatId, status: "idle", unread: false, _creationTime: 0, ...row } as SidebarChatRow,
    ...extra,
  }
}

const delegator = (chatId: string, lastActivityAt: number, extra: Partial<SidebarThread> = {}) => (
  thread(chatId, { delegator: true }, { lastActivityAt, ...extra })
)

describe("projectDelegators", () => {
  test("the project's delegators, most recently active first", () => {
    const threads = [delegator("old", 1), thread("plain"), delegator("new", 5), delegator("elsewhere", 9, { projectId: "p2" })]
    expect(projectDelegators(threads, "p1").map((item) => item.chatId)).toEqual(["new", "old"])
  })

  test("archived delegators are not offered, and no project has none", () => {
    expect(projectDelegators([delegator("put-away", 3, { archived: true })], "p1")).toEqual([])
    expect(projectDelegators([delegator("a", 1)], null)).toEqual([])
  })
})

describe("delegatedThreads", () => {
  test("the chats directly under the delegator, archived ones included, and nothing deeper", () => {
    const threads = [
      thread("child", { parentChatId: "deleg" }),
      thread("put-away", { parentChatId: "deleg" }, { archived: true }),
      thread("grandchild", { parentChatId: "child" }),
      thread("other", { parentChatId: "another" }),
      thread("plain"),
    ]
    expect(delegatedThreads(threads, "deleg").map((item) => item.chatId)).toEqual(["child", "put-away"])
  })
})

describe("delegatedAttentionCount", () => {
  const row = (extra: Partial<SidebarChatRow>) => ({ parentChatId: "deleg", status: "idle", unread: false, ...extra }) as SidebarChatRow

  test("counts the chats under it that are waiting on the user", () => {
    expect(delegatedAttentionCount([row({ status: "waiting_for_user" }), row({ status: "running" }), row({})], "deleg")).toBe(1)
  })

  // The server marks no other sub-chat unread: the delegator reports for it.
  test("an adopted chat that finished and has not been opened is counted until it is", () => {
    expect(delegatedAttentionCount([row({ adopted: true, unread: true })], "deleg")).toBe(1)
    expect(delegatedAttentionCount([row({ adopted: true, unread: false })], "deleg")).toBe(0)
  })

  test("an unread mark on a chat still working is not its last word, and not counted", () => {
    expect(delegatedAttentionCount([row({ adopted: true, unread: true, status: "running" }), row({ adopted: true, unread: true, status: "waiting_on_subagent" })], "deleg")).toBe(0)
  })

  test("only this delegator's chats", () => {
    expect(delegatedAttentionCount([row({ status: "waiting_for_user", parentChatId: "other" })], "deleg")).toBe(0)
  })
})

describe("delegatedListTitle", () => {
  test("a named delegator's list is headed by its name alone", () => {
    expect(delegatedListTitle("Ship 0.83")).toBe("Ship 0.83")
  })

  test("an unnamed or unknown one is headed Delegator, as on iOS", () => {
    expect(delegatedListTitle("New Chat")).toBe("Delegator")
    expect(delegatedListTitle("  ")).toBe("Delegator")
    expect(delegatedListTitle(undefined)).toBe("Delegator")
  })
})

import { describe, expect, test } from "bun:test"
import type { SidebarChatRow } from "../../shared/types"
import { delegatedAttentionCount, delegatedListTitle, delegatedThreads, delegatorToggleTitle } from "./delegators"
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

describe("delegatorToggleTitle", () => {
  test("a delegator can be made to work directly, and any other chat a delegator", () => {
    expect(delegatorToggleTitle({ delegator: true, provider: "claude" })).toBe("Work Here Directly")
    expect(delegatorToggleTitle({ provider: "codex" })).toBe("Make Delegator")
    // An empty chat has no provider yet.
    expect(delegatorToggleTitle({ provider: null })).toBe("Make Delegator")
  })

  test("a chat on a provider without the Kanna tools is not offered it, unless it already delegates", () => {
    expect(delegatorToggleTitle({ provider: "grok" })).toBeNull()
    expect(delegatorToggleTitle({ delegator: true, provider: "grok" })).toBe("Work Here Directly")
  })
})

import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarProjectGroup } from "../../shared/types"
import { computeChannelSections, getChannelPeekGroups, RECENT_CHANNEL_DAYS } from "./channel-sections"

const NOW = new Date(2026, 9, 1, 12).getTime()
const DAY = 24 * 60 * 60 * 1_000

function chat(chatId: string, at: number, extra: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: at,
    chatId,
    title: chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: null,
    lastMessageAt: at,
    ...extra,
  } as SidebarChatRow
}

function project(groupKey: string, chats: SidebarChatRow[]): SidebarProjectGroup {
  return { groupKey, title: groupKey, realTitle: groupKey, localPath: `/tmp/${groupKey}`, chats } as SidebarProjectGroup
}

function sectionsOf(groups: SidebarProjectGroup[], pins: Record<string, number> = {}) {
  const pinned = groups.map((group) => (
    pins[group.groupKey] === undefined ? group : { ...group, pinnedAt: pins[group.groupKey] }
  ))
  return computeChannelSections(pinned, NOW)
    .map((section) => [section.label, section.groups.map((group) => group.groupKey)])
}

describe("computeChannelSections", () => {
  test("puts a project in the section of its highest-priority chat", () => {
    expect(sectionsOf([
      project("yesterday-and-older", [chat("a", NOW - DAY), chat("b", NOW - 9 * DAY)]),
      project("today-and-relevant", [chat("c", NOW), chat("d", NOW - 9 * DAY, { unread: true })]),
      project("running", [chat("e", NOW - DAY, { status: "running" }), chat("f", NOW)]),
      project("today", [chat("g", NOW)]),
    ])).toEqual([
      ["In Progress", ["running"]],
      ["Relevant", ["today-and-relevant"]],
      ["Recent", ["today", "yesterday-and-older"]],
    ])
  })

  test("files the rest by age: a rolling week, then everything older, then projects with no chats", () => {
    const sections = computeChannelSections([
      project("month-ago", [chat("a", NOW - 30 * DAY)]),
      project("no-chats", []),
      project("six-days-ago", [chat("b", NOW - 6 * DAY)]),
      project("seven-days-ago", [chat("c", NOW - 7 * DAY)]),
      project("today", [chat("d", NOW)]),
      // Old by its newest finished chat, but something is running in it.
      project("old-but-running", [chat("e", NOW - 40 * DAY), chat("f", NOW - 60 * DAY, { status: "running" })]),
      project("years-ago", [chat("g", NOW - 800 * DAY)]),
    ], NOW)
    expect(sections.map((section) => [section.key, section.label, section.groups.map((group) => group.groupKey)])).toEqual([
      ["in-progress", "In Progress", ["old-but-running"]],
      ["recent", "Recent", ["today", "six-days-ago"]],
      // No lower cutoff, and newest first.
      ["older", "Older", ["seven-days-ago", "month-ago", "years-ago"]],
      ["quiet", "No Recent Chats", ["no-chats"]],
    ])
    // Fixed per section, whichever of them are there.
    expect(Object.fromEntries(sections.map((section) => [section.key, [section.collapsible, section.defaultExpanded]]))).toEqual({
      "in-progress": [false, true],
      "recent": [true, true],
      older: [true, false],
      quiet: [true, false],
    })
  })

  test("the week is whole local days: today and the six before it, turning over at midnight", () => {
    expect(RECENT_CHANNEL_DAYS).toBe(7)
    // NOW is noon on October 1st, so the week began as September 25th did.
    const weekStart = new Date(2026, 8, 25).getTime()
    const keyFor = (at: number, now = NOW) => computeChannelSections([project("p", [chat("a", at)])], now)[0]!.key
    expect(keyFor(weekStart)).toBe("recent")
    expect(keyFor(weekStart - 1)).toBe("older")
    // Not a rolling 168 hours: the first minute of that day is in at any
    // time today, and out the moment tomorrow starts.
    const endOfToday = new Date(2026, 9, 1, 23, 59, 59, 999).getTime()
    expect(keyFor(weekStart + 60_000, endOfToday)).toBe("recent")
    expect(keyFor(weekStart + 60_000, endOfToday + 1)).toBe("older")
    // A clock a little ahead of this one is still today.
    expect(keyFor(NOW + 5 * 60_000)).toBe("recent")
  })

  test("a project is as recent as its most recent chat activity, not its last message", () => {
    // Sent a fortnight ago, and the agent only finished yesterday.
    expect(sectionsOf([
      project("long-turn", [chat("a", NOW - 14 * DAY, { lastTurnEndedAt: NOW - DAY })]),
      project("old", [chat("b", NOW - 14 * DAY), chat("c", NOW - 20 * DAY)]),
    ])).toEqual([
      ["Recent", ["long-turn"]],
      ["Older", ["old"]],
    ])
  })

  test("leaves out a section with nothing in it", () => {
    expect(sectionsOf([project("old", [chat("a", NOW - 30 * DAY)])])).toEqual([["Older", ["old"]]])
    expect(sectionsOf([project("new", [chat("a", NOW)])])).toEqual([["Recent", ["new"]]])
  })

  test("has no section for delegators: one counts toward its project by status and age, like any chat", () => {
    expect(sectionsOf([
      project("delegator-running", [chat("a", NOW - 30 * DAY, { delegator: true, status: "running" })]),
      project("delegator-recent", [chat("b", NOW - DAY, { delegator: true })]),
      project("delegator-old", [chat("c", NOW - 30 * DAY, { delegator: true })]),
      project("delegator-unread", [chat("d", NOW - 30 * DAY, { delegator: true, unread: true })]),
      // Nothing has been said in it yet, so the project has no chat to show.
      project("delegator-empty", [chat("e", NOW, { delegator: true, lastMessageAt: undefined })]),
    ])).toEqual([
      ["In Progress", ["delegator-running"]],
      ["Relevant", ["delegator-unread"]],
      ["Recent", ["delegator-recent"]],
      ["Older", ["delegator-old"]],
      ["No Recent Chats", ["delegator-empty"]],
    ])
  })

  test("pins a project only when the channel itself is pinned", () => {
    expect(sectionsOf([
      project("has-pinned-chat", [chat("a", NOW, { pinnedAt: 5 })]),
      project("pinned-channel", [chat("b", NOW - DAY, { status: "running" })]),
      project("plain", [chat("c", NOW - DAY)]),
    ], { "pinned-channel": 10 })).toEqual([
      ["Pinned", ["pinned-channel"]],
      ["Recent", ["has-pinned-chat", "plain"]],
    ])
  })

  test("keeps projects with no chats to show reachable at the end", () => {
    expect(sectionsOf([
      project("empty", []),
      project("unsent", [chat("a", NOW, { lastMessageAt: undefined })]),
      project("active", [chat("b", NOW)]),
    ])).toEqual([
      ["Recent", ["active"]],
      ["No Recent Chats", ["empty", "unsent"]],
    ])
  })

})

describe("getChannelPeekGroups", () => {
  function peek(chats: SidebarChatRow[], archivedIds: string[] = []) {
    const group = {
      ...project("p", chats.filter((row) => !archivedIds.includes(row.chatId))),
      archivedChats: chats.filter((row) => archivedIds.includes(row.chatId)),
    }
    return getChannelPeekGroups(group, NOW)
      .map((peekGroup) => [peekGroup.label, peekGroup.threads.map((thread) => thread.chatId)])
  }

  test("offers everything down to Relevant, then the latest date bucket only", () => {
    expect(peek([
      chat("pinned", NOW - 9 * DAY, { pinnedAt: 1 }),
      chat("running", NOW, { status: "running" }),
      chat("unread", NOW - DAY, { unread: true }),
      chat("today", NOW),
      chat("yesterday", NOW - DAY),
    ])).toEqual([
      // The Chats view's own order.
      ["Pinned", ["pinned"]],
      ["In Progress", ["running"]],
      ["Relevant", ["unread"]],
      ["Today", ["today"]],
    ])
  })

  test("has no group for delegators: each is in the group its state puts it in", () => {
    expect(peek([
      chat("delegator-pinned", NOW - 30 * DAY, { delegator: true, pinnedAt: 3 }),
      chat("delegator-running", NOW - DAY, { delegator: true, status: "running" }),
      chat("delegator-unread", NOW - 2 * DAY, { delegator: true, unread: true }),
      chat("delegator-today", NOW, { delegator: true }),
      chat("delegator-empty", NOW - 3 * DAY, { delegator: true, lastMessageAt: undefined }),
    ])).toEqual([
      ["Pinned", ["delegator-pinned"]],
      ["In Progress", ["delegator-running"]],
      ["Relevant", ["delegator-unread"]],
      ["Today", ["delegator-today"]],
    ])
  })

  test("is the latest day alone for a project with nothing pressing", () => {
    expect(peek([chat("a", NOW - DAY), chat("b", NOW - 9 * DAY)])).toEqual([["Yesterday", ["a"]]])
  })

  test("adds the older buckets when asked for all of them", () => {
    const groups = getChannelPeekGroups(
      project("p", [chat("a", NOW - DAY), chat("b", NOW - 9 * DAY)]), NOW, undefined, undefined, true,
    )
    expect(groups.map((group) => group.threads.map((thread) => thread.chatId))).toEqual([["a"], ["b"]])
  })

  test("is empty for a project with no chats to show", () => {
    expect(peek([chat("unsent", NOW, { lastMessageAt: undefined })])).toEqual([])
  })
})

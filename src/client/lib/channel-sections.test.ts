import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarProjectGitState, SidebarProjectGroup } from "../../shared/types"
import {
  computeChannelSections,
  getChannelPeekGroups,
  isChannelRelevant,
  RECENT_CHANNEL_DAYS,
  RELEVANT_CHANNEL_ACTIVITY_MS,
} from "./channel-sections"

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

const CLEAN: SidebarProjectGitState = { dirty: false, ahead: 0, untrackedOnly: false }

/** A clean repo unless told otherwise, so only chats decide where it goes. */
function project(
  groupKey: string,
  chats: SidebarChatRow[],
  gitState: SidebarProjectGitState | null = CLEAN,
): SidebarProjectGroup {
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: `/tmp/${groupKey}`,
    chats,
    ...(gitState ? { gitState, hasGitRepo: true } : { hasGitRepo: false }),
  } as SidebarProjectGroup
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

  test("Relevant is a repo with work not yet committed or pushed", () => {
    expect(sectionsOf([
      project("dirty", [chat("a", NOW - 30 * DAY)], { ...CLEAN, dirty: true }),
      project("unpushed", [chat("b", NOW - 30 * DAY)], { ...CLEAN, ahead: 2 }),
      // Untracked files don't make work: this one is filed by age.
      project("untracked-old", [chat("c", NOW - 30 * DAY)], { ...CLEAN, untrackedOnly: true }),
      // Busy, but nothing is open in it.
      project("clean-busy", [chat("d", NOW)]),
    ])).toEqual([
      ["Relevant", ["dirty", "unpushed"]],
      ["Recent", ["clean-busy"]],
      ["Older", ["untracked-old"]],
    ])
  })

  test("Relevant falls back to the last 72 hours where git can't answer", () => {
    const justIn = NOW - RELEVANT_CHANNEL_ACTIVITY_MS + 60_000
    const justOut = NOW - RELEVANT_CHANNEL_ACTIVITY_MS - 60_000
    expect(sectionsOf([
      project("untracked-fresh", [chat("a", justIn)], { ...CLEAN, untrackedOnly: true }),
      project("untracked-stale", [chat("b", justOut)], { ...CLEAN, untrackedOnly: true }),
      project("no-repo-fresh", [chat("c", justIn)], null),
      project("no-repo-stale", [chat("d", justOut)], null),
    ])).toEqual([
      ["Relevant", ["untracked-fresh", "no-repo-fresh"]],
      ["Recent", ["untracked-stale", "no-repo-stale"]],
    ])
  })

  test("Relevant is newest first, and still holds a project waiting on you", () => {
    expect(sectionsOf([
      project("dirty-old", [chat("a", NOW - 20 * DAY)], { ...CLEAN, dirty: true }),
      project("unread-clean", [chat("b", NOW - 9 * DAY, { unread: true })]),
      project("unpushed-new", [chat("c", NOW - DAY)], { ...CLEAN, ahead: 1 }),
    ])).toEqual([
      ["Relevant", ["unpushed-new", "unread-clean", "dirty-old"]],
    ])
  })

  test("a chat the Chats view calls relevant doesn't make its clean project relevant", () => {
    expect(sectionsOf([
      project("clean", [chat("a", NOW - 9 * DAY, { uncommittedWork: true })]),
    ])).toEqual([["Older", ["clean"]]])
  })

  test("In Progress and Pinned still come first", () => {
    expect(sectionsOf([
      project("dirty-running", [chat("a", NOW, { status: "running" })], { ...CLEAN, dirty: true }),
      project("dirty-pinned", [chat("b", NOW)], { ...CLEAN, dirty: true }),
    ], { "dirty-pinned": 1 })).toEqual([
      ["Pinned", ["dirty-pinned"]],
      ["In Progress", ["dirty-running"]],
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

describe("isChannelRelevant", () => {
  const recent = NOW - DAY
  const old = NOW - 10 * DAY
  test.each([
    ["tracked changes", { ...CLEAN, dirty: true }, old, true],
    ["unpushed commits", { ...CLEAN, ahead: 3 }, old, true],
    // The server sends 0 ahead for a branch with no upstream.
    ["a clean local-only branch, however recent", CLEAN, recent, false],
    ["a clean repo", CLEAN, old, false],
    ["untracked files and a recent chat", { ...CLEAN, untrackedOnly: true }, recent, true],
    ["untracked files and an old chat", { ...CLEAN, untrackedOnly: true }, old, false],
    ["no repo and a recent chat", undefined, recent, true],
    ["no repo and an old chat", undefined, old, false],
    ["no repo and no chat", undefined, undefined, false],
  ] as const)("%s", (_name, gitState, lastActivityAt, expected) => {
    expect(isChannelRelevant({ gitState }, lastActivityAt, NOW)).toBe(expected)
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

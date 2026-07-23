import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../shared/types"
import {
  computeSidebarThreadSections,
  computeThreadDateBuckets,
  computeThreadSections,
  flattenSidebarThreads,
  getInProgressThreads,
  getRecentThreads,
  getReviewThreads,
  RECENT_THREADS_LIMIT,
} from "./thread-sections"

function makeChatRow(overrides: Partial<SidebarChatRow> & Pick<SidebarChatRow, "chatId" | "title">): SidebarChatRow {
  return {
    _id: overrides.chatId,
    _creationTime: 1_000,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function makeSidebarData(): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "project-a",
        title: "Kanna",
        realTitle: "Kanna",
        localPath: "/Users/jake/Projects/kanna",
        chats: [
          makeChatRow({ chatId: "chat-1", title: "Fix websocket reconnect", lastMessageAt: 300 }),
          makeChatRow({ chatId: "chat-2", title: "Command palette design", lastMessageAt: 900 }),
        ],
        previewChats: [],
        olderChats: [],
        archivedChats: [
          makeChatRow({ chatId: "chat-3", title: "Old palette prototype", lastMessageAt: 100 }),
        ],
        defaultCollapsed: false,
      },
      {
        groupKey: "project-b",
        title: "Superwall",
        realTitle: "Superwall",
        localPath: "/Users/jake/Projects/superwall",
        chats: [
          makeChatRow({ chatId: "chat-4", title: "Paywall experiments", lastMessageAt: 600 }),
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: false,
      },
    ],
  }
}

/** One project group wrapping the given rows (last one archived when `archived` set). */
function makeData(chats: SidebarChatRow[], archivedChats: SidebarChatRow[] = []): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "p",
        title: "P",
        realTitle: "P",
        localPath: "/tmp/p",
        chats,
        previewChats: [],
        olderChats: [],
        archivedChats,
        defaultCollapsed: false,
      },
    ],
  }
}

describe("flattenSidebarThreads", () => {
  test("includes active and archived chats with project metadata", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    expect(threads).toHaveLength(4)

    const archived = threads.find((thread) => thread.chatId === "chat-3")
    expect(archived?.archived).toBe(true)
    expect(archived?.projectTitle).toBe("Kanna")

    const active = threads.find((thread) => thread.chatId === "chat-4")
    expect(active?.archived).toBe(false)
    expect(active?.projectId).toBe("project-b")
  })

  test("falls back to creation time when lastMessageAt is missing", () => {
    const data = makeSidebarData()
    data.projectGroups[0].chats.push(makeChatRow({ chatId: "chat-5", title: "Draft" }))
    const threads = flattenSidebarThreads(data)
    expect(threads.find((thread) => thread.chatId === "chat-5")?.lastActivityAt).toBe(1_000)
  })
})

describe("getRecentThreads", () => {
  test("sorts by recency and excludes archived chats", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    const recent = getRecentThreads(threads, 3)
    expect(recent.map((thread) => thread.chatId)).toEqual(["chat-2", "chat-4", "chat-1"])
  })

  test("excludes chatIds passed in the exclude set", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    const recent = getRecentThreads(threads, 3, new Set(["chat-2"]))
    expect(recent.map((thread) => thread.chatId)).toEqual(["chat-4", "chat-1"])
  })
})

describe("getReviewThreads", () => {
  test("selects waiting_for_user / unread chats (sidebar dot), most recent first", () => {
    const data = makeData(
      [
        makeChatRow({ chatId: "waiting", title: "Waiting", status: "waiting_for_user", lastMessageAt: 300 }),
        makeChatRow({ chatId: "unread", title: "Unread", unread: true, lastMessageAt: 600 }),
        makeChatRow({ chatId: "idle", title: "Idle", lastMessageAt: 900 }),
        makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 950 }),
      ],
      [makeChatRow({ chatId: "archived-unread", title: "Archived", unread: true, lastMessageAt: 990 })],
    )
    const review = getReviewThreads(flattenSidebarThreads(data))
    // unread (600) before waiting (300); idle, running, and archived excluded.
    expect(review.map((thread) => thread.chatId)).toEqual(["unread", "waiting"])
  })
})

describe("getInProgressThreads", () => {
  test("selects running/starting chats, most recent first, excluding archived", () => {
    const data = makeData(
      [
        makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 300 }),
        makeChatRow({ chatId: "starting", title: "Starting", status: "starting", lastMessageAt: 600 }),
        makeChatRow({ chatId: "idle", title: "Idle", lastMessageAt: 900 }),
      ],
      [makeChatRow({ chatId: "archived-running", title: "Archived", status: "running", lastMessageAt: 990 })],
    )
    const inProgress = getInProgressThreads(flattenSidebarThreads(data))
    expect(inProgress.map((thread) => thread.chatId)).toEqual(["starting", "running"])
  })

  test("excludes chatIds passed in the exclude set", () => {
    const data = makeData([
      makeChatRow({ chatId: "running-1", title: "One", status: "running", lastMessageAt: 300 }),
      makeChatRow({ chatId: "running-2", title: "Two", status: "running", lastMessageAt: 600 }),
    ])
    const inProgress = getInProgressThreads(flattenSidebarThreads(data), new Set(["running-2"]))
    expect(inProgress.map((thread) => thread.chatId)).toEqual(["running-1"])
  })
})

describe("computeThreadSections", () => {
  test("a running unread chat lands in review, not in progress", () => {
    const data = makeData([
      makeChatRow({ chatId: "running-unread", title: "Both", status: "running", unread: true, lastMessageAt: 300 }),
      makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 600 }),
    ])
    const sections = computeThreadSections(flattenSidebarThreads(data))
    expect(sections.review.map((thread) => thread.chatId)).toEqual(["running-unread"])
    expect(sections.inProgress.map((thread) => thread.chatId)).toEqual(["running"])
  })

  test("recents excludes review and in-progress chats and hides empty new chats", () => {
    const data = makeData([
      makeChatRow({ chatId: "unread", title: "Unread", unread: true, lastMessageAt: 900 }),
      makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 800 }),
      makeChatRow({ chatId: "idle", title: "Idle", lastMessageAt: 700 }),
      makeChatRow({ chatId: "empty-draft", title: "Draft" }), // no lastMessageAt
    ])
    const sections = computeThreadSections(flattenSidebarThreads(data))
    expect(sections.recent.map((thread) => thread.chatId)).toEqual(["idle"])
  })

  test("recents is always capped at RECENT_THREADS_LIMIT, with or without other sections", () => {
    const idleChats = Array.from({ length: RECENT_THREADS_LIMIT + 2 }, (_, index) =>
      makeChatRow({ chatId: `idle-${index}`, title: `Idle ${index}`, lastMessageAt: 100 + index }))

    const withoutOthers = computeThreadSections(flattenSidebarThreads(makeData(idleChats)))
    expect(withoutOthers.review).toHaveLength(0)
    expect(withoutOthers.inProgress).toHaveLength(0)
    expect(withoutOthers.recent).toHaveLength(RECENT_THREADS_LIMIT)

    const withOthers = computeThreadSections(flattenSidebarThreads(makeData([
      ...idleChats,
      makeChatRow({ chatId: "unread", title: "Unread", unread: true, lastMessageAt: 900 }),
      makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 800 }),
    ])))
    expect(withOthers.recent).toHaveLength(RECENT_THREADS_LIMIT)
  })
})

// Wednesday, July 15 2026 at noon local — the reference date from the spec.
const NOW = new Date(2026, 6, 15, 12).getTime()

function at(year: number, month: number, day: number, hour = 10): number {
  return new Date(year, month - 1, day, hour).getTime()
}

function bucketThreads(rows: SidebarChatRow[]) {
  return computeThreadDateBuckets(
    flattenSidebarThreads(makeData(rows)).filter((thread) => thread.row.lastMessageAt != null),
    NOW,
  )
}

describe("computeThreadDateBuckets", () => {
  // Reference: Wed Jul 15 2026. This week = Mon Jul 13; last week = Mon Jul 6 – Sun Jul 12.
  test("two most recent activity days lead as Today/Yesterday, then This Week, Last Week, Last 30 Days", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "today", title: "t", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "yesterday", title: "y", lastMessageAt: at(2026, 7, 14) }),
      makeChatRow({ chatId: "monday", title: "m", lastMessageAt: at(2026, 7, 13) }),
      makeChatRow({ chatId: "last-week", title: "lw", lastMessageAt: at(2026, 7, 8) }),
      makeChatRow({ chatId: "older", title: "o", lastMessageAt: at(2026, 6, 20) }),
    ])
    expect(buckets.map((bucket) => [bucket.label, bucket.defaultExpanded])).toEqual([
      ["Today", true],
      ["Yesterday", true],
      ["This Week", false],
      ["Last Week", false],
      ["Last 30 Days", false],
    ])
    // Monday's chats fall through to This Week — the day sections took the 2 newest days.
    expect(buckets[2].threads.map((thread) => thread.chatId)).toEqual(["monday"])
  })

  test("walks timestamps: a gap yields Today and Last <weekday>", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "today", title: "t", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "friday", title: "f", lastMessageAt: at(2026, 7, 10) }), // Fri, 5 days back
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Today", "Last Friday"])
  })

  test("after idle weeks the day sections carry full dates, with the rest in Last 30 Days", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "mon", title: "a", lastMessageAt: at(2026, 6, 29) }), // Monday
      makeChatRow({ chatId: "fri", title: "b", lastMessageAt: at(2026, 6, 26) }), // Friday
      makeChatRow({ chatId: "older", title: "c", lastMessageAt: at(2026, 6, 20) }),
    ])
    expect(buckets.map((bucket) => [bucket.label, bucket.defaultExpanded])).toEqual([
      ["Monday Jun 29th", true],
      ["Friday Jun 26th", true],
      ["Last 30 Days", false],
    ])
  })

  test("has no client-side age cutoff — server GC bounds the list", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "recent", title: "a", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "ancient", title: "b", lastMessageAt: at(2026, 5, 1) }),
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Today", "Friday May 1st"])
  })

  test("empty buckets are never emitted and threads sort newest-first within a bucket", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "late", title: "a", lastMessageAt: at(2026, 7, 15, 11) }),
      makeChatRow({ chatId: "early", title: "b", lastMessageAt: at(2026, 7, 15, 9) }),
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0].label).toBe("Today")
    expect(buckets[0].threads.map((thread) => thread.chatId)).toEqual(["late", "early"])
  })
})

describe("computeSidebarThreadSections", () => {
  test("buckets exclude review/in-progress chats and empty new chats; archived get their own list", () => {
    const data = makeData(
      [
        makeChatRow({ chatId: "unread", title: "u", unread: true, lastMessageAt: at(2026, 7, 15) }),
        makeChatRow({ chatId: "running", title: "r", status: "running", lastMessageAt: at(2026, 7, 15) }),
        makeChatRow({ chatId: "idle", title: "i", lastMessageAt: at(2026, 7, 15) }),
        makeChatRow({ chatId: "empty-draft", title: "d" }), // no lastMessageAt
      ],
      [
        makeChatRow({ chatId: "archived-new", title: "x", lastMessageAt: at(2026, 7, 15) }),
        makeChatRow({ chatId: "archived-old", title: "y", lastMessageAt: at(2026, 7, 10) }),
      ],
    )
    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(sections.review.map((thread) => thread.chatId)).toEqual(["unread"])
    expect(sections.inProgress.map((thread) => thread.chatId)).toEqual(["running"])
    expect(sections.buckets).toHaveLength(1)
    expect(sections.buckets[0].threads.map((thread) => thread.chatId)).toEqual(["idle"])
    expect(sections.archived.map((thread) => thread.chatId)).toEqual(["archived-new", "archived-old"])
  })
})

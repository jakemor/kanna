import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../shared/types"
import {
  computeSidebarThreadSections,
  computeThreadDateBuckets,
  computeThreadSections,
  flattenSidebarThreads,
  getArchivedThreads,
  getInProgressThreads,
  getRecentThreads,
  getRelevantThreads,
  getReviewThreads,
  mergeRelevantThreads,
  RECENT_THREADS_LIMIT,
  stabilizeSidebarThreads,
} from "./thread-sections"
import { stabilizeSidebarData } from "../app/sidebarStability"

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
  test("selects waiting_for_user / unread chats (sidebar dot), oldest first", () => {
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
    // Oldest first: waiting (300) before unread (600); idle, running, and archived excluded.
    expect(review.map((thread) => thread.chatId)).toEqual(["waiting", "unread"])
  })

  test("activity time is the later of send-time and turn-end-time (oldest first here)", () => {
    const data = makeData([
      // Sent long ago but the turn only just came back → fresh (900), sorts last.
      makeChatRow({ chatId: "sent-early-finished-late", title: "A", unread: true, lastMessageAt: 100, lastTurnEndedAt: 900 }),
      // Sent recently, older turn end → send-time wins (800).
      makeChatRow({ chatId: "sent-late-finished-early", title: "B", unread: true, lastMessageAt: 800, lastTurnEndedAt: 400 }),
      // No completed turn yet → falls back to send-time activity (600).
      makeChatRow({ chatId: "no-turn-end", title: "C", unread: true, lastMessageAt: 600 }),
    ])
    const review = getReviewThreads(flattenSidebarThreads(data))
    expect(review.map((thread) => thread.chatId)).toEqual([
      "no-turn-end",              // 600
      "sent-late-finished-early", // 800
      "sent-early-finished-late", // 900
    ])
  })
})

describe("flattenSidebarThreads", () => {
  test("lastActivityAt = max(lastMessageAt, lastAgentMessageAt, lastTurnEndedAt), else creation time", () => {
    const data = makeData([
      makeChatRow({ chatId: "finished-after-send", title: "A", lastMessageAt: 100, lastTurnEndedAt: 900 }),
      makeChatRow({ chatId: "sent-after-finish", title: "B", lastMessageAt: 800, lastTurnEndedAt: 400 }),
      makeChatRow({ chatId: "send-only", title: "C", lastMessageAt: 600 }),
      makeChatRow({ chatId: "empty", title: "D", _creationTime: 50 }),
      // Parked mid-turn (plan mode / permission prompt): no turn has ended, so
      // only the agent's own last entry says how fresh this chat really is.
      makeChatRow({ chatId: "waiting-mid-turn", title: "E", lastMessageAt: 100, lastAgentMessageAt: 950 }),
    ])
    const byId = new Map(flattenSidebarThreads(data).map((thread) => [thread.chatId, thread.lastActivityAt]))
    expect(byId.get("finished-after-send")).toBe(900)
    expect(byId.get("sent-after-finish")).toBe(800)
    expect(byId.get("send-only")).toBe(600)
    expect(byId.get("empty")).toBe(50)
    expect(byId.get("waiting-mid-turn")).toBe(950)
  })
})

describe("getInProgressThreads", () => {
  test("selects running/starting chats, oldest first, excluding archived", () => {
    const data = makeData(
      [
        makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 300 }),
        makeChatRow({ chatId: "starting", title: "Starting", status: "starting", lastMessageAt: 600 }),
        makeChatRow({ chatId: "idle", title: "Idle", lastMessageAt: 900 }),
      ],
      [makeChatRow({ chatId: "archived-running", title: "Archived", status: "running", lastMessageAt: 990 })],
    )
    const inProgress = getInProgressThreads(flattenSidebarThreads(data))
    // Oldest first: running (300) before starting (600).
    expect(inProgress.map((thread) => thread.chatId)).toEqual(["running", "starting"])
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
  test("a running unread chat lands in progress, not review", () => {
    const data = makeData([
      makeChatRow({ chatId: "running-unread", title: "Both", status: "running", unread: true, lastMessageAt: 300 }),
      makeChatRow({ chatId: "running", title: "Running", status: "running", lastMessageAt: 600 }),
    ])
    const sections = computeThreadSections(flattenSidebarThreads(data))
    expect(sections.review).toHaveLength(0)
    // Oldest first; running/starting always win the In Progress section.
    expect(sections.inProgress.map((thread) => thread.chatId)).toEqual(["running-unread", "running"])
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
  test("three most recent activity days lead, then This Week, Last Week, Last 30 Days", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "today", title: "t", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "yesterday", title: "y", lastMessageAt: at(2026, 7, 14) }),
      makeChatRow({ chatId: "monday", title: "m", lastMessageAt: at(2026, 7, 13) }),
      makeChatRow({ chatId: "this-week", title: "tw", lastMessageAt: at(2026, 7, 13, 8) }),
      makeChatRow({ chatId: "last-week", title: "lw", lastMessageAt: at(2026, 7, 8) }),
      makeChatRow({ chatId: "older", title: "o", lastMessageAt: at(2026, 6, 20) }),
    ])
    // Only the leading bucket starts expanded — everything under it is folded.
    expect(buckets.map((bucket) => [bucket.label, bucket.defaultExpanded])).toEqual([
      ["Today", true],
      ["Yesterday", false],
      ["Monday", false],
      ["Last Week", false],
      ["Last 30 Days", false],
    ])
    // Both Monday chats land in the Monday day section — the day sections took
    // the 3 newest days, so nothing this week is left over for "This Week".
    expect(buckets[2].threads.map((thread) => thread.chatId)).toEqual(["monday", "this-week"])
  })

  test("a fourth distinct day falls through to This Week", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "today", title: "t", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "yesterday", title: "y", lastMessageAt: at(2026, 7, 14) }),
      makeChatRow({ chatId: "monday", title: "m", lastMessageAt: at(2026, 7, 13) }),
      makeChatRow({ chatId: "sunday", title: "s", lastMessageAt: at(2026, 7, 12) }),
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Today", "Yesterday", "Monday", "Last Week"])
    expect(buckets[3].threads.map((thread) => thread.chatId)).toEqual(["sunday"])
  })

  test("walks timestamps: a gap yields Today and Last <weekday>", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "today", title: "t", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "friday", title: "f", lastMessageAt: at(2026, 7, 10) }), // Fri, 5 days back
    ])
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Today", "Last Friday"])
  })

  test("weekday labels follow the same week boundary as the This Week / Last Week buckets", () => {
    // Sunday Jul 26 2026 — the last day of its own week (weeks start Monday),
    // which is where a rolling 6-day window used to go wrong: it called this
    // week's Friday "Last Friday" while this week's Monday sat in "This Week".
    const sunday = new Date(2026, 6, 26, 12).getTime()
    const buckets = computeThreadDateBuckets(
      flattenSidebarThreads(makeData([
        makeChatRow({ chatId: "today", title: "a", lastMessageAt: at(2026, 7, 26) }), // Sun (today)
        makeChatRow({ chatId: "fri", title: "b", lastMessageAt: at(2026, 7, 24) }), // Fri, this week
        makeChatRow({ chatId: "thu", title: "c", lastMessageAt: at(2026, 7, 23) }), // Thu, this week
        makeChatRow({ chatId: "mon", title: "d", lastMessageAt: at(2026, 7, 20) }), // Mon, this week
        makeChatRow({ chatId: "prev-fri", title: "e", lastMessageAt: at(2026, 7, 17) }), // Fri, last week
      ])),
      sunday,
    )
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      "Today",
      "Friday", // same week as today → bare weekday, matching "This Week" below
      "Thursday",
      "This Week", // Monday's leftovers, named for the same week as Friday/Thursday
      "Last Week",
    ])
    expect(buckets[3].threads.map((thread) => thread.chatId)).toEqual(["mon"])
    expect(buckets[4].threads.map((thread) => thread.chatId)).toEqual(["prev-fri"])
  })

  test("a day in the previous week keeps the Last <weekday> prefix", () => {
    // Monday Jul 20 2026: this week starts today, so every other day is last week.
    const monday = new Date(2026, 6, 20, 12).getTime()
    const buckets = computeThreadDateBuckets(
      flattenSidebarThreads(makeData([
        makeChatRow({ chatId: "today", title: "a", lastMessageAt: at(2026, 7, 20) }),
        makeChatRow({ chatId: "sun", title: "b", lastMessageAt: at(2026, 7, 19) }), // yesterday, but last week
        makeChatRow({ chatId: "fri", title: "c", lastMessageAt: at(2026, 7, 17) }),
      ])),
      monday,
    )
    // "Yesterday" still wins over the week rule — it's unambiguous either way.
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Today", "Yesterday", "Last Friday"])
  })

  test("after idle weeks the day sections carry full dates, with the rest in Last 30 Days", () => {
    const buckets = bucketThreads([
      makeChatRow({ chatId: "mon", title: "a", lastMessageAt: at(2026, 6, 29) }), // Monday
      makeChatRow({ chatId: "fri", title: "b", lastMessageAt: at(2026, 6, 26) }), // Friday
      makeChatRow({ chatId: "thu", title: "c", lastMessageAt: at(2026, 6, 25) }), // Thursday
      makeChatRow({ chatId: "older", title: "d", lastMessageAt: at(2026, 6, 20) }),
    ])
    // The leading bucket starts expanded even when it isn't Today — it's the
    // most recent activity there is, so it's what you came back to.
    expect(buckets.map((bucket) => [bucket.label, bucket.defaultExpanded])).toEqual([
      ["Monday Jun 29th", true],
      ["Friday Jun 26th", false],
      ["Thursday Jun 25th", false],
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

describe("getRelevantThreads", () => {
  test("keeps only flagged chats, newest first like the date buckets", () => {
    const data = makeData([
      makeChatRow({ chatId: "newer", title: "n", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "older", title: "o", uncommittedWork: true, lastMessageAt: at(2026, 7, 10) }),
      makeChatRow({ chatId: "clean", title: "c", lastMessageAt: at(2026, 7, 14) }),
    ])

    // Newest leads: this is the diff you're in the middle of, so the chat you
    // just touched is the one you want back. (Review / In Progress stay
    // oldest-first — they're queues you drain.)
    expect(getRelevantThreads(flattenSidebarThreads(data)).map((t) => t.chatId)).toEqual(["newer", "older"])
  })

  test("never surfaces archived chats, even when flagged", () => {
    const data = makeData(
      [],
      [makeChatRow({ chatId: "archived", title: "a", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) })],
    )

    expect(getRelevantThreads(flattenSidebarThreads(data))).toEqual([])
  })

  test("skips empty new chats", () => {
    const data = makeData([makeChatRow({ chatId: "draft", title: "d", uncommittedWork: true })])

    expect(getRelevantThreads(flattenSidebarThreads(data))).toEqual([])
  })

  test("honours the exclude set", () => {
    const data = makeData([
      makeChatRow({ chatId: "a", title: "a", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "b", title: "b", uncommittedWork: true, lastMessageAt: at(2026, 7, 14) }),
    ])

    const kept = getRelevantThreads(flattenSidebarThreads(data), new Set(["a"]))
    expect(kept.map((t) => t.chatId)).toEqual(["b"])
  })

  test("a chat holding an unsent draft always qualifies", () => {
    // Nothing else about this chat is remarkable — clean tree, old message.
    const data = makeData([
      makeChatRow({ chatId: "drafting", title: "d", lastMessageAt: at(2026, 6, 1) }),
    ])

    const kept = getRelevantThreads(flattenSidebarThreads(data), undefined, new Map([["drafting", at(2026, 7, 20)]]))
    expect(kept.map((t) => t.chatId)).toEqual(["drafting"])
  })

  test("a draft outranks the empty-new-chat rule", () => {
    // Opened, typed into, never sent — the one chat that must not vanish, and
    // the only place that sentence exists.
    const data = makeData([makeChatRow({ chatId: "unsent", title: "u" })])

    const kept = getRelevantThreads(flattenSidebarThreads(data), undefined, new Map([["unsent", at(2026, 7, 20)]]))
    expect(kept.map((t) => t.chatId)).toEqual(["unsent"])
  })

  test("a draft on an archived chat stays archived", () => {
    const data = makeData([], [makeChatRow({ chatId: "old", title: "o", lastMessageAt: at(2026, 7, 15) })])

    expect(getRelevantThreads(flattenSidebarThreads(data), undefined, new Map([["old", at(2026, 7, 20)]]))).toEqual([])
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

  test("archived sorts by when it was archived, not by activity", () => {
    const data = makeData([], [
      // Dormant for a month, archived a moment ago: it leads, because this list
      // answers "what did I just put away".
      makeChatRow({
        chatId: "just-archived",
        title: "x",
        lastMessageAt: at(2026, 7, 1),
        archivedAt: at(2026, 7, 20),
      }),
      makeChatRow({
        chatId: "archived-earlier",
        title: "y",
        lastMessageAt: at(2026, 7, 15),
        archivedAt: at(2026, 7, 16),
      }),
      // Pre-dates `archivedAt`: falls back to its activity, so it sorts last.
      makeChatRow({ chatId: "legacy", title: "z", lastMessageAt: at(2026, 7, 10) }),
    ])

    const archived = getArchivedThreads(flattenSidebarThreads(data))
    expect(archived.map((thread) => thread.chatId)).toEqual([
      "just-archived",
      "archived-earlier",
      "legacy",
    ])
  })

  test("Relevant drains flagged chats out of the date buckets", () => {
    const data = makeData([
      makeChatRow({ chatId: "dirty-old", title: "a", uncommittedWork: true, lastMessageAt: at(2026, 7, 10) }),
      makeChatRow({ chatId: "dirty-new", title: "b", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "clean", title: "c", lastMessageAt: at(2026, 7, 15) }),
    ])

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(sections.relevant.map((t) => t.chatId)).toEqual(["dirty-new", "dirty-old"])
    const bucketed = sections.buckets.flatMap((bucket) => bucket.threads.map((t) => t.chatId))
    expect(bucketed).toEqual(["clean"])
  })

  test("Review and In Progress outrank Relevant", () => {
    // Asking for something now beats touching the current diff, so a flagged
    // chat that is also unread or running stays where it was.
    const data = makeData([
      makeChatRow({ chatId: "unread", title: "u", unread: true, uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "running", title: "r", status: "running", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "idle-dirty", title: "d", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
    ])

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(sections.review.map((t) => t.chatId)).toEqual(["unread"])
    expect(sections.inProgress.map((t) => t.chatId)).toEqual(["running"])
    expect(sections.relevant.map((t) => t.chatId)).toEqual(["idle-dirty"])
  })

  test("a drafting chat sorts by when the draft appeared, not when the chat last moved", () => {
    // The chat itself is the stalest here; the sentence in it is the freshest.
    const data = makeData([
      makeChatRow({ chatId: "stale-chat", title: "s", lastMessageAt: at(2026, 6, 1) }),
      makeChatRow({ chatId: "dirty-fresh", title: "f", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
    ])

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      new Map([["stale-chat", at(2026, 7, 16)]]),
    )

    expect(sections.relevant.map((t) => t.chatId)).toEqual(["stale-chat", "dirty-fresh"])
  })

  test("a draft with no recorded start time falls back to chat activity", () => {
    // Drafts written before the timestamp existed keep their place rather than
    // sinking to the bottom.
    const data = makeData([
      makeChatRow({ chatId: "old-draft", title: "o", lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "dirty", title: "d", uncommittedWork: true, lastMessageAt: at(2026, 7, 10) }),
    ])

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      new Map([["old-draft", 0]]),
    )

    expect(sections.relevant.map((t) => t.chatId)).toEqual(["old-draft", "dirty"])
  })

  test("a draft pulls its chat out of the date buckets and into Relevant", () => {
    const data = makeData([
      makeChatRow({ chatId: "drafting", title: "d", lastMessageAt: at(2026, 7, 10) }),
      makeChatRow({ chatId: "quiet", title: "q", lastMessageAt: at(2026, 7, 10) }),
    ])

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      new Map([["drafting", at(2026, 7, 20)]]),
    )

    expect(sections.relevant.map((t) => t.chatId)).toEqual(["drafting"])
    expect(sections.buckets.flatMap((bucket) => bucket.threads.map((t) => t.chatId))).toEqual(["quiet"])
  })

  test("archived flagged chats stay in Archived", () => {
    const data = makeData(
      [],
      [makeChatRow({ chatId: "archived", title: "a", uncommittedWork: true, lastMessageAt: at(2026, 7, 15) })],
    )

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(sections.relevant).toEqual([])
    expect(sections.archived.map((t) => t.chatId)).toEqual(["archived"])
  })
})

describe("mergeRelevantThreads", () => {
  test("merges Review into Relevant, newest first", () => {
    // Review's own order is oldest-first; merged it takes Relevant's ordering,
    // so the two sets interleave by activity rather than stacking.
    const data = makeData([
      makeChatRow({ chatId: "unread-old", title: "a", unread: true, lastMessageAt: at(2026, 7, 9) }),
      makeChatRow({ chatId: "dirty-mid", title: "b", uncommittedWork: true, lastMessageAt: at(2026, 7, 12) }),
      makeChatRow({ chatId: "unread-new", title: "c", unread: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "clean", title: "d", lastMessageAt: at(2026, 7, 14) }),
    ])

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(mergeRelevantThreads(sections).map((t) => t.chatId))
      .toEqual(["unread-new", "dirty-mid", "unread-old"])
    // In Progress and the date buckets are untouched by the merge.
    const bucketed = sections.buckets.flatMap((bucket) => bucket.threads.map((t) => t.chatId))
    expect(bucketed).toEqual(["clean"])
  })

  test("a chat parked in plan mode leads on when its plan landed, not when it was sent", () => {
    const data = makeData([
      makeChatRow({ chatId: "dirty", title: "a", uncommittedWork: true, lastMessageAt: at(2026, 7, 15, 9) }),
      // Sent yesterday, plan came back just now and is waiting on the user. No
      // turn ended, so lastTurnEndedAt is unset — only lastAgentMessageAt moved.
      makeChatRow({
        chatId: "planning",
        title: "b",
        status: "waiting_for_user",
        lastMessageAt: at(2026, 7, 14),
        lastAgentMessageAt: at(2026, 7, 15, 11),
      }),
    ])

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(mergeRelevantThreads(sections).map((t) => t.chatId)).toEqual(["planning", "dirty"])
  })

  test("a chat that is both unread and flagged appears once", () => {
    const data = makeData([
      makeChatRow({ chatId: "both", title: "a", unread: true, uncommittedWork: true, lastMessageAt: at(2026, 7, 15) }),
    ])

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(mergeRelevantThreads(sections).map((t) => t.chatId)).toEqual(["both"])
  })

  test("the merge sorts on the same key the section did — drafts included", () => {
    // Otherwise a chat you just typed in would lead its section and then be
    // re-sorted back down by activity the moment Review was folded in.
    const data = makeData([
      makeChatRow({ chatId: "unread-new", title: "a", unread: true, lastMessageAt: at(2026, 7, 15) }),
      makeChatRow({ chatId: "drafting", title: "b", lastMessageAt: at(2026, 6, 1) }),
    ])
    const draftStartTimes = new Map([["drafting", at(2026, 7, 16)]])

    const sections = computeSidebarThreadSections(flattenSidebarThreads(data), NOW, draftStartTimes)
    expect(mergeRelevantThreads(sections, draftStartTimes).map((t) => t.chatId))
      .toEqual(["drafting", "unread-new"])
  })
})

describe("pending sends", () => {
  // The gap this closes: the composer clears its draft the instant you press
  // send, but the server has not yet recorded the message or moved the status
  // off idle. Without the pending entry the chat qualifies for no section at
  // all, so the row blinks out and comes back.
  const SENT_AT = at(2026, 7, 15, 11)

  test("a just-sent empty chat holds its place in In Progress", () => {
    const data = makeData([
      makeChatRow({ chatId: "just-sent", title: "new" }), // no lastMessageAt yet
      makeChatRow({ chatId: "other", title: "o", lastMessageAt: at(2026, 7, 15) }),
    ])

    const withoutPending = computeSidebarThreadSections(flattenSidebarThreads(data), NOW)
    expect(withoutPending.inProgress).toHaveLength(0)
    // Reproduces the bug: the chat is in nothing at all.
    expect(withoutPending.buckets.flatMap((bucket) => bucket.threads).map((t) => t.chatId))
      .not.toContain("just-sent")

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      undefined,
      new Map([["just-sent", SENT_AT]]),
    )
    expect(sections.inProgress.map((thread) => thread.chatId)).toEqual(["just-sent"])
  })

  test("a pending send outranks the unread badge it just answered", () => {
    const data = makeData([
      makeChatRow({ chatId: "replied", title: "r", unread: true, lastMessageAt: at(2026, 7, 15, 9) }),
    ])

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      undefined,
      new Map([["replied", SENT_AT]]),
    )

    expect(sections.review).toHaveLength(0)
    expect(sections.inProgress.map((thread) => thread.chatId)).toEqual(["replied"])
  })

  test("the entry goes inert once the snapshot catches up", () => {
    const data = makeData([
      makeChatRow({ chatId: "landed", title: "l", lastMessageAt: SENT_AT + 1 }),
    ])

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      undefined,
      new Map([["landed", SENT_AT]]),
    )

    // Idle again with the message recorded, so it belongs to a date bucket —
    // a stale pending entry must not pin it in In Progress.
    expect(sections.inProgress).toHaveLength(0)
    expect(sections.buckets.flatMap((bucket) => bucket.threads).map((t) => t.chatId))
      .toEqual(["landed"])
  })

  test("a pending send sorts by when it was sent, so it lands where it will stay", () => {
    const data = makeData([
      makeChatRow({ chatId: "old-running", title: "a", status: "running", lastMessageAt: at(2026, 7, 15, 8) }),
      // Created long ago, so a fallback to _creationTime would sort it first.
      makeChatRow({ chatId: "just-sent", title: "b", lastMessageAt: at(2026, 7, 10) }),
    ])

    const sections = computeSidebarThreadSections(
      flattenSidebarThreads(data),
      NOW,
      undefined,
      new Map([["just-sent", SENT_AT]]),
    )

    // In Progress is oldest-first, so the newest send trails — the slot it keeps
    // once the server stamps the same moment onto lastMessageAt.
    expect(sections.inProgress.map((thread) => thread.chatId)).toEqual(["old-running", "just-sent"])
  })
})


describe("stabilizeSidebarThreads", () => {
  // Exercised through `stabilizeSidebarData`, because that is what feeds it:
  // the row and group identities it compares are the ones that pass establishes.
  function flattenStabilized(previous: SidebarData | null, next: SidebarData) {
    return flattenSidebarThreads(stabilizeSidebarData(previous, next))
  }

  test("returns the previous list when every thread is unchanged", () => {
    const held = makeSidebarData()
    const first = flattenStabilized(null, held)

    const second = flattenStabilized(held, makeSidebarData())

    expect(stabilizeSidebarThreads(first, second)).toBe(first)
  })

  test("keeps every thread whose row did not move", () => {
    const held = makeSidebarData()
    const first = flattenStabilized(null, held)

    const moved = makeSidebarData()
    moved.projectGroups[0]!.chats[0] = {
      ...moved.projectGroups[0]!.chats[0]!,
      turnCount: 99,
    }
    const result = stabilizeSidebarThreads(first, flattenStabilized(held, moved))

    expect(result).not.toBe(first)
    const changed = result.find((thread) => thread.chatId === "chat-1")!
    expect(changed.row.turnCount).toBe(99)
    for (const thread of result) {
      if (thread.chatId === "chat-1") continue
      expect(thread).toBe(first.find((item) => item.chatId === thread.chatId)!)
    }
  })

  test("matches by chat id, so an insert does not orphan the rows below it", () => {
    const held = makeSidebarData()
    const first = flattenStabilized(null, held)

    const withNewChat = makeSidebarData()
    withNewChat.projectGroups[0]!.chats = [
      makeChatRow({ chatId: "chat-new", title: "Just started", lastMessageAt: 1_500 }),
      ...withNewChat.projectGroups[0]!.chats,
    ]
    const result = stabilizeSidebarThreads(first, flattenStabilized(held, withNewChat))

    expect(result[0]!.chatId).toBe("chat-new")
    // The project group was rebuilt around the insert, but the chat below it is
    // still the object its row already rendered.
    expect(result.find((thread) => thread.chatId === "chat-2"))
      .toBe(first.find((thread) => thread.chatId === "chat-2")!)
  })

  test("passes the first list through", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    expect(stabilizeSidebarThreads([], threads)).toBe(threads)
  })
})

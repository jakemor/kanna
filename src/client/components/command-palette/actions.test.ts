import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../../shared/types"
import {
  flattenVisibleProjectGroups,
  flattenSidebarThreads,
  getSettingsPaletteEntries,
  scorePaletteItem,
  searchProjects,
  searchSettingsEntries,
  searchThreadsByTitle,
} from "./actions"

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

// flattenSidebarThreads / getReviewThreads / getInProgressThreads /
// getRecentThreads / computeThreadSections are covered in
// lib/thread-sections.test.ts — actions.ts only re-exports them.

describe("searchThreadsByTitle", () => {
  test("returns empty for an empty query", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    expect(searchThreadsByTitle(threads, "  ")).toEqual([])
  })

  test("matches titles fuzzily and includes archived threads", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    const results = searchThreadsByTitle(threads, "palette")
    expect(results.map((thread) => thread.chatId)).toContain("chat-2")
    expect(results.map((thread) => thread.chatId)).toContain("chat-3")
  })

  test("matches on project title as an alias", () => {
    const threads = flattenSidebarThreads(makeSidebarData())
    const results = searchThreadsByTitle(threads, "superwall")
    expect(results.map((thread) => thread.chatId)).toContain("chat-4")
  })

  test("breaks score ties by recency", () => {
    const threads = flattenSidebarThreads({
      projectGroups: [
        {
          groupKey: "p",
          title: "P",
          realTitle: "P",
          localPath: "/tmp/p",
          chats: [
            makeChatRow({ chatId: "older", title: "Same title", lastMessageAt: 10 }),
            makeChatRow({ chatId: "newer", title: "Same title", lastMessageAt: 20 }),
          ],
          previewChats: [],
          olderChats: [],
          defaultCollapsed: false,
        },
      ],
    })
    const results = searchThreadsByTitle(threads, "same title")
    expect(results.map((thread) => thread.chatId)).toEqual(["newer", "older"])
  })
})

describe("flattenVisibleProjectGroups", () => {
  test("sidebar projects point at their most recent chat", () => {
    const projects = flattenVisibleProjectGroups(makeSidebarData().projectGroups)
    const kanna = projects.find((project) => project.projectId === "project-a")
    expect(kanna?.mostRecentChatId).toBe("chat-2")
    expect(kanna?.title).toBe("Kanna")
  })

  test("excludes projects with no unarchived chats (archived-only or empty)", () => {
    const data = makeSidebarData()
    data.projectGroups[0].chats = []
    const projects = flattenVisibleProjectGroups(data.projectGroups)
    // project-a has only archived chats now → dropped entirely, mirroring the sidebar.
    expect(projects.map((project) => project.projectId)).toEqual(["project-b"])
  })

  test("sorts by most recent chat activity, descending", () => {
    // project-a's newest chat is at 900, project-b's at 600.
    const projects = flattenVisibleProjectGroups(makeSidebarData().projectGroups)
    expect(projects.map((project) => project.projectId)).toEqual(["project-a", "project-b"])
  })
})

describe("searchProjects", () => {
  test("matches by title and path, empty query returns nothing", () => {
    const projects = flattenVisibleProjectGroups(makeSidebarData().projectGroups)
    expect(searchProjects(projects, "")).toEqual([])
    expect(searchProjects(projects, "kanna").map((project) => project.projectId)).toEqual(["project-a"])
    expect(searchProjects(projects, "superwall").map((project) => project.projectId)).toEqual(["project-b"])
  })
})

describe("scorePaletteItem", () => {
  test("matches on keywords when the title misses", () => {
    expect(scorePaletteItem("home", "Go to Projects", ["home", "navigate"])).toBeGreaterThan(0)
    expect(scorePaletteItem("zzzz", "Go to Projects", ["home"])).toBe(0)
  })

  test("empty query matches everything", () => {
    expect(scorePaletteItem("", "Anything")).toBe(1)
  })
})

describe("getSettingsPaletteEntries", () => {
  test("includes every section and registry row", () => {
    const entries = getSettingsPaletteEntries()
    const ids = entries.map((entry) => entry.id)

    // Sections
    expect(ids).toContain("settings-section-general")
    expect(ids).toContain("settings-section-changelog")

    // Registry rows carry anchored paths
    const theme = entries.find((entry) => entry.id === "settings-row-theme")
    expect(theme?.path).toBe("/settings/general#theme")
    expect(theme?.sectionLabel).toBe("Settings › General")

    // Individual keybinding rows are intentionally excluded from the palette
    expect(ids.some((id) => id.startsWith("settings-row-keybinding-"))).toBe(false)
  })

  test("rows are searchable by description keywords", () => {
    const entries = getSettingsPaletteEntries()
    const results = searchSettingsEntries(entries, "dark mode")
    expect(results.map((entry) => entry.id)).toContain("settings-row-theme")
  })
})

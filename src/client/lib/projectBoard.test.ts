import { describe, expect, test } from "bun:test"
import type { KannaStatus, SidebarChatRow, SidebarData } from "../../shared/types"
import { getProjectBoardColumns, getProjectBoardDiffTotals } from "./projectBoard"

const DAY_MS = 24 * 60 * 60 * 1_000
const nowMs = 40 * DAY_MS

function createChat(
  chatId: string,
  options: {
    ageDays?: number
    status?: KannaStatus
    unread?: boolean
    done?: boolean
  } = {}
): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: nowMs - (options.ageDays ?? 0) * DAY_MS,
    chatId,
    title: chatId,
    status: options.status ?? "idle",
    unread: options.unread ?? false,
    ...(options.done ? { done: true } : {}),
    localPath: "/tmp/project",
    provider: "codex",
    lastMessageAt: nowMs - (options.ageDays ?? 0) * DAY_MS,
    hasAutomation: false,
  }
}

function createSidebarData({
  chats,
  previewChats,
  olderChats,
  archivedChats = [],
}: {
  chats: SidebarChatRow[]
  previewChats: SidebarChatRow[]
  olderChats: SidebarChatRow[]
  archivedChats?: SidebarChatRow[]
}): SidebarData {
  return {
    projectGroups: [{
      groupKey: "project-1",
      title: "Kanna",
      realTitle: "Kanna",
      localPath: "/tmp/project",
      chats,
      previewChats,
      olderChats,
      archivedChats,
      defaultCollapsed: false,
    }],
  }
}

describe("getProjectBoardColumns", () => {
  test("maps runtime, unread, sidebar cutoff, and archived state into board columns", () => {
    const running = createChat("running", { ageDays: 2, status: "running" })
    const starting = createChat("starting", { ageDays: 2, status: "starting" })
    const waitingForUser = createChat("waiting-for-user", { ageDays: 2, status: "waiting_for_user" })
    const preview = createChat("preview", { ageDays: 1 })
    const oldUnread = createChat("old-unread", { ageDays: 20, unread: true })
    const older = createChat("older", { ageDays: 20 })
    const archived = createChat("archived", { ageDays: 3 })
    const data = createSidebarData({
      chats: [running, starting, waitingForUser, preview, oldUnread, older],
      previewChats: [running, starting, waitingForUser, preview],
      olderChats: [oldUnread, older],
      archivedChats: [archived],
    })

    const columns = getProjectBoardColumns(data, nowMs)

    expect(columns.running.map((entry) => entry.chat.chatId)).toEqual(["running", "starting"])
    expect(columns.waiting.map((entry) => entry.chat.chatId)).toEqual([
      "preview",
      "waiting-for-user",
      "old-unread",
    ])
    expect(columns.done.map((entry) => entry.chat.chatId)).toEqual(["archived", "older"])
    expect(columns.done[0]?.archived).toBe(true)
  })

  test("done chats stay in done even when recent, unread, or in the sidebar preview", () => {
    const doneUnread = createChat("done-unread", { ageDays: 1, unread: true, done: true })
    const doneWaiting = createChat("done-waiting", { ageDays: 1, status: "waiting_for_user", done: true })
    const data = createSidebarData({
      chats: [doneUnread, doneWaiting],
      previewChats: [doneUnread, doneWaiting],
      olderChats: [],
    })

    const columns = getProjectBoardColumns(data, nowMs)

    expect(columns.running).toEqual([])
    expect(columns.waiting).toEqual([])
    expect(columns.done.map((entry) => entry.chat.chatId)).toEqual(["done-unread", "done-waiting"])
  })

  test("only includes conversations with activity in the last 30 days", () => {
    const recent = createChat("recent", { ageDays: 29 })
    const cutoff = createChat("cutoff", { ageDays: 30, unread: true })
    const data = createSidebarData({
      chats: [recent, cutoff],
      previewChats: [],
      olderChats: [recent, cutoff],
    })

    const columns = getProjectBoardColumns(data, nowMs)

    expect(columns.done.map((entry) => entry.chat.chatId)).toEqual(["recent"])
    expect(columns.waiting).toEqual([])
  })
})

test("getProjectBoardDiffTotals sums additions and deletions across files", () => {
  expect(getProjectBoardDiffTotals([
    { additions: 12, deletions: 3 },
    { additions: 4, deletions: 8 },
  ])).toEqual({ additions: 16, deletions: 11 })
})

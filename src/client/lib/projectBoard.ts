import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getSidebarChatTimestamp } from "./sidebarChats"

const PROJECT_BOARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

export type ProjectBoardColumnId = "running" | "waiting" | "done"

export function isProjectBoardColumnId(value: unknown): value is ProjectBoardColumnId {
  return value === "running" || value === "waiting" || value === "done"
}

export interface ProjectBoardChat {
  chat: SidebarChatRow
  projectId: string
  projectTitle: string
  archived: boolean
  columnId: ProjectBoardColumnId
  timestamp: number
}

export type ProjectBoardColumns = Record<ProjectBoardColumnId, ProjectBoardChat[]>

function getActiveChatColumn(
  chat: SidebarChatRow,
  previewChatIds: Set<string>
): ProjectBoardColumnId {
  // Explicitly marked done wins over everything else, so reading a done chat
  // (which only clears unread) never pulls it back into Review.
  if (chat.done) {
    return "done"
  }

  if (chat.status === "starting" || chat.status === "running") {
    return "running"
  }

  if (chat.status === "waiting_for_user" || chat.unread || previewChatIds.has(chat.chatId)) {
    return "waiting"
  }

  return "done"
}

function isWithinProjectBoardWindow(timestamp: number, nowMs: number) {
  return Math.max(0, nowMs - timestamp) < PROJECT_BOARD_WINDOW_MS
}

export function getProjectBoardColumns(
  data: SidebarData,
  nowMs: number = Date.now()
): ProjectBoardColumns {
  const columns: ProjectBoardColumns = {
    running: [],
    waiting: [],
    done: [],
  }

  for (const project of data.projectGroups) {
    const previewChatIds = new Set(project.previewChats.map((chat) => chat.chatId))

    for (const chat of project.chats) {
      const timestamp = getSidebarChatTimestamp(chat)
      if (!isWithinProjectBoardWindow(timestamp, nowMs)) continue

      const columnId = getActiveChatColumn(chat, previewChatIds)
      columns[columnId].push({
        chat,
        projectId: project.groupKey,
        projectTitle: project.title,
        archived: false,
        columnId,
        timestamp,
      })
    }

    for (const chat of project.archivedChats ?? []) {
      const timestamp = getSidebarChatTimestamp(chat)
      if (!isWithinProjectBoardWindow(timestamp, nowMs)) continue

      columns.done.push({
        chat,
        projectId: project.groupKey,
        projectTitle: project.title,
        archived: true,
        columnId: "done",
        timestamp,
      })
    }
  }

  for (const column of Object.values(columns)) {
    column.sort((left, right) => right.timestamp - left.timestamp)
  }

  return columns
}

export function getProjectBoardDiffTotals(files: Array<{ additions: number; deletions: number }>) {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 }
  )
}

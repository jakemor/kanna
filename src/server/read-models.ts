import process from "node:process"
import type {
  ChatRuntime,
  ChatSnapshot,
  KannaStatus,
  LocalProjectsSnapshot,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
} from "../shared/types"
import type { ChatRecord, StoreState, TaskRecord } from "./events"
import { resolveLocalPath } from "./paths"
import { SERVER_PROVIDERS } from "./provider-catalog"

const SIDEBAR_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000
const SIDEBAR_FALLBACK_PREVIEW_LIMIT = 5

export function deriveStatus(chat: ChatRecord, activeStatus?: KannaStatus): KannaStatus {
  if (activeStatus) return activeStatus
  if (chat.lastTurnOutcome === "failed") return "failed"
  return "idle"
}

function getSidebarChatSortTimestamp(chat: ChatRecord) {
  return chat.lastMessageAt ?? chat.createdAt
}

function canForkChat(
  chat: ChatRecord,
  activeStatuses: Map<string, KannaStatus>,
  drainingChatIds: Set<string>,
) {
  if (!chat.provider) return false
  if (!chat.sessionToken && !chat.pendingForkSessionToken) return false
  if (activeStatuses.has(chat.id)) return false
  if (drainingChatIds.has(chat.id)) return false
  return true
}

function getSidebarChatTimestamp(chat: Pick<SidebarChatRow, "lastMessageAt" | "_creationTime">) {
  return chat.lastMessageAt ?? chat._creationTime
}

function isSidebarChatRecent(chat: Pick<SidebarChatRow, "lastMessageAt" | "_creationTime">, nowMs: number) {
  return Math.max(0, nowMs - getSidebarChatTimestamp(chat)) < SIDEBAR_RECENT_WINDOW_MS
}

function getSidebarChatBuckets(chats: SidebarChatRow[], nowMs: number) {
  const recentChats = chats.filter((chat) => isSidebarChatRecent(chat, nowMs))
  const previewChats = recentChats.length > 0
    ? recentChats
    : chats.slice(0, Math.min(SIDEBAR_FALLBACK_PREVIEW_LIMIT, chats.length))
  const previewChatIds = new Set(previewChats.map((chat) => chat.chatId))

  return {
    previewChats,
    olderChats: chats.filter((chat) => !previewChatIds.has(chat.chatId)),
  }
}

export function deriveSidebarData(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  options?: {
    nowMs?: number
    sidebarProjectOrder?: string[]
    drainingChatIds?: Set<string>
    sessionGrouping?: "default" | "tasks"
  }
): SidebarData {
  const nowMs = options?.nowMs ?? Date.now()
  const drainingChatIds = options?.drainingChatIds ?? new Set<string>()
  const chatsByProjectId = new Map<string, ChatRecord[]>()
  const archivedChatsByProjectId = new Map<string, ChatRecord[]>()
  for (const chat of state.chatsById.values()) {
    if (chat.deletedAt) continue
    const targetMap = chat.archivedAt ? archivedChatsByProjectId : chatsByProjectId
    const projectChats = targetMap.get(chat.projectId)
    if (projectChats) {
      projectChats.push(chat)
      continue
    }
    targetMap.set(chat.projectId, [chat])
  }

  const allProjects = [...state.projectsById.values()]
    .filter((project) => !project.deletedAt)
  const unorderedProjects = allProjects
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const projectById = new Map(unorderedProjects.map((project) => [project.id, project]))
  const orderedProjects = (options?.sidebarProjectOrder ?? [])
    .map((projectId) => projectById.get(projectId))
    .filter((project): project is NonNullable<typeof project> => Boolean(project))
  const orderedProjectIds = new Set(orderedProjects.map((project) => project.id))
  const projects = [
    ...orderedProjects,
    ...unorderedProjects.filter((project) => !orderedProjectIds.has(project.id)),
  ]

  function toSidebarChatRows(projectChats: ChatRecord[]) {
    return projectChats
      .sort((a, b) => getSidebarChatSortTimestamp(b) - getSidebarChatSortTimestamp(a))
      .map((chat) => {
        const project = state.projectsById.get(chat.projectId)
        return {
          _id: chat.id,
          _creationTime: chat.createdAt,
          chatId: chat.id,
          title: chat.title,
          status: deriveStatus(chat, activeStatuses.get(chat.id)),
          unread: chat.unread,
          localPath: project?.localPath ?? "",
          provider: chat.provider,
          lastMessageAt: chat.lastMessageAt,
          hasAutomation: false,
          canFork: canForkChat(chat, activeStatuses, drainingChatIds) || undefined,
        }
      })
  }

  if (options?.sessionGrouping === "tasks") {
    const chatsByTaskId = new Map<string, ChatRecord[]>()
    const archivedChatsByTaskId = new Map<string, ChatRecord[]>()
    const unassignedChats: ChatRecord[] = []
    const unassignedArchivedChats: ChatRecord[] = []
    const activeTasks = [...state.tasksById.values()].filter((task) => !task.deletedAt)
    const activeTaskIds = new Set(activeTasks.map((task) => task.id))
    const activeProjectIds = new Set(allProjects.map((project) => project.id))

    for (const chat of state.chatsById.values()) {
      if (chat.deletedAt) continue
      if (!activeProjectIds.has(chat.projectId)) continue
      const taskId = chat.taskId && activeTaskIds.has(chat.taskId) ? chat.taskId : null
      if (!taskId) {
        ;(chat.archivedAt ? unassignedArchivedChats : unassignedChats).push(chat)
        continue
      }
      const targetMap = chat.archivedAt ? archivedChatsByTaskId : chatsByTaskId
      const taskChats = targetMap.get(taskId)
      if (taskChats) {
        taskChats.push(chat)
      } else {
        targetMap.set(taskId, [chat])
      }
    }

    const getTaskSortTimestamp = (task: TaskRecord) => {
      const taskChats = [
        ...(chatsByTaskId.get(task.id) ?? []),
        ...(archivedChatsByTaskId.get(task.id) ?? []),
      ]
      return Math.max(task.updatedAt, ...taskChats.map((chat) => chat.updatedAt))
    }

    const taskGroups = activeTasks
      .sort((a, b) => getTaskSortTimestamp(b) - getTaskSortTimestamp(a))
      .map((task): SidebarProjectGroup => {
        const chats = toSidebarChatRows(chatsByTaskId.get(task.id) ?? [])
        const archivedChats = toSidebarChatRows(archivedChatsByTaskId.get(task.id) ?? [])
        const { previewChats, olderChats } = getSidebarChatBuckets(chats, nowMs)

        return {
          groupKey: task.id,
          kind: "task",
          taskId: task.id,
          title: task.title,
          realTitle: task.title,
          localPath: task.localPath,
          chats,
          previewChats,
          olderChats,
          ...(archivedChats.length ? { archivedChats } : {}),
          defaultCollapsed: chats.length > 0 && chats.every((chat) => !isSidebarChatRecent(chat, nowMs)),
        }
      })

    const unassignedRows = toSidebarChatRows(unassignedChats)
    const unassignedArchivedRows = toSidebarChatRows(unassignedArchivedChats)
    const unassignedBuckets = getSidebarChatBuckets(unassignedRows, nowMs)
    const unassignedGroup: SidebarProjectGroup = {
      groupKey: "unassigned",
      kind: "unassigned",
      title: "Unassigned Sessions",
      realTitle: "Unassigned Sessions",
      localPath: "",
      chats: unassignedRows,
      previewChats: unassignedBuckets.previewChats,
      olderChats: unassignedBuckets.olderChats,
      ...(unassignedArchivedRows.length ? { archivedChats: unassignedArchivedRows } : {}),
      defaultCollapsed: unassignedRows.length > 0 && unassignedRows.every((chat) => !isSidebarChatRecent(chat, nowMs)),
    }

    return {
      projectGroups: [
        ...taskGroups,
        unassignedGroup,
      ],
    }
  }

  const projectGroups: SidebarProjectGroup[] = projects.map((project) => {
    const chats = toSidebarChatRows(chatsByProjectId.get(project.id) ?? [])
    const archivedChats = toSidebarChatRows(archivedChatsByProjectId.get(project.id) ?? [])
    const { previewChats, olderChats } = getSidebarChatBuckets(chats, nowMs)

    return {
      groupKey: project.id,
      title: project.sidebarTitle ?? project.title,
      realTitle: project.title,
      ...(project.sidebarTitle ? { sidebarTitle: project.sidebarTitle } : {}),
      localPath: project.localPath,
      chats,
      previewChats,
      olderChats,
      ...(archivedChats.length ? { archivedChats } : {}),
      defaultCollapsed: chats.every((chat) => !isSidebarChatRecent(chat, nowMs)),
    }
  })

  return { projectGroups }
}

export function deriveLocalProjectsSnapshot(
  state: StoreState,
  discoveredProjects: Array<{ localPath: string; title: string; modifiedAt: number }>,
  machineName: string
): LocalProjectsSnapshot {
  const projects = new Map<string, LocalProjectsSnapshot["projects"][number]>()

  for (const project of discoveredProjects) {
    const normalizedPath = resolveLocalPath(project.localPath)
    projects.set(normalizedPath, {
      localPath: normalizedPath,
      title: project.title,
      source: "discovered",
      lastOpenedAt: project.modifiedAt,
      chatCount: 0,
    })
  }

  for (const project of [...state.projectsById.values()].filter((entry) => !entry.deletedAt)) {
    const chats = [...state.chatsById.values()].filter((chat) => chat.projectId === project.id && !chat.deletedAt && !chat.archivedAt)
    const lastOpenedAt = chats.reduce(
      (latest, chat) => Math.max(latest, getSidebarChatSortTimestamp(chat)),
      project.updatedAt
    )

    projects.set(project.localPath, {
      localPath: project.localPath,
      title: project.title,
      source: "saved",
      lastOpenedAt,
      chatCount: chats.length,
    })
  }

  return {
    machine: {
      id: "local",
      displayName: machineName,
      platform: process.platform,
    },
    projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
    tasks: [...state.tasksById.values()]
      .filter((task) => !task.deletedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((task) => ({ ...task })),
  }
}

export function deriveChatSnapshot(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  drainingChatIds: Set<string>,
  chatId: string,
  getMessages: (chatId: string) => Pick<ChatSnapshot, "messages" | "history">
): ChatSnapshot | null {
  const chat = state.chatsById.get(chatId)
  if (!chat || chat.deletedAt) return null
  const project = state.projectsById.get(chat.projectId)
  if (!project || project.deletedAt) return null

  const runtime: ChatRuntime = {
    chatId: chat.id,
    projectId: project.id,
    localPath: project.localPath,
    title: chat.title,
    status: deriveStatus(chat, activeStatuses.get(chat.id)),
    isDraining: drainingChatIds.has(chat.id),
    provider: chat.provider,
    planMode: chat.planMode,
    sessionToken: chat.sessionToken,
  }

  const transcript = getMessages(chat.id)

  return {
    runtime,
    queuedMessages: (state.queuedMessagesByChatId.get(chat.id) ?? []).map((entry) => ({
      ...entry,
      attachments: [...entry.attachments],
    })),
    messages: transcript.messages,
    history: transcript.history,
    availableProviders: [...SERVER_PROVIDERS],
  }
}

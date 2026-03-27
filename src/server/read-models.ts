import type {
  ChatRuntime,
  ChatSnapshot,
  KannaStatus,
  LocalProjectsSnapshot,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
} from "../shared/types"
import type { ChatRecord, StoreState } from "./events"
import { cloneTranscriptEntries } from "./events"
import { resolveLocalPath } from "./paths"
import { SERVER_PROVIDERS } from "./provider-catalog"

const DEFAULT_CHAT_SNAPSHOT_LIMIT = 200

export function deriveStatus(chat: ChatRecord, activeStatus?: KannaStatus): KannaStatus {
  if (activeStatus) return activeStatus
  if (chat.lastTurnOutcome === "failed") return "failed"
  return "idle"
}

export function deriveSidebarData(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>
): SidebarData {
  const projects = [...state.projectsById.values()]
    .filter((project) => !project.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const projectGroups: SidebarProjectGroup[] = projects.map((project) => {
    const chats: SidebarChatRow[] = [...state.chatsById.values()]
      .filter((chat) => chat.projectId === project.id && !chat.deletedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
      .map((chat) => ({
        _id: chat.id,
        _creationTime: chat.createdAt,
        chatId: chat.id,
        title: chat.title,
        status: deriveStatus(chat, activeStatuses.get(chat.id)),
        localPath: project.localPath,
        provider: chat.provider,
        lastMessageAt: chat.lastMessageAt,
        lastCompletedTurnAt: chat.lastCompletedTurnAt,
        hasAutomation: false,
      }))

    return {
      groupKey: project.id,
      localPath: project.localPath,
      chats,
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
    const chats = [...state.chatsById.values()].filter((chat) => chat.projectId === project.id && !chat.deletedAt)
    const lastOpenedAt = chats.reduce(
      (latest, chat) => Math.max(latest, chat.lastMessageAt ?? chat.updatedAt ?? 0),
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
    },
    projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
  }
}

export function deriveChatSnapshot(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  chatId: string,
  options?: {
    beforeMessageId?: string | null
    limit?: number
  }
): ChatSnapshot | null {
  const chat = state.chatsById.get(chatId)
  if (!chat || chat.deletedAt) return null
  const project = state.projectsById.get(chat.projectId)
  if (!project || project.deletedAt) return null

  const runtime = deriveChatRuntime(state, activeStatuses, chatId)
  if (!runtime) return null

  const allMessages = state.messagesByChatId.get(chatId) ?? []
  const { entries, hasOlderMessages, oldestLoadedMessageId } = sliceChatMessages(allMessages, options)

  return {
    runtime,
    messages: entries,
    hasOlderMessages,
    oldestLoadedMessageId,
    availableProviders: [...SERVER_PROVIDERS],
  }
}

export function sliceChatMessages(
  allMessages: readonly (ReturnType<typeof cloneTranscriptEntries>[number])[],
  options?: {
    beforeMessageId?: string | null
    limit?: number
  }
) {
  const limit = Math.max(1, options?.limit ?? DEFAULT_CHAT_SNAPSHOT_LIMIT)
  let endExclusive = allMessages.length

  if (options?.beforeMessageId) {
    const beforeIndex = allMessages.findIndex((entry) => entry._id === options.beforeMessageId)
    endExclusive = beforeIndex >= 0 ? beforeIndex : allMessages.length
  }

  const start = Math.max(0, endExclusive - limit)
  const entries = cloneTranscriptEntries(allMessages.slice(start, endExclusive))

  return {
    entries,
    hasOlderMessages: start > 0,
    oldestLoadedMessageId: entries[0]?._id ?? null,
  }
}

export function deriveChatRuntime(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  chatId: string
): ChatRuntime | null {
  const chat = state.chatsById.get(chatId)
  if (!chat || chat.deletedAt) return null
  const project = state.projectsById.get(chat.projectId)
  if (!project || project.deletedAt) return null

  return {
    chatId: chat.id,
    projectId: project.id,
    localPath: project.localPath,
    title: chat.title,
    status: deriveStatus(chat, activeStatuses.get(chat.id)),
    provider: chat.provider,
    planMode: chat.planMode,
    sessionToken: chat.sessionToken,
  }
}

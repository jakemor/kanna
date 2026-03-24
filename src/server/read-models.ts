import path from "node:path"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import type {
  ChatRuntime,
  ChatSnapshot,
  ChatUsageSnapshot,
  DirectoryBrowserSnapshot,
  KannaStatus,
  LocalProjectsSnapshot,
  SuggestedProjectFolder,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
} from "../shared/types"
import type { ChatRecord, StoreState } from "./events"
import { cloneTranscriptEntries } from "./events"
import { getDefaultDirectoryRoot, resolveLocalPath } from "./paths"
import { SERVER_PROVIDERS } from "./provider-catalog"

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
        hasAutomation: false,
      }))

    return {
      groupKey: project.id,
      title: project.title,
      localPath: project.localPath,
      chats,
    }
  })

  return { projectGroups }
}

export function deriveLocalProjectsSnapshot(
  state: StoreState,
  discoveredProjects: Array<{ repoKey: string; localPath: string; worktreePaths?: string[]; title: string; modifiedAt: number }>,
  machineName: string
): LocalProjectsSnapshot {
  const projects = new Map<string, LocalProjectsSnapshot["projects"][number]>()

  for (const project of discoveredProjects) {
    const normalizedPath = resolveLocalPath(project.localPath)
    projects.set(project.repoKey, {
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

    projects.set(project.repoKey, {
      localPath: project.localPath,
      title: project.title,
      source: "saved",
      lastOpenedAt,
      chatCount: chats.length,
    })
  }

  const suggestedFolders = deriveSuggestedProjectFolders(state, discoveredProjects)
  const rootDirectory = deriveRootDirectorySnapshot()

  return {
    machine: {
      id: "local",
      displayName: machineName,
    },
    projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
    suggestedFolders,
    rootDirectory,
  }
}

function deriveRootDirectorySnapshot(): DirectoryBrowserSnapshot | null {
  const currentPath = getDefaultDirectoryRoot()

  try {
    const entries = readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        localPath: path.join(currentPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return {
      currentPath,
      parentPath: path.dirname(currentPath) === currentPath ? null : path.dirname(currentPath),
      roots: [{ name: currentPath, localPath: currentPath }],
      entries,
    }
  } catch {
    return null
  }
}

function deriveSuggestedProjectFolders(
  state: StoreState,
  discoveredProjects: Array<{ localPath: string }>
): SuggestedProjectFolder[] {
  const candidates = new Map<string, string>()
  const home = homedir()

  const addCandidate = (label: string, candidatePath: string | null | undefined) => {
    if (!candidatePath) return
    const resolvedPath = resolveLocalPath(candidatePath)
    if (candidates.has(resolvedPath)) return
    if (!existsSync(resolvedPath)) return
    try {
      if (!statSync(resolvedPath).isDirectory()) return
    } catch {
      return
    }
    candidates.set(resolvedPath, label)
  }

  addCandidate("Home", home)
  addCandidate("Documents", path.join(home, "Documents"))
  addCandidate("Projects", path.join(home, "projects"))
  addCandidate("Projects", path.join(home, "Projects"))
  addCandidate("Downloads", path.join(home, "Downloads"))
  addCandidate("Desktop", path.join(home, "Desktop"))
  addCandidate("Current Project", process.cwd())
  addCandidate("Current Project Parent", path.dirname(process.cwd()))

  for (const project of discoveredProjects) {
    addCandidate(`Nearby: ${path.basename(project.localPath) || project.localPath}`, project.localPath)
    addCandidate(`Parent: ${path.basename(path.dirname(project.localPath)) || path.dirname(project.localPath)}`, path.dirname(project.localPath))
  }

  for (const project of state.projectsById.values()) {
    if (project.deletedAt) continue
    addCandidate(`Saved: ${project.title}`, project.localPath)
    addCandidate(`Parent: ${path.basename(path.dirname(project.localPath)) || path.dirname(project.localPath)}`, path.dirname(project.localPath))
  }

  return [...candidates.entries()]
    .map(([localPath, label]) => ({ localPath, label }))
    .slice(0, 12)
}

export function deriveChatSnapshot(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  chatId: string,
  usage: ChatUsageSnapshot | null = null
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
    provider: chat.provider,
    planMode: chat.planMode,
    sessionToken: chat.sessionToken,
  }

  return {
    runtime,
    messages: cloneTranscriptEntries(state.messagesByChatId.get(chat.id) ?? []),
    usage,
    availableProviders: [...SERVER_PROVIDERS],
  }
}

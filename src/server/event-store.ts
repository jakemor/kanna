import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir, LOG_PREFIX } from "../shared/branding"
import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { STORE_VERSION } from "../shared/types"
import {
  type ChatEvent,
  type MessageEvent,
  type ProjectEvent,
  type SnapshotFile,
  type StoreEvent,
  type StoreState,
  type TurnEvent,
  cloneTranscriptEntries,
  createEmptyState,
} from "./events"
import { resolveLocalPath } from "./paths"

const COMPACTION_THRESHOLD_BYTES = 2 * 1024 * 1024

export class EventStore {
  readonly dataDir: string
  readonly state: StoreState = createEmptyState()
  private writeChain = Promise.resolve()
  private storageReset = false
  private readonly snapshotPath: string
  private readonly projectsLogPath: string
  private readonly chatsLogPath: string
  private readonly messagesLogPath: string
  private readonly turnsLogPath: string

  constructor(dataDir = getDataDir(homedir())) {
    this.dataDir = dataDir
    this.snapshotPath = path.join(this.dataDir, "snapshot.json")
    this.projectsLogPath = path.join(this.dataDir, "projects.jsonl")
    this.chatsLogPath = path.join(this.dataDir, "chats.jsonl")
    this.messagesLogPath = path.join(this.dataDir, "messages.jsonl")
    this.turnsLogPath = path.join(this.dataDir, "turns.jsonl")
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.ensureFile(this.projectsLogPath)
    await this.ensureFile(this.chatsLogPath)
    await this.ensureFile(this.messagesLogPath)
    await this.ensureFile(this.turnsLogPath)
    await this.loadSnapshot()
    await this.replayLogs()
    if (await this.shouldCompact()) {
      await this.compact()
    }
  }

  private async ensureFile(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      await Bun.write(filePath, "")
    }
  }

  private async clearStorage() {
    if (this.storageReset) return
    this.storageReset = true
    this.resetState()
    await Promise.all([
      Bun.write(this.snapshotPath, ""),
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  private async loadSnapshot() {
    const file = Bun.file(this.snapshotPath)
    if (!(await file.exists())) return

    try {
      const text = await file.text()
      if (!text.trim()) return
      const parsed = JSON.parse(text) as SnapshotFile
      if (parsed.v !== STORE_VERSION) {
        console.warn(`${LOG_PREFIX} Resetting local chat history for store version ${STORE_VERSION}`)
        await this.clearStorage()
        return
      }
      for (const project of parsed.projects) {
        this.state.projectsById.set(project.id, { ...project })
        this.state.projectIdsByPath.set(project.localPath, project.id)
      }
      for (const chat of parsed.chats) {
        this.state.chatsById.set(chat.id, { ...chat })
      }
      for (const messageSet of parsed.messages) {
        this.state.messagesByChatId.set(messageSet.chatId, cloneTranscriptEntries(messageSet.entries))
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load snapshot, resetting local history:`, error)
      await this.clearStorage()
    }
  }

  private resetState() {
    this.state.projectsById.clear()
    this.state.projectIdsByPath.clear()
    this.state.chatsById.clear()
    this.state.messagesByChatId.clear()
  }

  private async replayLogs() {
    if (this.storageReset) return
    await this.replayLog<ProjectEvent>(this.projectsLogPath)
    if (this.storageReset) return
    await this.replayLog<ChatEvent>(this.chatsLogPath)
    if (this.storageReset) return
    await this.replayLog<MessageEvent>(this.messagesLogPath)
    if (this.storageReset) return
    await this.replayLog<TurnEvent>(this.turnsLogPath)
  }

  private async replayLog<TEvent extends StoreEvent>(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return
    const text = await file.text()
    if (!text.trim()) return

    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as Partial<StoreEvent>
        if (event.v !== STORE_VERSION) {
          console.warn(`${LOG_PREFIX} Resetting local history from incompatible event log`)
          await this.clearStorage()
          return
        }
        this.applyEvent(event as StoreEvent)
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(filePath)}`)
          return
        }
        console.warn(`${LOG_PREFIX} Failed to replay ${path.basename(filePath)}, resetting local history:`, error)
        await this.clearStorage()
        return
      }
    }
  }

  private applyEvent(event: StoreEvent) {
    switch (event.type) {
      case "project_opened": {
        const localPath = resolveLocalPath(event.localPath)
        const project = {
          id: event.projectId,
          localPath,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
        this.state.projectsById.set(project.id, project)
        this.state.projectIdsByPath.set(localPath, project.id)
        break
      }
      case "project_removed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        project.deletedAt = event.timestamp
        project.updatedAt = event.timestamp
        this.state.projectIdsByPath.delete(project.localPath)
        break
      }
      case "chat_created": {
        const chat = {
          id: event.chatId,
          projectId: event.projectId,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          provider: null,
          planMode: false,
          sessionToken: null,
          lastTurnOutcome: null,
        }
        this.state.chatsById.set(chat.id, chat)
        break
      }
      case "chat_renamed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.title = event.title
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_deleted": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.deletedAt = event.timestamp
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_provider_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.provider = event.provider
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_plan_mode_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.planMode = event.planMode
        chat.updatedAt = event.timestamp
        break
      }
      case "message_appended": {
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          if (event.entry.kind === "user_prompt") {
            chat.lastMessageAt = event.entry.createdAt
          }
          chat.updatedAt = Math.max(chat.updatedAt, event.entry.createdAt)
        }
        const existing = this.state.messagesByChatId.get(event.chatId) ?? []
        existing.push({ ...event.entry })
        this.state.messagesByChatId.set(event.chatId, existing)
        break
      }
      case "turn_started": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        break
      }
      case "turn_finished": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnOutcome = "success"
        break
      }
      case "turn_failed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnOutcome = "failed"
        break
      }
      case "turn_cancelled": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnOutcome = "cancelled"
        break
      }
      case "session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.sessionToken = event.sessionToken
        chat.updatedAt = event.timestamp
        break
      }
    }
  }

  private append<TEvent extends StoreEvent>(filePath: string, event: TEvent) {
    const payload = `${JSON.stringify(event)}\n`
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(filePath, payload, "utf8")
      this.applyEvent(event)
    })
    return this.writeChain
  }

  async openProject(localPath: string, title?: string) {
    const normalized = resolveLocalPath(localPath)
    const existingId = this.state.projectIdsByPath.get(normalized)
    if (existingId) {
      const existing = this.state.projectsById.get(existingId)
      if (existing && !existing.deletedAt) {
        return existing
      }
    }

    const projectId = crypto.randomUUID()
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_opened",
      timestamp: Date.now(),
      projectId,
      localPath: normalized,
      title: title?.trim() || path.basename(normalized) || normalized,
    }
    await this.append(this.projectsLogPath, event)
    return this.state.projectsById.get(projectId)!
  }

  async removeProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_removed",
      timestamp: Date.now(),
      projectId,
    }
    await this.append(this.projectsLogPath, event)
  }

  async createChat(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) {
      throw new Error("Project not found")
    }
    const chatId = crypto.randomUUID()
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: Date.now(),
      chatId,
      projectId,
      title: "New Chat",
    }
    await this.append(this.chatsLogPath, event)
    return this.state.chatsById.get(chatId)!
  }

  async renameChat(chatId: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    const chat = this.requireChat(chatId)
    if (chat.title === trimmed) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_renamed",
      timestamp: Date.now(),
      chatId,
      title: trimmed,
    }
    await this.append(this.chatsLogPath, event)
  }

  async deleteChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_deleted",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setChatProvider(chatId: string, provider: AgentProvider) {
    const chat = this.requireChat(chatId)
    if (chat.provider === provider) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_provider_set",
      timestamp: Date.now(),
      chatId,
      provider,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setPlanMode(chatId: string, planMode: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.planMode === planMode) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_plan_mode_set",
      timestamp: Date.now(),
      chatId,
      planMode,
    }
    await this.append(this.chatsLogPath, event)
  }

  async appendMessage(chatId: string, entry: TranscriptEntry) {
    this.requireChat(chatId)
    const event: MessageEvent = {
      v: STORE_VERSION,
      type: "message_appended",
      timestamp: Date.now(),
      chatId,
      entry,
    }
    await this.append(this.messagesLogPath, event)
  }

  async recordTurnStarted(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_started",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnFinished(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_finished",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnFailed(chatId: string, error: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_failed",
      timestamp: Date.now(),
      chatId,
      error,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnCancelled(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_cancelled",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async setSessionToken(chatId: string, sessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if (chat.sessionToken === sessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "session_token_set",
      timestamp: Date.now(),
      chatId,
      sessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  getProject(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) return null
    return project
  }

  requireChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) {
      throw new Error("Chat not found")
    }
    return chat
  }

  getChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) return null
    return chat
  }

  getMessages(chatId: string) {
    return cloneTranscriptEntries(this.state.messagesByChatId.get(chatId) ?? [])
  }

  listProjects() {
    return [...this.state.projectsById.values()].filter((project) => !project.deletedAt)
  }

  listChatsByProject(projectId: string) {
    return [...this.state.chatsById.values()]
      .filter((chat) => chat.projectId === projectId && !chat.deletedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
  }

  getChatCount(projectId: string) {
    return this.listChatsByProject(projectId).length
  }

  async compact() {
    const snapshot: SnapshotFile = {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      projects: this.listProjects().map((project) => ({ ...project })),
      chats: [...this.state.chatsById.values()]
        .filter((chat) => !chat.deletedAt)
        .map((chat) => ({ ...chat })),
      messages: [...this.state.messagesByChatId.entries()].map(([chatId, entries]) => ({
        chatId,
        entries: cloneTranscriptEntries(entries),
      })),
    }

    await Bun.write(this.snapshotPath, JSON.stringify(snapshot, null, 2))
    await Promise.all([
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  private async shouldCompact() {
    const sizes = await Promise.all([
      Bun.file(this.projectsLogPath).size,
      Bun.file(this.chatsLogPath).size,
      Bun.file(this.messagesLogPath).size,
      Bun.file(this.turnsLogPath).size,
    ])
    return sizes.reduce((total, size) => total + size, 0) >= COMPACTION_THRESHOLD_BYTES
  }
}

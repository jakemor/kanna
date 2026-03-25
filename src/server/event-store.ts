import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir, LOG_PREFIX } from "../shared/branding"
import { FEATURE_BROWSER_STATES, FEATURE_STAGES, type AgentProvider, type FeatureBrowserState, type FeatureStage, type TranscriptEntry } from "../shared/types"
import { STORE_VERSION } from "../shared/types"
import {
  type ChatEvent,
  type FeatureEvent,
  type MessageEvent,
  type ProjectEvent,
  type SnapshotFile,
  type StoreEvent,
  type StoreState,
  type TurnEvent,
  cloneTranscriptEntries,
  createEmptyState,
} from "./events"
import { resolveProjectRepositoryIdentity, resolveProjectWorktreePaths } from "./git-repository"
import { resolveLocalPath } from "./paths"

const COMPACTION_THRESHOLD_BYTES = 2 * 1024 * 1024
const FEATURE_METADATA_VERSION = 1 as const

interface PersistedProjectFeature {
  v: typeof FEATURE_METADATA_VERSION
  title: string
  description: string
  browserState: FeatureBrowserState
  stage: FeatureStage
  sortOrder: number
  directoryRelativePath: string
  overviewRelativePath: string
  chatKeys: string[]
}

export class EventStore {
  readonly dataDir: string
  readonly state: StoreState = createEmptyState()
  private writeChain = Promise.resolve()
  private storageReset = false
  private readonly snapshotPath: string
  private readonly projectsLogPath: string
  private readonly featuresLogPath: string
  private readonly chatsLogPath: string
  private readonly messagesLogPath: string
  private readonly turnsLogPath: string

  constructor(dataDir = getDataDir(homedir())) {
    this.dataDir = dataDir
    this.snapshotPath = path.join(this.dataDir, "snapshot.json")
    this.projectsLogPath = path.join(this.dataDir, "projects.jsonl")
    this.featuresLogPath = path.join(this.dataDir, "features.jsonl")
    this.chatsLogPath = path.join(this.dataDir, "chats.jsonl")
    this.messagesLogPath = path.join(this.dataDir, "messages.jsonl")
    this.turnsLogPath = path.join(this.dataDir, "turns.jsonl")
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.ensureFile(this.projectsLogPath)
    await this.ensureFile(this.featuresLogPath)
    await this.ensureFile(this.chatsLogPath)
    await this.ensureFile(this.messagesLogPath)
    await this.ensureFile(this.turnsLogPath)
    await this.loadSnapshot()
    await this.replayLogs()
    this.hydrateProjectWorktrees()
    if (await this.shouldCompact()) {
      await this.compact()
    }
  }

  private hydrateProjectWorktrees() {
    for (const project of this.state.projectsById.values()) {
      if (project.deletedAt || !project.repoKey.startsWith("git:")) continue
      const resolvedPaths = resolveProjectWorktreePaths(project.localPath)
      for (const worktreePath of resolvedPaths) {
        if (!project.worktreePaths.includes(worktreePath)) {
          project.worktreePaths.push(worktreePath)
        }
        this.state.projectIdsByPath.set(worktreePath, project.id)
      }
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
      Bun.write(this.featuresLogPath, ""),
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
        this.state.projectIdsByRepoKey.set(project.repoKey, project.id)
        for (const worktreePath of project.worktreePaths) {
          this.state.projectIdsByPath.set(worktreePath, project.id)
        }
      }
      for (const feature of parsed.features ?? []) {
        this.state.featuresById.set(feature.id, {
          ...feature,
          browserState: feature.browserState ?? "OPEN",
        })
      }
      for (const chat of parsed.chats) {
        this.state.chatsById.set(chat.id, { ...chat })
      }
      for (const messageSet of parsed.messages) {
        this.state.messagesByChatId.set(messageSet.chatId, cloneTranscriptEntries(messageSet.entries))
      }
      for (const repoKey of parsed.hiddenProjectKeys ?? []) {
        this.state.hiddenProjectKeys.add(repoKey)
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to load snapshot, resetting local history:`, error)
      await this.clearStorage()
    }
  }

  private resetState() {
    this.state.projectsById.clear()
    this.state.projectIdsByRepoKey.clear()
    this.state.projectIdsByPath.clear()
    this.state.featuresById.clear()
    this.state.chatsById.clear()
    this.state.messagesByChatId.clear()
    this.state.hiddenProjectKeys.clear()
  }

  private async replayLogs() {
    if (this.storageReset) return
    await this.replayLog<ProjectEvent>(this.projectsLogPath)
    if (this.storageReset) return
    await this.replayLog<FeatureEvent>(this.featuresLogPath)
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
          repoKey: event.repoKey,
          localPath,
          worktreePaths: event.worktreePaths.map((worktreePath) => resolveLocalPath(worktreePath)),
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
        this.state.projectsById.set(project.id, project)
        this.state.projectIdsByRepoKey.set(project.repoKey, project.id)
        for (const worktreePath of project.worktreePaths) {
          this.state.projectIdsByPath.set(worktreePath, project.id)
        }
        break
      }
      case "project_worktree_added": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        const localPath = resolveLocalPath(event.localPath)
        if (!project.worktreePaths.includes(localPath)) {
          project.worktreePaths.push(localPath)
        }
        project.localPath = localPath
        project.updatedAt = event.timestamp
        this.state.projectIdsByPath.set(localPath, project.id)
        break
      }
      case "project_removed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        project.deletedAt = event.timestamp
        project.updatedAt = event.timestamp
        this.state.projectIdsByRepoKey.delete(project.repoKey)
        for (const worktreePath of project.worktreePaths) {
          this.state.projectIdsByPath.delete(worktreePath)
        }
        break
      }
      case "project_hidden": {
        this.state.hiddenProjectKeys.add(event.repoKey)
        break
      }
      case "project_unhidden": {
        this.state.hiddenProjectKeys.delete(event.repoKey)
        break
      }
      case "feature_created": {
        this.state.featuresById.set(event.featureId, {
          id: event.featureId,
          projectId: event.projectId,
          title: event.title,
          description: event.description,
          browserState: event.browserState ?? "OPEN",
          stage: event.stage,
          sortOrder: event.sortOrder,
          directoryRelativePath: event.directoryRelativePath,
          overviewRelativePath: event.overviewRelativePath,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        })
        break
      }
      case "feature_renamed": {
        const feature = this.state.featuresById.get(event.featureId)
        if (!feature) break
        feature.title = event.title
        feature.updatedAt = event.timestamp
        break
      }
      case "feature_browser_state_set": {
        const feature = this.state.featuresById.get(event.featureId)
        if (!feature) break
        feature.browserState = event.browserState
        feature.updatedAt = event.timestamp
        break
      }
      case "feature_stage_set": {
        const feature = this.state.featuresById.get(event.featureId)
        if (!feature) break
        feature.stage = event.stage
        if (typeof event.sortOrder === "number") {
          feature.sortOrder = event.sortOrder
        }
        feature.updatedAt = event.timestamp
        break
      }
      case "feature_reordered": {
        const visibleFeatures = event.orderedFeatureIds
          .map((featureId) => this.state.featuresById.get(featureId))
          .filter((feature): feature is NonNullable<typeof feature> => Boolean(feature && !feature.deletedAt))

        visibleFeatures.forEach((feature, index) => {
          feature.sortOrder = index
          feature.updatedAt = event.timestamp
        })
        break
      }
      case "feature_deleted": {
        const feature = this.state.featuresById.get(event.featureId)
        if (!feature) break
        feature.deletedAt = event.timestamp
        feature.updatedAt = event.timestamp
        for (const chat of this.state.chatsById.values()) {
          if (chat.deletedAt || chat.featureId !== event.featureId) continue
          chat.featureId = null
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "chat_created": {
        const chat = {
          id: event.chatId,
          projectId: event.projectId,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          featureId: event.featureId ?? null,
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
      case "chat_feature_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.featureId = event.featureId
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
    const identity = resolveProjectRepositoryIdentity(localPath)
    const worktreePaths = identity.isGitRepo ? resolveProjectWorktreePaths(identity.worktreePath) : [identity.worktreePath]
    const existingId = this.state.projectIdsByRepoKey.get(identity.repoKey)
    if (existingId) {
      const existing = this.state.projectsById.get(existingId)
      if (existing && !existing.deletedAt) {
        const missingWorktreePaths = worktreePaths.filter((worktreePath) => !existing.worktreePaths.includes(worktreePath))
        for (const missingWorktreePath of missingWorktreePaths) {
          const event: ProjectEvent = {
            v: STORE_VERSION,
            type: "project_worktree_added",
            timestamp: Date.now(),
            projectId: existing.id,
            localPath: missingWorktreePath,
          }
          await this.append(this.projectsLogPath, event)
        }
        if (existing.localPath !== identity.worktreePath && existing.worktreePaths.includes(identity.worktreePath)) {
          const event: ProjectEvent = {
            v: STORE_VERSION,
            type: "project_worktree_added",
            timestamp: Date.now(),
            projectId: existing.id,
            localPath: identity.worktreePath,
          }
          await this.append(this.projectsLogPath, event)
        }
        return this.state.projectsById.get(existing.id)!
      }
    }

    const projectId = crypto.randomUUID()
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_opened",
      timestamp: Date.now(),
      projectId,
      repoKey: identity.repoKey,
      localPath: identity.worktreePath,
      worktreePaths,
      title: title?.trim() || identity.title,
    }
    await this.append(this.projectsLogPath, event)
    return this.state.projectsById.get(projectId)!
  }

  async removeProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    if (this.state.hiddenProjectKeys.has(project.repoKey)) return
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_hidden",
      timestamp: Date.now(),
      repoKey: project.repoKey,
    }
    await this.append(this.projectsLogPath, event)
  }

  async createFeature(projectId: string, title: string, description = "") {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    const trimmedTitle = title.trim()
    const trimmedDescription = description.trim()
    if (!trimmedTitle) {
      throw new Error("Feature title is required")
    }

    const directoryName = this.generateUniqueFeatureDirectoryName(projectId, trimmedTitle)
    const directoryRelativePath = path.posix.join(".kanna", directoryName)
    const overviewRelativePath = path.posix.join(directoryRelativePath, "overview.md")
    const featureDirPath = path.join(project.localPath, directoryRelativePath)
    const overviewPath = path.join(project.localPath, overviewRelativePath)
    const sortOrder = this.getNextFeatureSortOrder(projectId, "idea")

    await mkdir(featureDirPath, { recursive: true })
    await writeFile(overviewPath, this.buildFeatureOverviewContent({
      projectTitle: project.title,
      featureTitle: trimmedTitle,
      description: trimmedDescription,
    }), "utf8")

    const featureId = crypto.randomUUID()
    const event: FeatureEvent = {
      v: STORE_VERSION,
      type: "feature_created",
      timestamp: Date.now(),
      featureId,
      projectId,
      title: trimmedTitle,
      description: trimmedDescription,
      browserState: "OPEN",
      stage: "idea",
      sortOrder,
      directoryRelativePath,
      overviewRelativePath,
    }
    await this.append(this.featuresLogPath, event)
    await this.syncProjectFeatureState(projectId)
    return this.state.featuresById.get(featureId)!
  }

  async renameFeature(featureId: string, title: string) {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    const feature = this.requireFeature(featureId)
    if (feature.title === trimmedTitle) return
    const event: FeatureEvent = {
      v: STORE_VERSION,
      type: "feature_renamed",
      timestamp: Date.now(),
      featureId,
      title: trimmedTitle,
    }
    await this.append(this.featuresLogPath, event)
    await this.syncProjectFeatureState(feature.projectId)
  }

  async setFeatureStage(featureId: string, stage: FeatureStage) {
    const feature = this.requireFeature(featureId)
    if (feature.stage === stage) return
    const shouldRebaseOrder = feature.stage === "done" || stage === "done"
    const event: FeatureEvent = {
      v: STORE_VERSION,
      type: "feature_stage_set",
      timestamp: Date.now(),
      featureId,
      stage,
      ...(shouldRebaseOrder
        ? { sortOrder: this.getRebasedFeatureSortOrder(feature.projectId, featureId, stage) }
        : {}),
    }
    await this.append(this.featuresLogPath, event)
    await this.syncProjectFeatureState(feature.projectId, true)
  }

  async setFeatureBrowserState(featureId: string, browserState: FeatureBrowserState) {
    const feature = this.requireFeature(featureId)
    if (feature.browserState === browserState) return
    const event: FeatureEvent = {
      v: STORE_VERSION,
      type: "feature_browser_state_set",
      timestamp: Date.now(),
      featureId,
      browserState,
    }
    await this.append(this.featuresLogPath, event)
    await this.syncProjectFeatureState(feature.projectId)
  }

  async reorderFeatures(projectId: string, orderedFeatureIds: string[]) {
    const features = this.listFeaturesByProject(projectId)
    const visibleIds = features.map((feature) => feature.id)
    if (orderedFeatureIds.length !== visibleIds.length) {
      throw new Error("Feature reorder payload is incomplete")
    }
    const orderedSet = new Set(orderedFeatureIds)
    if (orderedSet.size !== visibleIds.length || visibleIds.some((id) => !orderedSet.has(id))) {
      throw new Error("Feature reorder payload does not match project features")
    }
    const event: FeatureEvent = {
      v: STORE_VERSION,
      type: "feature_reordered",
      timestamp: Date.now(),
      projectId,
      orderedFeatureIds,
    }
    await this.append(this.featuresLogPath, event)
    await this.syncProjectFeatureState(projectId)
  }

  async deleteFeature(featureId: string) {
    const feature = this.requireFeature(featureId)
    const project = this.getProject(feature.projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    await rm(path.join(project.localPath, feature.directoryRelativePath), { recursive: true, force: true })
    const event: FeatureEvent = {
      v: STORE_VERSION,
      type: "feature_deleted",
      timestamp: Date.now(),
      featureId,
    }
    await this.append(this.featuresLogPath, event)
    await this.syncProjectFeatureState(feature.projectId)
  }

  async hideProject(localPath: string) {
    const identity = resolveProjectRepositoryIdentity(localPath)
    if (this.state.hiddenProjectKeys.has(identity.repoKey)) return
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_hidden",
      timestamp: Date.now(),
      repoKey: identity.repoKey,
    }
    await this.append(this.projectsLogPath, event)
  }

  async unhideProject(localPath: string) {
    const identity = resolveProjectRepositoryIdentity(localPath)
    if (!this.state.hiddenProjectKeys.has(identity.repoKey)) return
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_unhidden",
      timestamp: Date.now(),
      repoKey: identity.repoKey,
    }
    await this.append(this.projectsLogPath, event)
  }

  async createChat(projectId: string, featureId?: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) {
      throw new Error("Project not found")
    }
    if (featureId) {
      const feature = this.requireFeature(featureId)
      if (feature.projectId !== projectId) {
        throw new Error("Feature does not belong to project")
      }
    }
    const chatId = crypto.randomUUID()
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: Date.now(),
      chatId,
      projectId,
      title: "New Chat",
      ...(featureId ? { featureId } : {}),
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
    const chat = this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_deleted",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
    await this.syncProjectFeatureState(chat.projectId)
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
    await this.syncProjectFeatureState(chat.projectId)
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

  async setChatFeature(chatId: string, featureId: string | null) {
    const chat = this.requireChat(chatId)
    if (featureId) {
      const feature = this.requireFeature(featureId)
      if (feature.projectId !== chat.projectId) {
        throw new Error("Feature does not belong to the same project")
      }
    }
    if ((chat.featureId ?? null) === featureId) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_feature_set",
      timestamp: Date.now(),
      chatId,
      featureId,
    }
    await this.append(this.chatsLogPath, event)
    await this.syncProjectFeatureState(chat.projectId)
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
    await this.syncProjectFeatureState(chat.projectId)
  }

  async reconcileProjectFeatureState(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    const persistedFeatures = await this.readProjectFeatureMetadata(project.localPath)
    const persistedByDirectory = new Map(
      persistedFeatures.map((feature) => [feature.directoryRelativePath, feature] as const)
    )
    const existingFeatures = this.listFeaturesByProject(projectId)
    const existingByDirectory = new Map(
      existingFeatures.map((feature) => [feature.directoryRelativePath, feature] as const)
    )

    for (const feature of existingFeatures) {
      if (persistedByDirectory.has(feature.directoryRelativePath)) continue
      await this.deleteFeature(feature.id)
    }

    const chatsByKey = new Map(
      this.listChatsByProject(projectId)
        .map((chat) => {
          const key = this.getChatPersistenceKey(chat)
          return key ? [key, chat] as const : null
        })
        .filter((entry): entry is readonly [string, ReturnType<EventStore["listChatsByProject"]>[number]] => Boolean(entry))
    )

    let importedFeatures = 0
    for (const persistedFeature of [...persistedFeatures].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const existingFeature = existingByDirectory.get(persistedFeature.directoryRelativePath)
      if (existingFeature) {
        continue
      }
      const featureId = crypto.randomUUID()
      const timestamp = Date.now()
      const event: FeatureEvent = {
        v: STORE_VERSION,
        type: "feature_created",
        timestamp,
        featureId,
        projectId,
        title: persistedFeature.title,
        description: persistedFeature.description,
        browserState: persistedFeature.browserState,
        stage: persistedFeature.stage,
        sortOrder: persistedFeature.sortOrder,
        directoryRelativePath: persistedFeature.directoryRelativePath,
        overviewRelativePath: persistedFeature.overviewRelativePath,
      }
      await this.append(this.featuresLogPath, event)
      importedFeatures += 1

      for (const chatKey of persistedFeature.chatKeys) {
        const chat = chatsByKey.get(chatKey)
        if (!chat) continue
        const assignmentEvent: ChatEvent = {
          v: STORE_VERSION,
          type: "chat_feature_set",
          timestamp: Date.now(),
          chatId: chat.id,
          featureId,
        }
        await this.append(this.chatsLogPath, assignmentEvent)
      }
    }

    return importedFeatures
  }

  getProject(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) return null
    return project
  }

  requireFeature(featureId: string) {
    const feature = this.state.featuresById.get(featureId)
    if (!feature || feature.deletedAt) {
      throw new Error("Feature not found")
    }
    return feature
  }

  getFeature(featureId: string) {
    const feature = this.state.featuresById.get(featureId)
    if (!feature || feature.deletedAt) return null
    return feature
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

  listFeaturesByProject(projectId: string) {
    return [...this.state.featuresById.values()]
      .filter((feature) => feature.projectId === projectId && !feature.deletedAt)
      .sort((a, b) => {
        const aDone = a.stage === "done" ? 1 : 0
        const bDone = b.stage === "done" ? 1 : 0
        if (aDone !== bDone) return aDone - bDone
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return b.updatedAt - a.updatedAt
      })
  }

  isProjectHidden(repoKey: string) {
    return this.state.hiddenProjectKeys.has(repoKey)
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
    await this.writeChain

    const snapshot: SnapshotFile = {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      projects: this.listProjects().map((project) => ({ ...project })),
      features: [...this.state.featuresById.values()]
        .filter((feature) => !feature.deletedAt)
        .map((feature) => ({ ...feature })),
      chats: [...this.state.chatsById.values()]
        .filter((chat) => !chat.deletedAt)
        .map((chat) => ({ ...chat })),
      messages: [...this.state.messagesByChatId.entries()].map(([chatId, entries]) => ({
        chatId,
        entries: cloneTranscriptEntries(entries),
      })),
      hiddenProjectKeys: [...this.state.hiddenProjectKeys.values()],
    }

    const tmpPath = `${this.snapshotPath}.tmp`
    await Bun.write(tmpPath, JSON.stringify(snapshot, null, 2))
    await rename(tmpPath, this.snapshotPath)
    await Promise.all([
      Bun.write(this.projectsLogPath, ""),
      Bun.write(this.featuresLogPath, ""),
      Bun.write(this.chatsLogPath, ""),
      Bun.write(this.messagesLogPath, ""),
      Bun.write(this.turnsLogPath, ""),
    ])
  }

  private async shouldCompact() {
    const sizes = await Promise.all([
      Bun.file(this.projectsLogPath).size,
      Bun.file(this.featuresLogPath).size,
      Bun.file(this.chatsLogPath).size,
      Bun.file(this.messagesLogPath).size,
      Bun.file(this.turnsLogPath).size,
    ])
    return sizes.reduce((total, size) => total + size, 0) >= COMPACTION_THRESHOLD_BYTES
  }

  private generateUniqueFeatureDirectoryName(projectId: string, title: string) {
    const normalizedBase = title
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .replace(/_+/g, "_")
      || "feature"
    const existing = new Set(
      this.listFeaturesByProject(projectId).map((feature) => path.posix.basename(feature.directoryRelativePath))
    )
    if (!existing.has(normalizedBase)) return normalizedBase
    let index = 2
    while (existing.has(`${normalizedBase}_${index}`)) {
      index += 1
    }
    return `${normalizedBase}_${index}`
  }

  private getNextFeatureSortOrder(projectId: string, stage: FeatureStage) {
    const features = this.listFeaturesByProject(projectId)
    if (stage === "done") {
      const doneOrders = features.filter((feature) => feature.stage === "done").map((feature) => feature.sortOrder)
      return doneOrders.length === 0 ? features.length : Math.max(...doneOrders) + 1
    }
    const nonDoneOrders = features.filter((feature) => feature.stage !== "done").map((feature) => feature.sortOrder)
    return nonDoneOrders.length === 0 ? 0 : Math.max(...nonDoneOrders) + 1
  }

  private getRebasedFeatureSortOrder(projectId: string, featureId: string, nextStage: FeatureStage) {
    const features = this.listFeaturesByProject(projectId).filter((feature) => feature.id !== featureId)
    if (nextStage === "done") {
      const doneOrders = features.filter((feature) => feature.stage === "done").map((feature) => feature.sortOrder)
      const maxOverall = features.map((feature) => feature.sortOrder)
      return doneOrders.length > 0
        ? Math.max(...doneOrders) + 1
        : maxOverall.length > 0
          ? Math.max(...maxOverall) + 1
          : 0
    }
    const nonDoneOrders = features.filter((feature) => feature.stage !== "done").map((feature) => feature.sortOrder)
    return nonDoneOrders.length === 0 ? 0 : Math.max(...nonDoneOrders) + 1
  }

  private buildFeatureOverviewContent(args: {
    projectTitle: string
    featureTitle: string
    description: string
  }) {
    const summary = args.description.trim() || "TODO: Add a short summary for this feature."
    return [
      `# ${args.featureTitle}`,
      "",
      `Project: ${args.projectTitle}`,
      "",
      "## Summary",
      summary,
      "",
      "## Notes",
      "- Initial feature overview generated at creation time.",
      "- Replace this with a fuller implementation plan as the feature evolves.",
      "",
      "## Open Questions",
      "- Scope details",
      "- Technical approach",
      "- Testing strategy",
      "",
    ].join("\n")
  }

  private getFeatureMetadataPath(localPath: string, directoryRelativePath: string) {
    return path.join(localPath, directoryRelativePath, "feature.json")
  }

  private getChatPersistenceKey(chat: {
    provider: AgentProvider | null
    sessionToken: string | null
  }) {
    if (!chat.provider || !chat.sessionToken) return null
    return `${chat.provider}:${chat.sessionToken}`
  }

  private async syncProjectFeatureState(projectId: string, force = false) {
    const project = this.getProject(projectId)
    if (!project) return
    if (!force && this.listFeaturesByProject(projectId).length === 0) {
      return
    }

    for (const feature of this.listFeaturesByProject(projectId)) {
      const persistedFeature: PersistedProjectFeature = {
        v: FEATURE_METADATA_VERSION,
        title: feature.title,
        description: feature.description,
        browserState: feature.browserState,
        stage: feature.stage,
        sortOrder: feature.sortOrder,
        directoryRelativePath: feature.directoryRelativePath,
        overviewRelativePath: feature.overviewRelativePath,
        chatKeys: this.listChatsByProject(projectId)
          .filter((chat) => chat.featureId === feature.id)
          .map((chat) => this.getChatPersistenceKey(chat))
          .filter((chatKey): chatKey is string => Boolean(chatKey)),
      }
      const featureMetadataPath = this.getFeatureMetadataPath(project.localPath, feature.directoryRelativePath)
      await mkdir(path.dirname(featureMetadataPath), { recursive: true })
      await writeFile(featureMetadataPath, JSON.stringify(persistedFeature, null, 2), "utf8")
    }
  }

  private async readProjectFeatureMetadata(localPath: string): Promise<PersistedProjectFeature[]> {
    try {
      const kannaDir = path.join(localPath, ".kanna")
      const entries = await readdir(kannaDir, { withFileTypes: true })
      const features: PersistedProjectFeature[] = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const raw = await readFile(path.join(kannaDir, entry.name, "feature.json"), "utf8").catch(() => null)
        if (!raw?.trim()) continue
        const parsed = JSON.parse(raw) as Partial<PersistedProjectFeature>
        if (
          parsed.v !== FEATURE_METADATA_VERSION
          || typeof parsed.title !== "string"
          || typeof parsed.description !== "string"
          || typeof parsed.directoryRelativePath !== "string"
          || typeof parsed.overviewRelativePath !== "string"
          || typeof parsed.sortOrder !== "number"
          || !FEATURE_BROWSER_STATES.includes((parsed.browserState ?? "OPEN") as FeatureBrowserState)
          || !FEATURE_STAGES.includes(parsed.stage as FeatureStage)
        ) {
          continue
        }
        features.push({
          v: FEATURE_METADATA_VERSION,
          title: parsed.title,
          description: parsed.description,
          browserState: (parsed.browserState ?? "OPEN") as FeatureBrowserState,
          stage: parsed.stage as FeatureStage,
          sortOrder: parsed.sortOrder,
          directoryRelativePath: parsed.directoryRelativePath,
          overviewRelativePath: parsed.overviewRelativePath,
          chatKeys: Array.isArray(parsed.chatKeys)
            ? parsed.chatKeys.filter((chatKey): chatKey is string => typeof chatKey === "string")
            : [],
        })
      }

      return features
    } catch {
      return []
    }
  }
}

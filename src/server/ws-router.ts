import type { ServerWebSocket } from "bun"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientEnvelope, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { isClientEnvelope } from "../shared/protocol"
import type { AgentCoordinator } from "./agent"
import type { AnalyticsReporter } from "./analytics"
import { NoopAnalyticsReporter } from "./analytics"
import type { AppSettingsManager } from "./app-settings"
import type { DiscoveredProject } from "./discovery"
import { DiffStore } from "./diff-store"
import { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import { KeybindingsManager } from "./keybindings"
import { killLocalHttpServer, listLocalHttpServers } from "./local-http-servers"
import { cloneRepository, createDirectory, ensureProjectDirectory, listDirectory, resolveClonePath, resolveLocalPath } from "./paths"
import { applyPiFaveModels } from "./provider-catalog"
import { readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"
import { installSkill, listGlobalSkillsWithSources, listInstalledSkills, searchSkills, uninstallSkill } from "./skills"
import { writeStandaloneTranscriptExport } from "./standalone-export"
import { TerminalManager } from "./terminal-manager"
import type { UpdateManager } from "./update-manager"
import type { UsageLimitsManager } from "./usage-limits"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import type {
  LlmProviderSnapshot,
  LlmProviderValidationResult,
  UsageLimitsSnapshot,
} from "../shared/types"

const DEFAULT_CHAT_RECENT_LIMIT = 200


export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
  snapshotSignatures: Map<string, string>
  protectedDraftChatIds?: Set<string>
}

interface CreateWsRouterArgs {
  store: EventStore
  diffStore: Pick<DiffStore, "getProjectSnapshot" | "getSnapshotVersion" | "refreshSnapshot" | "initializeGit" | "getGitHubPublishInfo" | "checkGitHubRepoAvailability" | "publishToGitHub" | "listBranches" | "previewMergeBranch" | "mergeBranch" | "syncBranch" | "checkoutBranch" | "createBranch" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile" | "readPatch">
  agent: AgentCoordinator
  terminals: TerminalManager
  keybindings: KeybindingsManager
  appSettings: Pick<AppSettingsManager, "getSnapshot" | "write" | "writePatch" | "onChange">
  analytics?: AnalyticsReporter
  llmProvider: {
    read: () => Promise<LlmProviderSnapshot>
    write: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>) => Promise<LlmProviderSnapshot>
    validate: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  }
  refreshDiscovery: () => Promise<DiscoveredProject[]>
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager | null
  usageLimits?: Pick<UsageLimitsManager, "getSnapshot" | "refresh" | "onChange"> | null
}

interface SnapshotBroadcastFilter {
  includeSidebar?: boolean
  includeLocalProjects?: boolean
  includeUpdate?: boolean
  includeKeybindings?: boolean
  includeAppSettings?: boolean
  includeUsageLimits?: boolean
  chatIds?: Set<string>
  projectIds?: Set<string>
  terminalIds?: Set<string>
}

interface SnapshotComputationCache {
  sidebar?: {
    data: ReturnType<typeof deriveSidebarData>
    signature: string
  }
  /** Serialized chat snapshots keyed by `chatId:recentLimit`, shared across sockets in one broadcast. */
  chat?: Map<string, string>
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  const payload = JSON.stringify(message)
  ws.send(payload)
  return payload.length
}

/**
 * Send a snapshot whose body was already serialized once for this broadcast,
 * so N subscribers cost one JSON.stringify instead of N.
 */
function sendSerializedSnapshot(ws: ServerWebSocket<ClientState>, id: string, snapshotJson: string) {
  ws.send(`{"v":${PROTOCOL_VERSION},"type":"snapshot","id":${JSON.stringify(id)},"snapshot":${snapshotJson}}`)
}

function ensureSnapshotSignatures(ws: ServerWebSocket<ClientState>) {
  if (!ws.data.snapshotSignatures) {
    ws.data.snapshotSignatures = new Map()
  }

  return ws.data.snapshotSignatures
}

export function createWsRouter({
  store,
  diffStore,
  agent,
  terminals,
  keybindings,
  appSettings,
  analytics,
  llmProvider,
  refreshDiscovery,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
  usageLimits,
}: CreateWsRouterArgs) {
  const sockets = new Set<ServerWebSocket<ClientState>>()
  let pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  let pendingBroadcastAll = false
  const pendingBroadcastChatIds = new Set<string>()
  const resolvedAnalytics = analytics ?? NoopAnalyticsReporter

  function getProtectedChatIds() {
    const activeStatuses = agent.getActiveStatuses()
    const drainingChatIds = typeof agent.getDrainingChatIds === "function"
      ? agent.getDrainingChatIds()
      : new Set<string>()
    return new Set([
      ...activeStatuses.keys(),
      ...drainingChatIds.values(),
    ])
  }

  function getProtectedDraftChatIds(extraSockets?: Iterable<ServerWebSocket<ClientState>>) {
    const protectedChatIds = new Set<string>()

    for (const socket of sockets) {
      for (const chatId of socket.data.protectedDraftChatIds ?? []) {
        protectedChatIds.add(chatId)
      }
    }

    for (const socket of extraSockets ?? []) {
      for (const chatId of socket.data.protectedDraftChatIds ?? []) {
        protectedChatIds.add(chatId)
      }
    }

    return protectedChatIds
  }

  async function maybePruneStaleEmptyChats(extraSockets?: Iterable<ServerWebSocket<ClientState>>) {
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    return await store.pruneStaleEmptyChats({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
  }

  async function maybeAutoArchiveStaleChats(extraSockets?: Iterable<ServerWebSocket<ClientState>>) {
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    return await store.autoArchiveStaleChats({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
  }

  async function maybeDeleteStaleChats(extraSockets?: Iterable<ServerWebSocket<ClientState>>) {
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    return await store.deleteStaleChats({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
  }

  function shouldIncludeTopic(topic: SubscriptionTopic, filter?: SnapshotBroadcastFilter) {
    if (!filter) {
      return true
    }

    if (topic.type === "sidebar") {
      return Boolean(filter.includeSidebar)
    }
    if (topic.type === "local-projects") {
      return Boolean(filter.includeLocalProjects)
    }
    if (topic.type === "update") {
      return Boolean(filter.includeUpdate)
    }
    if (topic.type === "keybindings") {
      return Boolean(filter.includeKeybindings)
    }
    if (topic.type === "app-settings") {
      return Boolean(filter.includeAppSettings)
    }
    if (topic.type === "usage-limits") {
      return Boolean(filter.includeUsageLimits)
    }
    if (topic.type === "chat") {
      return filter.chatIds?.has(topic.chatId) ?? false
    }
    if (topic.type === "project-git") {
      return filter.projectIds?.has(topic.projectId) ?? false
    }
    if (topic.type === "terminal") {
      return filter.terminalIds?.has(topic.terminalId) ?? false
    }

    return true
  }

  function getSidebarSnapshotCacheEntry(cache?: SnapshotComputationCache) {
    if (cache?.sidebar) {
      return cache.sidebar
    }

    const activeStatuses = agent.getActiveStatuses()
    const pendingToolKinds = new Map<string, string>()
    for (const [chatId, status] of activeStatuses) {
      if (status !== "waiting_for_user") continue
      const pendingTool = agent.getPendingTool(chatId)
      if (pendingTool) pendingToolKinds.set(chatId, pendingTool.toolKind)
    }
    const data = deriveSidebarData(store.state, activeStatuses, {
      sidebarProjectOrder: store.getSidebarProjectOrder(),
      drainingChatIds: agent.getDrainingChatIds(),
      pendingToolKinds,
    })

    const sidebar = {
      data,
      signature: JSON.stringify({
        type: "sidebar" as const,
        data,
      }),
    }

    if (cache) {
      cache.sidebar = sidebar
    }

    return sidebar
  }

  function getProjectGitSignature(projectId: string): string {
    return store.getProject(projectId)
      ? `project-git:${projectId}:v${diffStore.getSnapshotVersion(projectId)}`
      : `project-git:${projectId}:none`
  }

  function createEnvelope(id: string, topic: SubscriptionTopic, cache?: SnapshotComputationCache): ServerEnvelope {
    if (topic.type === "sidebar") {
      const sidebar = getSidebarSnapshotCacheEntry(cache)
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "sidebar",
          data: sidebar.data,
        },
      }
    }

    if (topic.type === "local-projects") {
      const discoveredProjects = getDiscoveredProjects()
      const data = deriveLocalProjectsSnapshot(store.state, discoveredProjects, machineDisplayName)

      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "local-projects",
          data,
        },
      }
    }

    if (topic.type === "keybindings") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "keybindings",
          data: keybindings.getSnapshot(),
        },
      }
    }

    if (topic.type === "app-settings") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "app-settings",
          data: appSettings.getSnapshot(),
        },
      }
    }

    if (topic.type === "usage-limits") {
      const data: UsageLimitsSnapshot = usageLimits?.getSnapshot() ?? { providers: [] }
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "usage-limits",
          data,
        },
      }
    }

    if (topic.type === "update") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "update",
          data: updateManager?.getSnapshot() ?? {
            currentVersion: "unknown",
            latestVersion: null,
            status: "idle",
            updateAvailable: false,
            lastCheckedAt: null,
            error: null,
            installAction: "restart",
            reloadRequestedAt: null,
          },
        },
      }
    }

    if (topic.type === "terminal") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "terminal",
          data: terminals.getSnapshot(topic.terminalId),
        },
      }
    }

    if (topic.type === "project-git") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "project-git",
          data: store.getProject(topic.projectId)
            ? diffStore.getProjectSnapshot(topic.projectId)
            : null,
        },
      }
    }

    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id,
      snapshot: {
        type: "chat",
        data: deriveChatSnapshot(
          store.state,
          agent.getActiveStatuses(),
          agent.getDrainingChatIds(),
          topic.chatId,
          (chatId) => store.getRecentChatHistory(chatId, topic.recentLimit ?? DEFAULT_CHAT_RECENT_LIMIT)
        ),
      },
    }
  }

  function getChatSnapshotJson(chatId: string, recentLimit: number | undefined, cache?: SnapshotComputationCache) {
    const limit = recentLimit ?? DEFAULT_CHAT_RECENT_LIMIT
    const key = `${chatId}:${limit}`
    const existing = cache?.chat?.get(key)
    if (existing !== undefined) {
      return existing
    }
    const data = deriveChatSnapshot(
      store.state,
      agent.getActiveStatuses(),
      agent.getDrainingChatIds(),
      chatId,
      (id) => store.getRecentChatHistory(id, limit)
    )
    const snapshotJson = JSON.stringify({ type: "chat", data })
    if (cache) {
      (cache.chat ??= new Map()).set(key, snapshotJson)
    }
    return snapshotJson
  }

  async function pushSnapshots(
    ws: ServerWebSocket<ClientState>,
    options?: { skipPrune?: boolean; filter?: SnapshotBroadcastFilter; cache?: SnapshotComputationCache }
  ) {
    if (!options?.skipPrune) {
      await maybePruneStaleEmptyChats([ws])
    }
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      if (!shouldIncludeTopic(topic, options?.filter)) {
        continue
      }
      // Sidebar and chat snapshots are serialized once per broadcast (shared
      // via the cache) and that serialization doubles as the dedupe signature,
      // so unchanged snapshots cost neither a derive nor a stringify per
      // socket, and changed ones are stringified exactly once.
      if (topic.type === "sidebar") {
        const sidebar = getSidebarSnapshotCacheEntry(options?.cache)
        if (snapshotSignatures.get(id) === sidebar.signature) {
          continue
        }
        snapshotSignatures.set(id, sidebar.signature)
        sendSerializedSnapshot(ws, id, sidebar.signature)
        continue
      }
      if (topic.type === "chat") {
        const snapshotJson = getChatSnapshotJson(topic.chatId, topic.recentLimit, options?.cache)
        if (snapshotSignatures.get(id) === snapshotJson) {
          continue
        }
        snapshotSignatures.set(id, snapshotJson)
        sendSerializedSnapshot(ws, id, snapshotJson)
        continue
      }
      // project-git has a cheap version-counter signature, so an unchanged
      // snapshot (e.g. thousands of diff files) skips payload building entirely.
      const precomputedSignature = topic.type === "project-git"
        ? getProjectGitSignature(topic.projectId)
        : null
      if (precomputedSignature !== null && snapshotSignatures.get(id) === precomputedSignature) {
        continue
      }
      const envelope = createEnvelope(id, topic, options?.cache)
      if (envelope.type !== "snapshot") continue
      const signature = precomputedSignature ?? JSON.stringify(envelope.snapshot)
      if (snapshotSignatures.get(id) === signature) {
        continue
      }
      snapshotSignatures.set(id, signature)
      send(ws, envelope)
    }
  }

  async function broadcastSnapshots() {
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      await pushSnapshots(ws, { skipPrune: true, cache })
    }
  }

  async function broadcastFilteredSnapshots(filter: SnapshotBroadcastFilter) {
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      await pushSnapshots(ws, { skipPrune: true, filter, cache })
    }
  }

  function flushPendingBroadcast() {
    pendingBroadcastTimer = null
    const shouldBroadcastAll = pendingBroadcastAll
    const chatIds = new Set(pendingBroadcastChatIds)
    pendingBroadcastAll = false
    pendingBroadcastChatIds.clear()
    if (shouldBroadcastAll) {
      void broadcastSnapshots()
      return
    }
    if (chatIds.size > 0) {
      void broadcastFilteredSnapshots({
        includeSidebar: true,
        chatIds,
      })
    }
  }

  function armPendingBroadcastTimer() {
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(flushPendingBroadcast, 16)
  }

  function scheduleBroadcast() {
    pendingBroadcastAll = true
    pendingBroadcastChatIds.clear()
    armPendingBroadcastTimer()
  }

  function scheduleChatStateBroadcast(chatId: string) {
    if (!pendingBroadcastAll) {
      pendingBroadcastChatIds.add(chatId)
    }
    armPendingBroadcastTimer()
  }

  async function broadcastChatAndSidebar(chatId: string) {
    await broadcastFilteredSnapshots({
      includeSidebar: true,
      chatIds: new Set([chatId]),
    })
  }

  async function broadcastChatStateImmediately(chatId: string) {
    await broadcastChatAndSidebar(chatId)
  }

  function broadcastError(message: string) {
    for (const ws of sockets) {
      send(ws, {
        v: PROTOCOL_VERSION,
        type: "error",
        message,
      })
    }
  }

  function pushTerminalSnapshot(terminalId: string) {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }

  function pushTerminalEvent(terminalId: string, event: Extract<ServerEnvelope, { type: "event" }>["event"]) {
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        send(ws, {
          v: PROTOCOL_VERSION,
          type: "event",
          id,
          event,
        })
      }
    }
  }

  const disposeTerminalEvents = terminals.onEvent((event) => {
    pushTerminalEvent(event.terminalId, event)
  })

  const disposeKeybindingEvents = keybindings.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "keybindings") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  })

  const disposeAppSettingsEvents = appSettings.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "app-settings") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  })

  const disposeUpdateEvents = updateManager?.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "update") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }) ?? (() => {})

  const disposeUsageLimitsEvents = usageLimits?.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "usage-limits") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }) ?? (() => {})

  agent.setBackgroundErrorReporter?.(broadcastError)

  function resolveChatProject(chatId: string) {
    const chat = store.getChat(chatId)
    if (!chat) throw new Error("Chat not found")
    const project = store.getProject(chat.projectId)
    if (!project) throw new Error("Project not found")
    return { chat, project }
  }

  /**
   * Shared shape for the chat-scoped git commands: resolve the chat's project,
   * run the diff-store operation, ack (with the result when one is produced),
   * and fire-and-forget a full snapshot broadcast when the operation reports
   * the git snapshot changed.
   */
  async function handleChatGitCommand(
    ws: ServerWebSocket<ClientState>,
    id: string,
    chatId: string,
    run: (project: ReturnType<typeof resolveChatProject>["project"]) => Promise<{ result?: unknown; changed?: boolean }>,
  ) {
    const { project } = resolveChatProject(chatId)
    const { result, changed } = await run(project)
    if (result === undefined) {
      send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
    } else {
      send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
    }
    if (changed) {
      void broadcastSnapshots()
    }
  }

  async function handleCommand(ws: ServerWebSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    try {
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "fs.list": {
          const result = await listDirectory(command.path, { nearest: command.nearest })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "fs.mkdir": {
          const result = await createDirectory(command.path)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "browser.listLocalHttpServers": {
          const project = command.projectId ? store.getProject(command.projectId) : null
          const result = await listLocalHttpServers({
            projectPath: project?.localPath,
            projectTerminalRootPids: project ? terminals.getRootPidsByCwd(project.localPath) : [],
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "browser.killLocalHttpServer": {
          const result = await killLocalHttpServer(command.port)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.readQuickActions": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await readProjectQuickActions(project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.writeQuickActions": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await writeProjectQuickActions(project.localPath, command.quickActions)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "update.check": {
          const snapshot = updateManager
            ? await updateManager.checkForUpdates({ force: command.force })
            : {
                currentVersion: "unknown",
                latestVersion: null,
                status: "error",
                updateAvailable: false,
                lastCheckedAt: Date.now(),
                error: "Update manager unavailable.",
                installAction: "restart",
                reloadRequestedAt: null,
              }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "update.install": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.installUpdate()
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result,
          })
          return
        }
        case "settings.readKeybindings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: keybindings.getSnapshot() })
          return
        }
        case "settings.writeKeybindings": {
          const snapshot = await keybindings.write(command.bindings)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "settings.readAppSettings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: appSettings.getSnapshot() })
          return
        }
        case "usage.refresh": {
          if (usageLimits) {
            // Auto-refresh (page/palette open) respects the read TTL; the
            // manual Refresh button forces past it.
            await usageLimits.refresh({ force: command.force ?? false })
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: usageLimits.getSnapshot() })
          } else {
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { providers: [] } satisfies UsageLimitsSnapshot })
          }
          return
        }
        case "settings.writeAppSettings": {
          const previousAnalyticsEnabled = appSettings.getSnapshot().analyticsEnabled
          if (previousAnalyticsEnabled && !command.analyticsEnabled) {
            resolvedAnalytics.track("analytics_disabled")
          }
          const snapshot = await appSettings.write({ analyticsEnabled: command.analyticsEnabled })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          if (!previousAnalyticsEnabled && command.analyticsEnabled) {
            resolvedAnalytics.track("analytics_enabled")
          }
          return
        }
        case "settings.writeAppSettingsPatch": {
          const previousAnalyticsEnabled = appSettings.getSnapshot().analyticsEnabled
          const snapshot = await appSettings.writePatch(command.patch)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          if (command.patch.analyticsEnabled !== undefined && previousAnalyticsEnabled && !snapshot.analyticsEnabled) {
            resolvedAnalytics.track("analytics_disabled")
          }
          if (command.patch.analyticsEnabled !== undefined && !previousAnalyticsEnabled && snapshot.analyticsEnabled) {
            resolvedAnalytics.track("analytics_enabled")
          }
          return
        }
        case "settings.readLlmProvider": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: await llmProvider.read() })
          return
        }
        case "settings.writeLlmProvider": {
          const snapshot = await llmProvider.write({
            provider: command.provider,
            apiKey: command.apiKey,
            model: command.model,
            baseUrl: command.baseUrl,
            // Writers that don't manage faves must not wipe the saved list.
            faveModels: command.faveModels ?? (await llmProvider.read()).faveModels,
          })
          // Fave models feed the pi provider's model picker, which clients read
          // from chat snapshots — refresh them when the catalog changes.
          if (applyPiFaveModels(snapshot.faveModels)) {
            void broadcastSnapshots()
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "settings.validateLlmProvider": {
          const result = await llmProvider.validate({
            provider: command.provider,
            apiKey: command.apiKey,
            model: command.model,
            baseUrl: command.baseUrl,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.listSkills": {
          const snapshot = await agent.listSkills(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "skills.search": {
          const snapshot = await searchSkills(command.query, command.limit)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "skills.install": {
          const result = await installSkill(command.source, command.skillId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "skills.uninstall": {
          const result = await uninstallSkill(command.skillId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "skills.listInstalled": {
          const result = await listInstalledSkills()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "skills.listGlobal": {
          const result = await listGlobalSkillsWithSources()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.open": {
          await ensureProjectDirectory(command.localPath)
          const normalizedPath = resolveLocalPath(command.localPath)
          const existingProjectId = store.state.projectIdsByPath.get(normalizedPath)
          const project = await store.openProject(command.localPath)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          if (!existingProjectId) {
            resolvedAnalytics.track("project_opened")
          }
          await broadcastFilteredSnapshots({ includeSidebar: true, includeLocalProjects: true })
          return
        }
        case "project.rename": {
          await store.renameProjectSidebarTitle(command.projectId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "project.clone": {
          const cloneDest = await resolveClonePath(command.localPath, command.fallbackPath)
          await cloneRepository(command.cloneUrl, cloneDest)
          const project = await store.openProject(cloneDest, command.title)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id, localPath: cloneDest } })
          await broadcastFilteredSnapshots({ includeSidebar: true, includeLocalProjects: true })
          return
        }
        case "project.remove": {
          await store.removeProject(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          resolvedAnalytics.track("project_removed")
          // Removing a project tombstones its chats too, so subscribers of any
          // topic may need fresh state.
          await broadcastSnapshots()
          return
        }
        case "sidebar.reorderProjectGroups": {
          await store.setSidebarProjectOrder(command.projectIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "project.readDiffPatch": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await diffStore.readPatch({
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "system.openExternal": {
          await openExternal(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.create": {
          const chat = await store.createChat(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { chatId: chat.id } })
          resolvedAnalytics.track("chat_created")
          // Adding a chat changes local-projects too (chatCount/lastOpenedAt).
          await broadcastFilteredSnapshots({
            includeSidebar: true,
            includeLocalProjects: true,
            chatIds: new Set([chat.id]),
          })
          return
        }
        case "chat.fork": {
          const result = await agent.forkChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastFilteredSnapshots({ includeSidebar: true, includeLocalProjects: true })
          return
        }
        case "chat.rename": {
          await store.renameChat(command.chatId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.archive": {
          // Archiving a chat that never got a message is a hard delete — an
          // empty chat has nothing worth keeping in the Archived list.
          const chat = store.getChat(command.chatId)
          const hardDeleted = chat != null && !chat.hasMessages && !chat.lastMessageAt
          if (hardDeleted) {
            await store.deleteChat(command.chatId)
          } else {
            await store.archiveChat(command.chatId)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          // Archiving removes the chat from local-projects' chat counts; a hard
          // delete must also refresh the chat's own topic (to null) so a tab
          // viewing it learns it's gone.
          await broadcastFilteredSnapshots({
            includeSidebar: true,
            includeLocalProjects: true,
            ...(hardDeleted ? { chatIds: new Set([command.chatId]) } : {}),
          })
          return
        }
        case "chat.unarchive": {
          await store.unarchiveChat(command.chatId)
          // Unarchiving is the explicit "Restore" action (viewing an archived
          // chat no longer unarchives it). Mark it done so restoring alone
          // doesn't resurface it as needing review; sending a message clears
          // the done state and brings it back to running.
          await store.setChatDoneState(command.chatId, true)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({
            includeSidebar: true,
            includeLocalProjects: true,
            chatIds: new Set([command.chatId]),
          })
          return
        }
        case "chat.delete": {
          await agent.cancel(command.chatId)
          await agent.closeChat(command.chatId)
          await store.deleteChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          resolvedAnalytics.track("chat_deleted")
          // The deleted chat's own topic must refresh (to null) so another tab
          // viewing it learns it's gone, and local-projects loses the chat.
          await broadcastFilteredSnapshots({
            includeSidebar: true,
            includeLocalProjects: true,
            chatIds: new Set([command.chatId]),
          })
          return
        }
        case "chat.markRead": {
          await store.setChatReadState(command.chatId, false)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.setDone": {
          await store.setChatDoneState(command.chatId, command.done)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.setDraftProtection": {
          // Only adjusts this socket's prune protection — no snapshot changes.
          ws.data.protectedDraftChatIds = new Set(command.chatIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.send": {
          const result = await agent.send(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.refreshDiffs": {
          // Acks without a result; broadcasts when the refresh reported a change.
          await handleChatGitCommand(ws, id, command.chatId, async (project) => ({
            changed: await diffStore.refreshSnapshot(project.id, project.localPath),
          }))
          return
        }
        case "chat.initGit": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.initializeGit({
              projectId: project.id,
              projectPath: project.localPath,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.getGitHubPublishInfo": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => ({
            result: await diffStore.getGitHubPublishInfo({
              projectPath: project.localPath,
            }),
          }))
          return
        }
        case "chat.checkGitHubRepoAvailability": {
          const result = await diffStore.checkGitHubRepoAvailability({
            owner: command.owner,
            name: command.name,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.publishToGitHub": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.publishToGitHub({
              projectId: project.id,
              projectPath: project.localPath,
              owner: command.owner,
              name: command.name,
              visibility: command.visibility,
              description: command.description,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.listBranches": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => ({
            result: await diffStore.listBranches({
              projectPath: project.localPath,
            }),
          }))
          return
        }
        case "chat.previewMergeBranch": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => ({
            result: await diffStore.previewMergeBranch({
              projectPath: project.localPath,
              branch: command.branch,
            }),
          }))
          return
        }
        case "chat.mergeBranch": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.mergeBranch({
              projectId: project.id,
              projectPath: project.localPath,
              branch: command.branch,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.checkoutBranch": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.checkoutBranch({
              projectId: project.id,
              projectPath: project.localPath,
              branch: command.branch,
              bringChanges: command.bringChanges,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.syncBranch": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.syncBranch({
              projectId: project.id,
              projectPath: project.localPath,
              action: command.action,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.createBranch": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.createBranch({
              projectId: project.id,
              projectPath: project.localPath,
              name: command.name,
              baseBranchName: command.baseBranchName,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.generateCommitMessage": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => ({
            result: await diffStore.generateCommitMessage({
              projectPath: project.localPath,
              paths: command.paths,
            }),
          }))
          return
        }
        case "chat.commitDiffs": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.commitFiles({
              projectId: project.id,
              projectPath: project.localPath,
              paths: command.paths,
              summary: command.summary,
              description: command.description,
              mode: command.mode,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.discardDiffFile": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.discardFile({
              projectId: project.id,
              projectPath: project.localPath,
              path: command.path,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.ignoreDiffFile": {
          await handleChatGitCommand(ws, id, command.chatId, async (project) => {
            const result = await diffStore.ignoreFile({
              projectId: project.id,
              projectPath: project.localPath,
              path: command.path,
            })
            return { result, changed: result.snapshotChanged }
          })
          return
        }
        case "chat.cancel": {
          await agent.cancel(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.stopDraining": {
          await agent.stopDraining(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.exportStandalone": {
          const { chat, project } = resolveChatProject(command.chatId)
          const result = await writeStandaloneTranscriptExport({
            chatId: chat.id,
            title: chat.title,
            localPath: project.localPath,
            theme: command.theme,
            attachmentMode: command.attachmentMode,
            messages: store.getMessages(command.chatId),
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.loadHistory": {
          const chat = store.getChat(command.chatId)
          if (!chat) throw new Error("Chat not found")
          const page = store.getMessagesPageBefore(command.chatId, command.beforeCursor, command.limit)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: page })
          return
        }
        case "chat.respondTool": {
          await agent.respondTool(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "message.enqueue": {
          const result = await agent.enqueue(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "message.steer": {
          await agent.steer(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "message.dequeue": {
          await agent.dequeue(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "terminal.create": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const snapshot = terminals.createTerminal({
            projectPath: project.localPath,
            terminalId: command.terminalId,
            cols: command.cols,
            rows: command.rows,
            scrollback: command.scrollback,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "terminal.input": {
          terminals.write(command.terminalId, command.data)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "terminal.resize": {
          terminals.resize(command.terminalId, command.cols, command.rows)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "terminal.close": {
          terminals.close(command.terminalId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          pushTerminalSnapshot(command.terminalId)
          return
        }
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error("[ws-router] command failed", {
        id,
        type: command.type,
        message: messageText,
      })
      send(ws, { v: PROTOCOL_VERSION, type: "error", id, message: messageText })
    }
  }

  return {
    handleOpen(ws: ServerWebSocket<ClientState>) {
      sockets.add(ws)
    },
    handleClose(ws: ServerWebSocket<ClientState>) {
      sockets.delete(ws)
    },
    broadcastSnapshots,
    broadcastChatStateImmediately,
    scheduleBroadcast,
    scheduleChatStateBroadcast,
    pruneStaleEmptyChats: () => maybePruneStaleEmptyChats(),
    autoArchiveStaleChats: () => maybeAutoArchiveStaleChats(),
    deleteStaleChats: () => maybeDeleteStaleChats(),
    async handleMessage(ws: ServerWebSocket<ClientState>, raw: string | Buffer | ArrayBuffer | Uint8Array) {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid JSON" })
        return
      }

      if (!isClientEnvelope(parsed)) {
        send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid envelope" })
        return
      }

      if (parsed.type === "subscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.set(parsed.id, parsed.topic)
        snapshotSignatures.delete(parsed.id)
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              void pushSnapshots(ws, { skipPrune: true })
            }
          })
          return
        }
        await pushSnapshots(ws, { skipPrune: true })
        // Kick a fresh usage read on subscribe so the page opens accurate;
        // the onChange fanout delivers the result to all subscribers.
        if (parsed.topic.type === "usage-limits" && usageLimits) {
          void usageLimits.refresh().catch(() => undefined)
        }
        return
      }

      if (parsed.type === "unsubscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.delete(parsed.id)
        snapshotSignatures.delete(parsed.id)
        send(ws, { v: PROTOCOL_VERSION, type: "ack", id: parsed.id })
        return
      }

      await handleCommand(ws, parsed)
    },
    dispose() {
      if (pendingBroadcastTimer) {
        clearTimeout(pendingBroadcastTimer)
      }
      agent.setBackgroundErrorReporter?.(null)
      disposeTerminalEvents()
      disposeKeybindingEvents()
      disposeAppSettingsEvents()
      disposeUpdateEvents()
      disposeUsageLimitsEvents()
    },
  }
}

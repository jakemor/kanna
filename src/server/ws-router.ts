import type { ServerWebSocket } from "bun"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientEnvelope, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { isClientEnvelope } from "../shared/protocol"
import type { AgentCoordinator } from "./agent"
import type { DiscoveredProject } from "./discovery"
import { DiffStore } from "./diff-store"
import { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import { KeybindingsManager } from "./keybindings"
import { ensureProjectDirectory } from "./paths"
import { TerminalManager } from "./terminal-manager"
import type { UpdateManager } from "./update-manager"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import type { LlmProviderSnapshot } from "../shared/types"
import type { LlmProviderValidationResult } from "../shared/types"
import { importClaudeSessions } from "./claude-session-importer"

const DEFAULT_CHAT_RECENT_LIMIT = 200

function isSendToStartingProfilingEnabled() {
  return process.env.KANNA_PROFILE_SEND_TO_STARTING === "1"
}

function logSendToStartingProfile(
  traceId: string | null | undefined,
  startedAt: number | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!traceId || startedAt === undefined || startedAt === null || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[kanna/send->starting][server]", JSON.stringify({
    traceId,
    stage,
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    ...details,
  }))
}

function countSubscriptionsByTopic(ws: ServerWebSocket<ClientState>) {
  let sidebar = 0
  let chat = 0
  let projectGit = 0
  let localProjects = 0
  let update = 0
  let keybindings = 0
  let terminal = 0

  for (const topic of ws.data.subscriptions.values()) {
    switch (topic.type) {
      case "sidebar":
        sidebar += 1
        break
      case "chat":
        chat += 1
        break
      case "project-git":
        projectGit += 1
        break
      case "local-projects":
        localProjects += 1
        break
      case "update":
        update += 1
        break
      case "keybindings":
        keybindings += 1
        break
      case "terminal":
        terminal += 1
        break
    }
  }

  return {
    total: ws.data.subscriptions.size,
    sidebar,
    chat,
    projectGit,
    localProjects,
    update,
    keybindings,
    terminal,
  }
}

export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
  snapshotSignatures: Map<string, string>
  protectedDraftChatIds?: Set<string>
}

interface CreateWsRouterArgs {
  store: EventStore
  diffStore?: Pick<DiffStore, "getProjectSnapshot" | "refreshSnapshot" | "initializeGit" | "getGitHubPublishInfo" | "checkGitHubRepoAvailability" | "publishToGitHub" | "listBranches" | "previewMergeBranch" | "mergeBranch" | "syncBranch" | "checkoutBranch" | "createBranch" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile" | "readPatch">
  agent: AgentCoordinator
  terminals: TerminalManager
  keybindings: KeybindingsManager
  llmProvider?: {
    read: () => Promise<LlmProviderSnapshot>
    write: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderSnapshot>
    validate: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  }
  refreshDiscovery: () => Promise<DiscoveredProject[]>
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager | null
}

interface SnapshotBroadcastFilter {
  includeSidebar?: boolean
  includeLocalProjects?: boolean
  includeUpdate?: boolean
  includeKeybindings?: boolean
  chatIds?: Set<string>
  projectIds?: Set<string>
  terminalIds?: Set<string>
}

interface SnapshotComputationCache {
  sidebar?: {
    data: ReturnType<typeof deriveSidebarData>
    signature: string
  }
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  const payload = JSON.stringify(message)
  ws.send(payload)
  return payload.length
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
  llmProvider,
  refreshDiscovery,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
}: CreateWsRouterArgs) {
  const sockets = new Set<ServerWebSocket<ClientState>>()
  let pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  let pendingBroadcastAll = false
  const pendingBroadcastChatIds = new Set<string>()
  const resolvedDiffStore = diffStore ?? {
    getProjectSnapshot: () => ({ status: "unknown", branchName: undefined, defaultBranchName: undefined, hasOriginRemote: undefined, originRepoSlug: undefined, hasUpstream: undefined, aheadCount: undefined, behindCount: undefined, lastFetchedAt: undefined, files: [] as const, branchHistory: { entries: [] as const } }),
    refreshSnapshot: async () => false,
    initializeGit: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    getGitHubPublishInfo: async () => ({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined, owners: [], suggestedRepoName: "my-repo" }),
    checkGitHubRepoAvailability: async () => ({ available: false, message: "Unavailable" }),
    publishToGitHub: async () => ({ ok: false, title: "Publish failed", message: "Unavailable", snapshotChanged: false }),
    listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" as const }),
    previewMergeBranch: async () => ({ currentBranchName: undefined, targetBranchName: "", targetDisplayName: "", status: "error" as const, commitCount: 0, hasConflicts: false, message: "Merge preview unavailable." }),
    mergeBranch: async () => ({ ok: false as const, title: "Merge failed", message: "Merge unavailable.", snapshotChanged: false }),
    syncBranch: async () => ({ ok: true, action: "fetch" as const, branchName: undefined, snapshotChanged: false }),
    checkoutBranch: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
    generateCommitMessage: async () => ({ subject: "Update selected files", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: async () => ({ ok: true, mode: "commit_only" as const, branchName: undefined, pushed: false, snapshotChanged: false }),
    discardFile: async () => ({ snapshotChanged: false }),
    ignoreFile: async () => ({ snapshotChanged: false }),
    readPatch: async () => ({ patch: "" }),
  }
  const resolvedLlmProvider = llmProvider ?? {
    read: async () => ({
      provider: "openai" as const,
      apiKey: "",
      model: "gpt-5.4-mini",
      baseUrl: "",
      resolvedBaseUrl: "https://api.openai.com/v1",
      enabled: false,
      warning: null,
      filePathDisplay: "~/.kanna/llm-provider.json",
    }),
    write: async ({ provider, apiKey, model, baseUrl }: {
      provider: "openai" | "openrouter" | "custom"
      apiKey: string
      model: string
      baseUrl: string
    }) => ({
      provider,
      apiKey,
      model,
      baseUrl,
      resolvedBaseUrl: provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : provider === "custom"
          ? baseUrl
          : "https://api.openai.com/v1",
      enabled: false,
      warning: null,
      filePathDisplay: "~/.kanna/llm-provider.json",
    }),
    validate: async () => ({
      ok: false,
      error: {
        type: "config_error",
        message: "LLM provider validation unavailable.",
      },
    }),
  }

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
    const startedAt = performance.now()
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    const prunedChatIds = await store.pruneStaleEmptyChats?.({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.prune_stale_empty_chats",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        activeChatCount: activeChatIds.size,
        protectedDraftChatCount: protectedDraftChatIds.size,
        prunedCount: prunedChatIds?.length ?? 0,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }
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

    const startedAt = performance.now()
    const data = deriveSidebarData(store.state, agent.getActiveStatuses())
    if (isSendToStartingProfilingEnabled()) {
      const totalChats = data.projectGroups.reduce((count, group) => count + group.chats.length, 0)
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.sidebar_snapshot_built",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        projectGroupCount: data.projectGroups.length,
        chatCount: totalChats,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }

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
            ? resolvedDiffStore.getProjectSnapshot(topic.projectId)
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
          agent.getSlashCommandsLoadingChatIds(),
          topic.chatId,
          (chatId) => store.getRecentChatHistory(chatId, topic.recentLimit ?? DEFAULT_CHAT_RECENT_LIMIT)
        ),
      },
    }
  }

  async function pushSnapshots(
    ws: ServerWebSocket<ClientState>,
    options?: { skipPrune?: boolean; filter?: SnapshotBroadcastFilter; cache?: SnapshotComputationCache }
  ) {
    const pushStartedAt = performance.now()
    if (!options?.skipPrune) {
      await maybePruneStaleEmptyChats([ws])
    }
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    let sentCount = 0
    let skippedCount = 0
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      if (!shouldIncludeTopic(topic, options?.filter)) {
        continue
      }
      const envelopeStartedAt = performance.now()
      const envelope = createEnvelope(id, topic, options?.cache)
      const createdAt = performance.now()
      if (envelope.type !== "snapshot") continue
      const signature = topic.type === "sidebar"
        ? getSidebarSnapshotCacheEntry(options?.cache).signature
        : JSON.stringify(envelope.snapshot)
      const signatureReadyAt = topic.type === "sidebar" ? createdAt : performance.now()
      if (snapshotSignatures.get(id) === signature) {
        skippedCount += 1
        continue
      }
      snapshotSignatures.set(id, signature)
      if (topic.type === "chat" && envelope.snapshot.type === "chat" && envelope.snapshot.data?.runtime.status === "starting") {
        const profile = agent.getActiveTurnProfile(topic.chatId)
        logSendToStartingProfile(profile?.traceId, profile?.startedAt, "ws.snapshot_sent", {
          chatId: topic.chatId,
          status: envelope.snapshot.data.runtime.status,
          messageCount: envelope.snapshot.data.messages.length,
          buildMs: Number((createdAt - envelopeStartedAt).toFixed(1)),
          signatureMs: Number((signatureReadyAt - createdAt).toFixed(1)),
          signatureBytes: signature.length,
        })
      }
      const payloadBytes = send(ws, envelope)
      sentCount += 1
      if (topic.type === "chat" && envelope.snapshot.type === "chat" && envelope.snapshot.data?.runtime.status === "starting") {
        const profile = agent.getActiveTurnProfile(topic.chatId)
        logSendToStartingProfile(profile?.traceId, profile?.startedAt, "ws.snapshot_send_completed", {
          chatId: topic.chatId,
          payloadBytes,
        })
      }
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.push_snapshots_completed",
        elapsedMs: Number((performance.now() - pushStartedAt).toFixed(1)),
        skipPrune: Boolean(options?.skipPrune),
        sentCount,
        skippedCount,
        ...countSubscriptionsByTopic(ws),
      }))
    }
  }

  async function broadcastSnapshots() {
    const startedAt = performance.now()
    let socketCount = 0
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      socketCount += 1
      await pushSnapshots(ws, { skipPrune: true, cache })
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.broadcast_snapshots_completed",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        pruneMs: 0,
        socketCount,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }
  }

  async function broadcastFilteredSnapshots(filter: SnapshotBroadcastFilter) {
    const startedAt = performance.now()
    let socketCount = 0
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      socketCount += 1
      await pushSnapshots(ws, { skipPrune: true, filter, cache })
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.broadcast_filtered_snapshots_completed",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        socketCount,
        includeSidebar: Boolean(filter.includeSidebar),
        chatCount: filter.chatIds?.size ?? 0,
        projectCount: filter.projectIds?.size ?? 0,
      }))
    }
  }

  function scheduleBroadcast() {
    pendingBroadcastAll = true
    pendingBroadcastChatIds.clear()
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(() => {
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
    }, 16)
  }

  function scheduleChatStateBroadcast(chatId: string) {
    if (!pendingBroadcastAll) {
      pendingBroadcastChatIds.add(chatId)
    }
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(() => {
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
    }, 16)
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

  agent.setBackgroundErrorReporter?.(broadcastError)

  function resolveChatProject(chatId: string) {
    const chat = store.getChat(chatId)
    if (!chat) throw new Error("Chat not found")
    const project = store.getProject(chat.projectId)
    if (!project) throw new Error("Project not found")
    return { chat, project }
  }

  async function handleCommand(ws: ServerWebSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    try {
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
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
        case "update.reload": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.forceReload()
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
        case "settings.readLlmProvider": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: await resolvedLlmProvider.read() })
          return
        }
        case "settings.writeLlmProvider": {
          const snapshot = await resolvedLlmProvider.write({
            provider: command.provider,
            apiKey: command.apiKey,
            model: command.model,
            baseUrl: command.baseUrl,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "settings.validateLlmProvider": {
          const result = await resolvedLlmProvider.validate({
            provider: command.provider,
            apiKey: command.apiKey,
            model: command.model,
            baseUrl: command.baseUrl,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.open": {
          await ensureProjectDirectory(command.localPath)
          const project = await store.openProject(command.localPath)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          break
        }
        case "project.create": {
          await ensureProjectDirectory(command.localPath)
          const project = await store.openProject(command.localPath, command.title)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          break
        }
        case "sessions.importClaude": {
          const result = await importClaudeSessions({ store })
          if (result.newProjects > 0) {
            await refreshDiscovery()
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          break
        }
        case "project.remove": {
          const project = store.getProject(command.projectId)
          for (const chat of store.listChatsByProject(command.projectId)) {
            await agent.cancel(chat.id)
            await agent.closeChat(chat.id)
          }
          if (project) {
            terminals.closeByCwd(project.localPath)
          }
          await store.removeProject(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
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
          const result = await resolvedDiffStore.readPatch({
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "system.openExternal": {
          await openExternal(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.create": {
          const chat = await store.createChat(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { chatId: chat.id } })
          await broadcastChatAndSidebar(chat.id)
          return
        }
        case "chat.rename": {
          await store.renameChat(command.chatId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.delete": {
          await agent.cancel(command.chatId)
          for (const scheduleId of agent.listLiveSchedules(command.chatId)) {
            await agent.cancelAutoContinue(command.chatId, scheduleId, "chat_deleted")
          }
          await agent.closeChat(command.chatId)
          await store.deleteChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "autoContinue.accept": {
          await agent.acceptAutoContinue(command.chatId, command.scheduleId, command.scheduledAt)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "autoContinue.reschedule": {
          await agent.rescheduleAutoContinue(command.chatId, command.scheduleId, command.scheduledAt)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "autoContinue.cancel": {
          await agent.cancelAutoContinue(command.chatId, command.scheduleId, "user")
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.markRead": {
          await store.setChatReadState(command.chatId, false)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.setDraftProtection": {
          ws.data.protectedDraftChatIds = new Set(command.chatIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.send": {
          const result = await agent.send(command)
          const profile = command.clientTraceId && result.chatId
            ? agent.getActiveTurnProfile(result.chatId)
            : null
          logSendToStartingProfile(profile?.traceId ?? command.clientTraceId, profile?.startedAt, "ws.chat_send_ack", {
            chatId: result.chatId ?? null,
          })
          const payloadBytes = send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          logSendToStartingProfile(profile?.traceId ?? command.clientTraceId, profile?.startedAt, "ws.chat_send_ack_completed", {
            chatId: result.chatId ?? null,
            payloadBytes,
          })
          return
        }
        case "chat.refreshDiffs": {
          const { project } = resolveChatProject(command.chatId)
          const changed = await resolvedDiffStore.refreshSnapshot(project.id, project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          if (changed) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.initGit": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.initializeGit({
            projectId: project.id,
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.getGitHubPublishInfo": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.getGitHubPublishInfo({
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.checkGitHubRepoAvailability": {
          const result = await resolvedDiffStore.checkGitHubRepoAvailability({
            owner: command.owner,
            name: command.name,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.publishToGitHub": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.publishToGitHub({
            projectId: project.id,
            projectPath: project.localPath,
            owner: command.owner,
            name: command.name,
            visibility: command.visibility,
            description: command.description,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.listBranches": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.listBranches({
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.previewMergeBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.previewMergeBranch({
            projectPath: project.localPath,
            branch: command.branch,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.mergeBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.mergeBranch({
            projectId: project.id,
            projectPath: project.localPath,
            branch: command.branch,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.checkoutBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.checkoutBranch({
            projectId: project.id,
            projectPath: project.localPath,
            branch: command.branch,
            bringChanges: command.bringChanges,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.syncBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.syncBranch({
            projectId: project.id,
            projectPath: project.localPath,
            action: command.action,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.createBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.createBranch({
            projectId: project.id,
            projectPath: project.localPath,
            name: command.name,
            baseBranchName: command.baseBranchName,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.generateCommitMessage": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.generateCommitMessage({
            projectPath: project.localPath,
            paths: command.paths,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.commitDiffs": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.commitFiles({
            projectId: project.id,
            projectPath: project.localPath,
            paths: command.paths,
            summary: command.summary,
            description: command.description,
            mode: command.mode,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.discardDiffFile": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.discardFile({
            projectId: project.id,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.ignoreDiffFile": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.ignoreFile({
            projectId: project.id,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
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

      await broadcastSnapshots()
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
        if (parsed.topic.type === "chat") {
          void agent.ensureSlashCommandsLoaded(parsed.topic.chatId)
        }
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              void pushSnapshots(ws, { skipPrune: true })
            }
          })
          return
        }
        await pushSnapshots(ws, { skipPrune: true })
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
      disposeUpdateEvents()
    },
  }
}

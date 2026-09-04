import type { ServerWebSocket } from "bun"
import { homedir } from "node:os"
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
import { cloneRepository, createDirectory, ensureProjectDirectory, initializeProjectDirectory, listDirectory, resolveClonePath, resolveLocalPath } from "./paths"
import { listRecentGitHubRepos } from "./github"
import { applyPiFaveModels } from "./provider-catalog"
import { readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"
import { installSkill, listGlobalSkillsWithSources, listInstalledSkills, searchSkills, uninstallSkill } from "./skills"
import { writeStandaloneTranscriptExport } from "./standalone-export"
import { TerminalManager } from "./terminal-manager"
import type { WorktreeProbe } from "./worktree-probe"
import type { ProviderAuthManager } from "./provider-auth"
import type { UpdateManager } from "./update-manager"
import type { UsageLimitsManager } from "./usage-limits"
import { deriveChatSnapshot, deriveChatTouchedFiles, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import type {
  ChatSnapshot,
  LlmProviderSnapshot,
  LlmProviderValidationResult,
  UsageLimitsSnapshot,
  ChatPreview,
} from "../shared/types"


/**
 * Cap on ids per `chat.getToolEntries`. The largest honest request is one tool
 * group's members; beyond that something is walking the transcript.
 */
const MAX_TOOL_ENTRY_REQUEST = 256

/** Coalescing window for transcript pushes — roughly one animation frame. */
const CHAT_BROADCAST_INTERVAL_MS = 16

export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
  snapshotSignatures: Map<string, string>
  /**
   * Absolute transcript span last sent per chat subscription, so the next push
   * can carry only the entries past it. Reset whenever the subscription is
   * (re)created, which is also what makes reconnect safe: a fresh id has no
   * span and therefore gets a full window.
   */
  chatEntrySpans?: Map<string, { start: number; end: number }>
  /**
   * Absolute index each chat subscription's window starts at. Set on
   * subscribe from the transcript-window setting, moved back by
   * `chat.loadOlder`, never forward. See shared/transcript-window.ts.
   */
  chatWindowStarts?: Map<string, number>
  /**
   * Outline length last sent per chat subscription. The outline rides only
   * on pushes where it changed, so this is what "changed" is measured
   * against.
   */
  chatOutlineCounts?: Map<string, number>
  protectedDraftChatIds?: Set<string>
}

interface CreateWsRouterArgs {
  store: EventStore
  diffStore: Pick<DiffStore, "getProjectSnapshot" | "getSnapshotVersion" | "refreshSnapshot" | "initializeGit" | "getGitHubPublishInfo" | "checkGitHubRepoAvailability" | "publishToGitHub" | "listBranches" | "previewMergeBranch" | "mergeBranch" | "syncBranch" | "checkoutBranch" | "createBranch" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile" | "readPatch">
  worktreeProbe: Pick<WorktreeProbe, "getStates" | "getRepoLabels" | "getProjectsWithoutRepo">
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
  /** Re-probe which editors are installed; results reach clients via app-settings. */
  refreshInstalledEditors?: () => void
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager | null
  usageLimits?: Pick<UsageLimitsManager, "getSnapshot" | "refresh" | "onChange"> | null
  providerAuth?: Pick<
    ProviderAuthManager,
    | "getSnapshot"
    | "refresh"
    | "probeService"
    | "install"
    | "startLogin"
    | "submitLoginCode"
    | "cancelLogin"
    | "startOpenRouterAuth"
    | "exchangeOpenRouterCode"
    | "onChange"
  > | null
}

interface SnapshotBroadcastFilter {
  includeSidebar?: boolean
  includeLocalProjects?: boolean
  includeUpdate?: boolean
  includeKeybindings?: boolean
  includeAppSettings?: boolean
  includeUsageLimits?: boolean
  includeProviderAuth?: boolean
  chatIds?: Set<string>
  projectIds?: Set<string>
  terminalIds?: Set<string>
}

interface SnapshotComputationCache {
  sidebar?: {
    data: ReturnType<typeof deriveSidebarData>
    signature: string
  }
  /**
   * Derived chat snapshots keyed by chat, shared across sockets in one
   * broadcast.
   *
   * The derive is shared but the serialization is not: each socket is at its
   * own point in the transcript, so the body it needs differs. Deriving once
   * is the expensive half; serializing an incremental body is cheap.
   */
  chat?: Map<string, ChatSnapshot | null>
}

/**
 * Frames at least this long are sent with per-message deflate when the
 * socket negotiated it. Below it (acks, pings, keystrokes) the deflate
 * header costs more than it saves and adds latency to typing.
 */
const COMPRESS_FRAME_MIN_BYTES = 1024

function sendFrame(ws: ServerWebSocket<ClientState>, payload: string) {
  ws.send(payload, payload.length >= COMPRESS_FRAME_MIN_BYTES)
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  const payload = JSON.stringify(message)
  sendFrame(ws, payload)
  return payload.length
}

/**
 * Send a snapshot whose body was already serialized once for this broadcast,
 * so N subscribers cost one JSON.stringify instead of N.
 */
function sendSerializedSnapshot(ws: ServerWebSocket<ClientState>, id: string, snapshotJson: string) {
  sendFrame(ws, `{"v":${PROTOCOL_VERSION},"type":"snapshot","id":${JSON.stringify(id)},"snapshot":${snapshotJson}}`)
}

function ensureChatEntrySpans(ws: ServerWebSocket<ClientState>) {
  if (!ws.data.chatEntrySpans) {
    ws.data.chatEntrySpans = new Map()
  }

  return ws.data.chatEntrySpans
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
  worktreeProbe,
  agent,
  terminals,
  keybindings,
  appSettings,
  analytics,
  llmProvider,
  refreshDiscovery,
  refreshInstalledEditors,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
  usageLimits,
  providerAuth,
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
    if (topic.type === "provider-auth") {
      return Boolean(filter.includeProviderAuth)
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

  /**
   * Bumped whenever the worktree probe reports a change. With the store's
   * own `stateVersion` and the agent's small status maps, it names every
   * input the sidebar derive reads, so the memo below is exact.
   */
  let sidebarInputsVersion = 0
  let sidebarMemo: { key: string; entry: { data: ReturnType<typeof deriveSidebarData>; signature: string } } | null = null

  /**
   * How often a sidebar that nothing else touched is re-derived, for the
   * time-based buckets ("recent" rows). Coarser than the 15 s activity
   * quantization on purpose: a row crossing the recent boundary a minute
   * late is invisible; re-deriving 600 rows per push was not.
   */
  const SIDEBAR_CLOCK_BUCKET_MS = 60_000

  function getSidebarSnapshotCacheEntry(cache?: SnapshotComputationCache) {
    if (cache?.sidebar) {
      return cache.sidebar
    }

    const activeStatuses = agent.getActiveStatuses()
    const drainingChatIds = agent.getDrainingChatIds()
    const pendingToolKinds = new Map<string, string>()
    for (const [chatId, status] of activeStatuses) {
      if (status !== "waiting_for_user") continue
      const pendingTool = agent.getPendingTool(chatId)
      if (pendingTool) pendingToolKinds.set(chatId, pendingTool.toolKind)
    }
    // Every input to the derive, in one string. A streaming turn bumps
    // `stateVersion` per appended entry, so this still re-derives per entry;
    // what it stops is the derive-and-stringify for broadcasts that changed
    // nothing sidebar-visible (terminal, git, settings, read anchors).
    const memoKey = [
      store.stateVersion,
      sidebarInputsVersion,
      Math.floor(Date.now() / SIDEBAR_CLOCK_BUCKET_MS),
      JSON.stringify([...activeStatuses].sort()),
      JSON.stringify([...drainingChatIds].sort()),
      JSON.stringify([...pendingToolKinds].sort()),
    ].join("|")
    // A store without a version (the router tests' stubs mutate state
    // directly) gets no memo rather than a stale sidebar.
    const canMemo = typeof store.stateVersion === "number"
    if (canMemo && sidebarMemo?.key === memoKey) {
      if (cache) cache.sidebar = sidebarMemo.entry
      return sidebarMemo.entry
    }
    const data = deriveSidebarData(store.state, activeStatuses, {
      sidebarProjectOrder: store.getSidebarProjectOrder(),
      drainingChatIds,
      pendingToolKinds,
      workingTrees: worktreeProbe.getStates(),
      repoLabels: worktreeProbe.getRepoLabels(),
      projectsWithoutRepo: worktreeProbe.getProjectsWithoutRepo(),
    })

    const sidebar = {
      data,
      signature: JSON.stringify({
        type: "sidebar" as const,
        data,
      }),
    }
    if (canMemo) sidebarMemo = { key: memoKey, entry: sidebar }

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

    if (topic.type === "provider-auth") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "provider-auth",
          data: providerAuth?.getSnapshot() ?? { services: [] },
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
          (chatId) => store.getClientTranscript(chatId)
        ),
      },
    }
  }

  /**
   * The earliest transcript index any socket holds for a chat. The derive
   * clones from here instead of from zero: a push used to clone the whole
   * chat and then cut it down per socket, which grew with the chat.
   */
  function getEarliestChatWindowStart(chatId: string) {
    let earliest: number | null = null
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "chat" || topic.chatId !== chatId) continue
        const start = getChatWindowStart(ws, id, chatId)
        if (earliest === null || start < earliest) earliest = start
      }
    }
    return earliest ?? 0
  }

  function getChatSnapshotData(chatId: string, cache?: SnapshotComputationCache) {
    const key = chatId
    const existing = cache?.chat?.get(key)
    if (existing !== undefined) {
      return existing
    }
    const data = deriveChatSnapshot(
      store.state,
      agent.getActiveStatuses(),
      agent.getDrainingChatIds(),
      chatId,
      (id) => store.getClientTranscript(id, getEarliestChatWindowStart(id))
    )
    if (cache) {
      (cache.chat ??= new Map()).set(key, data)
    }
    return data
  }

  function ensureChatWindowStarts(ws: ServerWebSocket<ClientState>) {
    if (!ws.data.chatWindowStarts) {
      ws.data.chatWindowStarts = new Map()
    }
    return ws.data.chatWindowStarts
  }

  function ensureChatOutlineCounts(ws: ServerWebSocket<ClientState>) {
    if (!ws.data.chatOutlineCounts) {
      ws.data.chatOutlineCounts = new Map()
    }
    return ws.data.chatOutlineCounts
  }

  function transcriptWindowAssistantMessages() {
    return appSettings.getSnapshot().transcript.windowAssistantMessages
  }

  /** The socket's window start for a chat subscription, sizing it on first use. */
  function getChatWindowStart(ws: ServerWebSocket<ClientState>, subscriptionId: string, chatId: string) {
    const starts = ensureChatWindowStarts(ws)
    const existing = starts.get(subscriptionId)
    if (existing !== undefined) return existing
    const start = store.getChat(chatId)
      ? store.getInitialTranscriptWindowStart(chatId, transcriptWindowAssistantMessages())
      : 0
    starts.set(subscriptionId, start)
    return start
  }

  /** Cut a full-transcript snapshot down to what starts at `windowStart`. */
  function sliceChatWindow(data: ChatSnapshot, windowStart: number): ChatSnapshot {
    const offset = Math.max(0, Math.min(windowStart - data.startIndex, data.messages.length))
    if (offset === 0) return data
    return { ...data, messages: data.messages.slice(offset), startIndex: data.startIndex + offset }
  }

  /**
   * Narrow a chat snapshot to the entries a socket has not seen.
   *
   * Two shapes qualify. Contiguous forward movement sends the new tail. A
   * window that grew backwards while its end stayed put (`chat.loadOlder`)
   * sends the older slice, which the client splices in front. Anything else
   * (both at once, or a jump past the socket's position after a missed
   * push) would leave the client with a hole it cannot detect, so the full
   * window is sent instead.
   */
  function toSocketChatSnapshot(data: ChatSnapshot | null, previous: { start: number; end: number } | undefined) {
    if (!data || !previous) return data
    const end = data.startIndex + data.messages.length
    if (data.startIndex < previous.start && end === previous.end) {
      return {
        ...data,
        messages: data.messages.slice(0, previous.start - data.startIndex),
        incremental: true,
      }
    }
    const isContiguous = data.startIndex >= previous.start
      && data.startIndex <= previous.end
      && previous.end <= end
    if (!isContiguous) return data
    return {
      ...data,
      messages: data.messages.slice(previous.end - data.startIndex),
      startIndex: previous.end,
      incremental: true,
    }
  }

  /**
   * Adopt a client's cached transcript position so its first push is
   * incremental.
   *
   * Honoured only when the entry at the boundary still matches what this
   * machine has — a cache from another machine, or from before a transcript
   * was rewritten, would otherwise be spliced onto unrelated history. Any
   * doubt (unverifiable index, mismatched id) falls through to a full window,
   * which is always correct and only costs bytes.
   */
  function seedChatEntrySpanFromClient(
    ws: ServerWebSocket<ClientState>,
    subscriptionId: string,
    topic: SubscriptionTopic
  ) {
    if (topic.type !== "chat") return
    const span = topic.cachedSpan
    if (!span || span.end <= 0 || span.start < 0 || span.start > span.end) return
    // A client can hold a cache for a chat this machine has since pruned.
    // Reading it would throw, and this runs outside the command try/catch on a
    // handler nobody awaits — so an unhandled rejection rather than the empty
    // snapshot the client is meant to get.
    if (!store.getChat(topic.chatId)) return
    // Populates the transcript cache as a side effect, which is what makes the
    // boundary entry visible to `getEntryIdAt`.
    store.getClientTranscript(topic.chatId)
    if (store.getEntryIdAt(topic.chatId, span.end - 1) !== span.endEntryId) return
    ensureChatEntrySpans(ws).set(subscriptionId, { start: span.start, end: span.end })
    // What the client already holds is its window; the server's default
    // only applies when it reaches further back than the cache does.
    const defaultStart = getChatWindowStart(ws, subscriptionId, topic.chatId)
    if (span.start < defaultStart) {
      ensureChatWindowStarts(ws).set(subscriptionId, span.start)
    }
  }

  async function pushSnapshots(
    ws: ServerWebSocket<ClientState>,
    options?: {
      skipPrune?: boolean
      filter?: SnapshotBroadcastFilter
      cache?: SnapshotComputationCache
      /** Answer exactly one subscription — see the `subscribe` handler. */
      onlySubscriptionId?: string
    }
  ) {
    if (!options?.skipPrune) {
      await maybePruneStaleEmptyChats([ws])
    }
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      if (options?.onlySubscriptionId !== undefined && id !== options.onlySubscriptionId) {
        continue
      }
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
        const full = getChatSnapshotData(topic.chatId, options?.cache)
        const data = full ? sliceChatWindow(full, getChatWindowStart(ws, id, topic.chatId)) : full
        const spans = ensureChatEntrySpans(ws)
        const outlineCounts = ensureChatOutlineCounts(ws)
        let body = toSocketChatSnapshot(data, spans.get(id))
        // The outline is a few KB and would otherwise ride every streamed
        // push; an incremental body carries it only when a prompt was added.
        const outlineCount = data?.outline?.length ?? 0
        if (body?.incremental) {
          // Same for the provider catalog and the read anchor: a few KB that
          // never change mid-chat, and the client latches both from the
          // first full snapshot (`foldChatSnapshot` carries them forward).
          const { availableProviders, readAnchor, ...rest } = body
          body = rest as typeof body
          if (outlineCounts.get(id) === outlineCount) {
            const { outline, ...withoutOutline } = body
            body = withoutOutline as typeof body
          }
        }
        const snapshotJson = JSON.stringify({ type: "chat", data: body })
        if (snapshotSignatures.get(id) === snapshotJson) {
          continue
        }
        snapshotSignatures.set(id, snapshotJson)
        // Record the whole window, not the slice that went out — it is what
        // this socket now holds, and what the next push measures against.
        if (data) {
          spans.set(id, { start: data.startIndex, end: data.startIndex + data.messages.length })
          outlineCounts.set(id, outlineCount)
        } else {
          spans.delete(id)
          outlineCounts.delete(id)
        }
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
      // The sidebar rides the chat flush. This is safe — not because sidebar
      // pushes are rare, but because the snapshot is derived at display
      // granularity (`SIDEBAR_ACTIVITY_RESOLUTION_MS` in read-models.ts), so a
      // streamed entry that changes nothing visible serializes to the same
      // bytes and the signature dedupe drops the push before the wire. What
      // remains are real changes — status flips, the unread dot, a new title —
      // and those must land at event speed: a 400 ms throttle here once made
      // every turn ending feel stuck.
      void broadcastFilteredSnapshots({ includeSidebar: true, chatIds })
    }
  }

  function armPendingBroadcastTimer() {
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(flushPendingBroadcast, CHAT_BROADCAST_INTERVAL_MS)
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

  /**
   * `force` skips the dedupe compare (the new signature is still recorded).
   * Needed on explicit close: a pane that subscribed before its session
   * existed has signature "null" from that first push, and the post-close
   * snapshot is "null" again — without force the "session gone" push would
   * be swallowed and the pane would never recreate.
   */
  function pushTerminalSnapshot(terminalId: string, options?: { force?: boolean }) {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (!options?.force && snapshotSignatures.get(id) === signature) continue
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

  const disposeProviderAuthEvents = providerAuth?.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "provider-auth") continue
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
    await runProjectGitCommand(ws, id, project, run)
  }

  /**
   * The same shape for git commands the client addresses by project — the ones
   * driven by the diff panel's own file selection, which must land on the
   * project that produced that selection even if the active chat has moved on.
   */
  async function handleProjectGitCommand(
    ws: ServerWebSocket<ClientState>,
    id: string,
    projectId: string,
    run: (project: ReturnType<typeof resolveChatProject>["project"]) => Promise<{ result?: unknown; changed?: boolean }>,
  ) {
    const project = store.getProject(projectId)
    if (!project) throw new Error("Project not found")
    await runProjectGitCommand(ws, id, project, run)
  }

  async function runProjectGitCommand(
    ws: ServerWebSocket<ClientState>,
    id: string,
    project: ReturnType<typeof resolveChatProject>["project"],
    run: (project: ReturnType<typeof resolveChatProject>["project"]) => Promise<{ result?: unknown; changed?: boolean }>,
  ) {
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
        case "update.installNightly": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.installNightly()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "update.installStable": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.installStable()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
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
        case "auth.refresh": {
          if (providerAuth) {
            await providerAuth.refresh({ force: command.force ?? false })
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: providerAuth.getSnapshot() })
          } else {
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { services: [] } })
          }
          return
        }
        case "auth.install": {
          if (!providerAuth) throw new Error("Provider auth unavailable.")
          // Fire-and-forget: progress travels via provider-auth snapshots.
          void providerAuth.install(command.service)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "auth.login.start": {
          if (!providerAuth) throw new Error("Provider auth unavailable.")
          providerAuth.startLogin(command.service)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "auth.login.submitCode": {
          if (!providerAuth) throw new Error("Provider auth unavailable.")
          providerAuth.submitLoginCode(command.service, command.code)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "auth.login.cancel": {
          if (!providerAuth) throw new Error("Provider auth unavailable.")
          providerAuth.cancelLogin(command.service)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "auth.openrouter.start": {
          if (!providerAuth) throw new Error("Provider auth unavailable.")
          const result = providerAuth.startOpenRouterAuth(command.callbackUrl)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "auth.openrouter.exchange": {
          if (!providerAuth) throw new Error("Provider auth unavailable.")
          const snapshot = await providerAuth.exchangeOpenRouterCode(command.code)
          // The exchanged key is a full Model Registry write — refresh the pi
          // model picker exactly like settings.writeLlmProvider does.
          if (applyPiFaveModels(snapshot.faveModels)) {
            void broadcastSnapshots()
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
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
          // Manually entering/clearing an OpenRouter key changes the auth card.
          void providerAuth?.probeService("openrouter").catch(() => undefined)
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
        case "project.create": {
          const resolved = await initializeProjectDirectory(command.localPath)
          const existingProjectId = store.state.projectIdsByPath.get(resolved)
          const project = await store.openProject(resolved, command.title)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id, localPath: resolved } })
          if (!existingProjectId) {
            resolvedAnalytics.track("project_opened")
          }
          await broadcastFilteredSnapshots({ includeSidebar: true, includeLocalProjects: true })
          return
        }
        case "github.listRecentRepos": {
          const result = await listRecentGitHubRepos()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
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
        case "chat.touchedFiles": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          // Ack-only: nothing about reading a list changes any snapshot, and
          // this fires on every hover.
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: deriveChatTouchedFiles(chat, worktreeProbe.getStates().get(chat.projectId)),
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
        case "chat.setReadAnchor": {
          // No broadcast on purpose. The anchor is not part of any snapshot,
          // so scrolling stays free of fan-out, and a device sitting on an
          // open chat never gets its viewport yanked by another device.
          await store.setChatReadAnchor(command.chatId, command.messageId, command.atEnd, {
            transcriptWidth: command.transcriptWidth,
            offsetFromMessage: command.offsetFromMessage,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.getReadAnchor": {
          const result = store.getChatReadAnchor(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.getPreview": {
          const chat = store.getChat(command.chatId)
          const result: ChatPreview = {
            ...(chat?.lastUserMessagePreview ? { lastUserMessagePreview: chat.lastUserMessagePreview } : {}),
            ...(chat?.lastAgentMessagePreview ? { lastAgentMessagePreview: chat.lastAgentMessagePreview } : {}),
            ...(chat?.lastAgentMessagePreviewAt != null
              ? { lastAgentMessagePreviewAt: chat.lastAgentMessagePreviewAt }
              : {}),
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.getEntryDebugRaw": {
          const result = store.getEntryDebugRaw(command.chatId, command.entryId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.getToolEntries": {
          // Bounded so a malformed client cannot ask for the whole transcript
          // one id at a time; the largest real request is one tool group.
          if (command.entryIds.length > MAX_TOOL_ENTRY_REQUEST) {
            throw new Error(`Too many entry ids (max ${MAX_TOOL_ENTRY_REQUEST})`)
          }
          const result = store.getEntriesById(command.chatId, command.entryIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.loadOlder": {
          // Per socket: only this socket's subscriptions on the chat widen,
          // and each gets the older slice pushed to it alone.
          if (!store.getChat(command.chatId)) {
            throw new Error("Chat not found")
          }
          const starts = ensureChatWindowStarts(ws)
          let startIndex = 0
          for (const [subscriptionId, topic] of ws.data.subscriptions.entries()) {
            if (topic.type !== "chat" || topic.chatId !== command.chatId) continue
            const current = getChatWindowStart(ws, subscriptionId, command.chatId)
            const next = store.widenTranscriptWindowStart(command.chatId, current, {
              assistantMessages: transcriptWindowAssistantMessages(),
              ...(command.untilMessageId !== undefined ? { untilMessageId: command.untilMessageId } : {}),
              ...(command.all ? { all: true } : {}),
            })
            starts.set(subscriptionId, next)
            startIndex = next
            await pushSnapshots(ws, { skipPrune: true, onlySubscriptionId: subscriptionId })
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { startIndex } })
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
        case "project.generateCommitMessage": {
          await handleProjectGitCommand(ws, id, command.projectId, async (project) => ({
            result: await diffStore.generateCommitMessage({
              projectPath: project.localPath,
              paths: command.paths,
            }),
          }))
          return
        }
        case "project.commitDiffs": {
          await handleProjectGitCommand(ws, id, command.projectId, async (project) => {
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
            resolveMediaPath: (url) => store.resolveTranscriptMediaPath(url),
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
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
          // projectId null → the dev-box home terminal (full-screen Terminal
          // page): a shell at $HOME instead of a project directory.
          let projectPath: string
          if (command.projectId === null) {
            projectPath = homedir()
          } else {
            const project = store.getProject(command.projectId)
            if (!project) {
              throw new Error("Project not found")
            }
            projectPath = project.localPath
          }
          const snapshot = terminals.createTerminal({
            projectPath,
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
          pushTerminalSnapshot(command.terminalId, { force: true })
          return
        }
        case "terminal.tail": {
          const result = terminals.getTail(command.terminalId, command.sinceVersion)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
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
    broadcastSidebar: () => {
      // Called by the worktree probe and the prune sweep, whose inputs the
      // store version does not see; the bump invalidates the sidebar memo.
      sidebarInputsVersion += 1
      return broadcastFilteredSnapshots({ includeSidebar: true })
    },
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
        // A (re)subscribe starts from nothing, so the next push sends a full window.
        ws.data.chatEntrySpans?.delete(parsed.id)
        ws.data.chatWindowStarts?.delete(parsed.id)
        ws.data.chatOutlineCounts?.delete(parsed.id)
        seedChatEntrySpanFromClient(ws, parsed.id, parsed.topic)
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              void pushSnapshots(ws, { skipPrune: true, onlySubscriptionId: parsed.id })
            }
          })
          return
        }
        // Only the subscription just made. Opening a chat used to answer every
        // topic on the socket, so the transcript queued behind a full sidebar
        // derive and re-serialization — and the sidebar is iterated first,
        // because the new subscription is appended last. Nothing else asked for
        // an update, and anything that changes meanwhile is broadcast anyway.
        await pushSnapshots(ws, { skipPrune: true, onlySubscriptionId: parsed.id })
        // Kick a fresh usage read on subscribe so the page opens accurate;
        // the onChange fanout delivers the result to all subscribers.
        if (parsed.topic.type === "usage-limits" && usageLimits) {
          void usageLimits.refresh().catch(() => undefined)
        }
        // Same shape for provider auth: cached state paints instantly, the
        // TTL-respecting probe pushes fresh results to all subscribers.
        if (parsed.topic.type === "provider-auth" && providerAuth) {
          void providerAuth.refresh().catch(() => undefined)
        }
        // And for installed editors: cached until its TTL lapses, so an editor
        // installed while Kanna ran shows up on the next page load.
        if (parsed.topic.type === "app-settings") {
          refreshInstalledEditors?.()
        }
        return
      }

      if (parsed.type === "unsubscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.delete(parsed.id)
        snapshotSignatures.delete(parsed.id)
        // A (re)subscribe starts from nothing, so the next push sends a full window.
        ws.data.chatEntrySpans?.delete(parsed.id)
        ws.data.chatWindowStarts?.delete(parsed.id)
        ws.data.chatOutlineCounts?.delete(parsed.id)
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
      disposeProviderAuthEvents()
    },
  }
}

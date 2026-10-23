import type { PerformanceLog } from "./performance-log"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Result, Schema, Scope, Stream } from "effect"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientCommand, ClientEnvelope, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { ClientFrameJsonSchema, CompatibleClientEnvelopeSchema } from "../shared/protocol-schema"
import { diffSidebarIndex, indexSidebarData, type SidebarIndex } from "../shared/sidebar-patch"
import type { AgentCoordinator } from "./agent"
import { ChatAgent } from "./chat-agent"
import { createChatCommands, type ChatChange, type ChatCommandOutcome, type ChatCommands } from "./chat-commands"
import { NoopAnalytics, type Analytics } from "./analytics"
import type { AppSettings } from "./app-settings"
import type { DiscoveredProject, ProjectDiscoveryError } from "./discovery"
import type { LlmProviderFileError } from "./llm-provider"
import type { DiffStore } from "./diff-store"
import type { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import type { Keybindings } from "./keybindings"
import { runKanna, runKannaSync } from "./effect/bridge"
import { killLocalHttpServer, listLocalHttpServers } from "./local-http-servers"
import type { PortTunnels } from "./port-tunnels"
import type { PlatformServices } from "./platform"
import type { ClientSocket } from "./platform/http-host"
import { Machine } from "./platform/machine"
import { FileSystemExtras } from "./platform/file-system-extras"
import { cloneRepository, createDirectory, ensureProjectDirectory, initializeProjectDirectory, listDirectory, resolveClonePath, resolveLocalPath } from "./paths"
import { listRecentGitHubRepos } from "./github"
import { SERVER_PROVIDERS, applyPiFaveModels } from "./provider-catalog"
import { readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"
import { installSkill, listGlobalSkillsWithSources, listInstalledSkills, searchSkills, uninstallSkill } from "./skills"
import { writeStandaloneTranscriptExport } from "./standalone-export"
import type { Terminals } from "./terminal-manager"
import type { WorktreeProbe } from "./worktree-probe"
import type { ProjectIcons } from "./project-icons"
import type { ProviderAuth } from "./provider-auth"
import type { UpdateManager } from "./update-manager"
import type { UsageLimits } from "./usage-limits"
import { deriveChatSnapshot, deriveChatTouchedFiles, deriveLocalProjectsSnapshot, deriveSidebarData, folderModifiedAtReader } from "./read-models"
import { sendEnvelope as send, sendSerializedSnapshot, shouldIncludeTopic, type SnapshotBroadcastFilter } from "./ws-transport"
import type {
  AppSettingsSnapshot,
  ChatSnapshot,
  LlmProviderSnapshot,
  LlmProviderValidationResult,
  UsageLimitsSnapshot,
  ChatPreview,
  WaitingOn,
} from "../shared/types"


/**
 * Cap on ids per `chat.getToolEntries`. The largest honest request is one tool
 * group's members; beyond that something is walking the transcript.
 */
const MAX_TOOL_ENTRY_REQUEST = 256

/** Coalescing window for transcript pushes — roughly one animation frame. */
const CHAT_BROADCAST_INTERVAL_MS = 16

/**
 * Floor between pushes on a background chat subscription (see the `background`
 * flag on the chat topic). Each push builds that chat's snapshot, a few ms on
 * average, and a client holding every running chat would otherwise pay it for
 * chats nobody is looking at on every streamed entry.
 */
const BACKGROUND_CHAT_PUSH_INTERVAL_MS = 2_000

class TerminalProjectNotFoundError extends Schema.TaggedError<TerminalProjectNotFoundError>()(
  "@kanna/server/ws-router/TerminalProjectNotFoundError",
  { projectId: Schema.String, message: Schema.String },
) {}

class GitProjectLookupError extends Schema.TaggedError<GitProjectLookupError>()(
  "@kanna/server/ws-router/GitProjectLookupError",
  { message: Schema.String, projectId: Schema.String, cause: Schema.Defect() },
) {}

class RouterCommandError extends Schema.TaggedError<RouterCommandError>()(
  "@kanna/server/ws-router/RouterCommandError",
  { message: Schema.String },
) {}

const decodeFrameJson = Schema.decodeUnknownEffect(ClientFrameJsonSchema)
const decodeCompatibleEnvelope = Schema.decodeUnknownEffect(CompatibleClientEnvelopeSchema)

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
  /**
   * Serialized provider catalog last sent per chat subscription. The catalog
   * changes at runtime (models discovered from the harnesses), so an
   * incremental push carries it whenever this differs from what is current.
   */
  chatProvidersSent?: Map<string, string>
  chatFollowing?: Map<string, boolean>
  chatWindowChecks?: Map<string, number>
  protectedDraftChatIds?: Set<string>
  /**
   * The sidebar snapshot each patch subscription last received, which the
   * next patch is diffed against. Absent means the next push is a reset.
   */
  sidebarPatchBases?: Map<string, SidebarSnapshotEntry>
  /**
   * When each background chat subscription was last pushed, and the trailing
   * push waiting out the interval, if any.
   */
  chatBackgroundPushes?: Map<string, { at: number; timer: Fiber.Fiber<void, never> | null }>
}

interface CreateWsRouterArgs {
  /**
   * The platform the router's file, git and process commands run on (the
   * home directory for a dev-box terminal, project folders, clones).
   */
  platform: Context.Context<PlatformServices>
  /** The standalone transcript viewer's build (dist/export-viewer); exports fail without it. */
  exportViewerDistDir?: string
  diagnostics?: PerformanceLog["Service"]
  store: EventStore["Service"]
  diffStore: Pick<DiffStore["Service"], "getProjectSnapshot" | "getSnapshotVersion" | "refreshSnapshot" | "initializeGit" | "getGitHubPublishInfo" | "checkGitHubRepoAvailability" | "publishToGitHub" | "listBranches" | "previewMergeBranch" | "mergeBranch" | "syncBranch" | "checkoutBranch" | "createBranch" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile" | "readPatch" | "readCommit" | "readBranch">
  worktreeProbe: Pick<WorktreeProbe["Service"], "states" | "repoLabels" | "projectsWithoutRepo">
  projectIcons?: Pick<ProjectIcons["Service"], "urls">
  agent: AgentCoordinator
  terminals: Terminals["Service"]
  portTunnels?: Pick<PortTunnels["Service"], "expose" | "unexpose" | "publicUrl">
  keybindings: Keybindings["Service"]
  appSettings: AppSettings["Service"]
  analytics?: Analytics["Service"]
  llmProvider: {
    read: () => Effect.Effect<LlmProviderSnapshot, LlmProviderFileError>
    write: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>) => Effect.Effect<LlmProviderSnapshot, LlmProviderFileError>
    validate: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Effect.Effect<LlmProviderValidationResult>
  }
  refreshDiscovery: () => Effect.Effect<DiscoveredProject[], ProjectDiscoveryError>
  /** Re-probe which editors and terminals are installed; results reach clients via app-settings. */
  refreshInstalledApps?: () => void
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager["Service"] | null
  usageLimits?: Pick<UsageLimits["Service"], "snapshot" | "refresh" | "changes"> | null
  providerAuth?: ProviderAuth["Service"] | null
  /** Overrides `BACKGROUND_CHAT_PUSH_INTERVAL_MS`; tests shorten it. */
  backgroundChatPushIntervalMs?: number
  /**
   * The chat actions, shared with the orchestrator so an agent's tools run
   * the same code as these commands. Built here when not handed in.
   */
  chatCommands?: ChatCommands["Service"]
}

interface SidebarSnapshotEntry {
  data: ReturnType<typeof deriveSidebarData>
  signature: string
  /** Moves exactly when `data` is re-derived; what patches name as from/to. */
  revision: number
  /** Built on the first patch that needs it; null when not patchable. */
  patchIndex?: SidebarIndex | null
  /** Serialized patches into this snapshot, by the revision they start from. */
  patchJsonByBase?: Map<number, string>
}

interface SnapshotComputationCache {
  sidebar?: SidebarSnapshotEntry
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

function ensureChatEntrySpans(ws: ClientSocket<ClientState>) {
  if (!ws.data.chatEntrySpans) {
    ws.data.chatEntrySpans = new Map()
  }

  return ws.data.chatEntrySpans
}

function ensureChatProvidersSent(ws: ClientSocket<ClientState>) {
  if (!ws.data.chatProvidersSent) {
    ws.data.chatProvidersSent = new Map()
  }

  return ws.data.chatProvidersSent
}

function ensureSnapshotSignatures(ws: ClientSocket<ClientState>) {
  if (!ws.data.snapshotSignatures) {
    ws.data.snapshotSignatures = new Map()
  }

  return ws.data.snapshotSignatures
}

export function createWsRouter({
  platform,
  exportViewerDistDir,
  diagnostics,
  store,
  diffStore,
  worktreeProbe,
  projectIcons,
  agent,
  terminals,
  portTunnels,
  keybindings,
  appSettings,
  analytics,
  llmProvider,
  refreshDiscovery,
  refreshInstalledApps,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
  usageLimits,
  providerAuth,
  backgroundChatPushIntervalMs = BACKGROUND_CHAT_PUSH_INTERVAL_MS,
  chatCommands: providedChatCommands,
}: CreateWsRouterArgs) {
  const sockets = new Set<ClientSocket<ClientState>>()
  let pendingBroadcastTimer: Fiber.Fiber<void, never> | null = null
  let pendingBroadcastAll = false
  const pendingBroadcastChatIds = new Set<string>()
  // Chats being made under an id their client chose, until they are written.
  // The web client is on such a chat's page as it sends `chat.create`, so what
  // that page sends next (its subscription, a git refresh, a first message)
  // can be handled while the create is still on its way to disk, and would
  // find no such chat. Whatever names one of these ids waits for it instead.
  const chatCreations = new Map<string, Deferred.Deferred<void>>()
  // One scope owns every change-stream listener attached by this router.
  const listenerScope = runKannaSync(Scope.make())
  const listen = <A, E>(stream: Stream.Stream<A, E>, listener: (value: A) => void) =>
    // Started on the spot, so the listener is subscribed before this returns
    // (as `subscribeKanna` was) and no change published right after is missed.
    runKannaSync(Stream.runForEach(stream, (value) => Effect.sync(() => listener(value))).pipe(
      Effect.forkIn(listenerScope, { startImmediately: true }),
    ))
  const forkRouter = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    runKannaSync(effect.pipe(
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError(`router ${operation} failed`, { cause })),
      Effect.forkIn(listenerScope),
    ))
  const chatCreatedEffect = Effect.fn("WsRouter.chatCreated")(function* (chatId: string) {
    const creation = chatCreations.get(chatId)
    // A create that failed leaves no chat, and the caller says so in its own words.
    if (creation) yield* Deferred.await(creation)
  })
  const resolvedAnalytics = analytics ?? NoopAnalytics
  const chatCommands = providedChatCommands ?? createChatCommands({ store, agent: ChatAgent.fromCoordinator(() => agent), analytics: resolvedAnalytics })

  /**
   * Every chat that is not at rest: a turn in flight, or waiting on a
   * subagent. The fallback is for test fakes that predate the second.
   */
  function getChatStatuses() {
    return agent.getChatStatuses?.() ?? agent.getActiveStatuses()
  }

  function getProtectedChatIds() {
    const activeStatuses = getChatStatuses()
    const drainingChatIds = typeof agent.getDrainingChatIds === "function"
      ? agent.getDrainingChatIds()
      : new Set<string>()
    return new Set([
      ...activeStatuses.keys(),
      ...drainingChatIds.values(),
    ])
  }

  function getProtectedDraftChatIds(extraSockets?: Iterable<ClientSocket<ClientState>>) {
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

  const pruneStaleEmptyChatsEffect = Effect.fn("WsRouter.pruneStaleEmptyChats")(function* (extraSockets?: Iterable<ClientSocket<ClientState>>) {
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    return yield* store.pruneStaleEmptyChats({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
  })
  const maybePruneStaleEmptyChats = (extraSockets?: Iterable<ClientSocket<ClientState>>) =>
    runKanna(pruneStaleEmptyChatsEffect(extraSockets))

  const autoArchiveStaleChatsEffect = Effect.fn("WsRouter.autoArchiveStaleChats")(function* (extraSockets?: Iterable<ClientSocket<ClientState>>) {
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    return yield* store.autoArchiveStaleChats({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
  })
  const maybeAutoArchiveStaleChats = (extraSockets?: Iterable<ClientSocket<ClientState>>) =>
    runKanna(autoArchiveStaleChatsEffect(extraSockets))

  const deleteStaleChatsEffect = Effect.fn("WsRouter.deleteStaleChats")(function* (extraSockets?: Iterable<ClientSocket<ClientState>>) {
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    return yield* store.deleteStaleChats({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
  })
  const maybeDeleteStaleChats = (extraSockets?: Iterable<ClientSocket<ClientState>>) =>
    runKanna(deleteStaleChatsEffect(extraSockets))

  /**
   * Bumped whenever the worktree probe reports a change. With the store's
   * own `stateVersion` and the agent's small status maps, it names every
   * input the sidebar derive reads, so the memo below is exact.
   */
  let sidebarInputsVersion = 0
  let sidebarMemo: { key: string; entry: SidebarSnapshotEntry } | null = null
  let sidebarRevision = 0

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

    const activeStatuses = getChatStatuses()
    const drainingChatIds = agent.getDrainingChatIds()
    const pendingToolKinds = new Map<string, string>()
    const pendingUserInputPreviews = new Map<string, string>()
    for (const [chatId, status] of activeStatuses) {
      if (status !== "waiting_for_user") continue
      const pendingTool = agent.getPendingTool(chatId)
      if (!pendingTool) continue
      pendingToolKinds.set(chatId, pendingTool.toolKind)
      if (pendingTool.preview) pendingUserInputPreviews.set(chatId, pendingTool.preview)
    }
    // How many of what, for the chats that are waiting. Optional on the
    // agent for the same reason as `getChatStatuses`.
    const waitingOn = new Map<string, WaitingOn>()
    for (const [chatId, status] of activeStatuses) {
      if (status !== "waiting_on_subagent") continue
      const counts = agent.getWaitingOn?.(chatId)
      if (counts) waitingOn.set(chatId, counts)
    }
    // Every input to the derive, in one string. `stateVersion` now moves only
    // when an append changed something the sidebar can show (see
    // `sidebarVisibleSignature` in event-store), so a streaming turn re-derives
    // on the 15 s activity bucket rather than per entry — on top of skipping
    // broadcasts that changed nothing sidebar-visible (terminal, git,
    // settings, read anchors).
    const memoKey = [
      store.stateVersion,
      sidebarInputsVersion,
      Math.floor(Date.now() / SIDEBAR_CLOCK_BUCKET_MS),
      JSON.stringify([...activeStatuses].sort()),
      JSON.stringify([...drainingChatIds].sort()),
      JSON.stringify([...pendingToolKinds].sort()),
      // Two questions of the same kind back to back share a tool kind, so the
      // text has to be in the key or the second one would show the first.
      JSON.stringify([...pendingUserInputPreviews].sort()),
      // A chat stays waiting while the count under it falls, so the status
      // alone would not say the row had changed.
      JSON.stringify([...waitingOn].sort(([left], [right]) => left.localeCompare(right))),
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
      pendingUserInputPreviews,
      waitingOn,
      workingTrees: runKannaSync(worktreeProbe.states),
      repoLabels: runKannaSync(worktreeProbe.repoLabels),
      projectsWithoutRepo: runKannaSync(worktreeProbe.projectsWithoutRepo),
      projectIcons: projectIcons ? runKannaSync(projectIcons.urls) : undefined,
    })

    const sidebar: SidebarSnapshotEntry = {
      data,
      signature: JSON.stringify({
        type: "sidebar" as const,
        data,
      }),
      revision: ++sidebarRevision,
    }
    if (canMemo) sidebarMemo = { key: memoKey, entry: sidebar }

    if (cache) {
      cache.sidebar = sidebar
    }

    return sidebar
  }

  /**
   * The live provider catalog rides every app-settings payload so pickers
   * outside a chat (new-chat composer, settings defaults) see
   * runtime-discovered models; chat snapshots carry the same list. That
   * includes the acks of the settings commands, not only the subscription
   * push: the client replaces its whole snapshot with an ack, so one without
   * the catalog put those pickers back on the static list after any write.
   */
  function withProviderCatalog(snapshot: AppSettingsSnapshot): AppSettingsSnapshot {
    return { ...snapshot, availableProviders: [...SERVER_PROVIDERS] }
  }

  /**
   * Answer a patch subscription with what changed since the snapshot it holds
   * (see shared/sidebar-patch.ts). False when this snapshot can't be patched,
   * and the caller sends it whole; the base is dropped so the next patch is a
   * reset. The serialized patch is cached on the snapshot by base revision,
   * so sockets at the same point share one diff and one stringify.
   */
  function sendSidebarPatch(ws: ClientSocket<ClientState>, id: string, sidebar: SidebarSnapshotEntry): boolean {
    ws.data.sidebarPatchBases ??= new Map()
    const bases = ws.data.sidebarPatchBases
    const base = bases.get(id)
    if (base === sidebar) return true

    if (sidebar.patchIndex === undefined) sidebar.patchIndex = indexSidebarData(sidebar.data)
    if (!sidebar.patchIndex) {
      bases.delete(id)
      return false
    }
    if (base && base.patchIndex === undefined) base.patchIndex = indexSidebarData(base.data)
    const from = base?.patchIndex ? base.revision : null

    sidebar.patchJsonByBase ??= new Map()
    let json = sidebar.patchJsonByBase.get(from ?? -1)
    if (json === undefined) {
      const patch = diffSidebarIndex(from === null ? null : base!.patchIndex!, sidebar.patchIndex, from, sidebar.revision)
      json = JSON.stringify({ type: "sidebar-patch", data: patch })
      sidebar.patchJsonByBase.set(from ?? -1, json)
    }
    bases.set(id, sidebar)
    ensureSnapshotSignatures(ws).delete(id)
    sendSerializedSnapshot(ws, id, json)
    return true
  }

  function getProjectGitSignature(projectId: string): string {
    return store.getProject(projectId)
      ? `project-git:${projectId}:v${diffStore.getSnapshotVersion(projectId)}`
      : `project-git:${projectId}:none`
  }

  const createLocalProjectsEnvelope = Effect.fn("WsRouter.localProjectsEnvelope")(function* (id: string) {
    const machine = Context.get(platform, Machine)
    const readModifiedAt = folderModifiedAtReader(Context.get(platform, FileSystemExtras), machine.homeDirectory)
    const facts = {
      displayName: machineDisplayName,
      platform: machine.platform,
      homeDirectory: machine.homeDirectory,
    }
    const initial = deriveLocalProjectsSnapshot(store.state, getDiscoveredProjects(), {
      displayName: machineDisplayName,
      platform: machine.platform,
      homeDirectory: machine.homeDirectory,
      folderModifiedAt: () => undefined,
    })
    // Only the visible projects need stat calls. All state derivations above
    // run together; file IO may yield without blocking the event loop.
    const times = new Map(yield* Effect.forEach(initial.projects, (project) => readModifiedAt(project.localPath).pipe(
      Effect.map((modifiedAt) => [project.localPath, modifiedAt] as const),
    ), { concurrency: 16 }))
    // Derive again after IO so an older request cannot restore a project
    // hidden or removed while its stat calls were in flight.
    const data = deriveLocalProjectsSnapshot(store.state, getDiscoveredProjects(), {
      ...facts,
      folderModifiedAt: (localPath) => times.get(localPath),
    })
    return { v: PROTOCOL_VERSION, type: "snapshot", id, snapshot: { type: "local-projects", data } } satisfies ServerEnvelope
  })

  function createEnvelope(id: string, topic: Exclude<SubscriptionTopic, { type: "local-projects" }>, cache?: SnapshotComputationCache): ServerEnvelope {
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

    if (topic.type === "keybindings") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "keybindings",
          data: runKannaSync(keybindings.snapshot),
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
          data: withProviderCatalog(runKannaSync(appSettings.snapshot)),
        },
      }
    }

    if (topic.type === "usage-limits") {
      const data: UsageLimitsSnapshot = usageLimits ? runKannaSync(usageLimits.snapshot) : { providers: [] }
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
          data: providerAuth ? runKannaSync(providerAuth.snapshot) : { services: [] },
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
          data: updateManager ? runKannaSync(updateManager.snapshot) : {
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
          data: runKannaSync(terminals.snapshot(topic.terminalId)),
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
          getChatStatuses(),
          agent.getDrainingChatIds(),
          topic.chatId,
          (chatId) => store.getClientTranscript(chatId),
          agent.getSubagents?.(topic.chatId),
          agent.getWaitingOn?.(topic.chatId)
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

  function getChatSnapshotData(chatId: string, cache?: SnapshotComputationCache, fromIndex?: number) {
    const key = `${chatId}:${fromIndex ?? "window"}:${typeof store.getTranscriptLength === "function" && store.getChat(chatId) ? store.getTranscriptLength(chatId) : ""}`
    const existing = cache?.chat?.get(key)
    if (existing !== undefined) {
      return existing
    }
    const data = deriveChatSnapshot(
      store.state,
      getChatStatuses(),
      agent.getDrainingChatIds(),
      chatId,
      (id) => store.getClientTranscript(id, fromIndex ?? getEarliestChatWindowStart(id)),
      agent.getSubagents?.(chatId),
      agent.getWaitingOn?.(chatId)
    )
    if (cache) {
      (cache.chat ??= new Map()).set(key, data)
    }
    return data
  }

  function ensureChatWindowStarts(ws: ClientSocket<ClientState>) {
    if (!ws.data.chatWindowStarts) {
      ws.data.chatWindowStarts = new Map()
    }
    return ws.data.chatWindowStarts
  }

  function ensureChatOutlineCounts(ws: ClientSocket<ClientState>) {
    if (!ws.data.chatOutlineCounts) {
      ws.data.chatOutlineCounts = new Map()
    }
    return ws.data.chatOutlineCounts
  }

  function transcriptWindowAssistantMessages() {
    return runKannaSync(appSettings.snapshot).transcript.windowAssistantMessages
  }

  /** The socket's window start for a chat subscription, sizing it on first use. */
  function getChatWindowStart(ws: ClientSocket<ClientState>, subscriptionId: string, chatId: string) {
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
    ws: ClientSocket<ClientState>,
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
    getChatWindowStart(ws, subscriptionId, topic.chatId)
    if (store.getEntryIdAt(topic.chatId, span.end - 1) !== span.endEntryId) return
    ensureChatEntrySpans(ws).set(subscriptionId, { start: span.start, end: span.end })
    // What the client already holds is its window; the server's default
    // only applies when it reaches further back than the cache does.
    const defaultStart = getChatWindowStart(ws, subscriptionId, topic.chatId)
    if (span.start < defaultStart) {
      ensureChatWindowStarts(ws).set(subscriptionId, span.start)
    }
  }

  /**
   * Whether a background chat subscription may be pushed now. The first push
   * always goes; after that one per interval, and a change inside the interval
   * arms a single trailing push rather than being dropped, so the last state
   * of a turn — its status flipping to idle — always arrives.
   */
  function admitBackgroundChatPush(ws: ClientSocket<ClientState>, subscriptionId: string) {
    const pushes = ws.data.chatBackgroundPushes ??= new Map()
    const entry = pushes.get(subscriptionId)
    const now = Date.now()
    if (!entry) {
      pushes.set(subscriptionId, { at: now, timer: null })
      return true
    }
    if (entry.timer) return false
    const wait = entry.at + backgroundChatPushIntervalMs - now
    if (wait <= 0) {
      entry.at = now
      return true
    }
    entry.timer = runKannaSync(Effect.sleep(wait).pipe(
      Effect.andThen(Effect.sync(() => {
        entry.timer = null
        if (pushes.get(subscriptionId) !== entry || !ws.data.subscriptions.has(subscriptionId)) return
        forkRouter("background chat push", pushSnapshotsEffect(ws, { skipPrune: true, onlySubscriptionId: subscriptionId }))
      })),
      Effect.forkIn(listenerScope),
    ))
    return false
  }

  function clearBackgroundChatPush(ws: ClientSocket<ClientState>, subscriptionId: string) {
    const entry = ws.data.chatBackgroundPushes?.get(subscriptionId)
    if (entry?.timer) Effect.runFork(Fiber.interrupt(entry.timer))
    ws.data.chatBackgroundPushes?.delete(subscriptionId)
  }

  const pushSnapshotsEffect = Effect.fn("WsRouter.pushSnapshots")(function* (
    ws: ClientSocket<ClientState>,
    options?: {
      skipPrune?: boolean
      filter?: SnapshotBroadcastFilter
      cache?: SnapshotComputationCache
      /** Answer exactly one subscription — see the `subscribe` handler. */
      onlySubscriptionId?: string
    }
  ) {
    if (!options?.skipPrune) {
      yield* pruneStaleEmptyChatsEffect([ws])
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
        if (topic.patches && sendSidebarPatch(ws, id, sidebar)) continue
        if (snapshotSignatures.get(id) === sidebar.signature) {
          continue
        }
        snapshotSignatures.set(id, sidebar.signature)
        sendSerializedSnapshot(ws, id, sidebar.signature)
        continue
      }
      if (topic.type === "chat") {
        if (topic.background && !admitBackgroundChatPush(ws, id)) continue
        // Held until this push ends: the reads below answer from the cache.
        if (store.retainTranscript && store.getChat(topic.chatId)) yield* store.retainTranscript(topic.chatId)
        if (ws.data.subscriptions.get(id) !== topic) continue
        const started = performance.now()
        const spans = ensureChatEntrySpans(ws)
        let windowStart = store.state.chatsById.has(topic.chatId) ? getChatWindowStart(ws, id, topic.chatId) : 0
        const end = typeof store.getTranscriptLength === "function" && store.getChat(topic.chatId) ? store.getTranscriptLength(topic.chatId) : undefined
        const checks = ws.data.chatWindowChecks ??= new Map()
        if (end !== undefined && ws.data.chatFollowing?.get(id) && end - (checks.get(id) ?? windowStart) >= 64) {
          checks.set(id, end)
          windowStart = store.getRollingTranscriptWindowStart(topic.chatId, windowStart, transcriptWindowAssistantMessages())
          ensureChatWindowStarts(ws).set(id, windowStart)
        }
        const previous = spans.get(id)
        const advanced = previous && windowStart > previous.start
        const fromIndex = !advanced && previous && previous.start === windowStart && end !== undefined && previous.end <= end
          ? previous.end
          : windowStart
        const full = getChatSnapshotData(topic.chatId, options?.cache, fromIndex)
        const data = full ? sliceChatWindow(full, windowStart) : full
        const outlineCounts = ensureChatOutlineCounts(ws)
        const providersSent = ensureChatProvidersSent(ws)
        let body = toSocketChatSnapshot(data, advanced ? undefined : previous)
        // The outline is a few KB and would otherwise ride every streamed
        // push; an incremental body carries it only when a prompt was added.
        const outlineCount = data?.outline?.length ?? 0
        const providersJson = JSON.stringify(data?.availableProviders ?? null)
        if (body?.incremental) {
          // The read anchor never changes mid-chat, and the client latches it
          // from the first full snapshot (`foldChatSnapshot` carries it forward).
          if (snapshotSignatures.has(id)) {
            const { readAnchor, ...rest } = body
            body = rest as typeof body
          }
          // The provider catalog is a few KB too, but it is not fixed: the
          // server discovers models at runtime (applyCodexModels and friends).
          // It rides an incremental push whenever this subscription has not
          // sent this exact list — the first push after a client subscribed
          // with a cached span, whose cache may hold an old catalog, and a
          // change while the chat is open.
          if (providersSent.get(id) === providersJson) {
            const { availableProviders, ...withoutProviders } = body
            body = withoutProviders as typeof body
          }
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
          spans.set(id, { start: windowStart, end: data.startIndex + data.messages.length })
          outlineCounts.set(id, outlineCount)
          providersSent.set(id, providersJson)
        } else {
          spans.delete(id)
          outlineCounts.delete(id)
          providersSent.delete(id)
        }
        sendSerializedSnapshot(ws, id, snapshotJson)
        if (diagnostics) {
          yield* Effect.all([
            diagnostics.record("chat_snapshot_ms", performance.now() - started),
            diagnostics.record("chat_snapshot_bytes", snapshotJson.length),
            diagnostics.record("chat_window_entries", Math.max(0, (end ?? 0) - windowStart)),
          ], { discard: true })
        }
        continue
      }
      // project-git has a cheap version-counter signature, so an unchanged
      // snapshot (e.g. thousands of diff files) skips payload building
      // entirely.
      const precomputedSignature = topic.type === "project-git"
        ? getProjectGitSignature(topic.projectId)
        : null
      if (precomputedSignature !== null && snapshotSignatures.get(id) === precomputedSignature) {
        continue
      }
      const envelope = topic.type === "local-projects"
        ? yield* createLocalProjectsEnvelope(id)
        : createEnvelope(id, topic, options?.cache)
      if (ws.data.subscriptions.get(id) !== topic) continue
      if (envelope.type !== "snapshot") continue
      const signature = precomputedSignature ?? JSON.stringify(envelope.snapshot)
      if (snapshotSignatures.get(id) === signature) {
        continue
      }
      snapshotSignatures.set(id, signature)
      send(ws, envelope)
    }
  }, Effect.scoped)

  const broadcastSnapshotsEffect = Effect.fn("WsRouter.broadcastSnapshots")(function* () {
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      yield* pushSnapshotsEffect(ws, { skipPrune: true, cache })
    }
  })
  const broadcastSnapshots = () => runKanna(broadcastSnapshotsEffect())

  const broadcastFilteredSnapshotsEffect = Effect.fn("WsRouter.broadcastFilteredSnapshots")(function* (filter: SnapshotBroadcastFilter) {
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      yield* pushSnapshotsEffect(ws, { skipPrune: true, filter, cache })
    }
  })
  const broadcastFilteredSnapshots = (filter: SnapshotBroadcastFilter) => runKanna(broadcastFilteredSnapshotsEffect(filter))

  function flushPendingBroadcast() {
    pendingBroadcastTimer = null
    const shouldBroadcastAll = pendingBroadcastAll
    const chatIds = new Set(pendingBroadcastChatIds)
    pendingBroadcastAll = false
    pendingBroadcastChatIds.clear()
    if (shouldBroadcastAll) {
      forkRouter("broadcast", broadcastSnapshotsEffect())
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
      forkRouter("chat broadcast", broadcastFilteredSnapshotsEffect({ includeSidebar: true, chatIds }))
    }
  }

  function armPendingBroadcastTimer() {
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = runKannaSync(Effect.sleep(CHAT_BROADCAST_INTERVAL_MS).pipe(
      Effect.andThen(Effect.sync(flushPendingBroadcast)),
      Effect.forkIn(listenerScope),
    ))
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

  const broadcastChatStateImmediately = (chatId: string) => runKanna(broadcastFilteredSnapshotsEffect({
    includeSidebar: true,
    chatIds: new Set([chatId]),
  }))

  /** Push what a chat command says it changed. */
  const broadcastChatChangeEffect = Effect.fn("WsRouter.broadcastChatChange")(function* (change: ChatChange) {
    yield* broadcastFilteredSnapshotsEffect({
      includeSidebar: change.sidebar,
      includeLocalProjects: change.localProjects,
      ...(change.chatIds?.length ? { chatIds: new Set(change.chatIds) } : {}),
    })
  })
  const broadcastChatChange = (change: ChatChange) => runKanna(broadcastChatChangeEffect(change))

  /** Ack a chat command, then push what it changed: the ack first, so the sender never sees its own push before its answer. */
  const finishChatCommandEffect = Effect.fn("WsRouter.finishChatCommand")(function* (
    ws: ClientSocket<ClientState>, id: string, outcome: ChatCommandOutcome<unknown>,
  ) {
    yield* Effect.sync(() => send(ws, {
      v: PROTOCOL_VERSION,
      type: "ack",
      id,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    }))
    if (outcome.changed) yield* broadcastChatChangeEffect(outcome.changed)
  })
  const createChatEffect = Effect.fn("WsRouter.createChat")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "chat.create" }>,
  ) {
    const requestedId = command.chatId
    const completion = requestedId === undefined ? null : Deferred.makeUnsafe<void>()
    if (requestedId !== undefined && completion) chatCreations.set(requestedId, completion)
    const outcome = yield* chatCommands.create(command.projectId, undefined, {
      delegator: command.delegator, chatId: requestedId,
    }).pipe(Effect.ensuring(Effect.sync(() => {
      if (requestedId !== undefined && completion) {
        Deferred.doneUnsafe(completion, Exit.void)
        if (chatCreations.get(requestedId) === completion) chatCreations.delete(requestedId)
      }
    })))
    yield* finishChatCommandEffect(ws, id, outcome)
  })

  const ackResultEffect = Effect.fn("WsRouter.ackResult")(function* <A, E>(
    ws: ClientSocket<ClientState>, id: string, operation: Effect.Effect<A, E>,
  ) {
    const result = yield* operation
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result }))
  })

  const ackVoidEffect = Effect.fn("WsRouter.ackVoid")(function* <A, E>(
    ws: ClientSocket<ClientState>, id: string, operation: Effect.Effect<A, E>,
  ) {
    yield* operation
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id }))
  })

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

  listen(terminals.events, (event) => {
    pushTerminalEvent(event.terminalId, event)
  })

  listen(keybindings.changes, () => {
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

  listen(appSettings.changes, () => {
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

  if (updateManager) listen(updateManager.changes, () => {
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
  })

  if (usageLimits) listen(usageLimits.changes, () => {
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
  })

  if (providerAuth) listen(providerAuth.changes, () => {
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
  })

  agent.setBackgroundErrorReporter?.(broadcastError)

  const openProjectEffect = Effect.fn("WsRouter.openProject")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "project.open" }>,
  ) {
    yield* ensureProjectDirectory(command.localPath).pipe(Effect.provide(platform))
    const normalizedPath = resolveLocalPath(command.localPath, Context.get(platform, Machine).homeDirectory)
    const existingProjectId = store.state.projectIdsByPath.get(normalizedPath)
    const project = yield* store.openProject(command.localPath)
    yield* refreshDiscovery()
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } }))
    if (!existingProjectId) yield* resolvedAnalytics.track("project_opened")
    yield* broadcastFilteredSnapshotsEffect({ includeSidebar: true, includeLocalProjects: true })
  })

  const createProjectEffect = Effect.fn("WsRouter.createProject")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "project.create" }>,
  ) {
    const resolved = yield* initializeProjectDirectory(command.localPath).pipe(Effect.provide(platform))
    const existingProjectId = store.state.projectIdsByPath.get(resolved)
    const project = yield* store.openProject(resolved, command.title)
    yield* refreshDiscovery()
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id, localPath: resolved } }))
    if (!existingProjectId) yield* resolvedAnalytics.track("project_opened")
    yield* broadcastFilteredSnapshotsEffect({ includeSidebar: true, includeLocalProjects: true })
  })

  const cloneProjectEffect = Effect.fn("WsRouter.cloneProject")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "project.clone" }>,
  ) {
    const cloneDest = yield* resolveClonePath(command.localPath, command.fallbackPath).pipe(Effect.provide(platform))
    yield* cloneRepository(command.cloneUrl, cloneDest).pipe(Effect.provide(platform))
    const project = yield* store.openProject(cloneDest, command.title)
    yield* refreshDiscovery()
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id, localPath: cloneDest } }))
    yield* broadcastFilteredSnapshotsEffect({ includeSidebar: true, includeLocalProjects: true })
  })

  const renameProjectEffect = Effect.fn("WsRouter.renameProject")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "project.rename" }>,
  ) {
    const projectId = "projectId" in command
      ? command.projectId
      : (yield* store.openProject(command.localPath)).id
    yield* store.renameProjectSidebarTitle(projectId, command.title)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id }))
    yield* broadcastFilteredSnapshotsEffect({ includeSidebar: true, includeLocalProjects: true })
  })

  const pinProjectEffect = Effect.fn("WsRouter.pinProject")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "project.setPinned" }>,
  ) {
    const pinnedAt = typeof command.pinnedAt === "number" && Number.isFinite(command.pinnedAt)
      ? command.pinnedAt
      : undefined
    yield* store.setProjectPinned(command.projectId, command.pinned, pinnedAt)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id }))
    yield* broadcastFilteredSnapshotsEffect({ includeSidebar: true })
  })

  const removeProjectEffect = Effect.fn("WsRouter.removeProject")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "project.remove" }>,
  ) {
    // Discovered folders need a saved record so Hide survives discovery and restarts.
    const projectId = "projectId" in command
      ? command.projectId
      : (yield* store.openProject(command.localPath)).id
    yield* store.removeProject(projectId)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId } }))
    yield* resolvedAnalytics.track("project_removed")
    // Hidden projects also hide their chats, so refresh every subscription.
    yield* broadcastSnapshotsEffect()
  })

  const reorderProjectGroupsEffect = Effect.fn("WsRouter.reorderProjectGroups")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "sidebar.reorderProjectGroups" }>,
  ) {
    yield* store.setSidebarProjectOrder(command.projectIds)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id }))
    yield* broadcastFilteredSnapshotsEffect({ includeSidebar: true })
  })

  const createTerminalEffect = Effect.fn("WsRouter.createTerminal")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "terminal.create" }>,
  ) {
    // A null projectId is the dev-box home terminal.
    let projectPath: string
    if (command.projectId === null) {
      projectPath = Context.get(platform, Machine).homeDirectory
    } else {
      const project = store.getProject(command.projectId)
      if (!project) {
        return yield* Effect.fail(new TerminalProjectNotFoundError({
          projectId: command.projectId,
          message: "Project not found",
        }))
      }
      projectPath = project.localPath
    }
    const snapshot = yield* terminals.create({
      projectPath,
      terminalId: command.terminalId,
      cols: command.cols,
      rows: command.rows,
      scrollback: command.scrollback,
    })
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot }))
  })

  const writeTerminalEffect = Effect.fn("WsRouter.writeTerminal")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "terminal.input" }>,
  ) {
    yield* terminals.write(command.terminalId, command.data)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id }))
  })

  const resizeTerminalEffect = Effect.fn("WsRouter.resizeTerminal")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "terminal.resize" }>,
  ) {
    yield* terminals.resize(command.terminalId, command.cols, command.rows)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id }))
  })

  const closeTerminalEffect = Effect.fn("WsRouter.closeTerminal")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "terminal.close" }>,
  ) {
    yield* terminals.close(command.terminalId)
    yield* Effect.sync(() => {
      send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
      pushTerminalSnapshot(command.terminalId, { force: true })
    })
  })

  const tailTerminalEffect = Effect.fn("WsRouter.tailTerminal")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "terminal.tail" }>,
  ) {
    const result = yield* terminals.tail(command.terminalId, command.sinceVersion)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result }))
  })

  const listLocalHttpServersEffect = Effect.fn("WsRouter.listLocalHttpServers")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "browser.listLocalHttpServers" }>,
  ) {
    const project = command.projectId ? store.getProject(command.projectId) : null
    const projectTerminalRootPids = project ? yield* terminals.rootPidsByCwd(project.localPath) : []
    const servers = yield* listLocalHttpServers({
      projectPath: project?.localPath,
      projectTerminalRootPids,
    })
    // The scan is cached; stamp current tunnel URLs after reading it.
    const result: typeof servers = []
    for (const server of servers) {
      const publicUrl = portTunnels ? yield* portTunnels.publicUrl(server.port) : undefined
      result.push(publicUrl ? { ...server, publicUrl } : server)
    }
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result }))
  })

  const killLocalHttpServerEffect = Effect.fn("WsRouter.killLocalHttpServer")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "browser.killLocalHttpServer" }>,
  ) {
    const result = yield* killLocalHttpServer(command.port)
    if (portTunnels) yield* portTunnels.unexpose(command.port)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result }))
  })

  const exportStandaloneEffect = Effect.fn("WsRouter.exportStandalone")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "chat.exportStandalone" }>,
  ) {
    const { chat, project } = resolveChatProject(command.chatId)
    const messages = yield* store.readMessages(command.chatId)
    const result = yield* writeStandaloneTranscriptExport({
      chatId: chat.id,
      title: chat.title,
      localPath: project.localPath,
      theme: command.theme,
      sourceOrigin: command.sourceOrigin,
      attachmentMode: command.attachmentMode,
      messages,
      resolveMediaPath: (url) => store.resolveTranscriptMediaPath(url),
    }, { viewerDistDir: exportViewerDistDir }).pipe(Effect.provide(platform))
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result }))
  })

  const writeAppSettingsPatchEffect = Effect.fn("WsRouter.writeAppSettingsPatch")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "settings.writeAppSettingsPatch" }>,
  ) {
    const previousAnalyticsEnabled = (yield* appSettings.snapshot).analyticsEnabled
    const snapshot = yield* appSettings.writePatch(command.patch)
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: withProviderCatalog(snapshot) }))
    if (command.patch.analyticsEnabled !== undefined && previousAnalyticsEnabled && !snapshot.analyticsEnabled) {
      yield* resolvedAnalytics.track("analytics_disabled")
    }
    if (command.patch.analyticsEnabled !== undefined && !previousAnalyticsEnabled && snapshot.analyticsEnabled) {
      yield* resolvedAnalytics.track("analytics_enabled")
    }
  })

  const writeAnalyticsSettingsEffect = Effect.fn("WsRouter.writeAnalyticsSettings")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "settings.writeAppSettings" }>,
  ) {
    const previousAnalyticsEnabled = (yield* appSettings.snapshot).analyticsEnabled
    if (previousAnalyticsEnabled && !command.analyticsEnabled) {
      yield* resolvedAnalytics.track("analytics_disabled")
    }
    const snapshot = yield* appSettings.write({ analyticsEnabled: command.analyticsEnabled })
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: withProviderCatalog(snapshot) }))
    if (!previousAnalyticsEnabled && command.analyticsEnabled) {
      yield* resolvedAnalytics.track("analytics_enabled")
    }
  })

  const refreshUsageEffect = Effect.fn("WsRouter.refreshUsage")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "usage.refresh" }>,
  ) {
    if (!usageLimits) {
      yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { providers: [] } satisfies UsageLimitsSnapshot }))
      return
    }
    yield* usageLimits.refresh({ force: command.force ?? false })
    const snapshot = yield* usageLimits.snapshot
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot }))
  })

  const refreshAuthEffect = Effect.fn("WsRouter.refreshAuth")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "auth.refresh" }>,
  ) {
    if (!providerAuth) {
      yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { services: [] } }))
      return
    }
    yield* providerAuth.refresh({ force: command.force ?? false })
    const snapshot = yield* providerAuth.snapshot
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot }))
  })

  const exchangeOpenRouterEffect = Effect.fn("WsRouter.exchangeOpenRouter")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "auth.openrouter.exchange" }>,
  ) {
    if (!providerAuth) throw new Error("Provider auth unavailable.")
    const snapshot = yield* providerAuth.exchangeOpenRouterCode(command.code)
    if (applyPiFaveModels(snapshot.faveModels)) forkRouter("model broadcast", broadcastSnapshotsEffect())
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot }))
  })

  const readLlmProviderEffect = Effect.fn("WsRouter.readLlmProvider")(function* (
    ws: ClientSocket<ClientState>, id: string,
  ) {
    const snapshot = yield* llmProvider.read()
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot }))
  })

  const writeLlmProviderEffect = Effect.fn("WsRouter.writeLlmProvider")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "settings.writeLlmProvider" }>,
  ) {
    const faveModels = command.faveModels ?? (yield* llmProvider.read()).faveModels
    const snapshot = yield* llmProvider.write({
      provider: command.provider,
      apiKey: command.apiKey,
      model: command.model,
      baseUrl: command.baseUrl,
      // Writers that don't manage faves must not wipe the saved list.
      faveModels,
    })
    // Catalog updates are intentionally fired before the ack, as before.
    if (applyPiFaveModels(snapshot.faveModels)) forkRouter("model broadcast", broadcastSnapshotsEffect())
    if (providerAuth) forkRouter("provider probe", providerAuth.probeService("openrouter"))
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot }))
  })

  const validateLlmProviderEffect = Effect.fn("WsRouter.validateLlmProvider")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "settings.validateLlmProvider" }>,
  ) {
    const result = yield* llmProvider.validate({
      provider: command.provider,
      apiKey: command.apiKey,
      model: command.model,
      baseUrl: command.baseUrl,
    })
    yield* Effect.sync(() => send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result }))
  })

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
  const handleChatGitCommandEffect = Effect.fn("WsRouter.handleChatGitCommand")(function* <E>(
    ws: ClientSocket<ClientState>,
    id: string,
    chatId: string,
    run: (project: ReturnType<typeof resolveChatProject>["project"]) => Effect.Effect<{ result?: unknown; changed?: boolean }, E>,
  ) {
    const { project } = yield* Effect.try({
      try: () => resolveChatProject(chatId),
      catch: (cause) => new GitProjectLookupError({
        message: cause instanceof Error ? cause.message : String(cause),
        projectId: store.getChat(chatId)?.projectId ?? "",
        cause,
      }),
    })
    yield* runProjectGitCommandEffect(ws, id, project, run)
  })

  /**
   * The same shape for git commands the client addresses by project — the ones
   * driven by the diff panel's own file selection, which must land on the
   * project that produced that selection even if the active chat has moved on.
   */
  const handleProjectGitCommandEffect = Effect.fn("WsRouter.handleProjectGitCommand")(function* <E>(
    ws: ClientSocket<ClientState>,
    id: string,
    projectId: string,
    run: (project: ReturnType<typeof resolveChatProject>["project"]) => Effect.Effect<{ result?: unknown; changed?: boolean }, E>,
  ) {
    const project = store.getProject(projectId)
    if (!project) return yield* Effect.fail(new GitProjectLookupError({
      message: "Project not found", projectId, cause: null,
    }))
    yield* runProjectGitCommandEffect(ws, id, project, run)
  })

  const runProjectGitCommandEffect = Effect.fn("WsRouter.runProjectGitCommand")(function* <E>(
    ws: ClientSocket<ClientState>,
    id: string,
    project: ReturnType<typeof resolveChatProject>["project"],
    run: (project: ReturnType<typeof resolveChatProject>["project"]) => Effect.Effect<{ result?: unknown; changed?: boolean }, E>,
  ) {
    const { result, changed } = yield* run(project)
    if (result === undefined) {
      send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
    } else {
      send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
    }
    if (changed) {
      // Scoped, not a full broadcast: a git command can move this project's
      // diff snapshot and the sidebar (branch label, uncommitted-work dot).
      // It cannot move terminal snapshots, whose serializer walks the whole
      // scrollback (~15 ms and ~350 KB at max scrollback) — and the 5 s diff
      // poll lands here, so an unfiltered broadcast paid that every poll.
      forkRouter("project broadcast", broadcastFilteredSnapshotsEffect({ includeSidebar: true, projectIds: new Set([project.id]) }))
    }
  })

  const setChatReadAnchorEffect = Effect.fn("WsRouter.setChatReadAnchor")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "chat.setReadAnchor" }>,
  ) {
    // The anchor is absent from snapshots, so scrolling has no fan-out.
    for (const [subscriptionId, topic] of ws.data.subscriptions) {
      if (topic.type === "chat" && topic.chatId === command.chatId && !topic.background) {
        (ws.data.chatFollowing ??= new Map()).set(subscriptionId, command.atEnd)
      }
    }
    yield* store.setChatReadAnchor(command.chatId, command.messageId, command.atEnd, {
      transcriptWidth: command.transcriptWidth,
      offsetFromMessage: command.offsetFromMessage,
    })
    send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
  })

  const getChatToolEntriesEffect = Effect.fn("WsRouter.getChatToolEntries")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "chat.getToolEntries" }>,
  ) {
    if (command.entryIds.length > MAX_TOOL_ENTRY_REQUEST) {
      return yield* Effect.fail(new Error(`Too many entry ids (max ${MAX_TOOL_ENTRY_REQUEST})`))
    }
    const result = yield* store.readEntriesById(command.chatId, command.entryIds)
    send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
  })

  const checkForUpdatesEffect = Effect.fn("WsRouter.checkForUpdates")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "update.check" }>,
  ) {
    const snapshot = updateManager
      ? yield* updateManager.checkForUpdates({ force: command.force })
      : {
          currentVersion: "unknown",
          latestVersion: null,
          status: "error" as const,
          updateAvailable: false,
          lastCheckedAt: Date.now(),
          error: "Update manager unavailable.",
          installAction: "restart" as const,
          reloadRequestedAt: null,
        }
    send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
  })

  const loadOlderChatEffect = Effect.fn("WsRouter.loadOlderChat")(function* (
    ws: ClientSocket<ClientState>, id: string,
    command: Extract<ClientCommand, { type: "chat.loadOlder" }>,
  ) {
    // Only this socket's foreground subscriptions widen. Each older slice
    // must reach the socket before the command ack.
    if (!store.getChat(command.chatId)) return yield* Effect.fail(new Error("Chat not found"))
    const starts = ensureChatWindowStarts(ws)
    let startIndex = 0
    for (const [subscriptionId, topic] of ws.data.subscriptions.entries()) {
      if (topic.type !== "chat" || topic.chatId !== command.chatId || topic.background) continue
      const current = getChatWindowStart(ws, subscriptionId, command.chatId)
      const next = store.widenTranscriptWindowStart(command.chatId, current, {
        assistantMessages: transcriptWindowAssistantMessages(),
        ...(command.untilMessageId !== undefined ? { untilMessageId: command.untilMessageId } : {}),
        ...(command.all ? { all: true } : {}),
      })
      starts.set(subscriptionId, next)
      ws.data.chatFollowing?.set(subscriptionId, false)
      startIndex = next
      yield* pushSnapshotsEffect(ws, { skipPrune: true, onlySubscriptionId: subscriptionId })
    }
    send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { startIndex } })
  })

  const handleCommandEffect = Effect.fn("WsRouter.handleCommand")(function* (ws: ClientSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    return yield* Effect.gen(function* () {
      if (command.type !== "chat.create" && "chatId" in command && typeof command.chatId === "string") {
        yield* (chatCreatedEffect(command.chatId))
      }
      if ("chatId" in command && typeof command.chatId === "string" && store.retainTranscript && store.getChat(command.chatId)) {
        if (["chat.getEntryDebugRaw", "chat.getToolEntries", "chat.loadOlder", "chat.getReadAnchor"].includes(command.type)) {
          // Held until the command finishes (see the Effect.scoped below).
          yield* (store.retainTranscript(command.chatId))
        }
      }
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "fs.list": {
          yield* (ackResultEffect(ws, id, listDirectory(command.path, { nearest: command.nearest }).pipe(Effect.provide(platform))))
          return
        }
        case "fs.mkdir": {
          yield* (ackResultEffect(ws, id, createDirectory(command.path).pipe(Effect.provide(platform))))
          return
        }
        case "browser.listLocalHttpServers": {
          yield* (listLocalHttpServersEffect(ws, id, command))
          return
        }
        case "browser.killLocalHttpServer": {
          yield* (killLocalHttpServerEffect(ws, id, command))
          return
        }
        case "browser.exposeLocalHttpServer": {
          if (!portTunnels) return yield* Effect.fail(new RouterCommandError({ message: "Port tunnels are not available." }))
          yield* (ackResultEffect(ws, id, portTunnels.expose(command.port)))
          return
        }
        case "browser.unexposeLocalHttpServer": {
          if (!portTunnels) return yield* Effect.fail(new RouterCommandError({ message: "Port tunnels are not available." }))
          yield* (ackResultEffect(ws, id, portTunnels.unexpose(command.port)))
          return
        }
        case "project.readQuickActions": {
          const project = store.getProject(command.projectId)
          if (!project) {
            return yield* Effect.fail(new RouterCommandError({ message: "Project not found" }))
          }
          yield* (ackResultEffect(ws, id, readProjectQuickActions(project.localPath).pipe(Effect.provide(platform))))
          return
        }
        case "project.writeQuickActions": {
          const project = store.getProject(command.projectId)
          if (!project) {
            return yield* Effect.fail(new RouterCommandError({ message: "Project not found" }))
          }
          yield* (ackResultEffect(ws, id, writeProjectQuickActions(project.localPath, command.quickActions).pipe(Effect.provide(platform))))
          return
        }
        case "update.check": {
          yield* (checkForUpdatesEffect(ws, id, command))
          return
        }
        case "update.installNightly": {
          if (!updateManager) {
            return yield* Effect.fail(new RouterCommandError({ message: "Update manager unavailable." }))
          }
          yield* (ackResultEffect(ws, id, updateManager.installNightly))
          return
        }
        case "update.installStable": {
          if (!updateManager) {
            return yield* Effect.fail(new RouterCommandError({ message: "Update manager unavailable." }))
          }
          yield* (ackResultEffect(ws, id, updateManager.installStable))
          return
        }
        case "update.install": {
          if (!updateManager) {
            return yield* Effect.fail(new RouterCommandError({ message: "Update manager unavailable." }))
          }
          yield* (ackResultEffect(ws, id, updateManager.installUpdate))
          return
        }
        case "settings.readKeybindings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: runKannaSync(keybindings.snapshot) })
          return
        }
        case "settings.writeKeybindings": {
          yield* (ackResultEffect(ws, id, keybindings.write(command.bindings)))
          return
        }
        case "settings.readAppSettings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: withProviderCatalog(runKannaSync(appSettings.snapshot)) })
          return
        }
        case "usage.refresh": {
          yield* (refreshUsageEffect(ws, id, command))
          return
        }
        case "auth.refresh": {
          yield* (refreshAuthEffect(ws, id, command))
          return
        }
        case "auth.install": {
          if (!providerAuth) return yield* Effect.fail(new RouterCommandError({ message: "Provider auth unavailable." }))
          // Fire-and-forget: progress travels via provider-auth snapshots.
          forkRouter("provider install", providerAuth.install(command.service))
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "auth.login.start": {
          if (!providerAuth) return yield* Effect.fail(new RouterCommandError({ message: "Provider auth unavailable." }))
          yield* (ackVoidEffect(ws, id, providerAuth.startLogin(command.service)))
          return
        }
        case "auth.login.submitCode": {
          if (!providerAuth) return yield* Effect.fail(new RouterCommandError({ message: "Provider auth unavailable." }))
          yield* (ackVoidEffect(ws, id, providerAuth.submitLoginCode(command.service, command.code)))
          return
        }
        case "auth.login.cancel": {
          if (!providerAuth) return yield* Effect.fail(new RouterCommandError({ message: "Provider auth unavailable." }))
          yield* (ackVoidEffect(ws, id, providerAuth.cancelLogin(command.service)))
          return
        }
        case "auth.openrouter.start": {
          if (!providerAuth) return yield* Effect.fail(new RouterCommandError({ message: "Provider auth unavailable." }))
          yield* (ackResultEffect(ws, id, providerAuth.startOpenRouterAuth(command.callbackUrl)))
          return
        }
        case "auth.openrouter.exchange": {
          yield* (exchangeOpenRouterEffect(ws, id, command))
          return
        }
        case "settings.writeAppSettings": {
          yield* (writeAnalyticsSettingsEffect(ws, id, command))
          return
        }
        case "settings.writeAppSettingsPatch": {
          yield* (writeAppSettingsPatchEffect(ws, id, command))
          return
        }
        case "settings.readLlmProvider": {
          yield* (readLlmProviderEffect(ws, id))
          return
        }
        case "settings.writeLlmProvider": {
          yield* (writeLlmProviderEffect(ws, id, command))
          return
        }
        case "settings.validateLlmProvider": {
          yield* (validateLlmProviderEffect(ws, id, command))
          return
        }
        case "chat.listSkills": {
          const snapshot = yield* agent.listSkillsEffect(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "skills.search": {
          yield* (ackResultEffect(ws, id, searchSkills(command.query, command.limit)))
          return
        }
        case "skills.install": {
          yield* (ackResultEffect(ws, id, installSkill(command.source, command.skillId).pipe(Effect.provide(platform))))
          return
        }
        case "skills.uninstall": {
          yield* (ackResultEffect(ws, id, uninstallSkill(command.skillId).pipe(Effect.provide(platform))))
          return
        }
        case "skills.listInstalled": {
          yield* (ackResultEffect(ws, id, listInstalledSkills().pipe(Effect.provide(platform))))
          return
        }
        case "skills.listGlobal": {
          yield* (ackResultEffect(ws, id, listGlobalSkillsWithSources().pipe(Effect.provide(platform))))
          return
        }
        case "project.open": {
          yield* (openProjectEffect(ws, id, command))
          return
        }
        case "project.create": {
          yield* (createProjectEffect(ws, id, command))
          return
        }
        case "github.listRecentRepos": {
          yield* (ackResultEffect(ws, id, listRecentGitHubRepos().pipe(Effect.provide(platform))))
          return
        }
        case "project.rename": {
          yield* (renameProjectEffect(ws, id, command))
          return
        }
        case "project.setPinned": {
          yield* (pinProjectEffect(ws, id, command))
          return
        }
        case "project.clone": {
          yield* (cloneProjectEffect(ws, id, command))
          return
        }
        case "project.remove": {
          yield* (removeProjectEffect(ws, id, command))
          return
        }
        case "sidebar.reorderProjectGroups": {
          yield* (reorderProjectGroupsEffect(ws, id, command))
          return
        }
        case "project.readDiffPatch": {
          const project = store.getProject(command.projectId)
          if (!project) {
            return yield* Effect.fail(new RouterCommandError({ message: "Project not found" }))
          }
          yield* (ackResultEffect(ws, id, diffStore.readPatch({
            projectPath: project.localPath,
            path: command.path,
            fullContext: command.fullContext === true,
          })))
          return
        }
        case "project.readBranch": {
          const project = store.getProject(command.projectId)
          if (!project) {
            return yield* Effect.fail(new RouterCommandError({ message: "Project not found" }))
          }
          yield* (ackResultEffect(ws, id, diffStore.readBranch({
            projectPath: project.localPath,
            branch: command.branch,
          })))
          return
        }
        case "project.readCommit": {
          const project = store.getProject(command.projectId)
          if (!project) {
            return yield* Effect.fail(new RouterCommandError({ message: "Project not found" }))
          }
          yield* (ackResultEffect(ws, id, diffStore.readCommit({
            projectPath: project.localPath,
            sha: command.sha,
          })))
          return
        }
        case "system.openExternal": {
          yield* (ackVoidEffect(ws, id, openExternal(command).pipe(Effect.provide(platform))))
          return
        }
        // The chat actions are defined in chat-commands.ts, where the agents'
        // tools reach them too. Only the ack and the push are done here.
        case "chat.create": {
          yield* (createChatEffect(ws, id, command))
          return
        }
        case "chat.setDelegator": {
          yield* (chatCommands.setDelegator(command.chatId, command.delegator).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.fork": {
          yield* (chatCommands.fork(command.chatId).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.rename": {
          yield* (chatCommands.rename(command.chatId, command.title).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.setPinned": {
          yield* (chatCommands.setPinned(command.chatId, command.pinned).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.archive": {
          yield* (chatCommands.archive(command.chatId).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.unarchive": {
          yield* (chatCommands.unarchive(command.chatId).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.delete": {
          yield* (chatCommands.delete(command.chatId).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.touchedFiles": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            return yield* Effect.fail(new RouterCommandError({ message: "Chat not found" }))
          }
          // Ack-only: nothing about reading a list changes any snapshot, and
          // this fires on every hover.
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: deriveChatTouchedFiles(chat, runKannaSync(worktreeProbe.states).get(chat.projectId)),
          })
          return
        }
        case "chat.markRead": {
          yield* (chatCommands.markRead(command.chatId).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.setDone": {
          yield* (chatCommands.setDone(command.chatId, command.done).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.setReadAnchor": {
          yield* (setChatReadAnchorEffect(ws, id, command))
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
          yield* (getChatToolEntriesEffect(ws, id, command))
          return
        }
        case "chat.loadOlder": {
          yield* (loadOlderChatEffect(ws, id, command))
          return
        }
        case "chat.setDraftProtection": {
          // Only adjusts this socket's prune protection — no snapshot changes.
          ws.data.protectedDraftChatIds = new Set(command.chatIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.send": {
          yield* (chatCommands.send(command).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.refreshDiffs": {
          // Acks without a result; broadcasts when the refresh reported a change.
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.refreshSnapshot(project.id, project.localPath).pipe(Effect.map((changed) => ({ changed })))) )
          return
        }
        case "chat.initGit": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.initializeGit({
              projectId: project.id,
              projectPath: project.localPath,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.getGitHubPublishInfo": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.getGitHubPublishInfo({
              projectPath: project.localPath,
            }).pipe(Effect.map((result) => ({ result }))) ))
          return
        }
        case "chat.checkGitHubRepoAvailability": {
          yield* (ackResultEffect(ws, id, diffStore.checkGitHubRepoAvailability({
            owner: command.owner,
            name: command.name,
          })))
          return
        }
        case "chat.publishToGitHub": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.publishToGitHub({
              projectId: project.id,
              projectPath: project.localPath,
              owner: command.owner,
              name: command.name,
              visibility: command.visibility,
              description: command.description,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.listBranches": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.listBranches({
              projectPath: project.localPath,
            }).pipe(Effect.map((result) => ({ result }))) ))
          return
        }
        case "chat.previewMergeBranch": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.previewMergeBranch({
              projectPath: project.localPath,
              branch: command.branch,
            }).pipe(Effect.map((result) => ({ result }))) ))
          return
        }
        case "chat.mergeBranch": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.mergeBranch({
              projectId: project.id,
              projectPath: project.localPath,
              branch: command.branch,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.checkoutBranch": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.checkoutBranch({
              projectId: project.id,
              projectPath: project.localPath,
              branch: command.branch,
              bringChanges: command.bringChanges,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.syncBranch": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.syncBranch({
              projectId: project.id,
              projectPath: project.localPath,
              action: command.action,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.createBranch": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.createBranch({
              projectId: project.id,
              projectPath: project.localPath,
              name: command.name,
              baseBranchName: command.baseBranchName,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "project.generateCommitMessage": {
          yield* (handleProjectGitCommandEffect(ws, id, command.projectId, (project) =>
            diffStore.generateCommitMessage({
              projectPath: project.localPath,
              paths: command.paths,
            }).pipe(Effect.map((result) => ({ result }))) ))
          return
        }
        case "project.commitDiffs": {
          yield* (handleProjectGitCommandEffect(ws, id, command.projectId, (project) =>
            diffStore.commitFiles({
              projectId: project.id,
              projectPath: project.localPath,
              paths: command.paths,
              summary: command.summary,
              description: command.description,
              mode: command.mode,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.discardDiffFile": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.discardFile({
              projectId: project.id,
              projectPath: project.localPath,
              path: command.path,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.ignoreDiffFile": {
          yield* (handleChatGitCommandEffect(ws, id, command.chatId, (project) =>
            diffStore.ignoreFile({
              projectId: project.id,
              projectPath: project.localPath,
              path: command.path,
            }).pipe(Effect.map((result) => ({ result, changed: result.snapshotChanged }))) ))
          return
        }
        case "chat.cancel": {
          yield* (chatCommands.cancel(command.chatId).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "chat.stopDraining": {
          yield* agent.stopDrainingEffect(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.stopTask": {
          // No broadcast: the task's end arrives on the session's stream and
          // updates the registry, which pushes the chat like any task report.
          yield* agent.stopBackgroundTaskEffect(command.chatId, command.taskId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.exportStandalone": {
          yield* (exportStandaloneEffect(ws, id, command))
          return
        }
        case "chat.respondTool": {
          yield* agent.respondToolEffect(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "message.enqueue": {
          yield* (chatCommands.enqueue(command).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "message.steer": {
          yield* (chatCommands.steer(command).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "message.dequeue": {
          yield* (chatCommands.dequeue(command).pipe(Effect.flatMap((outcome) => finishChatCommandEffect(ws, id, outcome))))
          return
        }
        case "terminal.create": {
          yield* (createTerminalEffect(ws, id, command))
          return
        }
        case "terminal.input": {
          yield* (writeTerminalEffect(ws, id, command))
          return
        }
        case "terminal.resize": {
          yield* (resizeTerminalEffect(ws, id, command))
          return
        }
        case "terminal.close": {
          yield* (closeTerminalEffect(ws, id, command))
          return
        }
        case "terminal.tail": {
          yield* (tailTerminalEffect(ws, id, command))
          return
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      const error = Cause.squash(cause)
      const messageText = error instanceof Error ? error.message : String(error)
      console.error("[ws-router] command failed", {
        id,
        type: command.type,
        message: messageText,
      })
      send(ws, { v: PROTOCOL_VERSION, type: "error", id, message: messageText })
    })))
  }, Effect.scoped)

  const subscribeEffect = Effect.fn("WsRouter.subscribe")(function* (
    ws: ClientSocket<ClientState>,
    message: Extract<ClientEnvelope, { type: "subscribe" }>,
  ) {
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    ws.data.subscriptions.set(message.id, message.topic)
    snapshotSignatures.delete(message.id)
    // A (re)subscribe starts from nothing, so the next push sends a full window.
    ws.data.chatEntrySpans?.delete(message.id)
    ws.data.chatWindowStarts?.delete(message.id)
    ws.data.chatOutlineCounts?.delete(message.id)
    ws.data.chatProvidersSent?.delete(message.id)
    ws.data.chatFollowing?.delete(message.id)
    ws.data.chatWindowChecks?.delete(message.id)
    ws.data.sidebarPatchBases?.delete(message.id)
    clearBackgroundChatPush(ws, message.id)
    // Register first so an unsubscribe arriving during either wait removes it.
    if (message.topic.type === "chat" && chatCreations.has(message.topic.chatId)) {
      const chatId = message.topic.chatId
      yield* chatCreatedEffect(chatId)
      if (ws.data.subscriptions.get(message.id) !== message.topic) return
    }
    if (message.topic.type === "chat" && store.retainTranscript && store.getChat(message.topic.chatId)) {
      // Held through the first push below (the handler is scoped).
      const prepared = yield* Effect.exit(store.retainTranscript(message.topic.chatId))
      if (Exit.isFailure(prepared)) {
        send(ws, { v: PROTOCOL_VERSION, type: "error", id: message.id, message: "Cannot read transcript" })
        return
      }
      if (ws.data.subscriptions.get(message.id) !== message.topic) return
    }
    seedChatEntrySpanFromClient(ws, message.id, message.topic)
    if (message.topic.type === "local-projects") {
      runKannaSync(Effect.gen(function* () {
        yield* refreshDiscovery()
        if (ws.data.subscriptions.has(message.id)) {
          yield* pushSnapshotsEffect(ws, { skipPrune: true, onlySubscriptionId: message.id })
        }
      }).pipe(Effect.forkIn(listenerScope)))
      return
    }
    // Only the subscription just made; other topics change via broadcasts.
    yield* pushSnapshotsEffect(ws, { skipPrune: true, onlySubscriptionId: message.id })
    // Paint cached state first, then refresh values whose providers have a TTL.
    if (message.topic.type === "usage-limits" && usageLimits) {
      forkRouter("usage refresh", usageLimits.refresh())
    }
    if (message.topic.type === "provider-auth" && providerAuth) {
      forkRouter("provider refresh", providerAuth.refresh())
    }
    if (message.topic.type === "app-settings") {
      refreshInstalledApps?.()
    }
  }, Effect.scoped)

  const handleMessageEffect = Effect.fn("WsRouter.handleMessage")(function* (
    ws: ClientSocket<ClientState>, raw: string | Buffer | ArrayBuffer | Uint8Array,
  ) {
    const json = yield* Effect.result(decodeFrameJson(String(raw)))
    if (Result.isFailure(json)) {
      send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid JSON" })
      return
    }

    const decoded = yield* Effect.result(decodeCompatibleEnvelope(json.success))
    if (Result.isFailure(decoded)) {
      send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid envelope" })
      return
    }
    const parsed = decoded.success

    if (parsed.type === "subscribe") {
      yield* subscribeEffect(ws, parsed)
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
      ws.data.chatProvidersSent?.delete(parsed.id)
      ws.data.chatFollowing?.delete(parsed.id)
      ws.data.chatWindowChecks?.delete(parsed.id)
      ws.data.sidebarPatchBases?.delete(parsed.id)
      clearBackgroundChatPush(ws, parsed.id)
      send(ws, { v: PROTOCOL_VERSION, type: "ack", id: parsed.id })
      return
    }

    yield* handleCommandEffect(ws, parsed)
  })

  const disposeEffect = Effect.fn("WsRouter.dispose")(function* () {
    if (pendingBroadcastTimer) yield* Fiber.interrupt(pendingBroadcastTimer)
    agent.setBackgroundErrorReporter?.(null)
    yield* Scope.close(listenerScope, Exit.void)
  })

  return {
    getResourceCounts() {
      let subscriptions = 0
      let providerEntries = 0
      let windows = 0
      for (const ws of sockets) {
        subscriptions += ws.data.subscriptions.size
        providerEntries += ws.data.chatProvidersSent?.size ?? 0
        windows += ws.data.chatEntrySpans?.size ?? 0
      }
      return { sockets: sockets.size, subscriptions, subscriptionProviderEntries: providerEntries, chatWindows: windows }
    },
    handleOpen(ws: ClientSocket<ClientState>) {
      sockets.add(ws)
    },
    handleClose(ws: ClientSocket<ClientState>) {
      sockets.delete(ws)
      ws.data.subscriptions.clear()
      ws.data.snapshotSignatures?.clear()
      ws.data.chatEntrySpans?.clear()
      ws.data.chatProvidersSent?.clear()
      ws.data.chatOutlineCounts?.clear()
      ws.data.chatWindowStarts?.clear()
      ws.data.chatFollowing?.clear()
      ws.data.chatWindowChecks?.clear()
      ws.data.sidebarPatchBases?.clear()
      for (const id of [...(ws.data.chatBackgroundPushes?.keys() ?? [])]) clearBackgroundChatPush(ws, id)
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
    broadcastChatChange,
    pruneStaleEmptyChats: () => maybePruneStaleEmptyChats(),
    autoArchiveStaleChats: () => maybeAutoArchiveStaleChats(),
    deleteStaleChats: () => maybeDeleteStaleChats(),
    handleMessage(ws: ClientSocket<ClientState>, raw: string | Buffer | ArrayBuffer | Uint8Array) {
      return runKanna(handleMessageEffect(ws, raw).pipe(Effect.provide(platform)))
    },
    disposeEffect,
    dispose: () => { void runKanna(disposeEffect()) },
  }
}

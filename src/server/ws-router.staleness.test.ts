import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SubscriptionTopic } from "../shared/protocol"
import type { TranscriptEntry } from "../shared/types"
import { createEmptyState } from "./events"
import { createWsRouter } from "./ws-router"

/**
 * Broadcast-staleness invariant suite.
 *
 * Every command case in ws-router.ts ends in a *targeted* snapshot broadcast
 * (it names exactly the topics it can change) instead of the old broadcast-
 * everything fallthrough. A missed topic fails silently: a second tab keeps
 * rendering stale state with no error anywhere. This suite pins the invariant
 * directly instead of mirroring the router's filter table:
 *
 *   After any state-mutating command, every already-connected subscriber's
 *   last-received snapshot must equal what a brand-new subscriber would
 *   receive (subscribing always pushes fresh state, so a fresh "probe"
 *   subscription is ground truth).
 *
 * Each table case also declares `expectChanged`: topics whose ground truth
 * must differ from the observer's pre-command snapshot. That guards against
 * vacuous passes where the fake store didn't actually mutate anything.
 *
 * Deliberate exemption: `allowStale` documents topics we accept as eventually
 * consistent for that command (see the message.steer case).
 */

class FakeWebSocket {
  readonly sent: Array<{ v: number; type: string; id?: string; snapshot?: { type: string; data: unknown } }> = []
  readonly data = {
    subscriptions: new Map<string, SubscriptionTopic>(),
    protectedDraftChatIds: new Set<string>(),
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }

  snapshotsById(id: string) {
    return this.sent.filter((entry) => entry.type === "snapshot" && entry.id === id)
  }

  lastSnapshot(id: string) {
    return this.snapshotsById(id).at(-1)?.snapshot
  }
}

const TOPIC_IDS = {
  sidebar: "topic-sidebar",
  localProjects: "topic-local-projects",
  chat1: "topic-chat-1",
  chat2: "topic-chat-2",
  projectGit: "topic-project-git",
  appSettings: "topic-app-settings",
  keybindings: "topic-keybindings",
} as const

type TopicId = (typeof TOPIC_IDS)[keyof typeof TOPIC_IDS]

const ALL_TOPICS: Array<[TopicId, SubscriptionTopic]> = [
  [TOPIC_IDS.sidebar, { type: "sidebar" }],
  [TOPIC_IDS.localProjects, { type: "local-projects" }],
  [TOPIC_IDS.chat1, { type: "chat", chatId: "chat-1" }],
  [TOPIC_IDS.chat2, { type: "chat", chatId: "chat-2" }],
  [TOPIC_IDS.projectGit, { type: "project-git", projectId: "project-1" }],
  [TOPIC_IDS.appSettings, { type: "app-settings" }],
  [TOPIC_IDS.keybindings, { type: "keybindings" }],
]

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

interface World {
  state: ReturnType<typeof createEmptyState>
  router: ReturnType<typeof createWsRouter>
  seedQueuedMessage: (chatId: string) => void
}

function createWorld(options?: { projectPath?: string }) {
  const state = createEmptyState()
  const nowMs = Date.now()

  const makeChat = (id: string, createdAt: number) => ({
    id,
    projectId: "project-1",
    title: `Chat ${id}`,
    createdAt,
    updatedAt: createdAt,
    unread: false,
    provider: null as "claude" | null,
    planMode: false,
    sessionToken: null as string | null,
    lastTurnOutcome: null,
    deletedAt: null as number | null,
    archivedAt: null as number | null,
    doneAt: null as number | null,
    lastMessageAt: undefined as number | undefined,
  })

  state.projectsById.set("project-1", {
    id: "project-1",
    localPath: "/tmp/staleness-project-1",
    title: "Project One",
    createdAt: nowMs - 20_000,
    updatedAt: nowMs - 10_000,
    deletedAt: null,
  } as never)
  state.projectIdsByPath.set("/tmp/staleness-project-1", "project-1")
  state.projectsById.set("project-2", {
    id: "project-2",
    localPath: "/tmp/staleness-project-2",
    title: "Project Two",
    createdAt: nowMs - 30_000,
    updatedAt: nowMs - 20_000,
    deletedAt: null,
  } as never)
  state.projectIdsByPath.set("/tmp/staleness-project-2", "project-2")
  state.chatsById.set("chat-1", makeChat("chat-1", nowMs - 5_000) as never)
  state.chatsById.set("chat-2", makeChat("chat-2", nowMs - 4_000) as never)

  const messagesByChatId = new Map<string, TranscriptEntry[]>()
  let sidebarProjectOrder: string[] = []
  let nextId = 0

  const requireChat = (chatId: string) => {
    const chat = state.chatsById.get(chatId)
    if (!chat) throw new Error("Chat not found")
    return chat as ReturnType<typeof makeChat>
  }

  const store = {
    state,
    getSidebarProjectOrder: () => [...sidebarProjectOrder],
    setSidebarProjectOrder: async (projectIds: string[]) => {
      sidebarProjectOrder = [...projectIds]
    },
    pruneStaleEmptyChats: async () => [],
    getProject: (projectId: string) => {
      const project = state.projectsById.get(projectId)
      // Mirrors EventStore.getProject: tombstoned projects read as absent.
      if (!project || project.deletedAt) return null
      return project
    },
    getChat: (chatId: string) => {
      const chat = state.chatsById.get(chatId)
      if (!chat || (chat as { deletedAt?: number | null }).deletedAt) return null
      return chat
    },
    getRecentChatHistory: (chatId: string) => ({
      messages: [...(messagesByChatId.get(chatId) ?? [])],
      history: { hasOlder: false, olderCursor: null },
    }),
    openProject: async (localPath: string, title?: string) => {
      const existingId = state.projectIdsByPath.get(localPath)
      if (existingId) return state.projectsById.get(existingId)
      nextId += 1
      const project = {
        id: `project-open-${nextId}`,
        localPath,
        title: title ?? path.basename(localPath),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      }
      state.projectsById.set(project.id, project as never)
      state.projectIdsByPath.set(localPath, project.id)
      return project
    },
    renameProjectSidebarTitle: async (projectId: string, title: string) => {
      const project = state.projectsById.get(projectId)
      if (!project) throw new Error("Project not found")
      ;(project as { sidebarTitle?: string }).sidebarTitle = title
    },
    removeProject: async (projectId: string) => {
      const project = state.projectsById.get(projectId)
      if (!project) throw new Error("Project not found")
      ;(project as { deletedAt: number | null }).deletedAt = Date.now()
      for (const chat of state.chatsById.values()) {
        if (chat.projectId === projectId) {
          ;(chat as { deletedAt: number | null }).deletedAt = Date.now()
        }
      }
    },
    createChat: async (projectId: string) => {
      nextId += 1
      const chat = { ...makeChat(`chat-created-${nextId}`, Date.now()), projectId }
      state.chatsById.set(chat.id, chat as never)
      return chat
    },
    renameChat: async (chatId: string, title: string) => {
      requireChat(chatId).title = title
    },
    archiveChat: async (chatId: string) => {
      requireChat(chatId).archivedAt = Date.now()
    },
    unarchiveChat: async (chatId: string) => {
      requireChat(chatId).archivedAt = null
    },
    deleteChat: async (chatId: string) => {
      requireChat(chatId).deletedAt = Date.now()
    },
    setChatReadState: async (chatId: string, unread: boolean) => {
      requireChat(chatId).unread = unread
    },
    setChatDoneState: async (chatId: string, done: boolean) => {
      requireChat(chatId).doneAt = done ? Date.now() : null
    },
  }

  let diffVersion = 1
  const bumpDiffVersion = () => {
    diffVersion += 1
  }
  const diffStore = {
    getProjectSnapshot: () => ({ status: "ready", branchName: "main", diffVersion, files: [] }),
    getSnapshotVersion: () => diffVersion,
    refreshSnapshot: async () => {
      bumpDiffVersion()
      return true
    },
    initializeGit: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    getGitHubPublishInfo: async () => ({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined, owners: [], suggestedRepoName: "repo" }),
    checkGitHubRepoAvailability: async () => ({ available: false, message: "n/a" }),
    publishToGitHub: async () => ({ ok: false, title: "n/a", message: "n/a", snapshotChanged: false }),
    listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
    previewMergeBranch: async () => ({ currentBranchName: undefined, targetBranchName: "", targetDisplayName: "", status: "error", commitCount: 0, hasConflicts: false, message: "n/a" }),
    mergeBranch: async () => ({ ok: false, title: "n/a", message: "n/a", snapshotChanged: false }),
    syncBranch: async () => ({ ok: true, action: "fetch", branchName: undefined, snapshotChanged: false }),
    checkoutBranch: async () => {
      bumpDiffVersion()
      return { ok: true, branchName: "feature/x", snapshotChanged: true }
    },
    createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
    generateCommitMessage: async () => ({ subject: "Update", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: async () => {
      bumpDiffVersion()
      return { ok: true, mode: "commit_only", branchName: "main", pushed: false, snapshotChanged: true }
    },
    discardFile: async () => ({ snapshotChanged: false }),
    ignoreFile: async () => ({ snapshotChanged: false }),
    readPatch: async () => ({ patch: "" }),
  }

  const agent = {
    getActiveStatuses: () => new Map(),
    getDrainingChatIds: () => new Set(),
    getPendingTool: () => null,
    cancel: async () => {},
    closeChat: async () => {},
    forkChat: async (chatId: string) => {
      requireChat(chatId)
      nextId += 1
      const fork = { ...makeChat(`chat-fork-${nextId}`, Date.now()), title: "Fork" }
      state.chatsById.set(fork.id, fork as never)
      return { chatId: fork.id }
    },
    enqueue: async (command: { chatId: string; content: string }) => {
      const queue = state.queuedMessagesByChatId.get(command.chatId) ?? []
      const queuedMessage = {
        id: `queued-${(nextId += 1)}`,
        content: command.content,
        attachments: [],
        createdAt: Date.now(),
      }
      state.queuedMessagesByChatId.set(command.chatId, [...queue, queuedMessage] as never)
      return { queuedMessageId: queuedMessage.id }
    },
    steer: async (command: { chatId: string; queuedMessageId: string }) => {
      const chat = requireChat(command.chatId)
      const queue = state.queuedMessagesByChatId.get(command.chatId) ?? []
      const queued = queue.find((entry) => entry.id === command.queuedMessageId)
      if (!queued) throw new Error("Queued message not found")
      state.queuedMessagesByChatId.set(command.chatId, queue.filter((entry) => entry.id !== command.queuedMessageId))
      const messages = messagesByChatId.get(command.chatId) ?? []
      messages.push({
        _id: `steered-${queued.id}`,
        kind: "user_prompt",
        content: queued.content,
        createdAt: Date.now(),
      } as never)
      messagesByChatId.set(command.chatId, messages)
      chat.lastMessageAt = Date.now()
    },
    dequeue: async (command: { chatId: string; queuedMessageId: string }) => {
      const queue = state.queuedMessagesByChatId.get(command.chatId) ?? []
      state.queuedMessagesByChatId.set(command.chatId, queue.filter((entry) => entry.id !== command.queuedMessageId))
    },
  }

  const appSettingsListeners = new Set<(snapshot: unknown) => void>()
  let appSettingsSnapshot: Record<string, unknown> = {
    analyticsEnabled: true,
    theme: "system",
    newSidebarEnabled: false,
  }
  const appSettings = {
    getSnapshot: () => appSettingsSnapshot,
    write: async (value: { analyticsEnabled: boolean }) => {
      appSettingsSnapshot = { ...appSettingsSnapshot, analyticsEnabled: value.analyticsEnabled }
      for (const listener of appSettingsListeners) listener(appSettingsSnapshot)
      return appSettingsSnapshot
    },
    writePatch: async (patch: Record<string, unknown>) => {
      appSettingsSnapshot = { ...appSettingsSnapshot, ...patch }
      for (const listener of appSettingsListeners) listener(appSettingsSnapshot)
      return appSettingsSnapshot
    },
    onChange: (listener: (snapshot: unknown) => void) => {
      appSettingsListeners.add(listener)
      return () => appSettingsListeners.delete(listener)
    },
  }

  const keybindingsListeners = new Set<() => void>()
  let keybindingsSnapshot: Record<string, unknown> = {
    bindings: { toggleEmbeddedTerminal: ["cmd+j"] },
    warning: null,
    filePathDisplay: "~/.kanna/keybindings.json",
  }
  const keybindings = {
    getSnapshot: () => keybindingsSnapshot,
    write: async (bindings: Record<string, string[]>) => {
      keybindingsSnapshot = { ...keybindingsSnapshot, bindings }
      for (const listener of keybindingsListeners) listener()
      return keybindingsSnapshot
    },
    onChange: (listener: () => void) => {
      keybindingsListeners.add(listener)
      return () => keybindingsListeners.delete(listener)
    },
  }

  const router = createWsRouter({
    store: store as never,
    diffStore: diffStore as never,
    agent: agent as never,
    terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
    keybindings: keybindings as never,
    appSettings: appSettings as never,
    llmProvider: {
      read: async () => ({ provider: "openai", apiKey: "", model: "", baseUrl: "", resolvedBaseUrl: "", faveModels: [], enabled: false, warning: null, filePathDisplay: "" }),
      write: async () => {
        throw new Error("not used")
      },
      validate: async () => ({ ok: true, error: null }),
    } as never,
    refreshDiscovery: async () => [],
    getDiscoveredProjects: () => [],
    machineDisplayName: "Staleness Machine",
    updateManager: null,
  })

  void options

  const world: World = {
    state,
    router,
    seedQueuedMessage: (chatId: string) => {
      state.queuedMessagesByChatId.set(chatId, [{
        id: "queued-seeded",
        content: "queued follow up",
        attachments: [],
        createdAt: nowMs - 1_000,
      }] as never)
    },
  }
  return world
}

interface StalenessCase {
  name: string
  command: Record<string, unknown> | ((context: { projectPath: string }) => Record<string, unknown>)
  prepare?: (world: World) => void
  /** Topics whose ground truth must differ from the pre-command snapshot (guards against vacuous passes). */
  expectChanged: TopicId[]
  /**
   * Topics deliberately allowed to lag after this command. Every entry must
   * carry a rationale in the table — an empty allowStale is the goal state.
   */
  allowStale?: TopicId[]
}

const CASES: StalenessCase[] = [
  {
    name: "project.open",
    command: ({ projectPath }) => ({ type: "project.open", localPath: projectPath }),
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects],
  },
  {
    name: "project.rename",
    command: { type: "project.rename", projectId: "project-1", title: "Renamed Project" },
    expectChanged: [TOPIC_IDS.sidebar],
  },
  {
    name: "project.remove",
    command: { type: "project.remove", projectId: "project-1" },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects, TOPIC_IDS.chat1, TOPIC_IDS.chat2, TOPIC_IDS.projectGit],
  },
  {
    name: "sidebar.reorderProjectGroups",
    command: { type: "sidebar.reorderProjectGroups", projectIds: ["project-2", "project-1"] },
    expectChanged: [TOPIC_IDS.sidebar],
  },
  {
    name: "chat.create",
    command: { type: "chat.create", projectId: "project-1" },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects],
  },
  {
    name: "chat.fork",
    command: { type: "chat.fork", chatId: "chat-1" },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects],
  },
  {
    name: "chat.rename",
    command: { type: "chat.rename", chatId: "chat-1", title: "Renamed Chat" },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.chat1],
  },
  {
    name: "chat.archive",
    command: { type: "chat.archive", chatId: "chat-1" },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects],
  },
  {
    name: "chat.unarchive",
    command: { type: "chat.unarchive", chatId: "chat-1" },
    prepare: (world) => {
      const chat = world.state.chatsById.get("chat-1") as { archivedAt: number | null }
      chat.archivedAt = Date.now() - 1_000
    },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects],
  },
  {
    name: "chat.delete",
    command: { type: "chat.delete", chatId: "chat-2" },
    expectChanged: [TOPIC_IDS.sidebar, TOPIC_IDS.localProjects, TOPIC_IDS.chat2],
  },
  {
    name: "chat.markRead",
    command: { type: "chat.markRead", chatId: "chat-1" },
    prepare: (world) => {
      const chat = world.state.chatsById.get("chat-1") as { unread: boolean }
      chat.unread = true
    },
    expectChanged: [TOPIC_IDS.sidebar],
  },
  {
    name: "chat.setDone",
    command: { type: "chat.setDone", chatId: "chat-1", done: true },
    expectChanged: [TOPIC_IDS.sidebar],
  },
  {
    name: "message.enqueue",
    command: { type: "message.enqueue", chatId: "chat-1", content: "queued", attachments: [] },
    expectChanged: [TOPIC_IDS.chat1],
  },
  {
    name: "message.steer",
    command: { type: "message.steer", chatId: "chat-1", queuedMessageId: "queued-seeded" },
    prepare: (world) => world.seedQueuedMessage("chat-1"),
    expectChanged: [TOPIC_IDS.chat1, TOPIC_IDS.sidebar],
    // Steering appends a message, which bumps the chat's lastMessageAt and
    // with it local-projects' lastOpenedAt ordering. Message appends are the
    // streaming hot path (they also flow through scheduleChatStateBroadcast),
    // so local-projects recency is deliberately eventually consistent there:
    // it reconverges on the next project/chat lifecycle command or discovery
    // refresh instead of re-deriving fs metadata on every appended message.
    allowStale: [TOPIC_IDS.localProjects],
  },
  {
    name: "message.dequeue",
    command: { type: "message.dequeue", chatId: "chat-1", queuedMessageId: "queued-seeded" },
    prepare: (world) => world.seedQueuedMessage("chat-1"),
    expectChanged: [TOPIC_IDS.chat1],
  },
  {
    name: "chat.refreshDiffs (snapshot changed)",
    command: { type: "chat.refreshDiffs", chatId: "chat-1" },
    expectChanged: [TOPIC_IDS.projectGit],
  },
  {
    name: "chat.commitDiffs (snapshot changed)",
    command: { type: "chat.commitDiffs", chatId: "chat-1", paths: ["a.txt"], summary: "Commit", description: "", mode: "commit_only" },
    expectChanged: [TOPIC_IDS.projectGit],
  },
  {
    name: "chat.checkoutBranch (snapshot changed)",
    command: { type: "chat.checkoutBranch", chatId: "chat-1", branch: { kind: "local", name: "feature/x" }, bringChanges: false },
    expectChanged: [TOPIC_IDS.projectGit],
  },
  {
    name: "settings.writeAppSettingsPatch",
    command: { type: "settings.writeAppSettingsPatch", patch: { theme: "dark" } },
    expectChanged: [TOPIC_IDS.appSettings],
  },
  {
    name: "settings.writeKeybindings",
    command: { type: "settings.writeKeybindings", bindings: { toggleEmbeddedTerminal: ["cmd+k"] } },
    expectChanged: [TOPIC_IDS.keybindings],
  },
]

async function subscribeToAllTopics(router: ReturnType<typeof createWsRouter>, ws: FakeWebSocket) {
  for (const [id, topic] of ALL_TOPICS) {
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id, topic }))
  }
  // local-projects pushes asynchronously after refreshDiscovery resolves.
  await settle()
}

describe("ws-router broadcast staleness invariant", () => {
  for (const stalenessCase of CASES) {
    test(`${stalenessCase.name} leaves no subscriber stale`, async () => {
      const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-staleness-"))
      try {
        const world = createWorld()
        stalenessCase.prepare?.(world)
        const { router } = world

        const actor = new FakeWebSocket()
        const observer = new FakeWebSocket()
        router.handleOpen(actor as never)
        router.handleOpen(observer as never)
        await subscribeToAllTopics(router, observer)

        const initialSnapshots = new Map<TopicId, string>()
        for (const [id] of ALL_TOPICS) {
          const snapshot = observer.lastSnapshot(id)
          expect(snapshot).toBeDefined()
          initialSnapshots.set(id, JSON.stringify(snapshot))
        }

        const command = typeof stalenessCase.command === "function"
          ? stalenessCase.command({ projectPath })
          : stalenessCase.command
        await router.handleMessage(
          actor as never,
          JSON.stringify({ v: 1, type: "command", id: `${stalenessCase.name}-1`, command })
        )
        // Some handlers broadcast fire-and-forget; let them settle.
        await settle()

        // Ground truth: a brand-new subscriber always receives current state.
        const probe = new FakeWebSocket()
        router.handleOpen(probe as never)
        await subscribeToAllTopics(router, probe)

        const errorEnvelope = actor.sent.find((entry) => entry.type === "error")
        expect(errorEnvelope).toBeUndefined()

        const changedTopics: TopicId[] = []
        for (const [id] of ALL_TOPICS) {
          const groundTruth = JSON.stringify(probe.lastSnapshot(id))
          const observed = JSON.stringify(observer.lastSnapshot(id))
          if (groundTruth !== initialSnapshots.get(id)) {
            changedTopics.push(id)
          }
          if (stalenessCase.allowStale?.includes(id)) continue
          if (observed !== groundTruth) {
            throw new Error(
              `${stalenessCase.name} left topic "${id}" stale.\n` +
              `observer has: ${observed}\n` +
              `ground truth: ${groundTruth}`
            )
          }
        }

        // Vacuity guard: the command must actually have changed what the case
        // says it changes, otherwise the invariant above passed trivially.
        for (const id of stalenessCase.expectChanged) {
          if (!changedTopics.includes(id)) {
            throw new Error(
              `${stalenessCase.name} was expected to change topic "${id}" but the ground truth is identical to the pre-command snapshot — the fake store mutation is a no-op and this case is vacuous.`
            )
          }
        }
      } finally {
        await rm(projectPath, { recursive: true, force: true })
      }
    })
  }
})

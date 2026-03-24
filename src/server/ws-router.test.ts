import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { KeybindingsSnapshot, UpdateSnapshot } from "../shared/types"
import { PROTOCOL_VERSION } from "../shared/types"
import { createEmptyState } from "./events"
import { GitManager } from "./git-manager"
import { createWsRouter } from "./ws-router"

const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-ws-router-"))
  tempDirs.push(directory)
  return directory
}

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
}

function cleanupTempDirs() {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

const DEFAULT_KEYBINDINGS_SNAPSHOT: KeybindingsSnapshot = {
  bindings: {
    submitChatMessage: ["enter"],
    toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
    toggleRightSidebar: ["ctrl+b"],
    openInFinder: ["cmd+alt+f"],
    openInEditor: ["cmd+shift+o"],
    addSplitTerminal: ["cmd+shift+j"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const DEFAULT_UPDATE_SNAPSHOT: UpdateSnapshot = {
  currentVersion: "0.12.0",
  latestVersion: null,
  status: "idle",
  updateAvailable: false,
  lastCheckedAt: null,
  error: null,
  installAction: "restart",
}

describe("ws-router", () => {
  test("acks system.ping without broadcasting snapshots", () => {
    const router = createWsRouter({
      store: { state: createEmptyState(), getChat: () => null } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-1", { type: "sidebar" })
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ping-1",
        command: { type: "system.ping" },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "ping-1",
      },
    ])
  })

  test("acks terminal.input without rebroadcasting terminal snapshots", () => {
    const router = createWsRouter({
      store: { state: createEmptyState(), getChat: () => null } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        write: () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-terminal", { type: "terminal", terminalId: "terminal-1" })
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "terminal-input-1",
        command: {
          type: "terminal.input",
          terminalId: "terminal-1",
          data: "ls\r",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "terminal-input-1",
      },
    ])
  })

  test("subscribes and unsubscribes chat topics", () => {
    const router = createWsRouter({
      store: { state: createEmptyState(), getChat: () => null } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub-1",
        topic: { type: "chat", chatId: "chat-1" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "chat-sub-1",
      snapshot: {
        type: "chat",
        data: null,
      },
    })

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "unsubscribe",
        id: "chat-sub-1",
      })
    )

    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "chat-sub-1",
    })
  })

  test("hides a discovered project without requiring a saved project record", async () => {
    const hiddenPaths: string[] = []
    const refreshed: string[] = []
    const router = createWsRouter({
      store: {
        state: createEmptyState(),
        listProjects: () => [],
        hideProject: async (localPath: string) => {
          hiddenPaths.push(localPath)
        },
      } as never,
      agent: { cancel: async () => {}, getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        closeByCwd: () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => {
        refreshed.push("done")
        return []
      },
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "project-hide-1",
        command: { type: "project.hide", localPath: "/tmp/project-1" },
      })
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(hiddenPaths).toEqual(["/tmp/project-1"])
    expect(refreshed).toEqual(["done"])
    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "project-hide-1",
      },
    ])
  })

  test("subscribes to keybindings snapshots and writes keybindings through the router", async () => {
    const initialSnapshot: KeybindingsSnapshot = DEFAULT_KEYBINDINGS_SNAPSHOT
    const keybindings = {
      snapshot: initialSnapshot,
      getSnapshot() {
        return this.snapshot
      },
      onChange: () => () => {},
      async write(bindings: KeybindingsSnapshot["bindings"]) {
        this.snapshot = { bindings, warning: null, filePathDisplay: "~/.kanna/keybindings.json" }
        return this.snapshot
      },
    }

    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: keybindings as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "keybindings-sub-1",
        topic: { type: "keybindings" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "keybindings-sub-1",
      snapshot: {
        type: "keybindings",
        data: keybindings.snapshot,
      },
    })

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "keybindings-write-1",
        command: {
          type: "settings.writeKeybindings",
          bindings: {
            submitChatMessage: ["shift+enter"],
            toggleEmbeddedTerminal: ["cmd+k"],
            toggleRightSidebar: ["ctrl+shift+b"],
            openInFinder: ["cmd+shift+g"],
            openInEditor: ["cmd+shift+p"],
            addSplitTerminal: ["cmd+alt+j"],
          },
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "keybindings-write-1",
      result: {
        bindings: {
          submitChatMessage: ["shift+enter"],
          toggleEmbeddedTerminal: ["cmd+k"],
          toggleRightSidebar: ["ctrl+shift+b"],
          openInFinder: ["cmd+shift+g"],
          openInEditor: ["cmd+shift+p"],
          addSplitTerminal: ["cmd+alt+j"],
        },
        warning: null,
        filePathDisplay: "~/.kanna/keybindings.json",
      },
    })
  })

  test("subscribes to update snapshots and handles update.check commands", async () => {
    const updateManager = {
      snapshot: { ...DEFAULT_UPDATE_SNAPSHOT },
      getSnapshot() {
        return this.snapshot
      },
      onChange: () => () => {},
      async checkForUpdates({ force }: { force?: boolean }) {
        this.snapshot = {
          ...this.snapshot,
          latestVersion: force ? "0.13.0" : "0.12.1",
          status: "available",
          updateAvailable: true,
          lastCheckedAt: 123,
        }
        return this.snapshot
      },
      async installUpdate() {
        return {
          ok: false,
          action: "restart",
          errorCode: "version_not_live_yet",
          userTitle: "Update not live yet",
          userMessage: "This update is still propagating. Try again in a few minutes.",
        }
      },
    }

    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: updateManager as never,
    })
    const ws = new FakeWebSocket()

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "update-sub-1",
        topic: { type: "update" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "update-sub-1",
      snapshot: {
        type: "update",
        data: DEFAULT_UPDATE_SNAPSHOT,
      },
    })

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "update-check-1",
        command: {
          type: "update.check",
          force: true,
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "update-check-1",
      result: {
        currentVersion: "0.12.0",
        latestVersion: "0.13.0",
        status: "available",
        updateAvailable: true,
        lastCheckedAt: 123,
        error: null,
        installAction: "restart",
      },
    })

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "update-install-1",
        command: {
          type: "update.install",
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[2]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "update-install-1",
      result: {
        ok: false,
        action: "restart",
        errorCode: "version_not_live_yet",
        userTitle: "Update not live yet",
        userMessage: "This update is still propagating. Try again in a few minutes.",
      },
    })
  })

  test("project.open returns the newest existing chat when the project already has history", async () => {
    const chatState = new Map<string, {
      id: string
      projectId: string
      provider: "claude" | "codex" | null
      sessionToken: string | null
      title: string
      updatedAt: number
      lastMessageAt?: number
    }>()

    chatState.set("chat-existing", {
      id: "chat-existing",
      projectId: "project-1",
      provider: "claude",
      sessionToken: "session-1",
      title: "Recovered chat",
      updatedAt: 10,
      lastMessageAt: 10,
    })

    const store = {
      state: createEmptyState(),
      unhideProject: async () => {},
      openProject: async () => ({
        id: "project-1",
        repoKey: "path:/tmp/project-1",
        localPath: "/tmp/project-1",
        worktreePaths: ["/tmp/project-1"],
        title: "project-1",
      }),
      isProjectHidden: () => false,
      listChatsByProject: () => [...chatState.values()].sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)),
      createChat: async (projectId: string) => {
        const next = {
          id: `chat-${chatState.size + 1}`,
          projectId,
          provider: null,
          sessionToken: null,
          title: "New Chat",
          updatedAt: chatState.size + 1,
        }
        chatState.set(next.id, next)
        return next
      },
      renameChat: async (chatId: string, title: string) => {
        const chat = chatState.get(chatId)
        if (chat) chat.title = title
      },
      setChatProvider: async (chatId: string, provider: "claude" | "codex") => {
        const chat = chatState.get(chatId)
        if (chat) chat.provider = provider
      },
      setSessionToken: async (chatId: string, sessionToken: string | null) => {
        const chat = chatState.get(chatId)
        if (chat) chat.sessionToken = sessionToken
      },
      appendMessage: async (chatId: string, entry: any) => {
        const chat = chatState.get(chatId)
        if (!chat) return
        chat.updatedAt = entry.createdAt
        if (entry.kind === "user_prompt") {
          chat.lastMessageAt = entry.createdAt
        }
      },
    }

    const router = createWsRouter({
      store: store as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "project-1")
    mkdirSync(projectDir, { recursive: true })
    const originalHome = process.env.HOME
    process.env.HOME = homeDir

    try {
      router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-open-1",
          command: { type: "project.open", localPath: projectDir },
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 25))
    } finally {
      process.env.HOME = originalHome
      cleanupTempDirs()
    }

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "project-open-1",
        result: {
          projectId: "project-1",
          chatId: "chat-existing",
          importedChats: 0,
        },
      },
    ])
  })

  test("project.open rejects missing directories instead of creating them", async () => {
    const router = createWsRouter({
      store: {
        state: createEmptyState(),
        getChat: () => null,
      } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    const homeDir = makeTempDir()
    const missingProjectDir = path.join(homeDir, "missing-project")
    const originalHome = process.env.HOME
    process.env.HOME = homeDir

    try {
      router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-open-missing",
          command: { type: "project.open", localPath: missingProjectDir },
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 25))
    } finally {
      process.env.HOME = originalHome
      cleanupTempDirs()
    }

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "error",
        id: "project-open-missing",
        message: `Project folder not found: ${missingProjectDir}`,
      },
    ])
  })

  test("system.listDirectory returns browsable host directories", async () => {
    const router = createWsRouter({
      store: {
        state: createEmptyState(),
        getChat: () => null,
      } as never,
      agent: { getActiveStatuses: () => new Map(), getLiveUsage: () => null } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    const homeDir = makeTempDir()
    const childDir = path.join(homeDir, "alpha")
    mkdirSync(childDir, { recursive: true })

    try {
      router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "list-directory-1",
          command: { type: "system.listDirectory", localPath: homeDir },
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 25))
    } finally {
      cleanupTempDirs()
    }

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "list-directory-1",
        result: {
          currentPath: homeDir,
          parentPath: path.dirname(homeDir) === homeDir ? null : path.dirname(homeDir),
          roots: [
            { name: "Home", localPath: homedir() },
            { name: "/", localPath: "/" },
          ],
          entries: [
            { name: "alpha", localPath: childDir },
          ],
        },
      },
    ])
  })
})

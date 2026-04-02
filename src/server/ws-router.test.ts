import { describe, expect, test } from "bun:test"
import type { KeybindingsSnapshot, UpdateSnapshot } from "../shared/types"
import { PROTOCOL_VERSION } from "../shared/types"
import { createEmptyState } from "./events"
import { createWsRouter } from "./ws-router"

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
    clientContext: undefined,
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
}

const DEFAULT_KEYBINDINGS_SNAPSHOT: KeybindingsSnapshot = {
  bindings: {
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
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
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
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        write: () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
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

  test("stores client context and passes it to chat.send", async () => {
    const calls: unknown[] = []
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        send: async (command: unknown, clientContext: unknown) => {
          calls.push({ command, clientContext })
          return { chatId: "chat-1" }
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
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
        type: "command",
        id: "ctx-1",
        command: {
          type: "system.setClientContext",
          context: {
            currentUserDevice: "pixel",
            currentUserDeviceLabel: "pixel",
          },
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "chat-send-1",
        command: {
          type: "chat.send",
          projectId: "project-1",
          content: "hello",
        },
      })
    )

    expect(calls).toEqual([
      {
        command: {
          type: "chat.send",
          projectId: "project-1",
          content: "hello",
        },
        clientContext: {
          currentUserDevice: "pixel",
          currentUserDeviceLabel: "pixel",
        },
      },
    ])
  })

  test("subscribes and unsubscribes chat topics", () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
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

  test("marks chats read and rebroadcasts sidebar snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: true,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const store = {
      state,
      async setChatReadState(chatId: string, unread: boolean) {
        const chat = state.chatsById.get(chatId)
        if (!chat) throw new Error("Chat not found")
        chat.unread = unread
      },
    }

    const router = createWsRouter({
      store: store as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()

    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)

    router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-a",
        topic: { type: "sidebar" },
      })
    )
    router.handleMessage(
      wsB as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-b",
        topic: { type: "sidebar" },
      })
    )

    router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "mark-read-1",
        command: { type: "chat.markRead", chatId: "chat-1" },
      })
    )

    await Promise.resolve()

    expect(wsA.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "mark-read-1",
    })
    expect(wsA.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-a",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [{
            groupKey: "project-1",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: null,
              lastMessageAt: undefined,
              hasAutomation: false,
            }],
          }],
        },
      },
    })
    expect(wsB.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-b",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [{
            groupKey: "project-1",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: null,
              lastMessageAt: undefined,
              hasAutomation: false,
            }],
          }],
        },
      },
    })
  })

  test("broadcasts background title-generation errors to connected clients", () => {
    let reportBackgroundError: ((message: string) => void) | null | undefined
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        setBackgroundErrorReporter: (reporter: ((message: string) => void) | null) => {
          reportBackgroundError = reporter
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    reportBackgroundError?.("[title-generation] chat chat-1 failed")

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "error",
        message: "[title-generation] chat chat-1 failed",
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
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: keybindings as never,
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
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
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
})

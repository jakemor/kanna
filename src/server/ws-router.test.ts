import { describe, expect, test } from "bun:test"
import type { KeybindingsSnapshot, UpdateSnapshot } from "../shared/types"
import { PROTOCOL_VERSION } from "../shared/types"
import { createEmptyState } from "./events"
import { createWsRouter } from "./ws-router"

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
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

  test("loads older chat history chunks through chat.loadMore", async () => {
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
      provider: "codex",
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
      activeTurn: null,
    })
    state.messagesByChatId.set("chat-1", Array.from({ length: 4 }, (_, index) => ({
      _id: `msg-${index + 1}`,
      createdAt: index + 1,
      kind: "assistant_text" as const,
      text: `message ${index + 1}`,
    })))

    const router = createWsRouter({
      store: { state } as never,
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
        type: "command",
        id: "chat-load-1",
        command: {
          type: "chat.loadMore",
          chatId: "chat-1",
          beforeMessageId: "msg-4",
          limit: 2,
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "chat-load-1",
      result: {
        runtime: {
          chatId: "chat-1",
          projectId: "project-1",
          localPath: "/tmp/project",
          title: "Chat",
          status: "idle",
          provider: "codex",
          planMode: false,
          sessionToken: null,
        },
        messages: [
          { _id: "msg-2", createdAt: 2, kind: "assistant_text", text: "message 2" },
          { _id: "msg-3", createdAt: 3, kind: "assistant_text", text: "message 3" },
        ],
        hasOlderMessages: true,
        oldestLoadedMessageId: "msg-2",
        availableProviders: expect.any(Array),
      },
    })
  })

  test("prefetches chat snapshots without opening a live subscription", async () => {
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
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
      activeTurn: null,
    })

    const router = createWsRouter({
      store: { state } as never,
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
        type: "command",
        id: "chat-prefetch-1",
        command: {
          type: "chat.prefetch",
          chatId: "chat-1",
        },
      })
    )

    await Promise.resolve()
    expect((ws.sent[0] as any).type).toBe("ack")
    expect((ws.sent[0] as any).result.runtime.chatId).toBe("chat-1")
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

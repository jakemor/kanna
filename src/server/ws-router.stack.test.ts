import { describe, expect, test } from "bun:test"
import type { KeybindingsSnapshot } from "../shared/types"
import type { ClientCommand } from "../shared/protocol"
import { createWsRouter } from "./ws-router"
import { createTestEventStore } from "./storage/test-helpers"

async function createTempDataDir(): Promise<string> {
  return `/virtual/stack-ws-test-${crypto.randomUUID()}`
}

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
    protectedDraftChatIds: new Set<string>(),
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
    jumpToSidebarChat: ["cmd+alt"],
    createChatInCurrentProject: ["cmd+alt+n"],
    openAddProject: ["cmd+alt+o"],
    newStack: ["cmd+alt+w"],
    newStackChat: ["cmd+alt+shift+n"],
    jumpToStacks: ["g s"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const NOOP_PUSH_MANAGER = {
  initialize: async () => {},
  observeStatuses: async () => {},
  getConfigSnapshot: () => ({
    vapidPublicKey: "test-key",
    preferences: { globalEnabled: true, mutedProjectPaths: [] },
    devices: [],
  }),
  addSubscription: async () => ({ id: "test-device-id" }),
  removeSubscription: async () => {},
  recordDeviceSeen: async () => {},
  setProjectMute: async () => {},
  setFocusedChat: () => {},
  clearFocus: () => {},
  sendTest: async () => {},
} as never

async function buildRouterWithStore() {
  const store = createTestEventStore(await createTempDataDir())
  await store.initialize()
  const p1 = await store.openProject("/tmp/stack-test-p1", "Project 1")
  const p2 = await store.openProject("/tmp/stack-test-p2", "Project 2")
  const p3 = await store.openProject("/tmp/stack-test-p3", "Project 3")

  const router = createWsRouter({
    store,
    agent: {
      getActiveStatuses: () => new Map(),
      getDrainingChatIds: () => new Set(),
      getSlashCommandsLoadingChatIds: () => new Set(),
      getWaitStartedAtByChatId: () => new Map(),
      ensureSlashCommandsLoaded: async () => {},
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
    pushManager: NOOP_PUSH_MANAGER,
  })

  return { store, router, p1, p2, p3 }
}

describe("ws-router stack commands", () => {
  test("stack.create routes to store.createStack and acks with stackId", async () => {
    const { store, router, p1, p2 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-1",
        command: { type: "stack.create", title: "My Stack", projectIds: [p1.id, p2.id] },
      })
    )

    const ack = ws.sent[0] as { v: number; type: string; id: string; result: { stackId: string } }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("cmd-1")
    expect(ack.result.stackId).toMatch(/[0-9a-f-]{36}/u)
    expect(store.listStacks()).toHaveLength(1)
    expect(store.listStacks()[0]?.title).toBe("My Stack")
  })

  test("stack.create with <2 projects sends an error ack", async () => {
    const { router, p1 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-err",
        command: { type: "stack.create", title: "Solo", projectIds: [p1.id] },
      })
    )

    const response = ws.sent[0] as { type: string; id: string }
    expect(response.type).toBe("error")
    expect(response.id).toBe("cmd-err")
  })

  test("stack.rename routes to store.renameStack and acks", async () => {
    const { store, router, p1, p2 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // Create a stack first
    const stack = await store.createStack("Original", [p1.id, p2.id])

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-rename",
        command: { type: "stack.rename", stackId: stack.id, title: "Renamed" },
      })
    )

    const ack = ws.sent[0] as { type: string; id: string }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("cmd-rename")
    expect(store.getStack(stack.id)?.title).toBe("Renamed")
  })

  test("stack.remove routes to store.removeStack and acks", async () => {
    const { store, router, p1, p2 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    const stack = await store.createStack("ToRemove", [p1.id, p2.id])

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-remove",
        command: { type: "stack.remove", stackId: stack.id },
      })
    )

    const ack = ws.sent[0] as { type: string; id: string }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("cmd-remove")
    expect(store.listStacks()).toHaveLength(0)
  })

  test("stack.addProject routes to store.addProjectToStack and acks", async () => {
    const { store, router, p1, p2, p3 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    const stack = await store.createStack("AddTest", [p1.id, p2.id])

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-addproject",
        command: { type: "stack.addProject", stackId: stack.id, projectId: p3.id },
      })
    )

    const ack = ws.sent[0] as { type: string; id: string }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("cmd-addproject")
    const updated = store.getStack(stack.id)
    expect(updated?.projectIds).toContain(p3.id)
    expect(updated?.projectIds).toHaveLength(3)
  })

  test("stack.removeProject routes to store.removeProjectFromStack and acks", async () => {
    const { store, router, p1, p2, p3 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    const stack = await store.createStack("RemoveTest", [p1.id, p2.id, p3.id])

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-removeproject",
        command: { type: "stack.removeProject", stackId: stack.id, projectId: p1.id },
      })
    )

    const ack = ws.sent[0] as { type: string; id: string }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("cmd-removeproject")
    const updated = store.getStack(stack.id)
    expect(updated?.projectIds).not.toContain(p1.id)
    expect(updated?.projectIds).toHaveLength(2)
  })

  test("chat.create with stack args persists bindings on the chat", async () => {
    const { store, router, p1, p2 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    const stack = await store.createStack("BindingStack", [p1.id, p2.id])

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-chatcreate",
        command: {
          type: "chat.create",
          projectId: p1.id,
          stackId: stack.id,
          stackBindings: [
            { projectId: p1.id, worktreePath: "/tmp/stack-test-p1", role: "primary" },
            { projectId: p2.id, worktreePath: "/tmp/stack-test-p2", role: "additional" },
          ],
        },
      })
    )

    const ack = ws.sent[0] as { v: number; type: string; id: string; result: { chatId: string } }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("cmd-chatcreate")
    expect(ack.result.chatId).toMatch(/[0-9a-f-]{36}/u)

    const chat = store.getChat(ack.result.chatId)
    expect(chat?.stackId).toBe(stack.id)
    expect(chat?.stackBindings).toEqual([
      { projectId: p1.id, worktreePath: "/tmp/stack-test-p1", role: "primary" },
      { projectId: p2.id, worktreePath: "/tmp/stack-test-p2", role: "additional" },
    ])
  })

  test("stack.listWorktrees is a valid ClientCommand", () => {
    const cmd: ClientCommand = { type: "stack.listWorktrees", projectId: "any-id" }
    expect(cmd.type).toBe("stack.listWorktrees")
  })

  test("chat.create rejects bindings violating invariants (e.g. no primary)", async () => {
    const { store, router, p1, p2 } = await buildRouterWithStore()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    const stack = await store.createStack("NoPrimaryStack", [p1.id, p2.id])

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cmd-chatcreate-err",
        command: {
          type: "chat.create",
          projectId: p1.id,
          stackId: stack.id,
          stackBindings: [
            { projectId: p1.id, worktreePath: "/tmp/stack-test-p1", role: "additional" },
            { projectId: p2.id, worktreePath: "/tmp/stack-test-p2", role: "additional" },
          ],
        },
      })
    )

    const response = ws.sent[0] as { type: string; id: string }
    expect(response.type).toBe("error")
    expect(response.id).toBe("cmd-chatcreate-err")
  })
})

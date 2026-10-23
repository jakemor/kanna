import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeFakeDiffStore } from "./diff-store.fake"
import { makeFakeKeybindings } from "./keybindings.fake"
import { makeFakeAppSettings } from "./app-settings.fake"
import { makeFakeAnalytics } from "./analytics.fake"
import { makeFakeTerminals } from "./terminal-manager.fake"
import { makeFakeWorktreeProbe } from "./worktree-probe.fake"
import { makeFakeProviderAuth } from "./provider-auth.fake"
import { ProviderAuthError } from "./provider-auth"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { AppSettingsSnapshot, KeybindingsSnapshot, LlmProviderSnapshot, SidebarData, UpdateSnapshot } from "../shared/types"
import { applySidebarPatch, type SidebarPatch } from "../shared/sidebar-patch"
import { PROTOCOL_VERSION } from "../shared/types"
import { findTranscriptWindowStart } from "../shared/transcript-window"
import { createEmptyState } from "./events"
import { openEventStore } from "./event-store-bridge"
import { fakeRouterStore } from "./chat-commands.fake"
import { deriveLocalProjectsSnapshot } from "./read-models"
import { SERVER_PROVIDERS, applyCodexModels, resetServerProvidersForTests } from "./provider-catalog"
import { createWsRouter } from "./ws-router"
import { makeFakeUpdateManager } from "./update-manager.fake"
import { testLocalMachine } from "./testing/local-machine"
import { testPlatformContext } from "./platform/testing"

function withSidebarGroupDefaults(group: {
  groupKey: string
  title: string
  realTitle?: string
  localPath: string
  chats: Array<{
    _id: string
    _creationTime: number
    chatId: string
    title: string
    status: "idle" | "starting" | "running" | "waiting_for_user" | "failed"
    unread: boolean
    localPath: string
    provider: "claude" | "codex" | null
    lastMessageAt?: number
    canFork?: boolean
    hasAutomation: boolean
  }>
}) {
  return {
    ...group,
    realTitle: group.realTitle ?? group.title,
    previewChats: group.chats,
    olderChats: [],
    defaultCollapsed: true,
  }
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
    openCommandPalette: ["cmd+k", "ctrl+k"],
    toggleFocusMode: ["cmd+shift+f", "ctrl+shift+f"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const DEFAULT_APP_SETTINGS_SNAPSHOT: AppSettingsSnapshot = {
  devbox: false,
  installedTerminals: null,
  installedEditors: null,
  analyticsEnabled: true,
  browserSettingsMigrated: false,
  setupShown: false,
  setupCompleted: false,
  setupDismissed: false,
  theme: "system",
  chatSoundPreference: "always",
  chatSoundId: "funk",
  chatBrowserNotificationPreference: "never",
  submitWhileRunning: "queue",
  paneVisibility: { widgets: "chat", terminal: "chat" },
  terminal: {
    scrollbackLines: 1_000,
    minColumnWidth: 450,
    webglRenderer: false,
  },
  editor: {
    preset: "cursor",
    commandTemplate: "cursor {path}",
  },
  transcript: {
    windowAssistantMessages: 50,
  },
  defaultProvider: "last_used",
  providerDefaults: {
    claude: {
      model: "claude-opus-4-8",
      modelOptions: {
        reasoningEffort: "high",
        contextWindow: "1m",
        fastMode: false,
      },
      planMode: false,
      autoPlan: false,
    },
    codex: {
      model: "gpt-5.5",
      modelOptions: {
        reasoningEffort: "high",
        fastMode: false,
      },
      planMode: false,
      autoPlan: false,
    },
    cursor: {
      model: "composer-2.5",
      modelOptions: {
        fastMode: false,
      },
      planMode: false,
      autoPlan: false,
    },
    grok: {
      model: "grok-4.6",
      modelOptions: {
        reasoningEffort: "high",
      },
      planMode: false,
      autoPlan: false,
    },
    pi: {
      model: "~anthropic/claude-fable-latest",
      modelOptions: {
        reasoningEffort: "medium",
      },
      planMode: false,
      autoPlan: false,
    },
  },
  newSidebarEnabled: false,
  newProjectsDirectory: "~/Kanna",
  warning: null,
  filePathDisplay: "~/.kanna/data/settings.json",
}

const DEFAULT_UPDATE_SNAPSHOT: UpdateSnapshot = {
  currentVersion: "0.12.0",
  latestVersion: null,
  status: "idle",
  updateAvailable: false,
  lastCheckedAt: null,
  error: null,
  installAction: "restart",
  reloadRequestedAt: null,
}

const DEFAULT_LLM_PROVIDER_SNAPSHOT: LlmProviderSnapshot = {
  provider: "openai",
  apiKey: "",
  model: "",
  baseUrl: "",
  resolvedBaseUrl: "https://api.openai.com/v1",
  faveModels: [],
  enabled: false,
  warning: null,
  filePathDisplay: "~/.kanna/llm-provider.json",
}

type CreateWsRouterArgs = Parameters<typeof createWsRouter>[0]

/** In-memory EventStore stand-in covering the methods the router always calls. */
function createFakeStore(overrides: Record<string, unknown> = {}) {
  const store = {
    state: createEmptyState(),
    getSidebarProjectOrder: () => [],
    pruneStaleEmptyChats: async () => [],
    // Whole transcript by default; the window tests override these.
    getInitialTranscriptWindowStart: () => 0,
    widenTranscriptWindowStart: (_chatId: string, current: number) => current,
    ...overrides,
  }
  return fakeRouterStore(store) as never
}

function createFakeLlmProvider(): CreateWsRouterArgs["llmProvider"] {
  return {
    read: () => Effect.succeed(DEFAULT_LLM_PROVIDER_SNAPSHOT),
    write: (value) => Effect.succeed({
      ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
      faveModels: value.faveModels ?? [],
    }),
    validate: () => Effect.succeed({ ok: true, error: null }),
  }
}

/** Builds a router with fake dependencies; pass overrides for the pieces a test cares about. */
function createTestRouter(overrides: Partial<CreateWsRouterArgs> = {}) {
  return createWsRouter({
    platform: testPlatformContext,
    store: createFakeStore(),
    diffStore: makeFakeDiffStore(),
    worktreeProbe: makeFakeWorktreeProbe(),
    agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
    terminals: makeFakeTerminals(),
    keybindings: makeFakeKeybindings(DEFAULT_KEYBINDINGS_SNAPSHOT),
    appSettings: makeFakeAppSettings(DEFAULT_APP_SETTINGS_SNAPSHOT),
    llmProvider: createFakeLlmProvider(),
    refreshDiscovery: () => Effect.succeed([]),
    getDiscoveredProjects: () => [],
    machineDisplayName: "Local Machine",
    updateManager: null,
    ...overrides,
  })
}

describe("ws-router", () => {
  test("keeps JSON and envelope errors distinct at the WebSocket boundary", async () => {
    const router = createTestRouter()
    const ws = new FakeWebSocket()
    await router.handleMessage(ws as never, "{bad")
    await router.handleMessage(ws as never, "42")
    await router.handleMessage(ws as never, JSON.stringify({ v: 2, type: "command", id: "wrong-version" }))
    expect(ws.sent).toEqual([
      { v: 1, type: "error", message: "Invalid JSON" },
      { v: 1, type: "error", message: "Invalid envelope" },
      { v: 1, type: "error", message: "Invalid envelope" },
    ])
    router.dispose()
  })

  test("dispatches unknown and incomplete commands without changing their responses", async () => {
    const router = createTestRouter({ store: createFakeStore({ getProject: () => null }) })
    const ws = new FakeWebSocket()
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id: "future", command: { type: "future.command" } }))
    expect(ws.sent).toEqual([])
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id: "incomplete", command: { type: "project.readCommit", projectId: "missing" } }))
    expect(ws.sent).toEqual([{ v: 1, type: "error", id: "incomplete", message: "Project not found" }])
    router.dispose()
  })

  test("native agent command failures keep their wire error text", async () => {
    const router = createTestRouter({
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        stopDrainingEffect: () => Effect.fail(new Error("Cannot stop draining")),
      } as never,
    })
    const ws = new FakeWebSocket()
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "stop", command: { type: "chat.stopDraining", chatId: "chat-1" },
    }))
    expect(ws.sent).toEqual([{ v: 1, type: "error", id: "stop", message: "Cannot stop draining" }])
    router.dispose()
  })

  test("skill listing uses the agent's native Effect operation", async () => {
    const calls: unknown[] = []
    const snapshot = { provider: "claude", skills: [], origin: "filesystem" }
    const router = createTestRouter({
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        listSkillsEffect: (command: unknown) => Effect.sync(() => {
          calls.push(command)
          return snapshot
        }),
      } as never,
    })
    const ws = new FakeWebSocket()
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "skills",
      command: { type: "chat.listSkills", provider: "claude", projectId: "project-1" },
    }))
    expect(calls).toEqual([{ type: "chat.listSkills", provider: "claude", projectId: "project-1" }])
    expect(ws.sent).toEqual([{ v: 1, type: "ack", id: "skills", result: snapshot }])
    router.dispose()
  })

  test("passes nested and extra fields through to the command handler", async () => {
    const router = createTestRouter()
    const ws = new FakeWebSocket()
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "patch", extra: "outer",
      command: { type: "settings.writeAppSettingsPatch", patch: { theme: "sepia", futureSetting: 7 }, extra: "inner" },
    }))
    expect(ws.sent).toContainEqual(expect.objectContaining({
      v: 1, type: "ack", id: "patch", result: expect.objectContaining({ theme: "sepia", futureSetting: 7 }),
    }))
    router.dispose()
  })

  test("disposal stops the router's scoped terminal event listener", async () => {
    const terminals = makeFakeTerminals()
    const router = createTestRouter({ terminals })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    ws.data.subscriptions.set("terminal-sub", { type: "terminal", terminalId: "t1" })
    terminals.emit({ type: "terminal.output", terminalId: "t1", data: "before" })
    await Bun.sleep(5)
    expect(ws.sent).toEqual([{ v: 1, type: "event", id: "terminal-sub", event: { type: "terminal.output", terminalId: "t1", data: "before" } }])
    router.dispose()
    await Bun.sleep(5)
    terminals.emit({ type: "terminal.output", terminalId: "t1", data: "after" })
    await Bun.sleep(5)
    expect(ws.sent).toHaveLength(1)
  })

  test("git lookup failures retain their command error messages", async () => {
    const router = createTestRouter({ store: createFakeStore({ getChat: () => null, getProject: () => null }) })
    const ws = new FakeWebSocket()
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "chat-git", command: { type: "chat.refreshDiffs", chatId: "missing" },
    }))
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "project-git", command: { type: "project.generateCommitMessage", projectId: "missing", paths: [] },
    }))
    expect(ws.sent).toEqual([
      { v: 1, type: "error", id: "chat-git", message: "Chat not found" },
      { v: 1, type: "error", id: "project-git", message: "Project not found" },
    ])
    router.dispose()
  })

  test("renames a discovered project by path and updates all project lists", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-rename-project-"))
    try {
      const store = await openEventStore(path.join(projectPath, "data"))
      const discovered = [{ localPath: projectPath, title: "Project", modifiedAt: 1 }]
      const router = createTestRouter({ store: store.service, getDiscoveredProjects: () => discovered })
      const ws = new FakeWebSocket()
      router.handleOpen(ws as never)
      ws.data.subscriptions.set("projects", { type: "local-projects" })

      await router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "rename-project",
        command: { type: "project.rename", localPath: projectPath, title: "Display Name" },
      }))

      const projects = deriveLocalProjectsSnapshot(store.state, discovered, { ...testLocalMachine, displayName: "Local Machine" }).projects
      expect(projects).toHaveLength(1)
      expect(projects[0]).toMatchObject({ localPath: projectPath, sidebarTitle: "Display Name", chatCount: 0 })
      expect(store.state.chatsById.size).toBe(0)
      expect(ws.sent).toContainEqual({
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "projects",
        snapshot: {
          type: "local-projects",
          data: { machine: { id: "local", displayName: "Local Machine", platform: process.platform }, projects },
        },
      })
      expect((await stat(projectPath)).isDirectory()).toBe(true)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test.each(["saved", "discovered"])("hides a %s project by path without creating a chat", async (source) => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-hide-project-"))
    try {
      const dataDir = path.join(projectPath, "data")
      const store = await openEventStore(dataDir)
      const savedProject = source === "saved" ? await store.openProject(projectPath) : null
      const discovered = [{ localPath: projectPath, title: "Project", modifiedAt: 1 }]
      const router = createTestRouter({ store: store.service, getDiscoveredProjects: () => discovered })
      const ws = new FakeWebSocket()
      router.handleOpen(ws as never)
      ws.data.subscriptions.set("projects", { type: "local-projects" })

      await router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "hide-project",
        command: { type: "project.remove", localPath: `${projectPath}/` },
      }))

      const hidden = [...store.state.projectsById.values()][0]!
      expect(hidden.localPath).toBe(projectPath)
      expect(hidden.deletedAt).toBeNumber()
      if (savedProject) expect(hidden.id).toBe(savedProject.id)
      expect(store.state.chatsById.size).toBe(0)
      expect(ws.sent).toContainEqual({
        v: PROTOCOL_VERSION, type: "ack", id: "hide-project", result: { projectId: hidden.id },
      })
      expect(ws.sent).toContainEqual({
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "projects",
        snapshot: {
          type: "local-projects",
          data: { machine: { id: "local", displayName: "Local Machine", platform: process.platform }, projects: [] },
        },
      })

      const reloaded = await openEventStore(dataDir)
      expect(deriveLocalProjectsSnapshot(reloaded.state, discovered, { ...testLocalMachine, displayName: "Machine" }).projects).toEqual([])
      expect((await stat(projectPath)).isDirectory()).toBe(true)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("acks system.ping without broadcasting snapshots", async () => {
    const router = createTestRouter()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    ws.data.subscriptions.set("sub-1", { type: "sidebar" })
    await router.handleMessage(
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

  test("reads and writes llm provider settings via commands", async () => {
    const writes: Array<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl"> & Partial<Pick<LlmProviderSnapshot, "faveModels">>> = []
    const router = createTestRouter({
      llmProvider: {
        read: () => Effect.succeed(DEFAULT_LLM_PROVIDER_SNAPSHOT),
        write: (value) => Effect.sync(() => {
          writes.push(value)
          return {
            ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
            ...value,
            resolvedBaseUrl: value.provider === "custom" ? value.baseUrl : "https://api.openai.com/v1",
            faveModels: [],
            enabled: Boolean(value.apiKey && value.model),
          }
        }),
        validate: () => Effect.succeed({
          ok: true,
          error: null,
        }),
      },
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-read-1",
        command: { type: "settings.readLlmProvider" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-write-1",
        command: {
          type: "settings.writeLlmProvider",
          provider: "custom",
          apiKey: "test-key",
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-read-1",
        result: DEFAULT_LLM_PROVIDER_SNAPSHOT,
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-write-1",
        result: {
          ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
          provider: "custom",
          apiKey: "test-key",
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
          resolvedBaseUrl: "https://example.com/v1",
          faveModels: [],
          enabled: true,
        },
      },
    ])
    expect(writes).toEqual([{
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://example.com/v1",
      // The command omitted faveModels, so the handler carried over the saved
      // list (empty here) instead of wiping it.
      faveModels: [],
    }])
  })

  test("reads and writes app settings via commands", async () => {
    const writes: Array<{ analyticsEnabled: boolean }> = []
    const settings = makeFakeAppSettings(DEFAULT_APP_SETTINGS_SNAPSHOT)
    const router = createTestRouter({
      appSettings: {
        ...settings,
        write: (value) => {
          writes.push(value)
          return settings.write(value)
        },
      },
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-read-1",
        command: { type: "settings.readAppSettings" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-write-1",
        command: {
          type: "settings.writeAppSettings",
          analyticsEnabled: false,
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "settings-read-1",
        // Acks carry the live provider catalog too: the client replaces its
        // snapshot with them.
        result: { ...DEFAULT_APP_SETTINGS_SNAPSHOT, availableProviders: SERVER_PROVIDERS },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "settings-write-1",
        result: {
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          availableProviders: SERVER_PROVIDERS,
          analyticsEnabled: false,
        },
      },
    ])
    expect(writes).toEqual([{ analyticsEnabled: false }])
  })

  test("subscribes to app settings and writes patches through the router", async () => {
    const router = createTestRouter({
      appSettings: makeFakeAppSettings(DEFAULT_APP_SETTINGS_SNAPSHOT),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "app-settings-sub-1",
        topic: { type: "app-settings" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-patch-1",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            theme: "dark",
            terminal: { scrollbackLines: 2_000 },
          },
        },
      })
    )

    // The change reaches subscribers from the settings' change stream, so
    // the push and the ack can land in either order.
    for (let attempt = 0; ws.sent.length < 3 && attempt < 100; attempt += 1) {
      await Bun.sleep(1)
    }
    expect(ws.sent).toHaveLength(3)
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "app-settings-sub-1",
      snapshot: {
        type: "app-settings",
        // The live provider catalog rides along for pickers outside a chat.
        data: { ...DEFAULT_APP_SETTINGS_SNAPSHOT, availableProviders: SERVER_PROVIDERS },
      },
    })
    expect(ws.sent.slice(1)).toEqual(expect.arrayContaining([
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT,
            availableProviders: SERVER_PROVIDERS,
            theme: "dark",
            terminal: {
              ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
              scrollbackLines: 2_000,
            },
          },
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "settings-patch-1",
        result: {
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          availableProviders: SERVER_PROVIDERS,
          theme: "dark",
          terminal: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
            scrollbackLines: 2_000,
          },
        },
      },
    ]))
  })

  test("tracks analytics preference transitions in the correct order", async () => {
    const { analytics, events: analyticsEvents } = makeFakeAnalytics()
    const router = createTestRouter({
      appSettings: makeFakeAppSettings({ ...DEFAULT_APP_SETTINGS_SNAPSHOT, analyticsEnabled: true }),
      analytics,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-disable-1",
        command: {
          type: "settings.writeAppSettings",
          analyticsEnabled: false,
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-enable-1",
        command: {
          type: "settings.writeAppSettings",
          analyticsEnabled: true,
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-enable-2",
        command: {
          type: "settings.writeAppSettings",
          analyticsEnabled: true,
        },
      })
    )

    expect(analyticsEvents).toEqual([
      "analytics_disabled",
      "analytics_enabled",
    ])
  })

  test("tracks project lifecycle analytics", async () => {
    const { analytics, events: analyticsEvents } = makeFakeAnalytics()
    const state = createEmptyState()
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-router-project-"))

    try {
      const router = createTestRouter({
        store: createFakeStore({
          state,
          openProject: async (localPath: string, title?: string) => {
            const project = {
              id: "project-1",
              localPath,
              title: title ?? "Project",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              deletedAt: null,
            }
            state.projectsById.set(project.id, project as never)
            state.projectIdsByPath.set(localPath, project.id)
            return project
          },
          getProject: () => ({
            id: "project-1",
            localPath: projectPath,
          }),
          listChatsByProject: () => [{ id: "chat-1" }, { id: "chat-2" }],
          removeProject: async () => {},
        }),
        agent: {
          cancel: async () => {},
          closeChat: async () => {},
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
        } as never,
        analytics,
      })
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-open-analytics-1",
          command: { type: "project.open", localPath: projectPath },
        })
      )

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-remove-1",
          command: { type: "project.remove", projectId: "project-1" },
        })
      )

      expect(analyticsEvents).toEqual([
        "project_opened",
        "project_removed",
      ])
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("project.create initializes the directory, acks the resolved path, and tracks analytics", async () => {
    const { analytics, events: analyticsEvents } = makeFakeAnalytics()
    const state = createEmptyState()
    const parentPath = await mkdtemp(path.join(tmpdir(), "kanna-router-create-"))
    const projectPath = path.join(parentPath, "brand-new")

    try {
      const router = createTestRouter({
        store: createFakeStore({
          state,
          openProject: async (localPath: string, title?: string) => {
            const project = {
              id: "project-created",
              localPath,
              title: title ?? "Project",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              deletedAt: null,
            }
            state.projectsById.set(project.id, project as never)
            state.projectIdsByPath.set(localPath, project.id)
            return project
          },
        }),
        analytics,
      })
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-create-1",
          command: { type: "project.create", localPath: projectPath, title: "brand-new" },
        })
      )

      const ack = ws.sent.find((message) => {
        const parsed = message as { type?: string; id?: string }
        return parsed.type === "ack" && parsed.id === "project-create-1"
      }) as { result?: { projectId: string; localPath: string } } | undefined
      expect(ack?.result).toEqual({ projectId: "project-created", localPath: projectPath })
      // The directory exists and was git-initialized (it was brand-new).
      expect((await stat(path.join(projectPath, ".git"))).isDirectory()).toBe(true)
      expect(analyticsEvents).toEqual(["project_opened"])
    } finally {
      await rm(parentPath, { recursive: true, force: true })
    }
  })

  test("acks terminal.input without rebroadcasting terminal snapshots", async () => {
    const terminals = makeFakeTerminals()
    const router = createTestRouter({ terminals })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-terminal", { type: "terminal", terminalId: "terminal-1" })
    await router.handleMessage(
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
    expect(terminals.writes).toEqual([{ terminalId: "terminal-1", data: "ls\r" }])
  })

  test("terminal.create with projectId null spawns a home-directory terminal", async () => {
    const terminals = makeFakeTerminals()
    const router = createTestRouter({
      store: createFakeStore({ getProject: () => null }),
      terminals,
    })
    const created = terminals.created
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "terminal-create-home",
        command: {
          type: "terminal.create",
          projectId: null,
          terminalId: "home",
          cols: 80,
          rows: 24,
          scrollback: 1_000,
        },
      })
    )

    expect(created.map(({ projectPath, terminalId }) => ({ projectPath, terminalId }))).toEqual([{ projectPath: homedir(), terminalId: "home" }])
    expect(ws.sent[0]).toMatchObject({ type: "ack", id: "terminal-create-home" })

    // A string projectId still resolves through the store (unknown → error).
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "terminal-create-unknown",
        command: {
          type: "terminal.create",
          projectId: "no-such-project",
          terminalId: "t2",
          cols: 80,
          rows: 24,
          scrollback: 1_000,
        },
      })
    )
    expect(created.length).toBe(1)
    expect(ws.sent[1]).toMatchObject({ type: "error", id: "terminal-create-unknown" })
  })

  test("terminal.close pushes the null snapshot even when the subscribe-time snapshot was null", async () => {
    // Regression: a pane subscribes before its session exists (signature
    // "null"), creates, then clears (close). The post-close null snapshot
    // must not be deduped away — it's what tells the pane to recreate.
    const router = createTestRouter({ terminals: makeFakeTerminals() })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({ v: 1, type: "subscribe", id: "term-sub", topic: { type: "terminal", terminalId: "t1" } })
    )
    expect(ws.sent[0]).toMatchObject({ type: "snapshot", id: "term-sub", snapshot: { type: "terminal", data: null } })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "create-t1",
        command: { type: "terminal.create", projectId: null, terminalId: "t1", cols: 80, rows: 24, scrollback: 1_000 },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({ v: 1, type: "command", id: "close-t1", command: { type: "terminal.close", terminalId: "t1" } })
    )

    const closeIndex = ws.sent.findIndex((envelope) => (envelope as { id?: string }).id === "close-t1")
    expect(closeIndex).toBeGreaterThan(-1)
    const nullPushesAfterClose = ws.sent.slice(closeIndex).filter((envelope) => {
      const candidate = envelope as { type?: string; id?: string; snapshot?: { type?: string; data?: unknown } }
      return candidate.type === "snapshot" && candidate.id === "term-sub" && candidate.snapshot?.data === null
    })
    expect(nullPushesAfterClose.length).toBe(1)
  })

  test("subscribes and unsubscribes chat topics", async () => {
    const router = createTestRouter()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
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

    await router.handleMessage(
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

  test("reuses one sidebar derivation across sockets in the same broadcast pass", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    let activeStatusCalls = 0
    const router = createTestRouter({
      store: createFakeStore({ state }),
      agent: {
        getActiveStatuses: () => {
          activeStatusCalls += 1
          return new Map()
        },
        getDrainingChatIds: () => new Set(),
      } as never,
    })

    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()
    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)
    wsA.data.subscriptions.set("sidebar-a", { type: "sidebar" })
    wsB.data.subscriptions.set("sidebar-b", { type: "sidebar" })

    await router.broadcastSnapshots()

    expect(activeStatusCalls).toBe(1)
    expect(wsA.sent).toHaveLength(1)
    expect(wsB.sent).toHaveLength(1)
  })

  test("a chat that starts waiting on a subagent is pushed once, to the sidebar and to the chat", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", { id: "project-1", localPath: "/tmp/project", title: "Project", createdAt: 1, updatedAt: 1 })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    // No turn is in flight throughout: only the wider read knows of the wait.
    const waiting = new Map<string, "waiting_on_subagent">()
    const router = createTestRouter({
      store: createFakeStore({
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getClientTranscript: () => ({ messages: [], startIndex: 0, readAnchor: null }),
      }),
      agent: {
        getActiveStatuses: () => new Map(),
        getChatStatuses: () => new Map(waiting),
        getDrainingChatIds: () => new Set(),
      } as never,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    ws.data.subscriptions.set("sidebar-1", { type: "sidebar" })
    ws.data.subscriptions.set("chat-1", { type: "chat", chatId: "chat-1" })
    const change = { sidebar: true, chatIds: ["chat-1"] }
    const statuses = () => JSON.stringify(ws.sent).match(/"status":"[a-z_]+"/g) ?? []

    await router.broadcastChatChange(change)
    expect(ws.sent).toHaveLength(2)
    expect(new Set(statuses())).toEqual(new Set(['"status":"idle"']))

    waiting.set("chat-1", "waiting_on_subagent")
    await router.broadcastChatChange(change)
    expect(ws.sent).toHaveLength(4)
    for (const message of ws.sent.slice(2)) expect(JSON.stringify(message)).toContain('"status":"waiting_on_subagent"')

    // Nothing moved, so nothing is sent: the status is part of what is compared.
    await router.broadcastChatChange(change)
    expect(ws.sent).toHaveLength(4)

    waiting.clear()
    await router.broadcastChatChange(change)
    expect(ws.sent).toHaveLength(6)
  })

  test("a waiting chat's count reaches the sidebar when it changes, though its status has not", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", { id: "project-1", localPath: "/tmp/project", title: "Project", createdAt: 1, updatedAt: 1 })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    let chats = 2
    const router = createTestRouter({
      // Versioned, as the real store is, so the sidebar is memoized: a count
      // left out of the memo's key would be served stale from it.
      store: createFakeStore({ state, stateVersion: 1 }),
      agent: {
        getActiveStatuses: () => new Map(),
        getChatStatuses: () => new Map([["chat-1", "waiting_on_subagent"]]),
        getWaitingOn: () => ({ chats, agents: 0 }),
        getDrainingChatIds: () => new Set(),
      } as never,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    ws.data.subscriptions.set("sidebar-1", { type: "sidebar" })

    await router.broadcastChatChange({ sidebar: true })
    expect(JSON.stringify(ws.sent.at(-1))).toContain('"waitingOn":{"chats":2,"agents":0}')
    const sentBefore = ws.sent.length

    // Nothing moved: nothing sent.
    await router.broadcastChatChange({ sidebar: true })
    expect(ws.sent).toHaveLength(sentBefore)

    chats = 1
    await router.broadcastChatChange({ sidebar: true })
    expect(ws.sent.length).toBeGreaterThan(sentBefore)
    expect(JSON.stringify(ws.sent.at(-1))).toContain('"chats":1')
  })

  test("subscribes to project git snapshots independently from chat snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createTestRouter({
      store: createFakeStore({
        state,
        getProject: () => state.projectsById.get("project-1") ?? null,
      }),
      diffStore: makeFakeDiffStore({
        getProjectSnapshot: () => ({
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        }),
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "project-git-sub-1",
        topic: { type: "project-git", projectId: "project-1" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "project-git-sub-1",
      snapshot: {
        type: "project-git",
        data: {
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        },
      },
    })
  })

  test("reads diff patches through the project-scoped command", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createTestRouter({
      store: createFakeStore({
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      }),
      diffStore: makeFakeDiffStore({
        readPatch: () => Effect.succeed({ patch: "diff --git a/app.txt b/app.txt" }),
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "read-patch-1",
        command: {
          type: "project.readDiffPatch",
          projectId: "project-1",
          path: "app.txt",
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "read-patch-1",
      result: { patch: "diff --git a/app.txt b/app.txt" },
    })
  })

  test("routes merge preview and merge commands through the diff store", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const router = createTestRouter({
      store: createFakeStore({
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
      }),
      diffStore: makeFakeDiffStore({
        getProjectSnapshot: () => ({ status: "ready", branchName: "main", files: [], branchHistory: { entries: [] } }),
        previewMergeBranch: () => Effect.succeed({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 2, hasConflicts: false, message: "2 commits from feature/test will merge into main." }),
        mergeBranch: () => Effect.succeed({ ok: true, branchName: "main", snapshotChanged: true }),
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "preview-merge-1",
        command: {
          type: "chat.previewMergeBranch",
          chatId: "chat-1",
          branch: { kind: "local", name: "feature/test" },
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "merge-1",
        command: {
          type: "chat.mergeBranch",
          chatId: "chat-1",
          branch: { kind: "local", name: "feature/test" },
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "preview-merge-1",
      result: {
        currentBranchName: "main",
        targetBranchName: "feature/test",
        targetDisplayName: "feature/test",
        status: "mergeable",
        commitCount: 2,
        hasConflicts: false,
        message: "2 commits from feature/test will merge into main.",
      },
    })
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "merge-1",
      result: {
        ok: true,
        branchName: "main",
        snapshotChanged: true,
      },
    })
  })

  test("persists a read anchor without broadcasting any snapshot", async () => {
    const writes: Array<{ chatId: string; messageId: string; atEnd: boolean }> = []
    const router = createTestRouter({
      store: createFakeStore({
        async setChatReadAnchor(chatId: string, messageId: string, atEnd: boolean) {
          writes.push({ chatId, messageId, atEnd })
        },
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // Subscribed to the sidebar so a stray broadcast would be visible below.
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1,
      type: "subscribe",
      id: "sidebar-1",
      topic: { type: "sidebar" },
    }))
    const sentBefore = ws.sent.length

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1,
      type: "command",
      id: "set-anchor-1",
      command: { type: "chat.setReadAnchor", chatId: "chat-1", messageId: "entry-7", atEnd: false },
    }))

    expect(writes).toEqual([{ chatId: "chat-1", messageId: "entry-7", atEnd: false }])
    // Exactly one new frame: the ack. Scrolling must never cause fan-out.
    expect(ws.sent.length).toBe(sentBefore + 1)
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "set-anchor-1",
    })
  })

  test("returns the stored read anchor", async () => {
    const router = createTestRouter({
      store: createFakeStore({
        getChatReadAnchor: (chatId: string) => (
          chatId === "chat-1" ? { messageId: "entry-7", atEnd: false, distanceFromEnd: 420 } : null
        ),
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1,
      type: "command",
      id: "get-anchor-1",
      command: { type: "chat.getReadAnchor", chatId: "chat-1" },
    }))

    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "get-anchor-1",
      result: { messageId: "entry-7", atEnd: false, distanceFromEnd: 420 },
    })

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1,
      type: "command",
      id: "get-anchor-2",
      command: { type: "chat.getReadAnchor", chatId: "chat-2" },
    }))

    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "get-anchor-2",
      result: null,
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
      autoPlan: false,
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

    const router = createTestRouter({
      store: createFakeStore(store),
    })
    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()

    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)

    await router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-a",
        topic: { type: "sidebar" },
      })
    )
    await router.handleMessage(
      wsB as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-b",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "mark-read-1",
        command: { type: "chat.markRead", chatId: "chat-1" },
      })
    )

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
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
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
              hasAutomation: false,
            }],
          })],
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
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
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
              hasAutomation: false,
            }],
          })],
        },
      },
    })
  })

  test("a patch subscription gets a reset and then only the rows that changed, a plain one full snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    for (const [id, unread] of [["chat-1", true], ["chat-2", false]] as const) {
      state.chatsById.set(id, {
        id,
        projectId: "project-1",
        title: id,
        createdAt: 1,
        updatedAt: 1,
        unread,
        provider: null,
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastTurnOutcome: null,
      })
    }

    const router = createTestRouter({
      store: createFakeStore({
        state,
        async setChatReadState(chatId: string, unread: boolean) {
          state.chatsById.get(chatId)!.unread = unread
        },
      }),
    })
    const patchWs = new FakeWebSocket()
    const plainWs = new FakeWebSocket()
    router.handleOpen(patchWs as never)
    router.handleOpen(plainWs as never)

    await router.handleMessage(patchWs as never, JSON.stringify({
      v: 1, type: "subscribe", id: "sidebar-p", topic: { type: "sidebar", patches: true },
    }))
    await router.handleMessage(plainWs as never, JSON.stringify({
      v: 1, type: "subscribe", id: "sidebar-f", topic: { type: "sidebar" },
    }))

    const reset = (patchWs.sent.at(-1) as { snapshot: { type: string; data: SidebarPatch } }).snapshot
    expect(reset.type).toBe("sidebar-patch")
    expect(reset.data.from).toBeNull()
    expect(reset.data.rows?.map((row) => row.chatId).sort()).toEqual(["chat-1", "chat-2"])
    const held = applySidebarPatch(null, reset.data)

    await router.handleMessage(patchWs as never, JSON.stringify({
      v: 1, type: "command", id: "mark-read", command: { type: "chat.markRead", chatId: "chat-1" },
    }))

    const change = (patchWs.sent.at(-1) as { snapshot: { type: string; data: SidebarPatch } }).snapshot
    expect(change.type).toBe("sidebar-patch")
    expect(change.data.from).toBe(reset.data.to)
    expect(change.data.rows?.map((row) => ({ chatId: row.chatId, unread: row.unread }))).toEqual([
      { chatId: "chat-1", unread: false },
    ])
    expect(change.data.headers).toBeUndefined()
    expect(change.data.lists).toBeUndefined()
    const next = applySidebarPatch(held, change.data)
    expect(next.projectGroups[0]!.chats.map((chat) => [chat.chatId, chat.unread])).toEqual([
      ["chat-1", false],
      ["chat-2", false],
    ])

    const full = (plainWs.sent.at(-1) as { snapshot: { type: string; data: SidebarData } }).snapshot
    expect(full.type).toBe("sidebar")
    expect(full.data.projectGroups[0]!.chats.find((chat) => chat.chatId === "chat-1")?.unread).toBe(false)
  })

  test("reorders sidebar project groups on the server and rebroadcasts the snapshot", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project-1",
      title: "Project 1",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectsById.set("project-2", {
      id: "project-2",
      localPath: "/tmp/project-2",
      title: "Project 2",
      createdAt: 2,
      updatedAt: 2,
    })

    const setSidebarProjectOrderCalls: string[][] = []
    let sidebarProjectOrder: string[] = []
    const router = createTestRouter({
      store: createFakeStore({
        state,
        getSidebarProjectOrder() {
          return [...sidebarProjectOrder]
        },
        async setSidebarProjectOrder(projectIds: string[]) {
          setSidebarProjectOrderCalls.push(projectIds)
          sidebarProjectOrder = [...projectIds]
        },
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "sidebar-reorder-1",
        command: { type: "sidebar.reorderProjectGroups", projectIds: ["project-1", "project-2"] },
      })
    )

    expect(setSidebarProjectOrderCalls).toEqual([["project-1", "project-2"]])
    expect(ws.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "sidebar-reorder-1",
    })
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [
            withSidebarGroupDefaults({
              groupKey: "project-1",
              title: "Project 1",
              localPath: "/tmp/project-1",
              chats: [],
            }),
            withSidebarGroupDefaults({
              groupKey: "project-2",
              title: "Project 2",
              localPath: "/tmp/project-2",
              chats: [],
            }),
          ],
        },
      },
    })
  })

  test("forks a chat through the agent and rebroadcasts the sidebar snapshot", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: "session-1",
      pendingForkSessionToken: null,
      lastTurnOutcome: null,
    })

    const forkChatCalls: string[] = []
    const router = createTestRouter({
      store: createFakeStore({ state }),
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
          forkChat: async (chatId: string) => {
          forkChatCalls.push(chatId)
          state.chatsById.set("chat-fork-1", {
            id: "chat-fork-1",
            projectId: "project-1",
            title: "Fork: Chat",
            createdAt: 2,
            updatedAt: 2,
            unread: false,
            provider: "claude",
            planMode: false,
            autoPlan: false,
            sessionToken: null,
            pendingForkSessionToken: "session-1",
            lastTurnOutcome: null,
          })
          return { chatId: "chat-fork-1" }
        },
      } as never,
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "fork-1",
        command: { type: "chat.fork", chatId: "chat-1" },
      })
    )

    expect(forkChatCalls).toEqual(["chat-1"])
    expect(ws.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "fork-1",
      result: { chatId: "chat-fork-1" },
    })
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-fork-1",
              _creationTime: 2,
              chatId: "chat-fork-1",
              title: "Fork: Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: "claude",
              canFork: true,
              hasAutomation: false,
            }, {
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: "claude",
              canFork: true,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
  })

  test("prunes stale empty chats during explicit maintenance runs", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-stale", {
      id: "chat-stale",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    let pruneCalls = 0
    const router = createTestRouter({
      store: createFakeStore({
        state,
        async pruneStaleEmptyChats() {
          pruneCalls += 1
          state.chatsById.delete("chat-stale")
          return ["chat-stale"]
        },
      }),
    })
    const ws = new FakeWebSocket()

    await router.pruneStaleEmptyChats()
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    expect(pruneCalls).toBe(1)
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [{
            ...withSidebarGroupDefaults({
              groupKey: "project-1",
              title: "Project",
              localPath: "/tmp/project",
              chats: [],
            }),
          }],
        },
      },
    })
  })

  test("protects draft-bearing chats during explicit maintenance runs", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-stale", {
      id: "chat-stale",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    let capturedProtectedChatIds: string[] = []
    const router = createTestRouter({
      store: createFakeStore({
        state,
        async pruneStaleEmptyChats(args?: { protectedChatIds?: Iterable<string> }) {
          capturedProtectedChatIds = [...(args?.protectedChatIds ?? [])]
          return []
        },
      }),
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "draft-protection-1",
        command: {
          type: "chat.setDraftProtection",
          chatIds: ["chat-stale"],
        },
      })
    )

    await router.pruneStaleEmptyChats()
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    expect(capturedProtectedChatIds).toEqual(["chat-stale"])
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "draft-protection-1",
    })
  })

  test("broadcasts background title-generation errors to connected clients", () => {
    let reportBackgroundError: ((message: string) => void) | null | undefined
    const router = createTestRouter({
      agent: {
        getActiveStatuses: () => new Map(),
        setBackgroundErrorReporter: (reporter: ((message: string) => void) | null) => {
          reportBackgroundError = reporter
        },
      } as never,
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
    const keybindings = makeFakeKeybindings(initialSnapshot)

    const router = createTestRouter({
      keybindings,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
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
        data: initialSnapshot,
      },
    })

    await router.handleMessage(
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
            jumpToSidebarChat: ["cmd+alt"],
            createChatInCurrentProject: ["cmd+alt+n"],
            openAddProject: ["cmd+alt+o"],
            openCommandPalette: ["cmd+p"],
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
          jumpToSidebarChat: ["cmd+alt"],
          createChatInCurrentProject: ["cmd+alt+n"],
          openAddProject: ["cmd+alt+o"],
          openCommandPalette: ["cmd+p"],
        },
        warning: null,
        filePathDisplay: "~/.kanna/keybindings.json",
      },
    })
  })

  test("subscribes to update snapshots and handles update.check commands", async () => {
    const { updateManager } = makeFakeUpdateManager({ ...DEFAULT_UPDATE_SNAPSHOT }, {
      check: (snapshot, force) => ({
        ...snapshot,
        latestVersion: force ? "0.13.0" : "0.12.1",
        status: "available",
        updateAvailable: true,
        lastCheckedAt: 123,
      }),
      install: {
        ok: false,
        action: "restart",
        errorCode: "version_not_live_yet",
        userTitle: "Update not live yet",
        userMessage: "This update is still propagating. Try again in a few minutes.",
      },
    })

    const router = createTestRouter({ updateManager })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    const sentWithId = (id: string) => ws.sent.find((message) => (message as { id?: string }).id === id && (message as { type?: string }).type === "ack")

    await router.handleMessage(
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

    await router.handleMessage(
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
    expect(sentWithId("update-check-1")).toEqual({
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
        reloadRequestedAt: null,
      },
    })

    await router.handleMessage(
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
    expect(sentWithId("update-install-1")).toEqual({
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

    // The check changed the snapshot, so the subscriber was pushed the new one.
    await Bun.sleep(0)
    expect(ws.sent.filter((message) => (message as { id?: string }).id === "update-sub-1").at(-1)).toMatchObject({
      type: "snapshot",
      snapshot: { type: "update", data: { latestVersion: "0.13.0", status: "available" } },
    })
  })

  test("routes discard diff file commands through the diff store and rebroadcasts chat snapshots", async () => {
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
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const discardCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const router = createTestRouter({
      store: createFakeStore({
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getClientTranscript: () => ({ messages: [], startIndex: 0, readAnchor: null }),
      }),
      diffStore: makeFakeDiffStore({
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        discardFile: (args) => Effect.sync(() => {
          discardCalls.push(args)
          return { snapshotChanged: true }
        }),
      }),
    })
    const ws = new FakeWebSocket()

    router.handleOpen(ws as never)
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub",
        topic: { type: "chat", chatId: "chat-1" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "discard-1",
        command: {
          type: "chat.discardDiffFile",
          chatId: "chat-1",
          path: "app.txt",
        },
      })
    )

    expect(discardCalls).toEqual([{
      projectId: "project-1",
      projectPath: "/tmp/project",
      path: "app.txt",
    }])
    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "discard-1",
      result: { snapshotChanged: true },
    })
  })

  test("routes ignore diff file commands through the diff store", async () => {
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
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const ignoreCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const router = createTestRouter({
      store: createFakeStore({
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      }),
      diffStore: makeFakeDiffStore({
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        ignoreFile: (args) => Effect.sync(() => {
          ignoreCalls.push(args)
          return { snapshotChanged: false }
        }),
      }),
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ignore-1",
        command: {
          type: "chat.ignoreDiffFile",
          chatId: "chat-1",
          path: "scratch.log",
        },
      })
    )

    expect(ignoreCalls).toEqual([{
      projectId: "project-1",
      projectPath: "/tmp/project",
      path: "scratch.log",
    }])
    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "ignore-1",
      result: { snapshotChanged: false },
    })
  })
})

describe("ws-router provider auth", () => {
  const AUTH_SERVICES_SNAPSHOT = {
    services: [
      {
        service: "gh" as const,
        label: "GitHub",
        installed: true,
        version: "2.96.0",
        latestVersion: null,
        updateAvailable: false,
        authStatus: "signed_out" as const,
        account: null,
        statusDetail: null,
        login: { phase: "idle" as const },
        installState: "idle" as const,
        installError: null,
        checkedAt: 1,
      },
    ],
  }

  function createFakeProviderAuth() {
    return makeFakeProviderAuth(AUTH_SERVICES_SNAPSHOT, {
      openRouterSnapshot: { ...DEFAULT_LLM_PROVIDER_SNAPSHOT, provider: "openrouter", apiKey: "sk-or-key" },
    })
  }

  test("subscribing pushes the snapshot and kicks a refresh; onChange fanout dedupes", async () => {
    const fake = createFakeProviderAuth()
    const router = createTestRouter({ providerAuth: fake.providerAuth })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({ v: 1, type: "subscribe", id: "sub-auth", topic: { type: "provider-auth" } })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "sub-auth",
        snapshot: { type: "provider-auth", data: AUTH_SERVICES_SNAPSHOT },
      },
    ])
    expect(fake.calls).toContain("refresh")

    // Unchanged snapshot on change → deduped, nothing new sent.
    fake.setSnapshot(AUTH_SERVICES_SNAPSHOT)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ws.sent).toHaveLength(1)

    // A changed one is pushed.
    const signedIn = {
      services: [{ ...AUTH_SERVICES_SNAPSHOT.services[0]!, authStatus: "signed_in" as const, account: "jakemny" }],
    }
    fake.setSnapshot(signedIn)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sub-auth",
      snapshot: { type: "provider-auth", data: signedIn },
    })
  })

  test("a refused login is an error reply with the service's message", async () => {
    const fake = createFakeProviderAuth()
    const router = createTestRouter({
      providerAuth: {
        ...fake.providerAuth,
        startLogin: (service) =>
          Effect.fail(new ProviderAuthError({ operation: "login", service, message: "Codex is not installed." })),
      },
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({ v: 1, type: "command", id: "c1", command: { type: "auth.login.start", service: "codex" } })
    )

    expect(ws.sent).toEqual([{ v: PROTOCOL_VERSION, type: "error", id: "c1", message: "Codex is not installed." }])
  })

  test("auth commands route to the manager and ack", async () => {
    const fake = createFakeProviderAuth()
    const router = createTestRouter({ providerAuth: fake.providerAuth })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    const send = (id: string, command: unknown) =>
      router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id, command }))

    await send("c1", { type: "auth.login.start", service: "gh" })
    await send("c2", { type: "auth.login.submitCode", service: "claude", code: "abc" })
    await send("c3", { type: "auth.login.cancel", service: "gh" })
    await send("c4", { type: "auth.install", service: "codex" })
    await send("c5", { type: "auth.openrouter.start", callbackUrl: "http://localhost:3210/oauth/openrouter/callback" })
    await send("c6", { type: "auth.openrouter.exchange", code: "code-1" })

    expect(fake.calls).toEqual(
      expect.arrayContaining(["start:gh", "submit:claude:abc", "cancel:gh", "install:codex", "exchange:code-1"])
    )

    const acks = ws.sent as Array<{ type: string; id: string; result?: unknown }>
    expect(acks.every((message) => message.type === "ack")).toBe(true)
    const startAck = acks.find((message) => message.id === "c5")
    expect((startAck?.result as { authUrl: string }).authUrl).toContain("openrouter.ai/auth")
    const exchangeAck = acks.find((message) => message.id === "c6")
    expect((exchangeAck?.result as LlmProviderSnapshot).provider).toBe("openrouter")
  })

  test("auth.refresh acks the snapshot even without a manager", async () => {
    const router = createTestRouter()
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    await router.handleMessage(
      ws as never,
      JSON.stringify({ v: 1, type: "command", id: "r1", command: { type: "auth.refresh" } })
    )
    expect(ws.sent).toEqual([
      { v: PROTOCOL_VERSION, type: "ack", id: "r1", result: { services: [] } },
    ])
  })
})

describe("transcript windows", () => {
  /** prompt, text, text: three entries, two assistant messages. */
  function turn(n: number) {
    return [
      { _id: `p${n}`, createdAt: n, kind: "user_prompt", content: `question ${n}` },
      { _id: `a${n}`, createdAt: n, kind: "assistant_text", text: "one" },
      { _id: `b${n}`, createdAt: n, kind: "assistant_text", text: "two" },
    ]
  }

  function createWindowedRouter(entries: Array<Record<string, unknown>>, overrides: Partial<CreateWsRouterArgs> = {}) {
    const state = createEmptyState()
    state.projectsById.set("project-1", { id: "project-1", localPath: "/tmp/project", title: "Project", createdAt: 1, updatedAt: 1 })
    state.chatsById.set("chat-1", {
      id: "chat-1", projectId: "project-1", title: "Chat", createdAt: 1, updatedAt: 1, unread: false,
      provider: null, planMode: false, autoPlan: false, sessionToken: null, lastTurnOutcome: null,
    })
    // The store's own window methods are covered in event-store.test.ts;
    // this fake mirrors them over the fixture so the router logic is what
    // is under test here.
    const typed = entries as never[]
    const fake = createFakeStore({
      state,
      getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
      getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      getClientTranscript: () => ({ messages: entries, startIndex: 0, readAnchor: null }),
      getEntryIdAt: (_chatId: string, index: number) => (entries[index] as { _id?: string } | undefined)?._id ?? null,
      getInitialTranscriptWindowStart: (_chatId: string, assistantMessages: number) =>
        findTranscriptWindowStart(typed, { endExclusive: entries.length, assistantMessages }),
      widenTranscriptWindowStart: (_chatId: string, current: number, options: { assistantMessages: number; untilMessageId?: string; all?: boolean }) => {
        if (options.all) return 0
        if (options.untilMessageId !== undefined) {
          const index = entries.findIndex((item) => item._id === options.untilMessageId)
          if (index < 0 || index >= current) return current
          return findTranscriptWindowStart(typed, { endExclusive: current, assistantMessages: options.assistantMessages, mustIncludeIndex: index })
        }
        return findTranscriptWindowStart(typed, { endExclusive: current, assistantMessages: options.assistantMessages })
      },
    })
    const settings = makeFakeAppSettings({ ...DEFAULT_APP_SETTINGS_SNAPSHOT, transcript: { windowAssistantMessages: 2 } })
    return createTestRouter({ store: fake, appSettings: settings, ...overrides })
  }

  const chatData = (ws: FakeWebSocket, index: number) =>
    (ws.sent[index] as { snapshot: { data: { messages: Array<{ _id: string }>; startIndex: number; incremental?: boolean; outline?: unknown[] } } }).snapshot.data

  test("opens on the last window of assistant messages with the whole outline", async () => {
    const router = createWindowedRouter([...turn(1), ...turn(2), ...turn(3)])
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: "sub", topic: { type: "chat", chatId: "chat-1" } }))

    const data = chatData(ws, 0)
    expect(data.startIndex).toBe(6)
    expect(data.messages.map((entry) => entry._id)).toEqual(["p3", "a3", "b3"])
    expect(data.outline).toHaveLength(3)
  })

  test("loadOlder pushes the older slice as an incremental body in front, without the outline", async () => {
    const router = createWindowedRouter([...turn(1), ...turn(2), ...turn(3)])
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: "sub", topic: { type: "chat", chatId: "chat-1" } }))

    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id: "older", command: { type: "chat.loadOlder", chatId: "chat-1" } }))

    const older = chatData(ws, 1)
    expect(older.incremental).toBe(true)
    expect(older.startIndex).toBe(3)
    expect(older.messages.map((entry) => entry._id)).toEqual(["p2", "a2", "b2"])
    expect(older.outline).toBeUndefined()
    expect(ws.sent[2]).toEqual({ v: PROTOCOL_VERSION, type: "ack", id: "older", result: { startIndex: 3 } })

    // Until a message: jumps straight to the window holding it.
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id: "older-2", command: { type: "chat.loadOlder", chatId: "chat-1", untilMessageId: "p1" } }))
    expect(chatData(ws, 3).messages.map((entry) => entry._id)).toEqual(["p1", "a1", "b1"])
    expect(ws.sent[4]).toEqual({ v: PROTOCOL_VERSION, type: "ack", id: "older-2", result: { startIndex: 0 } })
  })

  test("transcript window failures retain their command errors", async () => {
    const router = createWindowedRouter([...turn(1)])
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "missing-chat",
      command: { type: "chat.loadOlder", chatId: "missing" },
    }))
    expect(ws.sent.at(-1)).toEqual({ v: PROTOCOL_VERSION, type: "error", id: "missing-chat", message: "Chat not found" })

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "command", id: "too-many-entries",
      command: { type: "chat.getToolEntries", chatId: "chat-1", entryIds: Array.from({ length: 257 }, (_, index) => String(index)) },
    }))
    expect(ws.sent.at(-1)).toEqual({ v: PROTOCOL_VERSION, type: "error", id: "too-many-entries", message: "Too many entry ids (max 256)" })
  })

  test("a cached span reaching further back than the default keeps the client's window", async () => {
    const router = createWindowedRouter([...turn(1), ...turn(2), ...turn(3)])
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "subscribe", id: "sub",
      topic: { type: "chat", chatId: "chat-1", cachedSpan: { start: 3, end: 8, endEntryId: "a3" } },
    }))

    // Only the entry past the cache is sent, and the window start is the cache's.
    const data = chatData(ws, 0)
    expect(data.incremental).toBe(true)
    expect(data.startIndex).toBe(8)
    expect(data.messages.map((entry) => entry._id)).toEqual(["b3"])
  })

  test("the provider catalog rides a cached span's first push and every change, nothing else", async () => {
    const router = createWindowedRouter([...turn(1), ...turn(2), ...turn(3)])
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    const providersOf = (index: number) =>
      (chatData(ws, index) as { availableProviders?: Array<{ id: string; models: Array<{ id: string }> }> }).availableProviders

    try {
      await router.handleMessage(ws as never, JSON.stringify({
        v: 1, type: "subscribe", id: "sub",
        topic: { type: "chat", chatId: "chat-1", cachedSpan: { start: 3, end: 8, endEntryId: "a3" } },
      }))
      // The client's cache may hold an old catalog, so the incremental first
      // push carries the current one.
      expect(chatData(ws, 0).incremental).toBe(true)
      expect(providersOf(0)?.map((provider) => provider.id)).toEqual(["claude", "codex", "cursor", "grok", "pi"])

      // Unchanged catalog: no later push repeats it.
      await router.broadcastSnapshots()
      for (let index = 1; index < ws.sent.length; index += 1) {
        expect(providersOf(index)).toBeUndefined()
      }

      // A model discovered at runtime reaches the open chat.
      expect(applyCodexModels([{ model: "gpt-6-astra", displayName: "GPT-6-Astra" }])).toBe(true)
      await router.broadcastSnapshots()
      const last = providersOf(ws.sent.length - 1)
      expect(last?.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual(["gpt-6-astra"])
    } finally {
      resetServerProvidersForTests()
    }
  })

  test("a background subscription is pushed at most once per interval, and the last change still lands", async () => {
    const entries = [...turn(1), ...turn(2)]
    const router = createWindowedRouter(entries, { backgroundChatPushIntervalMs: 40 })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "subscribe", id: "bg", topic: { type: "chat", chatId: "chat-1", background: true },
    }))
    // The first push is never held back.
    expect(ws.sent).toHaveLength(1)

    // Two changes inside the interval: neither goes out yet.
    entries.push(...turn(3))
    await router.broadcastSnapshots()
    entries.push(...turn(4))
    await router.broadcastSnapshots()
    expect(ws.sent).toHaveLength(1)

    // One trailing push carries both.
    await Bun.sleep(80)
    expect(ws.sent).toHaveLength(2)
    expect(chatData(ws, 1).messages.map((entry) => entry._id)).toEqual(["p3", "a3", "b3", "p4", "a4", "b4"])
  })

  test("unsubscribing a background chat cancels its pending push", async () => {
    const entries = [...turn(1), ...turn(2)]
    const router = createWindowedRouter(entries, { backgroundChatPushIntervalMs: 40 })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    await router.handleMessage(ws as never, JSON.stringify({
      v: 1, type: "subscribe", id: "bg", topic: { type: "chat", chatId: "chat-1", background: true },
    }))
    entries.push(...turn(3))
    await router.broadcastSnapshots()

    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "unsubscribe", id: "bg" }))
    await Bun.sleep(80)
    // The first push and the unsubscribe ack, nothing after.
    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[1]).toEqual({ v: PROTOCOL_VERSION, type: "ack", id: "bg" })
  })

  test("chat.create makes a delegator when asked, and chat.setDelegator changes one", async () => {
    const calls: unknown[] = []
    const router = createTestRouter({
      store: createFakeStore({
        createChat: async (projectId: string, lineage: unknown, options: unknown) => {
          calls.push(["create", projectId, lineage, options])
          return { id: `chat-${calls.length}` }
        },
        setChatDelegator: async (chatId: string, delegator: boolean) => { calls.push(["set", chatId, delegator]) },
      }),
    })
    const ws = new FakeWebSocket()
    const send = (id: string, command: unknown) => router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id, command }))

    await send("a", { type: "chat.create", projectId: "project-1", delegator: true })
    await send("b", { type: "chat.create", projectId: "project-1" })
    await send("c", { type: "chat.setDelegator", chatId: "chat-1", delegator: false })

    expect(calls).toEqual([
      ["create", "project-1", undefined, { delegator: true }],
      ["create", "project-1", undefined, { delegator: undefined }],
      ["set", "chat-1", false],
    ])
    // The new chat's id comes back on the ack, as for any chat.
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "a", result: { chatId: "chat-1" } })
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "c" })
  })

  // The web client goes to a new chat's page as it sends `chat.create`, with
  // an id of its own making, so the page's subscription can be handled while
  // the chat is still being written. Whichever lands first, the socket ends
  // up holding the chat.
  test.each(["create first", "subscribe first"])("a chat made with the client's id reaches a subscription sent alongside it (%s)", async (order) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-client-chat-id-"))
    try {
      const store = await openEventStore(dataDir)
      const project = await store.openProject(dataDir)
      const router = createTestRouter({ store: store.service })
      const ws = new FakeWebSocket()
      router.handleOpen(ws as never)
      const chatId = "0b9c4d0e-6f0a-4a57-9d55-1f3a6c1d2e77"
      const create = () => router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION, type: "command", id: "create", command: { type: "chat.create", projectId: project.id, chatId },
      }))
      const subscribe = () => router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION, type: "subscribe", id: "chat-sub", topic: { type: "chat", chatId },
      }))

      // Neither is awaited before the other is handed over, as on a socket.
      await Promise.all(order === "create first" ? [create(), subscribe()] : [subscribe(), create()])

      expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "create", result: { chatId } })
      const pushes = ws.sent.filter((message): message is { id: string; snapshot: { data: { runtime: { chatId: string; title: string } } | null } } => (
        (message as { type?: string; id?: string }).type === "snapshot" && (message as { id?: string }).id === "chat-sub"
      ))
      expect(pushes.at(-1)?.snapshot.data?.runtime).toMatchObject({ chatId, title: "New Chat", projectId: project.id })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  // What the new chat's page sends behind its `chat.create` is handled while
  // the chat is still on its way to disk. It waits for the chat, rather than
  // being told there is no such chat.
  test("what names a chat still being made waits for it", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-client-chat-id-"))
    try {
      const store = await openEventStore(dataDir)
      const project = await store.openProject(dataDir)
      const router = createTestRouter({ store: store.service })
      const ws = new FakeWebSocket()
      router.handleOpen(ws as never)
      const chatId = "5d2f8a10-3c4b-4e6f-8a9b-0c1d2e3f4a5b"
      const send = (envelope: Record<string, unknown>) => router.handleMessage(ws as never, JSON.stringify({ v: PROTOCOL_VERSION, ...envelope }))

      await Promise.all([
        send({ type: "command", id: "create", command: { type: "chat.create", projectId: project.id, chatId } }),
        send({ type: "command", id: "rename", command: { type: "chat.rename", chatId, title: "Named at once" } }),
        // Left as soon as it was opened: the subscription must not outlive it.
        send({ type: "subscribe", id: "chat-sub", topic: { type: "chat", chatId } }),
        send({ type: "unsubscribe", id: "chat-sub" }),
      ])

      expect(ws.sent.filter((message) => (message as { type?: string }).type === "error")).toEqual([])
      expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "rename" })
      expect(store.getChat(chatId)?.title).toBe("Named at once")
      expect(ws.data.subscriptions.has("chat-sub")).toBe(false)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test("a chat that could not be made fails what waited on it, and holds nothing back afterwards", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-client-chat-id-"))
    try {
      const store = await openEventStore(dataDir)
      const router = createTestRouter({ store: store.service })
      const ws = new FakeWebSocket()
      router.handleOpen(ws as never)
      const chatId = "7e1a9b22-4d5c-4f70-9b8a-1d2e3f4a5b6c"
      const send = (id: string, command: Record<string, unknown>) => router.handleMessage(ws as never, JSON.stringify({ v: PROTOCOL_VERSION, type: "command", id, command }))

      await Promise.all([
        send("create", { type: "chat.create", projectId: "no-such-project", chatId }),
        send("rename", { type: "chat.rename", chatId, title: "Never" }),
      ])
      await send("later", { type: "chat.rename", chatId, title: "Never" })

      const errors = ws.sent.filter((message) => (message as { type?: string }).type === "error") as Array<{ id: string; message: string }>
      expect(errors.map((error) => [error.id, error.message])).toEqual([
        ["create", "Project not found"],
        ["rename", "Chat not found"],
        ["later", "Chat not found"],
      ])
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AUTH_DEFAULTS, CLAUDE_AUTH_DEFAULTS, CLAUDE_DRIVER_DEFAULTS, CLAUDE_PTY_LIFECYCLE_DEFAULTS, CLOUDFLARE_TUNNEL_DEFAULTS, PROTOCOL_VERSION, UPLOAD_DEFAULTS } from "../shared/types"
import type { AppSettingsSnapshot, KeybindingsSnapshot, LlmProviderSnapshot, McpServerConfig, McpServerTestResult, UpdateSnapshot } from "../shared/types"
import { createEmptyState } from "./events"
import {
  assertSafeSkillId,
  assertSafeSkillSource,
  buildInstallSkillCommand,
  buildUninstallSkillCommand,
  createWsRouter,
  isBenignStaleStateMessage,
  listInstalledSkills,
  parseInstalledSkillsLock,
} from "./ws-router"
import { createToolCallbackService } from "./tool-callback"
import { createTestEventStore } from "./storage/test-helpers"
import { POLICY_DEFAULT } from "../shared/permission-policy"

function withSidebarGroupDefaults(group: {
  groupKey: string
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
  const chatsWithDefaults = group.chats.map((chat) => ({ sessionState: "cold" as const, hasPolicyOverride: false, ...chat }))
  return {
    ...group,
    chats: chatsWithDefaults,
    previewChats: chatsWithDefaults,
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
    newStack: ["cmd+alt+w"],
    newStackChat: ["cmd+alt+shift+n"],
    jumpToStacks: ["g s"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const DEFAULT_APP_SETTINGS_SNAPSHOT: AppSettingsSnapshot = {
  analyticsEnabled: true,
  cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
  auth: AUTH_DEFAULTS,
  claudeAuth: CLAUDE_AUTH_DEFAULTS,
  browserSettingsMigrated: false,
  theme: "system",
  chatSoundPreference: "always",
  chatSoundId: "funk",
  terminal: {
    scrollbackLines: 1_000,
    minColumnWidth: 450,
  },
  editor: {
    preset: "cursor",
    commandTemplate: "cursor {path}",
  },
  defaultProvider: "last_used",
  providerDefaults: {
    claude: {
      model: "claude-opus-4-7",
      modelOptions: {
        reasoningEffort: "high",
        contextWindow: "200k",
      },
      planMode: false,
    },
    codex: {
      model: "gpt-5.5",
      modelOptions: {
        reasoningEffort: "high",
        fastMode: false,
      },
      planMode: false,
    },
  },
  warning: null,
  filePathDisplay: "~/.kanna/data/settings.json",
  uploads: UPLOAD_DEFAULTS,
  subagents: [],
  customMcpServers: [],
  claudeDriver: { ...CLAUDE_DRIVER_DEFAULTS, lifecycle: { ...CLAUDE_PTY_LIFECYCLE_DEFAULTS } },
  globalPromptAppend: "",
}

describe("isBenignStaleStateMessage", () => {
  test("matches known stale-state errors", () => {
    expect(isBenignStaleStateMessage("Chat not found")).toBe(true)
    expect(isBenignStaleStateMessage("Queued message not found")).toBe(true)
    expect(isBenignStaleStateMessage("File is no longer changed: foo/bar.ts")).toBe(true)
    expect(isBenignStaleStateMessage("Project not found")).toBe(true)
  })

  test("does not match unrelated errors", () => {
    expect(isBenignStaleStateMessage("Exactly one primary binding required")).toBe(false)
    expect(isBenignStaleStateMessage("")).toBe(false)
    expect(isBenignStaleStateMessage("Chat not found, plus extra")).toBe(false)
  })
})

describe("skills helpers", () => {
  test("parses installed global skills from a lock payload", () => {
    const snapshot = parseInstalledSkillsLock({
      version: 1,
      skills: {
        zeta: {
          source: "owner/zeta",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/zeta",
          skillPath: "skills/zeta/SKILL.md",
          installedAt: "2026-05-01T01:00:00.000Z",
          updatedAt: "2026-05-01T02:00:00.000Z",
          pluginName: "zeta-plugin",
        },
        alpha: {
          source: "owner/alpha",
          sourceType: "github",
        },
        ignored: "not an object",
      },
    }, "/tmp/.skill-lock.json")

    expect(snapshot.lockFilePath).toBe("/tmp/.skill-lock.json")
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"])
    expect(snapshot.skills[0]).toMatchObject({
      name: "alpha",
      source: "owner/alpha",
      sourceType: "github",
      sourceUrl: "",
      installedAt: "",
      updatedAt: "",
    })
    expect(snapshot.skills[1]).toMatchObject({
      name: "zeta",
      source: "owner/zeta",
      skillPath: "skills/zeta/SKILL.md",
      pluginName: "zeta-plugin",
    })
  })

  test("returns an empty installed skills snapshot when the lock file is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-skills-"))
    try {
      const missingPath = path.join(dir, "missing.json")
      expect(await listInstalledSkills(missingPath)).toEqual({
        lockFilePath: missingPath,
        skills: [],
      })

      const invalidPath = path.join(dir, ".skill-lock.json")
      await writeFile(invalidPath, "{", "utf8")
      expect(await listInstalledSkills(invalidPath)).toEqual({
        lockFilePath: invalidPath,
        skills: [],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("validates skill source and id before building commands", () => {
    expect(assertSafeSkillSource(" owner/repo ")).toBe("owner/repo")
    expect(assertSafeSkillId(" my-skill_1 ")).toBe("my-skill_1")
    expect(() => assertSafeSkillSource("https://github.com/owner/repo")).toThrow("owner/repo")
    expect(() => assertSafeSkillId("../nope")).toThrow("Skill id is invalid.")
  })

  test("builds global install and uninstall commands for universal and Claude Code aliases", () => {
    expect(buildInstallSkillCommand("owner/repo", "my-skill").slice(1)).toEqual([
      "skills",
      "add",
      "owner/repo",
      "--skill",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
    expect(buildUninstallSkillCommand("my-skill").slice(1)).toEqual([
      "skills",
      "remove",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
  })
})

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
  enabled: false,
  warning: null,
  filePathDisplay: "~/.kanna/llm-provider.json",
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

describe("ws-router", () => {
  test("acks system.ping without broadcasting snapshots", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
    const writes: Array<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">> = []
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      llmProvider: {
        read: async () => DEFAULT_LLM_PROVIDER_SNAPSHOT,
        write: async (value) => {
          writes.push(value)
          return {
            ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
            ...value,
            resolvedBaseUrl: value.provider === "custom" ? value.baseUrl : "https://api.openai.com/v1",
            enabled: Boolean(value.apiKey && value.model),
          }
        },
        validate: async () => ({
          ok: true,
          error: null,
        }),
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
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
          enabled: true,
        },
      },
    ])
    expect(writes).toEqual([{
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://example.com/v1",
    }])
  })

  test("reads and writes app settings via commands", async () => {
    const writes: Array<{ analyticsEnabled: boolean }> = []
    let analyticsEnabled = DEFAULT_APP_SETTINGS_SNAPSHOT.analyticsEnabled
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => ({
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          analyticsEnabled,
        }),
        write: async (value) => {
          writes.push(value)
          analyticsEnabled = value.analyticsEnabled
          return {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT,
            analyticsEnabled: value.analyticsEnabled,
          }
        },
        setCloudflareTunnel: async (_patch) => ({ ...DEFAULT_APP_SETTINGS_SNAPSHOT }),
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
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
        result: DEFAULT_APP_SETTINGS_SNAPSHOT,
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "settings-write-1",
        result: {
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          analyticsEnabled: false,
        },
      },
    ])
    expect(writes).toEqual([{ analyticsEnabled: false }])
  })

  test("subscribes to app settings and writes patches through the router", async () => {
    let snapshot: AppSettingsSnapshot = DEFAULT_APP_SETTINGS_SNAPSHOT
    let listener: ((nextSnapshot: AppSettingsSnapshot) => void) | null = null
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => snapshot,
        write: async (value) => {
          snapshot = { ...snapshot, analyticsEnabled: value.analyticsEnabled }
          return snapshot
        },
        writePatch: async (patch) => {
          snapshot = {
            ...snapshot,
            analyticsEnabled: patch.analyticsEnabled ?? snapshot.analyticsEnabled,
            browserSettingsMigrated: patch.browserSettingsMigrated ?? snapshot.browserSettingsMigrated,
            theme: patch.theme ?? snapshot.theme,
            chatSoundPreference: patch.chatSoundPreference ?? snapshot.chatSoundPreference,
            chatSoundId: patch.chatSoundId ?? snapshot.chatSoundId,
            defaultProvider: patch.defaultProvider ?? snapshot.defaultProvider,
            terminal: { ...snapshot.terminal, ...patch.terminal },
            editor: { ...snapshot.editor, ...patch.editor },
          }
          listener?.(snapshot)
          return snapshot
        },
        onChange: (nextListener) => {
          listener = nextListener
          return () => {
            listener = null
          }
        },
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
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

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: DEFAULT_APP_SETTINGS_SNAPSHOT,
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT,
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
          theme: "dark",
          terminal: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
            scrollbackLines: 2_000,
          },
        },
      },
    ])
  })

  test("tracks analytics preference transitions in the correct order", async () => {
    const analyticsEvents: string[] = []
    let analyticsEnabled = true
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => ({
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          analyticsEnabled,
        }),
        write: async (value) => {
          analyticsEnabled = value.analyticsEnabled
          return {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT,
            analyticsEnabled: value.analyticsEnabled,
          }
        },
        setCloudflareTunnel: async (_patch) => ({ ...DEFAULT_APP_SETTINGS_SNAPSHOT }),
      },
      analytics: {
        track: (eventName: string) => {
          analyticsEvents.push(eventName)
        },
        trackLaunch: () => {},
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
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
    const analyticsEvents: string[] = []
    const state = createEmptyState()
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-router-project-"))

    try {
      const router = createWsRouter({
        store: {
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
        } as never,
        agent: {
          cancel: async () => {},
          closeChat: async () => {},
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
          getWaitStartedAtByChatId: () => new Map(),
        } as never,
        analytics: {
          track: (eventName: string) => {
            analyticsEvents.push(eventName)
          },
          trackLaunch: () => {},
        },
        terminals: {
          closeByCwd: () => {},
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
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-create-1",
          command: { type: "project.create", localPath: projectPath, title: "Project" },
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
        "project_created",
        "project_removed",
      ])
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("project.remove kills terminals running in the project's cwd", async () => {
    const state = createEmptyState()
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-router-project-"))
    const closeByCwdCalls: string[] = []

    try {
      const router = createWsRouter({
        store: {
          state,
          getProject: () => ({
            id: "project-1",
            localPath: projectPath,
          }),
          listChatsByProject: () => [],
          removeProject: async () => {},
        } as never,
        agent: {
          cancel: async () => {},
          closeChat: async () => {},
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
          getWaitStartedAtByChatId: () => new Map(),
        } as never,
        analytics: {
          track: () => {},
          trackLaunch: () => {},
        },
        terminals: {
          closeByCwd: (cwd: string) => {
            closeByCwdCalls.push(cwd)
          },
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
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "project-remove-1",
          command: { type: "project.remove", projectId: "project-1" },
        })
      )

      expect(closeByCwdCalls).toEqual([projectPath])
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("acks terminal.input without rebroadcasting terminal snapshots", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
      pushManager: NOOP_PUSH_MANAGER,
    })
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
  })

  test("subscribes and unsubscribes chat topics", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => {
          activeStatusCalls += 1
          return new Map()
        },
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

  test("subscribes to project git snapshots independently from chat snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: () => state.projectsById.get("project-1") ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        }),
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 1, hasConflicts: false, message: "ready" }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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

    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => null,
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 1, hasConflicts: false, message: "ready" }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "diff --git a/app.txt b/app.txt" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({ status: "ready", branchName: "main", files: [], branchHistory: { entries: [] } }),
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 2, hasConflicts: false, message: "2 commits from feature/test will merge into main." }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: true }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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

  test("loads older chat history pages", async () => {
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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    const router = createWsRouter({
      store: {
        state,
        getMessagesPageBefore: () => ({
          messages: [{
            _id: "msg-1",
            kind: "assistant_text",
            createdAt: 1,
            text: "older message",
          }],
          hasOlder: false,
          olderCursor: null,
        }),
        getChat: () => state.chatsById.get("chat-1") ?? null,
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "history-1",
        command: {
          type: "chat.loadHistory",
          chatId: "chat-1",
          beforeCursor: "idx:100",
          limit: 100,
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "history-1",
      result: {
        messages: [{
          _id: "msg-1",
          kind: "assistant_text",
          createdAt: 1,
          text: "older message",
        }],
        hasOlder: false,
        olderCursor: null,
      },
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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    const store = {
      state,
      getTunnelEvents: (_chatId: string) => [] as never[],
      async setChatReadState(chatId: string, unread: boolean) {
        const chat = state.chatsById.get(chatId)
        if (!chat) throw new Error("Chat not found")
        chat.unread = unread
      },
    }

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
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
          starredProjectGroups: [],
          projectGroups: [withSidebarGroupDefaults({
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
              hasAutomation: false,
            }],
          })],
          stacks: [],
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
          starredProjectGroups: [],
          projectGroups: [withSidebarGroupDefaults({
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
              hasAutomation: false,
            }],
          })],
          stacks: [],
        },
      },
    })
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
    const router = createWsRouter({
      store: {
        state,
        getSidebarProjectOrder() {
          return [...sidebarProjectOrder]
        },
        async setSidebarProjectOrder(projectIds: string[]) {
          setSidebarProjectOrderCalls.push(projectIds)
          sidebarProjectOrder = [...projectIds]
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
          starredProjectGroups: [],
          projectGroups: [
            withSidebarGroupDefaults({
              groupKey: "project-1",
              localPath: "/tmp/project-1",
              chats: [],
            }),
            withSidebarGroupDefaults({
              groupKey: "project-2",
              localPath: "/tmp/project-2",
              chats: [],
            }),
          ],
          stacks: [],
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
      sessionTokensByProvider: { claude: "session-1" },
      sourceHash: null,
      pendingForkSessionToken: null,
      lastTurnOutcome: null,
    })

    const forkChatCalls: string[] = []
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
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
            sessionTokensByProvider: {},
            sourceHash: null,
            pendingForkSessionToken: { provider: "claude", token: "session-1" },
            lastTurnOutcome: null,
          })
          return { chatId: "chat-fork-1" }
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
      pushManager: NOOP_PUSH_MANAGER,
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
          starredProjectGroups: [],
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
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
          stacks: [],
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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    let pruneCalls = 0
    const router = createWsRouter({
      store: {
        state,
        async pruneStaleEmptyChats() {
          pruneCalls += 1
          state.chatsById.delete("chat-stale")
          return ["chat-stale"]
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
          starredProjectGroups: [],
          projectGroups: [{
            ...withSidebarGroupDefaults({
              groupKey: "project-1",
              localPath: "/tmp/project",
              chats: [],
            }),
          }],
          stacks: [],
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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    let capturedProtectedChatIds: string[] = []
    const router = createWsRouter({
      store: {
        state,
        async pruneStaleEmptyChats(args?: { protectedChatIds?: Iterable<string> }) {
          capturedProtectedChatIds = [...(args?.protectedChatIds ?? [])]
          return []
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getWaitStartedAtByChatId: () => new Map(),
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
      pushManager: NOOP_PUSH_MANAGER,
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
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: keybindings as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
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
        data: keybindings.snapshot,
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
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
      pushManager: NOOP_PUSH_MANAGER,
    })
    const ws = new FakeWebSocket()

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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    const discardCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const diffStore = {
      getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
      refreshSnapshot: async () => false,
      syncBranch: async () => ({ ok: true as const, action: "fetch" as const, snapshotChanged: false }),
      generateCommitMessage: async () => ({ subject: "", body: "" }),
      commitFiles: async () => ({ ok: true as const, mode: "commit_only" as const, pushed: false, snapshotChanged: false }),
      discardFile: async (args: { projectId: string; projectPath: string; path: string }) => {
        discardCalls.push(args)
        return { snapshotChanged: true }
      },
      ignoreFile: async () => ({ snapshotChanged: false }),
    }

    const router = createWsRouter({
      store: {
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getRecentChatHistory: () => ({ entries: [], hasOlder: false, olderCursor: null }),
        getTunnelEvents: (_chatId: string) => [] as never[],
      } as never,
      diffStore: diffStore as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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
      sessionTokensByProvider: {},
      sourceHash: null,
      lastTurnOutcome: null,
    })

    const ignoreCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const router = createWsRouter({
      store: {
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        refreshSnapshot: async () => false,
        syncBranch: async () => ({ ok: true as const, action: "fetch" as const, snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "" }),
        commitFiles: async () => ({ ok: true as const, mode: "commit_only" as const, pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async (args: { projectId: string; projectPath: string; path: string }) => {
          ignoreCalls.push(args)
          return { snapshotChanged: false }
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getSlashCommandsLoadingChatIds: () => new Set(), getWaitStartedAtByChatId: () => new Map(), ensureSlashCommandsLoaded: async () => {} } as never,
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

  // ── autoContinue WS command tests ────────────────────────────────────────

  function makeAutoContinueAgent(overrides: Record<string, unknown> = {}) {
    const appendedEvents: unknown[] = []
    return {
      appendedEvents,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getSlashCommandsLoadingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
        ensureSlashCommandsLoaded: async () => {},
        acceptAutoContinue: async (_chatId: string, _scheduleId: string, _scheduledAt: number) => {},
        rescheduleAutoContinue: async (_chatId: string, _scheduleId: string, _scheduledAt: number) => {},
        cancelAutoContinue: async (_chatId: string, _scheduleId: string, _reason: string) => {},
        listLiveSchedules: (_chatId: string): string[] => [],
        cancel: async () => {},
        closeChat: async () => {},
        ...overrides,
      },
    }
  }

  function makeAutoContinueStore(state: ReturnType<typeof createEmptyState>) {
    return {
      state,
      deleteChat: async () => {},
    }
  }

  test("autoContinue.accept routes to agent.acceptAutoContinue and acks", async () => {
    const acceptCalls: Array<{ chatId: string; scheduleId: string; scheduledAt: number }> = []
    const { agent } = makeAutoContinueAgent({
      acceptAutoContinue: async (chatId: string, scheduleId: string, scheduledAt: number) => {
        acceptCalls.push({ chatId, scheduleId, scheduledAt })
      },
    })

    const router = createWsRouter({
      store: makeAutoContinueStore(createEmptyState()) as never,
      agent: agent as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "accept-1",
        command: {
          type: "autoContinue.accept",
          chatId: "chat-1",
          scheduleId: "sched-1",
          scheduledAt: Date.now() + 60_000,
        },
      })
    )

    expect(acceptCalls).toHaveLength(1)
    expect(acceptCalls[0]!.chatId).toBe("chat-1")
    expect(acceptCalls[0]!.scheduleId).toBe("sched-1")
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "accept-1" })
  })

  test("autoContinue.reschedule routes to agent.rescheduleAutoContinue and acks", async () => {
    const rescheduleCalls: Array<{ chatId: string; scheduleId: string; scheduledAt: number }> = []
    const { agent } = makeAutoContinueAgent({
      rescheduleAutoContinue: async (chatId: string, scheduleId: string, scheduledAt: number) => {
        rescheduleCalls.push({ chatId, scheduleId, scheduledAt })
      },
    })

    const router = createWsRouter({
      store: makeAutoContinueStore(createEmptyState()) as never,
      agent: agent as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "reschedule-1",
        command: {
          type: "autoContinue.reschedule",
          chatId: "chat-1",
          scheduleId: "sched-1",
          scheduledAt: Date.now() + 120_000,
        },
      })
    )

    expect(rescheduleCalls).toHaveLength(1)
    expect(rescheduleCalls[0]!.chatId).toBe("chat-1")
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "reschedule-1" })
  })

  test("autoContinue.cancel routes to agent.cancelAutoContinue and acks", async () => {
    const cancelCalls: Array<{ chatId: string; scheduleId: string; reason: string }> = []
    const { agent } = makeAutoContinueAgent({
      cancelAutoContinue: async (chatId: string, scheduleId: string, reason: string) => {
        cancelCalls.push({ chatId, scheduleId, reason })
      },
    })

    const router = createWsRouter({
      store: makeAutoContinueStore(createEmptyState()) as never,
      agent: agent as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cancel-1",
        command: {
          type: "autoContinue.cancel",
          chatId: "chat-1",
          scheduleId: "sched-1",
        },
      })
    )

    expect(cancelCalls).toHaveLength(1)
    expect(cancelCalls[0]!.reason).toBe("user")
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "cancel-1" })
  })

  test("dispatches chat.cancelSubagentRun to coordinator", async () => {
    const calls: Array<{ type: string; chatId: string; runId: string }> = []
    const { agent } = makeAutoContinueAgent({
      cancelSubagentRun: async (cmd: { type: string; chatId: string; runId: string }) => {
        calls.push(cmd)
      },
    })

    const router = createWsRouter({
      store: makeAutoContinueStore(createEmptyState()) as never,
      agent: agent as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "cancel-subagent-1",
        command: {
          type: "chat.cancelSubagentRun",
          chatId: "chat-1",
          runId: "run-42",
        },
      })
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.chatId).toBe("chat-1")
    expect(calls[0]!.runId).toBe("run-42")
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "cancel-subagent-1" })
  })

  test("chat.delete cancels live schedules before closing chat", async () => {
    const cancelledScheduleIds: string[] = []
    const callOrder: string[] = []

    const { agent } = makeAutoContinueAgent({
      listLiveSchedules: (_chatId: string) => ["sched-live"],
      cancelAutoContinue: async (_chatId: string, scheduleId: string, _reason: string) => {
        cancelledScheduleIds.push(scheduleId)
        callOrder.push("cancelAutoContinue")
      },
      closeChat: async () => {
        callOrder.push("closeChat")
      },
    })

    const router = createWsRouter({
      store: makeAutoContinueStore(createEmptyState()) as never,
      agent: agent as never,
      terminals: { getSnapshot: () => null, onEvent: () => () => {} } as never,
      keybindings: { getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT, onChange: () => () => {} } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
      updateManager: null,
      pushManager: NOOP_PUSH_MANAGER,
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "delete-1",
        command: { type: "chat.delete", chatId: "chat-1" },
      })
    )

    expect(cancelledScheduleIds).toEqual(["sched-live"])
    expect(callOrder.indexOf("cancelAutoContinue")).toBeLessThan(callOrder.indexOf("closeChat"))
    expect(ws.sent).toContainEqual({ v: PROTOCOL_VERSION, type: "ack", id: "delete-1" })
  })
})

describe("ws-router project.setStar", () => {
  test("project.setStar with starred:true sets starredAt to a positive number", async () => {
    const state = createEmptyState()
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-router-star-"))
    const setProjectStarCalls: Array<{ projectId: string; starred: boolean }> = []
    let starredAt: number | undefined

    try {
      const router = createWsRouter({
        store: {
          state,
          getProject: () => ({
            id: "project-star-1",
            localPath: projectPath,
          }),
          listChatsByProject: () => [],
          setProjectStar: async (projectId: string, starred: boolean) => {
            setProjectStarCalls.push({ projectId, starred })
            starredAt = starred ? Date.now() : undefined
          },
        } as never,
        agent: {
          cancel: async () => {},
          closeChat: async () => {},
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
          getWaitStartedAtByChatId: () => new Map(),
        } as never,
        analytics: {
          track: () => {},
          trackLaunch: () => {},
        },
        terminals: {
          closeByCwd: () => {},
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
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "set-star-1",
          command: { type: "project.setStar", projectId: "project-star-1", starred: true },
        })
      )

      expect(setProjectStarCalls).toEqual([{ projectId: "project-star-1", starred: true }])
      expect(starredAt).toBeGreaterThan(0)
      expect(ws.sent[0]).toMatchObject({ type: "ack", id: "set-star-1" })
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("project.setStar with starred:false clears starredAt", async () => {
    const state = createEmptyState()
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-router-star-"))
    let starredAt: number | undefined = Date.now()

    try {
      const router = createWsRouter({
        store: {
          state,
          getProject: () => ({
            id: "project-star-2",
            localPath: projectPath,
          }),
          listChatsByProject: () => [],
          setProjectStar: async (_projectId: string, starred: boolean) => {
            starredAt = starred ? Date.now() : undefined
          },
        } as never,
        agent: {
          cancel: async () => {},
          closeChat: async () => {},
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
          getWaitStartedAtByChatId: () => new Map(),
        } as never,
        analytics: {
          track: () => {},
          trackLaunch: () => {},
        },
        terminals: {
          closeByCwd: () => {},
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
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "set-star-2",
          command: { type: "project.setStar", projectId: "project-star-2", starred: false },
        })
      )

      expect(starredAt).toBeUndefined()
      expect(ws.sent[0]).toMatchObject({ type: "ack", id: "set-star-2" })
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test("project.setStar with unknown projectId sends error response", async () => {
    const state = createEmptyState()
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-router-star-"))

    try {
      const router = createWsRouter({
        store: {
          state,
          getProject: () => undefined,
          listChatsByProject: () => [],
          setProjectStar: async () => {
            throw new Error("Project not found")
          },
        } as never,
        agent: {
          cancel: async () => {},
          closeChat: async () => {},
          getActiveStatuses: () => new Map(),
          getDrainingChatIds: () => new Set(),
          getWaitStartedAtByChatId: () => new Map(),
        } as never,
        analytics: {
          track: () => {},
          trackLaunch: () => {},
        },
        terminals: {
          closeByCwd: () => {},
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
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "set-star-3",
          command: { type: "project.setStar", projectId: "unknown-project", starred: true },
        })
      )

      expect(ws.sent[0]).toMatchObject({ type: "error", id: "set-star-3", message: "Project not found" })
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })
})

test("ws-router: chat.toolRequestAnswer broadcasts chat snapshot after answering", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-ws-toolreq-broadcast-"))
  try {
    const store = createTestEventStore(dir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const toolCallbackSvc = createToolCallbackService({
      store,
      serverSecret: "test-secret",
      now: () => 1_000,
      timeoutMs: 600_000,
    })

    const pendingPromise = toolCallbackSvc.submit({
      chatId: chat.id,
      sessionId: "sess-1",
      toolUseId: "tu-broadcast",
      toolName: "ask_user_question",
      args: { questions: [{ q: "broadcast?" }] },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })

    const pending = store.listPendingToolRequests(chat.id)
    expect(pending).toHaveLength(1)
    const toolRequestId = pending[0].id

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getSlashCommandsLoadingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
        ensureSlashCommandsLoaded: async () => {},
        toolCallbackService: toolCallbackSvc,
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

    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    // Subscribe to the chat to receive broadcast snapshots.
    ws.data.subscriptions.set("chat-sub-1", { type: "chat", chatId: chat.id })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "tool-answer-broadcast",
        command: {
          type: "chat.toolRequestAnswer",
          chatId: chat.id,
          toolRequestId,
          decision: { kind: "answer", payload: { ok: true } },
        },
      })
    )

    // Ack followed by a chat snapshot from broadcastChatAndSidebar.
    expect(ws.sent).toHaveLength(2)
    const ack = ws.sent[0] as { type: string; id: string }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("tool-answer-broadcast")
    const snap = ws.sent[1] as { type: string; snapshot: { type: string } }
    expect(snap.type).toBe("snapshot")
    expect(snap.snapshot.type).toBe("chat")

    await pendingPromise
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ws-router: chat.toolRequestAnswer throws when toolRequestId belongs to different chat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-ws-toolreq-ownership-"))
  try {
    const store = createTestEventStore(dir)
    await store.initialize()

    const toolCallbackSvc = createToolCallbackService({
      store,
      serverSecret: "test-secret",
      now: () => 1_000,
      timeoutMs: 600_000,
    })

    const pendingPromise = toolCallbackSvc.submit({
      chatId: "chat-owner",
      sessionId: "sess-1",
      toolUseId: "tu-ownership",
      toolName: "ask_user_question",
      args: { questions: [] },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })

    const pending = store.listPendingToolRequests("chat-owner")
    expect(pending).toHaveLength(1)
    const toolRequestId = pending[0].id

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getSlashCommandsLoadingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
        ensureSlashCommandsLoaded: async () => {},
        toolCallbackService: toolCallbackSvc,
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

    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // Send with wrong chatId — "chat-attacker" instead of "chat-owner".
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "tool-answer-wrong-chat",
        command: {
          type: "chat.toolRequestAnswer",
          chatId: "chat-attacker",
          toolRequestId,
          decision: { kind: "allow" },
        },
      })
    )

    expect(ws.sent[0]).toMatchObject({ type: "error", id: "tool-answer-wrong-chat" })
    const errMsg = (ws.sent[0] as { message: string }).message
    expect(errMsg).toContain("does not belong to this chat")

    // Cancel the pending promise to avoid unresolved promise warning.
    await toolCallbackSvc.cancel(toolRequestId, "test_done")
    await pendingPromise
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ws-router: chat.toolRequestAnswer throws on invalid decision.kind", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-ws-toolreq-kind-"))
  try {
    const store = createTestEventStore(dir)
    await store.initialize()

    const toolCallbackSvc = createToolCallbackService({
      store,
      serverSecret: "test-secret",
      now: () => 1_000,
      timeoutMs: 600_000,
    })

    const pendingPromise = toolCallbackSvc.submit({
      chatId: "chat-kind",
      sessionId: "sess-1",
      toolUseId: "tu-kind",
      toolName: "ask_user_question",
      args: { questions: [] },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })

    const pending = store.listPendingToolRequests("chat-kind")
    expect(pending).toHaveLength(1)
    const toolRequestId = pending[0].id

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getSlashCommandsLoadingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
        ensureSlashCommandsLoaded: async () => {},
        toolCallbackService: toolCallbackSvc,
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

    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "tool-answer-bad-kind",
        command: {
          type: "chat.toolRequestAnswer",
          chatId: "chat-kind",
          toolRequestId,
          decision: { kind: "hack" },
        },
      })
    )

    expect(ws.sent[0]).toMatchObject({ type: "error", id: "tool-answer-bad-kind" })
    const errMsg = (ws.sent[0] as { message: string }).message
    expect(errMsg).toContain("Invalid tool request decision kind")

    await toolCallbackSvc.cancel(toolRequestId, "test_done")
    await pendingPromise
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ws-router: chat.toolRequestAnswer resolves a pending tool request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-ws-toolreq-"))
  try {
    const store = createTestEventStore(dir)
    await store.initialize()

    const toolCallbackSvc = createToolCallbackService({
      store,
      serverSecret: "test-secret",
      now: () => 1_000,
      timeoutMs: 600_000,
    })

    // Submit a request that requires user approval ("ask" verdict).
    const pendingPromise = toolCallbackSvc.submit({
      chatId: "chat-1",
      sessionId: "sess-1",
      toolUseId: "tu-1",
      toolName: "ask_user_question",
      args: { questions: [{ q: "ok?" }] },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })

    const pending = store.listPendingToolRequests("chat-1")
    expect(pending).toHaveLength(1)
    const toolRequestId = pending[0].id

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        getSlashCommandsLoadingChatIds: () => new Set(),
        getWaitStartedAtByChatId: () => new Map(),
        ensureSlashCommandsLoaded: async () => {},
        toolCallbackService: toolCallbackSvc,
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

    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "tool-answer-1",
        command: {
          type: "chat.toolRequestAnswer",
          chatId: "chat-1",
          toolRequestId,
          decision: { kind: "answer", payload: { ok: true } },
        },
      })
    )

    expect(ws.sent).toEqual([
      { v: PROTOCOL_VERSION, type: "ack", id: "tool-answer-1" },
    ])

    // The pending submit() should have resolved with the answered decision.
    const result = await pendingPromise
    expect(result.status).toBe("answered")
    expect(result.decision.payload).toEqual({ ok: true })

    // The store record should reflect the answered status.
    expect(store.getToolRequest(toolRequestId)?.status).toBe("answered")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// settings.testMcpServer + customMcpServers end-to-end
// ---------------------------------------------------------------------------

function makeAppSettingsStub(initial?: Partial<AppSettingsSnapshot>) {
  let snapshot: AppSettingsSnapshot = { ...DEFAULT_APP_SETTINGS_SNAPSHOT, ...initial }
  const listeners: Array<(s: AppSettingsSnapshot) => void> = []

  function notify() {
    for (const l of listeners) l(snapshot)
  }

  return {
    getSnapshot: () => snapshot,
    write: async (value: { analyticsEnabled: boolean }) => {
      snapshot = { ...snapshot, analyticsEnabled: value.analyticsEnabled }
      notify()
      return snapshot
    },
    writePatch: async (patch: import("../shared/types").AppSettingsPatch) => {
      // Handle customMcpServers mutations
      if (patch.customMcpServers?.create) {
        const input = patch.customMcpServers.create
        const now = new Date().toISOString()
        const entry: McpServerConfig = {
          id: randomUUID(),
          name: input.name,
          enabled: input.enabled ?? true,
          createdAt: now,
          updatedAt: now,
          lastTest: { status: "untested" },
          ...("command" in input
            ? { transport: "stdio" as const, command: input.command, args: input.args ?? [], env: input.env ?? {}, cwd: input.cwd }
            : { transport: input.transport, url: input.url, headers: input.headers ?? {} }),
        } as McpServerConfig
        snapshot = { ...snapshot, customMcpServers: [...snapshot.customMcpServers, entry] }
      } else if (patch.customMcpServers?.update) {
        const { id, patch: p } = patch.customMcpServers.update
        snapshot = {
          ...snapshot,
          customMcpServers: snapshot.customMcpServers.map((s) =>
            s.id === id ? ({ ...s, ...p, updatedAt: new Date().toISOString() } as McpServerConfig) : s,
          ),
        }
      } else if (patch.customMcpServers?.delete) {
        snapshot = {
          ...snapshot,
          customMcpServers: snapshot.customMcpServers.filter((s) => s.id !== patch.customMcpServers?.delete?.id),
        }
      } else if (patch.customMcpServers?.setEnabled) {
        const { id, enabled } = patch.customMcpServers.setEnabled
        snapshot = {
          ...snapshot,
          customMcpServers: snapshot.customMcpServers.map((s) => (s.id === id ? { ...s, enabled } : s)),
        }
      } else if (patch.customMcpServers?.setTestResult) {
        const { id, result } = patch.customMcpServers.setTestResult
        snapshot = {
          ...snapshot,
          customMcpServers: snapshot.customMcpServers.map((s) =>
            s.id === id ? { ...s, lastTest: result } : s,
          ),
        }
      } else {
        snapshot = {
          ...snapshot,
          analyticsEnabled: patch.analyticsEnabled ?? snapshot.analyticsEnabled,
          theme: patch.theme ?? snapshot.theme,
        }
      }
      notify()
      return snapshot
    },
    onChange: (listener: (s: AppSettingsSnapshot) => void) => {
      listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }
}

function makeTestRouter(appSettings: ReturnType<typeof makeAppSettingsStub>) {
  return createWsRouter({
    store: { state: createEmptyState() } as never,
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
    appSettings,
    refreshDiscovery: async () => [],
    getDiscoveredProjects: () => [],
    machineDisplayName: "Local Machine",
    updateManager: null,
    pushManager: NOOP_PUSH_MANAGER,
  })
}

describe("settings.testMcpServer", () => {
  test("returns ok:false with not-found message for unknown id", async () => {
    const appSettings = makeAppSettingsStub()
    const router = makeTestRouter(appSettings)
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "test-mcp-1",
        command: { type: "settings.testMcpServer", id: "nope" },
      }),
    )

    const ack = ws.sent[0] as { type: string; id: string; result: { ok: boolean; message: string; lastTest: McpServerTestResult } }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("test-mcp-1")
    expect(ack.result.ok).toBe(false)
    expect(ack.result.message).toContain("not found")
  })

  test("runs validator on existing entry and persists error result", async () => {
    const appSettings = makeAppSettingsStub()
    const router = makeTestRouter(appSettings)
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // Create an MCP server entry with a command that definitely doesn't exist.
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "create-mcp-1",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: {
              create: {
                name: "bad-server",
                transport: "stdio",
                command: "/does/not/exist",
                args: [],
                env: {},
              },
            },
          },
        },
      }),
    )

    const createdEntry = appSettings.getSnapshot().customMcpServers[0]
    expect(createdEntry).toBeDefined()
    const entryId = createdEntry!.id

    ws.sent.length = 0 // clear prior messages

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "test-mcp-2",
        command: { type: "settings.testMcpServer", id: entryId },
      }),
    )

    const ack = ws.sent[ws.sent.length - 1] as {
      type: string
      id: string
      result: { ok: boolean; message?: string; lastTest: McpServerTestResult }
    }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("test-mcp-2")
    expect(ack.result.ok).toBe(false)
    expect(ack.result.message).toBeDefined()
    // Validator formatError maps ENOENT → "command not found: <cmd>"
    expect(ack.result.message).toContain("command not found")

    // The persisted lastTest should reflect the error.
    const persisted = appSettings.getSnapshot().customMcpServers.find((s) => s.id === entryId)
    expect(persisted?.lastTest.status).toBe("error")
  }, 15_000)
})

describe("settings.writeAppSettingsPatch customMcpServers", () => {
  test("create persists entry end-to-end", async () => {
    const appSettings = makeAppSettingsStub()
    const router = makeTestRouter(appSettings)
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "patch-create-1",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: {
              create: {
                name: "my-server",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
                env: {},
              },
            },
          },
        },
      }),
    )

    const ack = ws.sent[ws.sent.length - 1] as { type: string; id: string; result: AppSettingsSnapshot }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("patch-create-1")

    // Use the ack result (snapshot captured before auto-test runs) to check the initial state.
    expect(ack.result.customMcpServers).toHaveLength(1)
    expect(ack.result.customMcpServers[0]!.name).toBe("my-server")
    // At ack time the entry is freshly created — lastTest is untested before auto-test fires.
    expect(ack.result.customMcpServers[0]!.lastTest.status).toBe("untested")
  })
})

// ---------------------------------------------------------------------------
// Auto-test on create / update
// ---------------------------------------------------------------------------

async function waitForLastTest(
  settings: { getSnapshot(): { customMcpServers: McpServerConfig[] } },
  id: string,
  predicate: (lt: McpServerTestResult) => boolean,
  timeoutMs = 5_000,
): Promise<McpServerTestResult> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entry = settings.getSnapshot().customMcpServers.find((s) => s.id === id)
    if (entry && predicate(entry.lastTest)) return entry.lastTest
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("waitForLastTest: timeout")
}

describe("settings.writeAppSettingsPatch auto-test", () => {
  test("auto-test fires after create: lastTest transitions from untested → pending → error", async () => {
    const appSettings = makeAppSettingsStub()
    const router = makeTestRouter(appSettings)
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // 1) Send writeAppSettingsPatch.customMcpServers.create with command: "/does/not/exist"
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "auto-create-1",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: {
              create: {
                name: "auto-test-server",
                transport: "stdio",
                command: "/does/not/exist",
                args: [],
                env: {},
              },
            },
          },
        },
      }),
    )

    // 2) Wait for ack (auto-test is fire-and-forget, runs after).
    const ack = ws.sent[ws.sent.length - 1] as { type: string; id: string }
    expect(ack.type).toBe("ack")
    expect(ack.id).toBe("auto-create-1")

    const entryId = appSettings.getSnapshot().customMcpServers[0]!.id

    // 3) Poll until lastTest.status !== "untested" AND lastTest.status !== "pending".
    const lastTest = await waitForLastTest(
      appSettings,
      entryId,
      (lt) => lt.status !== "untested" && lt.status !== "pending",
      5_000,
    )

    // 4) Assert lastTest.status === "error" and message lowercase contains "command not found".
    expect(lastTest.status).toBe("error")
    expect((lastTest as { status: "error"; message: string }).message.toLowerCase()).toContain("command not found")
  }, 10_000)

  test("auto-test fires after update: lastTest is updated to new validator result", async () => {
    const appSettings = makeAppSettingsStub()
    const router = makeTestRouter(appSettings)
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // Create an entry first (auto-test fires, ignore it).
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "auto-update-create",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: {
              create: {
                name: "updatable-server",
                transport: "stdio",
                command: "/does/not/exist",
                args: [],
                env: {},
              },
            },
          },
        },
      }),
    )

    const entryId = appSettings.getSnapshot().customMcpServers[0]!.id

    // Wait until first test finishes.
    await waitForLastTest(appSettings, entryId, (lt) => lt.status !== "untested" && lt.status !== "pending", 5_000)

    // Then update with a new command — should re-fire.
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "auto-update-patch",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: {
              update: {
                id: entryId,
                patch: { command: "/also/does/not/exist" },
              },
            },
          },
        },
      }),
    )

    // Wait until the second result lands (status goes back through pending → error).
    const lastTest = await waitForLastTest(
      appSettings,
      entryId,
      (lt) => lt.status !== "untested" && lt.status !== "pending",
      5_000,
    )

    // Assert lastTest.status === "error" with new message.
    expect(lastTest.status).toBe("error")
    expect((lastTest as { status: "error"; message: string }).message.toLowerCase()).toContain("command not found")
  }, 15_000)

  test("auto-test does NOT fire on setEnabled or setTestResult", async () => {
    const appSettings = makeAppSettingsStub()
    const router = makeTestRouter(appSettings)
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    // Create an entry (with command that gives a known error fast).
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "no-fire-create",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: {
              create: {
                name: "no-refire-server",
                transport: "stdio",
                command: "/does/not/exist",
                args: [],
                env: {},
              },
            },
          },
        },
      }),
    )

    const entryId = appSettings.getSnapshot().customMcpServers[0]!.id

    // Wait for first lastTest to finish.
    await waitForLastTest(appSettings, entryId, (lt) => lt.status !== "untested" && lt.status !== "pending", 5_000)

    // Capture lastTest snapshot.
    const capturedLastTest = appSettings.getSnapshot().customMcpServers.find((s) => s.id === entryId)!.lastTest

    // Send setEnabled patch.
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "no-fire-setenabled",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            customMcpServers: { setEnabled: { id: entryId, enabled: false } },
          },
        },
      }),
    )

    // Wait ~200ms (no test should fire).
    await new Promise((r) => setTimeout(r, 200))

    // Assert lastTest still equals the captured value.
    const currentLastTest = appSettings.getSnapshot().customMcpServers.find((s) => s.id === entryId)!.lastTest
    expect(currentLastTest).toEqual(capturedLastTest)
  })
})

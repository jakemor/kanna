import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { AppSettingsSnapshot, KeybindingsSnapshot, LlmProviderSnapshot, UpdateSnapshot } from "../shared/types"
import { PROTOCOL_VERSION } from "../shared/types"
import { findTranscriptWindowStart } from "../shared/transcript-window"
import { createEmptyState } from "./events"
import {
  assertSafeSkillId,
  assertSafeSkillSource,
  buildInstallSkillCommand,
  buildUninstallSkillCommand,
  listGlobalSkillsWithSources,
  listInstalledSkills,
  parseInstalledSkillsLock,
} from "./skills"
import { createWsRouter } from "./ws-router"

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

  test("listGlobalSkillsWithSources scans global roots and annotates lock-file sources", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "kanna-global-skills-"))
    try {
      const { mkdir } = await import("node:fs/promises")
      const universalDir = path.join(home, ".agents", "skills", "installed-skill")
      const handDroppedDir = path.join(home, ".claude", "skills", "hand-dropped")
      await mkdir(universalDir, { recursive: true })
      await mkdir(handDroppedDir, { recursive: true })
      await writeFile(path.join(universalDir, "SKILL.md"), "---\nname: installed-skill\ndescription: From the marketplace\n---\n")
      await writeFile(path.join(handDroppedDir, "SKILL.md"), "---\nname: hand-dropped\ndescription: Made by hand\n---\n")

      const lockPath = path.join(home, ".agents", ".skill-lock.json")
      await writeFile(lockPath, JSON.stringify({
        version: 3,
        skills: {
          "installed-skill": { source: "owner/repo", sourceType: "github" },
        },
      }))

      const snapshot = await listGlobalSkillsWithSources({ home, lockFilePath: lockPath })
      const byName = new Map(snapshot.skills.map((skill) => [skill.name, skill]))

      // Lock-tracked skill carries its marketplace source; ~/.agents attributes codex/cursor/pi.
      expect(byName.get("installed-skill")).toMatchObject({
        source: "owner/repo",
        providers: ["codex", "cursor", "pi"],
      })
      // Hand-dropped skill still listed, claude-attributed, with no source.
      expect(byName.get("hand-dropped")?.providers).toEqual(["claude"])
      expect(byName.get("hand-dropped")?.source).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
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
  faveModels: [],
  enabled: false,
  warning: null,
  filePathDisplay: "~/.kanna/llm-provider.json",
}

type CreateWsRouterArgs = Parameters<typeof createWsRouter>[0]

/** In-memory EventStore stand-in covering the methods the router always calls. */
function createFakeStore(overrides: Record<string, unknown> = {}) {
  return {
    state: createEmptyState(),
    getSidebarProjectOrder: () => [],
    pruneStaleEmptyChats: async () => [],
    // Whole transcript by default; the window tests override these.
    getInitialTranscriptWindowStart: () => 0,
    widenTranscriptWindowStart: (_chatId: string, current: number) => current,
    ...overrides,
  } as never
}

function createFakeDiffStore(overrides: Record<string, unknown> = {}): CreateWsRouterArgs["diffStore"] {
  return {
    getProjectSnapshot: () => null,
    getSnapshotVersion: () => 0,
    refreshSnapshot: async () => false,
    initializeGit: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    getGitHubPublishInfo: async () => ({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined, owners: [], suggestedRepoName: "my-repo" }),
    checkGitHubRepoAvailability: async () => ({ available: false, message: "Unavailable" }),
    publishToGitHub: async () => ({ ok: false, title: "Publish failed", message: "Unavailable", snapshotChanged: false }),
    listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
    previewMergeBranch: async () => ({ currentBranchName: undefined, targetBranchName: "", targetDisplayName: "", status: "error", commitCount: 0, hasConflicts: false, message: "Merge preview unavailable." }),
    mergeBranch: async () => ({ ok: false, title: "Merge failed", message: "Merge unavailable.", snapshotChanged: false }),
    syncBranch: async () => ({ ok: true, action: "fetch", branchName: undefined, snapshotChanged: false }),
    checkoutBranch: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
    generateCommitMessage: async () => ({ subject: "Update selected files", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: async () => ({ ok: true, mode: "commit_only", branchName: undefined, pushed: false, snapshotChanged: false }),
    discardFile: async () => ({ snapshotChanged: false }),
    ignoreFile: async () => ({ snapshotChanged: false }),
    readPatch: async () => ({ patch: "" }),
    ...overrides,
  } as never
}

function createFakeAppSettings(overrides: Partial<CreateWsRouterArgs["appSettings"]> = {}): CreateWsRouterArgs["appSettings"] {
  let snapshot = DEFAULT_APP_SETTINGS_SNAPSHOT
  return {
    getSnapshot: () => snapshot,
    write: async (value) => {
      snapshot = { ...snapshot, analyticsEnabled: value.analyticsEnabled }
      return snapshot
    },
    writePatch: async (patch) => {
      snapshot = {
        ...snapshot,
        ...patch,
        terminal: { ...snapshot.terminal, ...patch.terminal },
        editor: { ...snapshot.editor, ...patch.editor },
        transcript: { ...snapshot.transcript, ...patch.transcript },
        providerDefaults: snapshot.providerDefaults,
      } as AppSettingsSnapshot
      return snapshot
    },
    onChange: () => () => {},
    ...overrides,
  }
}

function createFakeLlmProvider(): CreateWsRouterArgs["llmProvider"] {
  return {
    read: async () => DEFAULT_LLM_PROVIDER_SNAPSHOT,
    write: async (value) => ({
      ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
      faveModels: value.faveModels ?? [],
    }),
    validate: async () => ({ ok: true, error: null }),
  }
}

/** Builds a router with fake dependencies; pass overrides for the pieces a test cares about. */
function createTestRouter(overrides: Partial<CreateWsRouterArgs> = {}) {
  return createWsRouter({
    store: createFakeStore(),
    diffStore: createFakeDiffStore(),
    worktreeProbe: { getStates: () => new Map(), getRepoLabels: () => new Map(), getProjectsWithoutRepo: () => new Set() },
    agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
    terminals: {
      getSnapshot: () => null,
      onEvent: () => () => {},
    } as never,
    keybindings: {
      getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
      onChange: () => () => {},
    } as never,
    appSettings: createFakeAppSettings(),
    llmProvider: createFakeLlmProvider(),
    refreshDiscovery: async () => [],
    getDiscoveredProjects: () => [],
    machineDisplayName: "Local Machine",
    updateManager: null,
    ...overrides,
  })
}

describe("ws-router", () => {
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
        read: async () => DEFAULT_LLM_PROVIDER_SNAPSHOT,
        write: async (value) => {
          writes.push(value)
          return {
            ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
            ...value,
            resolvedBaseUrl: value.provider === "custom" ? value.baseUrl : "https://api.openai.com/v1",
            faveModels: [],
            enabled: Boolean(value.apiKey && value.model),
          }
        },
        validate: async () => ({
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
    let analyticsEnabled = DEFAULT_APP_SETTINGS_SNAPSHOT.analyticsEnabled
    const router = createTestRouter({
      appSettings: createFakeAppSettings({
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
      }),
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
    const router = createTestRouter({
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
        transcript: { ...snapshot.transcript, ...patch.transcript },
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
    const router = createTestRouter({
      appSettings: createFakeAppSettings({
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
      }),
      analytics: {
        track: (eventName: string) => {
          analyticsEvents.push(eventName)
        },
        trackLaunch: () => {},
      },
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
        analytics: {
          track: (eventName: string) => {
            analyticsEvents.push(eventName)
          },
          trackLaunch: () => {},
        },
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
    const analyticsEvents: string[] = []
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
        analytics: {
          track: (eventName: string) => {
            analyticsEvents.push(eventName)
          },
          trackLaunch: () => {},
        },
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
    const router = createTestRouter({
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        write: () => {},
      } as never,
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

  test("terminal.create with projectId null spawns a home-directory terminal", async () => {
    const created: Array<{ projectPath: string; terminalId: string }> = []
    const router = createTestRouter({
      store: createFakeStore({ getProject: () => null }),
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        createTerminal: (args: { projectPath: string; terminalId: string }) => {
          created.push({ projectPath: args.projectPath, terminalId: args.terminalId })
          return { terminalId: args.terminalId }
        },
      } as never,
    })
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

    expect(created).toEqual([{ projectPath: homedir(), terminalId: "home" }])
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
    const sessions = new Map<string, { terminalId: string }>()
    const router = createTestRouter({
      terminals: {
        getSnapshot: (terminalId: string) => sessions.get(terminalId) ?? null,
        onEvent: () => () => {},
        createTerminal: (args: { terminalId: string }) => {
          const snapshot = { terminalId: args.terminalId }
          sessions.set(args.terminalId, snapshot)
          return snapshot
        },
        close: (terminalId: string) => {
          sessions.delete(terminalId)
        },
      } as never,
    })
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
      diffStore: createFakeDiffStore({
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
      diffStore: createFakeDiffStore({
        readPatch: async () => ({ patch: "diff --git a/app.txt b/app.txt" }),
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
      diffStore: createFakeDiffStore({
        getProjectSnapshot: () => ({ status: "ready", branchName: "main", files: [], branchHistory: { entries: [] } }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 2, hasConflicts: false, message: "2 commits from feature/test will merge into main." }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: true }),
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

    const router = createTestRouter({
      keybindings: keybindings as never,
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

    const router = createTestRouter({
      updateManager: updateManager as never,
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
      diffStore: createFakeDiffStore({
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        discardFile: async (args: { projectId: string; projectPath: string; path: string }) => {
          discardCalls.push(args)
          return { snapshotChanged: true }
        },
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
      diffStore: createFakeDiffStore({
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        ignoreFile: async (args: { projectId: string; projectPath: string; path: string }) => {
          ignoreCalls.push(args)
          return { snapshotChanged: false }
        },
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
    const calls: string[] = []
    let changeListener: (() => void) | null = null
    const manager = {
      getSnapshot: () => AUTH_SERVICES_SNAPSHOT,
      refresh: async () => {
        calls.push("refresh")
      },
      probeService: async (service: string) => {
        calls.push(`probe:${service}`)
      },
      install: async (service: string) => {
        calls.push(`install:${service}`)
      },
      startLogin: (service: string) => {
        calls.push(`start:${service}`)
      },
      submitLoginCode: (service: string, code: string) => {
        calls.push(`submit:${service}:${code}`)
      },
      cancelLogin: (service: string) => {
        calls.push(`cancel:${service}`)
      },
      startOpenRouterAuth: (callbackUrl: string) => ({
        authUrl: `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=x&code_challenge_method=S256`,
      }),
      exchangeOpenRouterCode: async (code: string) => {
        calls.push(`exchange:${code}`)
        return { ...DEFAULT_LLM_PROVIDER_SNAPSHOT, provider: "openrouter" as const, apiKey: "sk-or-key" }
      },
      onChange: (listener: () => void) => {
        changeListener = listener
        return () => {
          changeListener = null
        }
      },
    }
    return { manager: manager as never, calls, fireChange: () => changeListener?.() }
  }

  test("subscribing pushes the snapshot and kicks a refresh; onChange fanout dedupes", async () => {
    const fake = createFakeProviderAuth()
    const router = createTestRouter({ providerAuth: fake.manager })
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
    fake.fireChange()
    expect(ws.sent).toHaveLength(1)
  })

  test("auth commands route to the manager and ack", async () => {
    const fake = createFakeProviderAuth()
    const router = createTestRouter({ providerAuth: fake.manager })
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

  function createWindowedRouter(entries: Array<Record<string, unknown>>) {
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
    const settings = createFakeAppSettings({
      getSnapshot: () => ({ ...DEFAULT_APP_SETTINGS_SNAPSHOT, transcript: { windowAssistantMessages: 2 } }),
    })
    return createTestRouter({ store: fake, appSettings: settings })
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
})

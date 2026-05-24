import { randomUUID } from "node:crypto"
import { readTextFileOrThrow, spawnCommandCapture } from "./ws-router-io.adapter"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientEnvelope, PtyInstancesEvent, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import type { PtyInstanceDelta } from "../shared/pty-instance"
import type { PtyInstanceRegistry } from "./claude-pty/pty-instance-registry"
import { isClientEnvelope } from "../shared/protocol"
import type { AgentCoordinator } from "./agent"
import type { AnalyticsReporter } from "./analytics"
import { NoopAnalyticsReporter } from "./analytics"
import type { AppSettingsManager } from "./app-settings"
import type { DiscoveredProject } from "./discovery.adapter"
import { DiffStore } from "./diff-store"
import { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import { KeybindingsManager } from "./keybindings"
import { resolveLocalPath } from "./paths"
import { ensureProjectDirectory } from "./project-directory.adapter"
import { writeStandaloneTranscriptExport } from "./standalone-export.adapter"
import { TerminalManager } from "./terminal-manager"
import type { UpdateManager } from "./update-manager"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { AUTH_DEFAULTS, CLAUDE_AUTH_DEFAULTS, CLAUDE_DRIVER_DEFAULTS, CLAUDE_PTY_LIFECYCLE_DEFAULTS, CLOUDFLARE_TUNNEL_DEFAULTS, UPLOAD_DEFAULTS } from "../shared/types"
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  InstalledSkillsSnapshot,
  LlmProviderSnapshot,
  LlmProviderValidationResult,
  SkillInstallResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
  Subagent,
  SubagentValidationError,
} from "../shared/types"
import { importClaudeSessions } from "./claude-session-importer.adapter"
import { listWorktrees } from "./worktree-store.adapter"
import type { TunnelGateway } from "./cloudflare-tunnel/gateway"
import type { PushManager } from "./push/push-manager"
import { validateMcpServer } from "./mcp-validator"
import type { SessionShareService } from "./session-share"

const DEFAULT_CHAT_RECENT_LIMIT = 200
const SKILL_AGENT_ALIASES = ["universal", "claude-code"] as const

function isSendToStartingProfilingEnabled() {
  return process.env.KANNA_PROFILE_SEND_TO_STARTING === "1"
}

function logSendToStartingProfile(
  traceId: string | null | undefined,
  startedAt: number | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!traceId || startedAt === undefined || startedAt === null || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[kanna/send->starting][server]", JSON.stringify({
    traceId,
    stage,
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    ...details,
  }))
}

function countSubscriptionsByTopic(ws: ServerWebSocket<ClientState>) {
  let sidebar = 0
  let chat = 0
  let projectGit = 0
  let localProjects = 0
  let update = 0
  let keybindings = 0
  let appSettings = 0
  let terminal = 0

  for (const topic of ws.data.subscriptions.values()) {
    switch (topic.type) {
      case "sidebar":
        sidebar += 1
        break
      case "chat":
        chat += 1
        break
      case "project-git":
        projectGit += 1
        break
      case "local-projects":
        localProjects += 1
        break
      case "update":
        update += 1
        break
      case "keybindings":
        keybindings += 1
        break
      case "app-settings":
        appSettings += 1
        break
      case "terminal":
        terminal += 1
        break
    }
  }

  return {
    total: ws.data.subscriptions.size,
    sidebar,
    chat,
    projectGit,
    localProjects,
    update,
    keybindings,
    appSettings,
    terminal,
  }
}

export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
  snapshotSignatures: Map<string, string>
  protectedDraftChatIds?: Set<string>
  pushDeviceId?: string | null
}

interface CreateWsRouterArgs {
  store: EventStore
  diffStore?: Pick<DiffStore, "getProjectSnapshot" | "refreshSnapshot" | "initializeGit" | "getGitHubPublishInfo" | "checkGitHubRepoAvailability" | "publishToGitHub" | "listBranches" | "previewMergeBranch" | "mergeBranch" | "syncBranch" | "checkoutBranch" | "createBranch" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile" | "readPatch">
  agent: AgentCoordinator
  terminals: TerminalManager
  keybindings: KeybindingsManager
  appSettings?: Pick<AppSettingsManager, "getSnapshot" | "write">
    & Partial<Pick<AppSettingsManager, "setCloudflareTunnel" | "setClaudeAuth" | "writePatch" | "onChange" | "createSubagent" | "updateSubagent" | "deleteSubagent">>
  analytics?: AnalyticsReporter
  tunnelGateway?: TunnelGateway
  llmProvider?: {
    read: () => Promise<LlmProviderSnapshot>
    write: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderSnapshot>
    validate: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  }
  refreshDiscovery: () => Promise<DiscoveredProject[]>
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager | null
  pushManager: PushManager
  ptyInstances?: PtyInstanceRegistry
  killPtyInstance?: (chatId: string) => Promise<{ ok: boolean; error?: string }>
  sessionShare?: SessionShareService
}

interface SnapshotBroadcastFilter {
  includeSidebar?: boolean
  includeLocalProjects?: boolean
  includeUpdate?: boolean
  includeKeybindings?: boolean
  includeAppSettings?: boolean
  includePushConfig?: boolean
  chatIds?: Set<string>
  projectIds?: Set<string>
  terminalIds?: Set<string>
}

interface SnapshotComputationCache {
  sidebar?: {
    data: ReturnType<typeof deriveSidebarData>
    signature: string
  }
}

function getSidebarProjectOrder(store: EventStore) {
  return typeof store.getSidebarProjectOrder === "function"
    ? store.getSidebarProjectOrder()
    : []
}

// Stale-state command failures happen during normal client/server races
// (e.g. the user steers a queued message that drained between snapshots).
// They flood pm2 logs at console.error level; downgrade to console.log.
const BENIGN_STALE_STATE_MESSAGES = [
  /^Chat not found$/,
  /^Queued message not found$/,
  /^File is no longer changed: /,
  /^Project not found$/,
] as const

export function isBenignStaleStateMessage(message: string): boolean {
  return BENIGN_STALE_STATE_MESSAGES.some((pattern) => pattern.test(message))
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  const payload = JSON.stringify(message)
  ws.send(payload)
  return payload.length
}

function isSubagentValidationError(value: Subagent | SubagentValidationError): value is SubagentValidationError {
  return "code" in value && "message" in value
}

export function assertSafeSkillSource(source: string) {
  const normalized = source.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Skill source must be an owner/repo pair.")
  }
  return normalized
}

export function assertSafeSkillId(skillId: string) {
  const normalized = skillId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error("Skill id is invalid.")
  }
  return normalized
}

export function getGlobalSkillLockPath() {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim()
  if (xdgStateHome) {
    return path.join(xdgStateHome, "skills", ".skill-lock.json")
  }
  return path.join(os.homedir(), ".agents", ".skill-lock.json")
}

function asString(value: unknown) {
  return typeof value === "string" ? value : ""
}

export function parseInstalledSkillsLock(parsed: unknown, lockFilePath: string): InstalledSkillsSnapshot {
  const skillsRecord = parsed
    && typeof parsed === "object"
    && "skills" in parsed
    && parsed.skills
    && typeof parsed.skills === "object"
    && !Array.isArray(parsed.skills)
      ? parsed.skills as Record<string, unknown>
      : {}

  const skills = Object.entries(skillsRecord)
    .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map(([name, entry]) => {
      const record = entry as Record<string, unknown>
      return {
        name,
        source: asString(record.source),
        sourceType: asString(record.sourceType),
        sourceUrl: asString(record.sourceUrl),
        skillPath: asString(record.skillPath) || undefined,
        installedAt: asString(record.installedAt),
        updatedAt: asString(record.updatedAt),
        pluginName: asString(record.pluginName) || undefined,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    lockFilePath,
    skills,
  }
}

export async function listInstalledSkills(lockFilePath = getGlobalSkillLockPath()): Promise<InstalledSkillsSnapshot> {
  try {
    return parseInstalledSkillsLock(JSON.parse(await readTextFileOrThrow(lockFilePath)), lockFilePath)
  } catch {
    return {
      lockFilePath,
      skills: [],
    }
  }
}

export async function searchSkills(query: string, limit = 100): Promise<SkillSearchSnapshot> {
  const normalizedQuery = query.trim()
  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      searchType: "fuzzy",
      skills: [],
      count: 0,
      duration_ms: 0,
    }
  }

  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const url = new URL("https://skills.sh/api/search")
  url.searchParams.set("q", normalizedQuery)
  url.searchParams.set("limit", String(normalizedLimit))

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Skills search failed with status ${response.status}.`)
  }

  const payload = await response.json() as Partial<SkillSearchSnapshot>
  return {
    query: typeof payload.query === "string" ? payload.query : normalizedQuery,
    searchType: typeof payload.searchType === "string" ? payload.searchType : "fuzzy",
    skills: Array.isArray(payload.skills)
      ? payload.skills
        .filter((skill) => (
          skill
          && typeof skill === "object"
          && typeof skill.id === "string"
          && typeof skill.skillId === "string"
          && typeof skill.name === "string"
          && typeof skill.source === "string"
        ))
        .map((skill) => ({
          id: skill.id,
          skillId: skill.skillId,
          name: skill.name,
          installs: typeof skill.installs === "number" ? skill.installs : 0,
          source: skill.source,
        }))
      : [],
    count: typeof payload.count === "number" ? payload.count : 0,
    duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : 0,
  }
}

export function buildInstallSkillCommand(source: string, skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "add",
    assertSafeSkillSource(source),
    "--skill",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

export function buildUninstallSkillCommand(skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "remove",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

async function runSkillCommand(command: string[]) {
  const cwd = os.homedir()
  const { stdout, stderr, exitCode } = await spawnCommandCapture(command, cwd, {
    ...process.env,
    DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? "1",
  })

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `skills CLI exited with code ${exitCode}.`)
  }

  return { cwd, stdout, stderr }
}

export async function installSkill(source: string, skillId: string): Promise<SkillInstallResult> {
  const command = buildInstallSkillCommand(source, skillId)
  const { cwd, stdout, stderr } = await runSkillCommand(command)
  return {
    source: command[3],
    skillId: command[5],
    command,
    cwd,
    stdout,
    stderr,
  }
}

export async function uninstallSkill(skillId: string): Promise<SkillUninstallResult> {
  const command = buildUninstallSkillCommand(skillId)
  const { cwd, stdout, stderr } = await runSkillCommand(command)
  return {
    skillId: command[3],
    command,
    cwd,
    stdout,
    stderr,
  }
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
  agent,
  terminals,
  keybindings,
  appSettings,
  analytics,
  tunnelGateway,
  llmProvider,
  refreshDiscovery,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
  pushManager,
  ptyInstances,
  killPtyInstance,
  sessionShare,
}: CreateWsRouterArgs) {
  const sockets = new Set<ServerWebSocket<ClientState>>()
  let pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  let pendingBroadcastAll = false
  const pendingBroadcastChatIds = new Set<string>()
  const resolvedDiffStore = diffStore ?? {
    getProjectSnapshot: () => ({ status: "unknown", branchName: undefined, defaultBranchName: undefined, hasOriginRemote: undefined, originRepoSlug: undefined, hasUpstream: undefined, aheadCount: undefined, behindCount: undefined, lastFetchedAt: undefined, files: [] as const, branchHistory: { entries: [] as const } }),
    refreshSnapshot: async () => false,
    initializeGit: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    getGitHubPublishInfo: async () => ({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined, owners: [], suggestedRepoName: "my-repo" }),
    checkGitHubRepoAvailability: async () => ({ available: false, message: "Unavailable" }),
    publishToGitHub: async () => ({ ok: false, title: "Publish failed", message: "Unavailable", snapshotChanged: false }),
    listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" as const }),
    previewMergeBranch: async () => ({ currentBranchName: undefined, targetBranchName: "", targetDisplayName: "", status: "error" as const, commitCount: 0, hasConflicts: false, message: "Merge preview unavailable." }),
    mergeBranch: async () => ({ ok: false as const, title: "Merge failed", message: "Merge unavailable.", snapshotChanged: false }),
    syncBranch: async () => ({ ok: true, action: "fetch" as const, branchName: undefined, snapshotChanged: false }),
    checkoutBranch: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
    generateCommitMessage: async () => ({ subject: "Update selected files", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: async () => ({ ok: true, mode: "commit_only" as const, branchName: undefined, pushed: false, snapshotChanged: false }),
    discardFile: async () => ({ snapshotChanged: false }),
    ignoreFile: async () => ({ snapshotChanged: false }),
    readPatch: async () => ({ patch: "" }),
  }
  const resolvedLlmProvider = llmProvider ?? {
    read: async () => ({
      provider: "openai" as const,
      apiKey: "",
      model: "gpt-5.4-mini",
      baseUrl: "",
      resolvedBaseUrl: "https://api.openai.com/v1",
      enabled: false,
      warning: null,
      filePathDisplay: "~/.kanna/llm-provider.json",
    }),
    write: async ({ provider, apiKey, model, baseUrl }: {
      provider: "openai" | "openrouter" | "custom"
      apiKey: string
      model: string
      baseUrl: string
    }) => ({
      provider,
      apiKey,
      model,
      baseUrl,
      resolvedBaseUrl: provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : provider === "custom"
          ? baseUrl
          : "https://api.openai.com/v1",
      enabled: false,
      warning: null,
      filePathDisplay: "~/.kanna/llm-provider.json",
    }),
    validate: async () => ({
      ok: false,
      error: {
        type: "config_error",
        message: "LLM provider validation unavailable.",
      },
    }),
  }
  let fallbackAppSettingsSnapshot: AppSettingsSnapshot = {
    analyticsEnabled: true,
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
    cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
    auth: AUTH_DEFAULTS,
    claudeAuth: CLAUDE_AUTH_DEFAULTS,
    uploads: UPLOAD_DEFAULTS,
    subagents: [],
    customMcpServers: [],
    claudeDriver: { ...CLAUDE_DRIVER_DEFAULTS, lifecycle: { ...CLAUDE_PTY_LIFECYCLE_DEFAULTS } },
    globalPromptAppend: "",
    shareDefaultTtlHours: 24,
  }
  const mergeAppSettingsPatch = (snapshot: AppSettingsSnapshot, patch: AppSettingsPatch): AppSettingsSnapshot => {
    let subagents = snapshot.subagents
    if (patch.subagents?.create) {
      const now = Date.now()
      subagents = [...subagents, {
        id: randomUUID(),
        ...patch.subagents.create,
        name: patch.subagents.create.name.trim(),
        createdAt: now,
        updatedAt: now,
      }]
    } else if (patch.subagents?.update) {
      subagents = subagents.map((subagent) => subagent.id === patch.subagents?.update?.id
        ? {
            ...subagent,
            ...patch.subagents.update.patch,
            name: patch.subagents.update.patch.name?.trim() ?? subagent.name,
            description: patch.subagents.update.patch.description === null
              ? undefined
              : patch.subagents.update.patch.description ?? subagent.description,
            modelOptions: { ...subagent.modelOptions, ...(patch.subagents.update.patch.modelOptions ?? {}) } as Subagent["modelOptions"],
            updatedAt: Date.now(),
          }
        : subagent)
    } else if (patch.subagents?.delete) {
      subagents = subagents.filter((subagent) => subagent.id !== patch.subagents?.delete?.id)
    }

    return {
      ...snapshot,
      ...patch,
      terminal: {
        ...snapshot.terminal,
        ...patch.terminal,
      },
      editor: {
        ...snapshot.editor,
        ...patch.editor,
      },
      providerDefaults: {
        claude: {
          ...snapshot.providerDefaults.claude,
          ...patch.providerDefaults?.claude,
          modelOptions: {
            ...snapshot.providerDefaults.claude.modelOptions,
            ...patch.providerDefaults?.claude?.modelOptions,
          },
        },
        codex: {
          ...snapshot.providerDefaults.codex,
          ...patch.providerDefaults?.codex,
          modelOptions: {
            ...snapshot.providerDefaults.codex.modelOptions,
            ...patch.providerDefaults?.codex?.modelOptions,
          },
        },
      },
      cloudflareTunnel: {
        ...snapshot.cloudflareTunnel,
        ...patch.cloudflareTunnel,
      },
      auth: {
        ...snapshot.auth,
        ...patch.auth,
      },
      claudeAuth: {
        tokens: patch.claudeAuth?.tokens ?? snapshot.claudeAuth.tokens,
        concurrencyDefault: patch.claudeAuth?.concurrencyDefault ?? snapshot.claudeAuth.concurrencyDefault,
      },
      uploads: {
        ...snapshot.uploads,
        ...patch.uploads,
      },
      subagents,
      customMcpServers: snapshot.customMcpServers,
      claudeDriver: {
        preference: patch.claudeDriver?.preference ?? snapshot.claudeDriver.preference,
        lifecycle: {
          ...snapshot.claudeDriver.lifecycle,
          ...patch.claudeDriver?.lifecycle,
        },
      },
    }
  }
  const resolvedAppSettings = {
    getSnapshot: () => appSettings?.getSnapshot() ?? fallbackAppSettingsSnapshot,
    write: async (value: { analyticsEnabled: boolean }) => {
      if (appSettings) return await appSettings.write(value)
      fallbackAppSettingsSnapshot = { ...fallbackAppSettingsSnapshot, analyticsEnabled: value.analyticsEnabled }
      return fallbackAppSettingsSnapshot
    },
    writePatch: async (patch: AppSettingsPatch) => {
      if (appSettings?.writePatch) return await appSettings.writePatch(patch)
      if (appSettings && patch.analyticsEnabled !== undefined && Object.keys(patch).length === 1) {
        return await appSettings.write({ analyticsEnabled: patch.analyticsEnabled })
      }
      fallbackAppSettingsSnapshot = mergeAppSettingsPatch(appSettings?.getSnapshot() ?? fallbackAppSettingsSnapshot, patch)
      return fallbackAppSettingsSnapshot
    },
    setCloudflareTunnel: async (patch: Partial<AppSettingsSnapshot["cloudflareTunnel"]>) => {
      if (appSettings?.setCloudflareTunnel) return await appSettings.setCloudflareTunnel(patch)
      fallbackAppSettingsSnapshot = mergeAppSettingsPatch(appSettings?.getSnapshot() ?? fallbackAppSettingsSnapshot, { cloudflareTunnel: patch })
      return fallbackAppSettingsSnapshot
    },
    setClaudeAuth: async (patch: Partial<AppSettingsSnapshot["claudeAuth"]>) => {
      if (appSettings?.setClaudeAuth) return await appSettings.setClaudeAuth(patch)
      fallbackAppSettingsSnapshot = mergeAppSettingsPatch(
        appSettings?.getSnapshot() ?? fallbackAppSettingsSnapshot,
        { claudeAuth: patch },
      )
      return fallbackAppSettingsSnapshot
    },
    createSubagent: async (input: Parameters<AppSettingsManager["createSubagent"]>[0]) => {
      if (appSettings?.createSubagent) return await appSettings.createSubagent(input)
      const snapshot = await resolvedAppSettings.writePatch({ subagents: { create: input } })
      return snapshot.subagents[snapshot.subagents.length - 1] ?? { code: "NOT_FOUND" as const, message: "Created subagent not found" }
    },
    updateSubagent: async (id: string, patch: Parameters<AppSettingsManager["updateSubagent"]>[1]) => {
      if (appSettings?.updateSubagent) return await appSettings.updateSubagent(id, patch)
      const snapshot = await resolvedAppSettings.writePatch({ subagents: { update: { id, patch } } })
      return snapshot.subagents.find((subagent) => subagent.id === id) ?? { code: "NOT_FOUND" as const, message: `Subagent ${id} not found` }
    },
    deleteSubagent: async (id: string) => {
      if (appSettings?.deleteSubagent) return await appSettings.deleteSubagent(id)
      await resolvedAppSettings.writePatch({ subagents: { delete: { id } } })
    },
    onChange: (listener: (snapshot: AppSettingsSnapshot) => void) => appSettings?.onChange?.(listener) ?? (() => {}),
  }
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
    const startedAt = performance.now()
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    const prunedChatIds = await store.pruneStaleEmptyChats?.({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.prune_stale_empty_chats",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        activeChatCount: activeChatIds.size,
        protectedDraftChatCount: protectedDraftChatIds.size,
        prunedCount: prunedChatIds?.length ?? 0,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }
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
    if (topic.type === "push-config") {
      return Boolean(filter.includePushConfig)
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

  function getSidebarSnapshotCacheEntry(cache?: SnapshotComputationCache) {
    if (cache?.sidebar) {
      return cache.sidebar
    }

    const startedAt = performance.now()
    const data = deriveSidebarData(store.state, agent.getActiveStatuses(), {
      sidebarProjectOrder: getSidebarProjectOrder(store),
      drainingChatIds: agent.getDrainingChatIds(),
      claudeSessionStates: agent.getClaudeSessionStates?.(),
    })
    const observed = data.projectGroups.flatMap((group) =>
      group.chats.map((chat) => ({
        chatId: chat.chatId,
        projectLocalPath: group.localPath,
        projectTitle: group.localPath.split("/").filter(Boolean).pop() ?? group.localPath,
        chatTitle: chat.title,
        status: chat.status,
      }))
    )
    void pushManager.observeStatuses(observed).catch((error) => {
      console.warn("[kanna/push] observeStatuses failed", { error })
    })
    if (isSendToStartingProfilingEnabled()) {
      const totalChats = data.projectGroups.reduce((count, group) => count + group.chats.length, 0)
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.sidebar_snapshot_built",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        projectGroupCount: data.projectGroups.length,
        chatCount: totalChats,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }

    const sidebar = {
      data,
      signature: JSON.stringify({
        type: "sidebar" as const,
        data,
      }),
    }

    if (cache) {
      cache.sidebar = sidebar
    }

    return sidebar
  }

  function createEnvelope(
    id: string,
    topic: SubscriptionTopic,
    cache?: SnapshotComputationCache,
    connection?: ServerWebSocket<ClientState>,
  ): ServerEnvelope {
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
          data: resolvedAppSettings.getSnapshot(),
        },
      }
    }

    if (topic.type === "push-config") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "push-config",
          data: pushManager.getConfigSnapshot(connection?.data.pushDeviceId ?? null),
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
            ? resolvedDiffStore.getProjectSnapshot(topic.projectId)
            : null,
        },
      }
    }

    if (topic.type === "pty-instances") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "pty-instances",
          data: { instances: ptyInstances?.snapshot() ?? [] },
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
          agent.getSlashCommandsLoadingChatIds(),
          topic.chatId,
          (chatId) => store.getRecentChatHistory(chatId, topic.recentLimit ?? DEFAULT_CHAT_RECENT_LIMIT),
          (chatId) => store.getTunnelEvents(chatId),
          agent.getWaitStartedAtByChatId(),
          Date.now(),
          agent.getClaudeSessionStates?.() ?? new Map(),
        ),
      },
    }
  }

  // timings.derivedAtMs = Date.now() on every call, making every snapshot unique
  // and defeating signature-based dedup. Strip timings from the signature so that
  // idle/finished chats are only sent once instead of on every broadcastSnapshots call.
  function getStableChatSnapshotSignature(snapshot: Extract<ServerEnvelope, { type: "snapshot" }>["snapshot"]): string {
    if (snapshot.type === "chat" && snapshot.data?.runtime) {
      const { timings: _t, ...stableRuntime } = snapshot.data.runtime
      return JSON.stringify({ type: snapshot.type, data: { ...snapshot.data, runtime: stableRuntime } })
    }
    return JSON.stringify(snapshot)
  }

  async function pushSnapshots(
    ws: ServerWebSocket<ClientState>,
    options?: { skipPrune?: boolean; filter?: SnapshotBroadcastFilter; cache?: SnapshotComputationCache }
  ) {
    const pushStartedAt = performance.now()
    if (!options?.skipPrune) {
      await maybePruneStaleEmptyChats([ws])
    }
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    let sentCount = 0
    let skippedCount = 0
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      if (!shouldIncludeTopic(topic, options?.filter)) {
        continue
      }
      const envelopeStartedAt = performance.now()
      const envelope = createEnvelope(id, topic, options?.cache, ws)
      const createdAt = performance.now()
      if (envelope.type !== "snapshot") continue
      const signature = topic.type === "sidebar"
        ? getSidebarSnapshotCacheEntry(options?.cache).signature
        : getStableChatSnapshotSignature(envelope.snapshot)
      const signatureReadyAt = topic.type === "sidebar" ? createdAt : performance.now()
      if (snapshotSignatures.get(id) === signature) {
        skippedCount += 1
        continue
      }
      snapshotSignatures.set(id, signature)
      if (topic.type === "chat" && envelope.snapshot.type === "chat" && envelope.snapshot.data?.runtime.status === "starting") {
        const profile = agent.getActiveTurnProfile(topic.chatId)
        logSendToStartingProfile(profile?.traceId, profile?.startedAt, "ws.snapshot_sent", {
          chatId: topic.chatId,
          status: envelope.snapshot.data.runtime.status,
          messageCount: envelope.snapshot.data.messages.length,
          buildMs: Number((createdAt - envelopeStartedAt).toFixed(1)),
          signatureMs: Number((signatureReadyAt - createdAt).toFixed(1)),
          signatureBytes: signature.length,
        })
      }
      const payloadBytes = send(ws, envelope)
      sentCount += 1
      if (topic.type === "chat" && envelope.snapshot.type === "chat" && envelope.snapshot.data?.runtime.status === "starting") {
        const profile = agent.getActiveTurnProfile(topic.chatId)
        logSendToStartingProfile(profile?.traceId, profile?.startedAt, "ws.snapshot_send_completed", {
          chatId: topic.chatId,
          payloadBytes,
        })
      }
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.push_snapshots_completed",
        elapsedMs: Number((performance.now() - pushStartedAt).toFixed(1)),
        skipPrune: Boolean(options?.skipPrune),
        sentCount,
        skippedCount,
        ...countSubscriptionsByTopic(ws),
      }))
    }
  }

  async function broadcastSnapshots() {
    const startedAt = performance.now()
    let socketCount = 0
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      socketCount += 1
      await pushSnapshots(ws, { skipPrune: true, cache })
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.broadcast_snapshots_completed",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        pruneMs: 0,
        socketCount,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }
  }

  async function broadcastFilteredSnapshots(filter: SnapshotBroadcastFilter) {
    const startedAt = performance.now()
    let socketCount = 0
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      socketCount += 1
      await pushSnapshots(ws, { skipPrune: true, filter, cache })
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[kanna/send->starting][server]", JSON.stringify({
        stage: "ws.broadcast_filtered_snapshots_completed",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        socketCount,
        includeSidebar: Boolean(filter.includeSidebar),
        chatCount: filter.chatIds?.size ?? 0,
        projectCount: filter.projectIds?.size ?? 0,
      }))
    }
  }

  function scheduleBroadcast() {
    pendingBroadcastAll = true
    pendingBroadcastChatIds.clear()
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(() => {
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
        void broadcastFilteredSnapshots({
          includeSidebar: true,
          chatIds,
        })
      }
    }, 16)
  }

  function scheduleChatStateBroadcast(chatId: string) {
    if (!pendingBroadcastAll) {
      pendingBroadcastChatIds.add(chatId)
    }
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(() => {
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
        void broadcastFilteredSnapshots({
          includeSidebar: true,
          chatIds,
        })
      }
    }, 16)
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

  function pushTerminalSnapshot(terminalId: string) {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        const envelope = createEnvelope(id, topic, undefined, ws)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
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
        const envelope = createEnvelope(id, topic, undefined, ws)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  })

  const disposeAppSettingsEvents = resolvedAppSettings.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "app-settings") continue
        const envelope = createEnvelope(id, topic, undefined, ws)
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
        const envelope = createEnvelope(id, topic, undefined, ws)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }) ?? (() => {})

  function pushPtyInstancesEvent(event: PtyInstancesEvent) {
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "pty-instances") continue
        send(ws, { v: PROTOCOL_VERSION, type: "event", id, event })
      }
    }
  }

  const disposePtyInstances: () => void = ptyInstances?.subscribe((delta: PtyInstanceDelta) => {
    if (delta.type === "added") {
      pushPtyInstancesEvent({ type: "pty-instances.added", instance: delta.instance })
    } else if (delta.type === "updated") {
      pushPtyInstancesEvent({ type: "pty-instances.updated", instance: delta.instance })
    } else {
      pushPtyInstancesEvent({ type: "pty-instances.removed", chatId: delta.chatId })
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

  async function handleCommand(ws: ServerWebSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    try {
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
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
        case "update.install": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.installUpdate({ version: command.version })
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result,
          })
          return
        }
        case "update.reload": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.forceReload()
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
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: resolvedAppSettings.getSnapshot() })
          return
        }
        case "settings.writeAppSettings": {
          const previousAnalyticsEnabled = resolvedAppSettings.getSnapshot().analyticsEnabled
          if (previousAnalyticsEnabled && !command.analyticsEnabled) {
            resolvedAnalytics.track("analytics_disabled")
          }
          const snapshot = await resolvedAppSettings.write({ analyticsEnabled: command.analyticsEnabled })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          if (!previousAnalyticsEnabled && command.analyticsEnabled) {
            resolvedAnalytics.track("analytics_enabled")
          }
          return
        }
        case "appSettings.setCloudflareTunnel": {
          await resolvedAppSettings.setCloudflareTunnel(command.patch)
          const snapshot = resolvedAppSettings.getSnapshot()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "appSettings.setClaudeAuth": {
          await resolvedAppSettings.setClaudeAuth(command.patch)
          const snapshot = resolvedAppSettings.getSnapshot()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "appSettings.testOAuthToken": {
          const result = await testOAuthToken(command.token)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "settings.writeAppSettingsPatch": {
          const previousAnalyticsEnabled = resolvedAppSettings.getSnapshot().analyticsEnabled
          const snapshot = await resolvedAppSettings.writePatch(command.patch)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })

          // Fire-and-forget auto-test for newly created or updated MCP server.
          const targetId = (() => {
            const ops = command.patch.customMcpServers
            if (!ops) return null
            if (ops.update) return ops.update.id
            if (ops.create) {
              // The created entry is the one with no prior match by name —
              // simplest: pick the entry with the latest createdAt.
              const list = snapshot.customMcpServers
              if (list.length === 0) return null
              return list.reduce((latest, e) => (e.createdAt > latest.createdAt ? e : latest), list[0]!).id
            }
            return null
          })()
          if (targetId) {
            void runMcpAutoTest(targetId, resolvedAppSettings)
          }

          if (command.patch.analyticsEnabled !== undefined && previousAnalyticsEnabled && !snapshot.analyticsEnabled) {
            resolvedAnalytics.track("analytics_disabled")
          }
          if (command.patch.analyticsEnabled !== undefined && !previousAnalyticsEnabled && snapshot.analyticsEnabled) {
            resolvedAnalytics.track("analytics_enabled")
          }
          return
        }
        case "subagent.create": {
          const result = await resolvedAppSettings.createSubagent(command.input)
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: isSubagentValidationError(result)
              ? { ok: false, error: result }
              : { ok: true, subagent: result },
          })
          return
        }
        case "subagent.update": {
          const result = await resolvedAppSettings.updateSubagent(command.id, command.patch)
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: isSubagentValidationError(result)
              ? { ok: false, error: result }
              : { ok: true, subagent: result },
          })
          return
        }
        case "subagent.delete": {
          await resolvedAppSettings.deleteSubagent(command.id)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { ok: true } })
          return
        }
        case "settings.testMcpServer": {
          const snapshot = resolvedAppSettings.getSnapshot()
          const entry = snapshot.customMcpServers.find((s) => s.id === command.id)
          if (!entry) {
            send(ws, {
              v: PROTOCOL_VERSION,
              type: "ack",
              id,
              result: {
                ok: false,
                message: "MCP server not found",
                lastTest: { status: "error", testedAt: new Date().toISOString(), message: "not found" } as const,
              },
            })
            return
          }
          // Mark pending so the UI sees a spinner while we connect.
          await resolvedAppSettings.writePatch({
            customMcpServers: {
              setTestResult: { id: entry.id, result: { status: "pending", startedAt: new Date().toISOString() } },
            },
          })
          const lastTest = await validateMcpServer(entry)
          await resolvedAppSettings.writePatch({
            customMcpServers: { setTestResult: { id: entry.id, result: lastTest } },
          })
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: {
              ok: lastTest.status === "ok",
              message: lastTest.status === "error" ? lastTest.message : undefined,
              lastTest,
            },
          })
          return
        }
        case "settings.readLlmProvider": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: await resolvedLlmProvider.read() })
          return
        }
        case "settings.writeLlmProvider": {
          const snapshot = await resolvedLlmProvider.write({
            provider: command.provider,
            apiKey: command.apiKey,
            model: command.model,
            baseUrl: command.baseUrl,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "settings.validateLlmProvider": {
          const result = await resolvedLlmProvider.validate({
            provider: command.provider,
            apiKey: command.apiKey,
            model: command.model,
            baseUrl: command.baseUrl,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
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
          break
        }
        case "project.create": {
          await ensureProjectDirectory(command.localPath)
          const normalizedPath = resolveLocalPath(command.localPath)
          const existingProjectId = store.state.projectIdsByPath.get(normalizedPath)
          const project = await store.openProject(command.localPath, command.title)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          if (!existingProjectId) {
            resolvedAnalytics.track("project_opened")
            resolvedAnalytics.track("project_created")
          }
          break
        }
        case "sessions.importClaude": {
          const result = await importClaudeSessions({ store })
          if (result.newProjects > 0) {
            await refreshDiscovery()
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          break
        }
        case "project.remove": {
          const project = store.getProject(command.projectId)
          await store.removeProject(command.projectId)
          if (project) {
            terminals.closeByCwd(project.localPath)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          resolvedAnalytics.track("project_removed")
          break
        }
        case "project.setStar": {
          await store.setProjectStar(command.projectId, command.starred)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
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
          const result = await resolvedDiffStore.readPatch({
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "system.openExternal": {
          await openExternal(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.create": {
          const chat = await store.createChat(command.projectId, {
            stackId: command.stackId,
            stackBindings: command.stackBindings,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { chatId: chat.id } })
          resolvedAnalytics.track("chat_created")
          await broadcastChatAndSidebar(chat.id)
          return
        }
        case "chat.fork": {
          const result = await agent.forkChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "chat.rename": {
          await store.renameChat(command.chatId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.archive": {
          await store.archiveChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "chat.unarchive": {
          await store.unarchiveChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.delete": {
          await agent.cancel(command.chatId)
          for (const scheduleId of agent.listLiveSchedules(command.chatId)) {
            await agent.cancelAutoContinue(command.chatId, scheduleId, "chat_deleted")
          }
          await agent.closeChat(command.chatId)
          if (agent.toolCallbackService) {
            await agent.toolCallbackService.cancelAllForChat(command.chatId, "chat_deleted")
          }
          await store.deleteChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          resolvedAnalytics.track("chat_deleted")
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "autoContinue.accept": {
          await agent.acceptAutoContinue(command.chatId, command.scheduleId, command.scheduledAt)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "autoContinue.reschedule": {
          await agent.rescheduleAutoContinue(command.chatId, command.scheduleId, command.scheduledAt)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "autoContinue.cancel": {
          await agent.cancelAutoContinue(command.chatId, command.scheduleId, "user")
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "tunnel.accept": {
          if (tunnelGateway) {
            await tunnelGateway.accept(command.chatId, command.tunnelId)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "tunnel.stop": {
          if (tunnelGateway) {
            await tunnelGateway.stop(command.chatId, command.tunnelId)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "tunnel.retry": {
          if (tunnelGateway) {
            await tunnelGateway.retry(command.chatId, command.tunnelId)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.markRead": {
          await store.setChatReadState(command.chatId, false)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.setPolicyOverride": {
          await store.setChatPolicyOverride(command.chatId, command.policyOverride ?? null)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.setDraftProtection": {
          ws.data.protectedDraftChatIds = new Set(command.chatIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.send": {
          const result = await agent.send(command)
          const profile = command.clientTraceId && result.chatId
            ? agent.getActiveTurnProfile(result.chatId)
            : null
          logSendToStartingProfile(profile?.traceId ?? command.clientTraceId, profile?.startedAt, "ws.chat_send_ack", {
            chatId: result.chatId ?? null,
          })
          const payloadBytes = send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          logSendToStartingProfile(profile?.traceId ?? command.clientTraceId, profile?.startedAt, "ws.chat_send_ack_completed", {
            chatId: result.chatId ?? null,
            payloadBytes,
          })
          return
        }
        case "chat.refreshDiffs": {
          const { project } = resolveChatProject(command.chatId)
          const changed = await resolvedDiffStore.refreshSnapshot(project.id, project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          if (changed) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.initGit": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.initializeGit({
            projectId: project.id,
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.getGitHubPublishInfo": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.getGitHubPublishInfo({
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.checkGitHubRepoAvailability": {
          const result = await resolvedDiffStore.checkGitHubRepoAvailability({
            owner: command.owner,
            name: command.name,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.publishToGitHub": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.publishToGitHub({
            projectId: project.id,
            projectPath: project.localPath,
            owner: command.owner,
            name: command.name,
            visibility: command.visibility,
            description: command.description,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.listBranches": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.listBranches({
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.previewMergeBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.previewMergeBranch({
            projectPath: project.localPath,
            branch: command.branch,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.mergeBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.mergeBranch({
            projectId: project.id,
            projectPath: project.localPath,
            branch: command.branch,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.checkoutBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.checkoutBranch({
            projectId: project.id,
            projectPath: project.localPath,
            branch: command.branch,
            bringChanges: command.bringChanges,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.syncBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.syncBranch({
            projectId: project.id,
            projectPath: project.localPath,
            action: command.action,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.createBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.createBranch({
            projectId: project.id,
            projectPath: project.localPath,
            name: command.name,
            baseBranchName: command.baseBranchName,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.generateCommitMessage": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.generateCommitMessage({
            projectPath: project.localPath,
            paths: command.paths,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.commitDiffs": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.commitFiles({
            projectId: project.id,
            projectPath: project.localPath,
            paths: command.paths,
            summary: command.summary,
            description: command.description,
            mode: command.mode,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.discardDiffFile": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.discardFile({
            projectId: project.id,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.ignoreDiffFile": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.ignoreFile({
            projectId: project.id,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
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
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.loadHistory": {
          const chat = store.getChat(command.chatId)
          if (!chat) throw new Error("Chat not found")
          const page = store.getMessagesPageBefore(command.chatId, command.beforeCursor, command.limit)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: page })
          return
        }
        case "chat.respondTool": {
          await agent.respondTool(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.toolRequestAnswer": {
          const toolCallbackSvc = agent.toolCallbackService
          if (!toolCallbackSvc) throw new Error("tool callback service unavailable")
          const validKinds = new Set(["allow", "deny", "answer"])
          if (typeof command.decision !== "object" || command.decision === null || !validKinds.has((command.decision as { kind?: string }).kind ?? "")) {
            throw new Error("Invalid tool request decision kind")
          }
          const existing = store.getToolRequest(command.toolRequestId)
          if (!existing || existing.chatId !== command.chatId) {
            throw new Error("Tool request does not belong to this chat")
          }
          await toolCallbackSvc.answer(command.toolRequestId, command.decision)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.respondSubagentTool": {
          await agent.respondSubagentTool(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.cancelSubagentRun": {
          await agent.cancelSubagentRun(command)
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
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const snapshot = terminals.createTerminal({
            projectPath: project.localPath,
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
          pushTerminalSnapshot(command.terminalId)
          return
        }
        case "push.identifyDevice": {
          ws.data.pushDeviceId = command.pushDeviceId
          if (command.pushDeviceId) {
            await pushManager.recordDeviceSeen(command.pushDeviceId)
            await broadcastFilteredSnapshots({ includePushConfig: true })
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "push.subscribe": {
          const result = await pushManager.addSubscription({
            subscription: command.subscription,
            label: command.label,
            userAgent: command.userAgent,
          })
          ws.data.pushDeviceId = result.id
          await broadcastFilteredSnapshots({ includePushConfig: true })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "push.unsubscribe": {
          await pushManager.removeSubscription(command.pushDeviceId, "user_revoked")
          if (ws.data.pushDeviceId === command.pushDeviceId) {
            ws.data.pushDeviceId = null
          }
          await broadcastFilteredSnapshots({ includePushConfig: true })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "push.test": {
          if (ws.data.pushDeviceId) {
            await pushManager.sendTest(ws.data.pushDeviceId)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "push.setProjectMute": {
          await pushManager.setProjectMute(command.localPath, command.muted)
          await broadcastFilteredSnapshots({ includePushConfig: true })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "push.setFocusedChat": {
          if (ws.data.pushDeviceId) {
            pushManager.setFocusedChat(ws.data.pushDeviceId, command.chatId)
          }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "pty.cancel": {
          try {
            await agent.cancel(command.chatId)
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { ok: true } })
          } catch (err) {
            send(ws, {
              v: PROTOCOL_VERSION,
              type: "ack",
              id,
              result: { ok: false, error: err instanceof Error ? err.message : String(err) },
            })
          }
          return
        }
        case "pty.kill": {
          if (!killPtyInstance) {
            send(ws, {
              v: PROTOCOL_VERSION,
              type: "ack",
              id,
              result: { ok: false, error: "pty kill not available" },
            })
            return
          }
          const result = await killPtyInstance(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "stack.create": {
          const stack = await store.createStack(command.title, command.projectIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { stackId: stack.id } })
          resolvedAnalytics.track("stack_created")
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "stack.rename": {
          await store.renameStack(command.stackId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "stack.remove": {
          await store.removeStack(command.stackId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "stack.addProject": {
          await store.addProjectToStack(command.stackId, command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "stack.removeProject": {
          await store.removeProjectFromStack(command.stackId, command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "stack.listWorktrees": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const worktrees = await listWorktrees(project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { worktrees } })
          return
        }
        case "share.mint": {
          if (!sessionShare) {
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { ok: false, error: { kind: "no_tunnel" } } })
            return
          }
          const r = await sessionShare.mintToken(command.payload)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: r })
          return
        }
        case "share.revoke": {
          if (!sessionShare) {
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { ok: false, error: { kind: "not_found" } } })
            return
          }
          const r = await sessionShare.revokeToken(command.payload)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: r })
          return
        }
        case "share.list": {
          if (!sessionShare) {
            send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { ok: true, data: { shares: [] } } })
            return
          }
          const shares = sessionShare.listSharesForChat(command.payload.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { ok: true, data: { shares } } })
          return
        }
      }

      await broadcastSnapshots()
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      const benign = isBenignStaleStateMessage(messageText)
      const logger = benign ? console.log : console.error
      logger("[ws-router] command failed", {
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
      if (ws.data.pushDeviceId) {
        pushManager.clearFocus(ws.data.pushDeviceId)
      }
      sockets.delete(ws)
    },
    broadcastSnapshots,
    broadcastChatStateImmediately,
    scheduleBroadcast,
    scheduleChatStateBroadcast,
    pruneStaleEmptyChats: () => maybePruneStaleEmptyChats(),
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
        if (parsed.topic.type === "chat") {
          void agent.ensureSlashCommandsLoaded(parsed.topic.chatId)
        }
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              void pushSnapshots(ws, { skipPrune: true })
            }
          })
          return
        }
        await pushSnapshots(ws, { skipPrune: true })
        return
      }

      if (parsed.type === "unsubscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.delete(parsed.id)
        snapshotSignatures.delete(parsed.id)
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
      disposePtyInstances()
    },
  }
}

async function testOAuthToken(token: string): Promise<{ ok: boolean; error: string | null }> {
  const trimmed = typeof token === "string" ? token.trim() : ""
  if (!trimmed) return { ok: false, error: "Token is empty" }
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "authorization": `Bearer ${trimmed}`,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Unauthorized" }
    if (res.status === 429) return { ok: true, error: "Token valid but currently rate-limited" }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, error: null }
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error: "Request timed out after 10s" }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runMcpAutoTest(
  id: string,
  appSettings: { getSnapshot(): AppSettingsSnapshot; writePatch(p: AppSettingsPatch): Promise<unknown> },
): Promise<void> {
  try {
    const entry = appSettings.getSnapshot().customMcpServers.find((s) => s.id === id)
    if (!entry) return
    await appSettings.writePatch({
      customMcpServers: {
        setTestResult: { id, result: { status: "pending", startedAt: new Date().toISOString() } },
      },
    })
    const result = await validateMcpServer(entry)
    await appSettings.writePatch({ customMcpServers: { setTestResult: { id, result } } })
  } catch (err) {
    // Auto-test must never throw; log + swallow.
    console.warn("[kanna/ws-router] runMcpAutoTest failed", err)
  }
}

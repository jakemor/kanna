import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useShallow } from "zustand/react/shallow"
import { APP_NAME } from "../../shared/branding"
import { PROVIDERS, type AgentProvider, type AppSettingsSnapshot, type AskUserQuestionAnswerMap, type ChatAttachment, type ChatDiffSnapshot, type ChatHistoryPage, type KeybindingsSnapshot, type LlmProviderSnapshot, type LlmProviderValidationResult, type ModelOptions, type ProviderCatalogEntry, type QueuedChatMessage, type TranscriptEntry, type UpdateInstallResult, type UpdateSnapshot, type UserPromptEntry } from "../../shared/types"
import { NEW_CHAT_COMPOSER_ID, type ComposerState, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { useChatInputStore } from "../stores/chatInputStore"
import { useSlashCommandsStore } from "../stores/slashCommandsStore"
import { usePreferencesStore } from "../stores/preferences"
import type { ChatSnapshot, CloudflareTunnelRecord, CloudflareTunnelSettings, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import { useAppDialog } from "../components/ui/app-dialog"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { generateUUID } from "../lib/utils"
import { canCancelStatus, getLatestToolIds, isProcessingStatus } from "./derived"
import { KannaSocket, type SocketStatus } from "./socket"

function sameRuntime(left: ChatSnapshot["runtime"] | null | undefined, right: ChatSnapshot["runtime"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.chatId === right.chatId
    && left.projectId === right.projectId
    && left.localPath === right.localPath
    && left.title === right.title
    && left.status === right.status
    && left.isDraining === right.isDraining
    && left.provider === right.provider
    && left.planMode === right.planMode
    && left.sessionToken === right.sessionToken
}

function sameTranscriptEntries(left: ChatSnapshot["messages"] | null | undefined, right: ChatSnapshot["messages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((entry, index) => entry._id === right[index]?._id)
}

function sameProviders(left: ProviderCatalogEntry[] | null | undefined, right: ProviderCatalogEntry[] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((provider, index) => provider.id === right[index]?.id)
}

function sameHistory(left: ChatSnapshot["history"] | null | undefined, right: ChatSnapshot["history"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.hasOlder === right.hasOlder
    && left.olderCursor === right.olderCursor
    && left.recentLimit === right.recentLimit
}

function sameQueuedMessage(left: QueuedChatMessage, right: QueuedChatMessage) {
  return left.id === right.id
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.provider === right.provider
    && left.model === right.model
    && left.planMode === right.planMode
    && JSON.stringify(left.modelOptions) === JSON.stringify(right.modelOptions)
    && sameAttachmentArray(left.attachments, right.attachments)
}

function sameAttachmentArray(left: ChatAttachment[], right: ChatAttachment[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((attachment, index) => {
    const other = right[index]
    return Boolean(other)
      && attachment.id === other.id
      && attachment.kind === other.kind
      && attachment.displayName === other.displayName
      && attachment.absolutePath === other.absolutePath
      && attachment.relativePath === other.relativePath
      && attachment.contentUrl === other.contentUrl
      && attachment.mimeType === other.mimeType
      && attachment.size === other.size
  })
}

function sameQueuedMessages(left: ChatSnapshot["queuedMessages"] | null | undefined, right: ChatSnapshot["queuedMessages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((message, index) => sameQueuedMessage(message, right[index]!))
}

function sameDiffs(left: ChatDiffSnapshot | null | undefined, right: ChatDiffSnapshot | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.status !== right.status) return false
  if (left.branchName !== right.branchName) return false
  if (left.defaultBranchName !== right.defaultBranchName) return false
  if (left.hasOriginRemote !== right.hasOriginRemote) return false
  if (left.originRepoSlug !== right.originRepoSlug) return false
  if (left.hasUpstream !== right.hasUpstream) return false
  if (left.aheadCount !== right.aheadCount) return false
  if (left.behindCount !== right.behindCount) return false
  if (left.lastFetchedAt !== right.lastFetchedAt) return false
  const leftHistory = left.branchHistory?.entries ?? []
  const rightHistory = right.branchHistory?.entries ?? []
  if (leftHistory.length !== rightHistory.length) return false
  const sameBranchHistory = leftHistory.every((entry, index) => {
    const other = rightHistory[index]
    return Boolean(other)
      && entry.sha === other.sha
      && entry.summary === other.summary
      && entry.description === other.description
      && entry.authorName === other.authorName
      && entry.authoredAt === other.authoredAt
      && entry.githubUrl === other.githubUrl
      && entry.tags.length === other.tags.length
      && entry.tags.every((tag, tagIndex) => tag === other.tags[tagIndex])
  })
  if (!sameBranchHistory) return false
  if (left.files.length !== right.files.length) return false
  return left.files.every((file, index) => {
    const other = right.files[index]
    return Boolean(other)
      && file.path === other.path
      && file.changeType === other.changeType
      && file.isUntracked === other.isUntracked
      && file.additions === other.additions
      && file.deletions === other.deletions
      && file.patchDigest === other.patchDigest
      && file.mimeType === other.mimeType
      && file.size === other.size
  })
}

function shouldPreserveExistingProjectDiffs(
  current: ChatDiffSnapshot | null | undefined,
  next: ChatDiffSnapshot | null | undefined
) {
  return Boolean(
    current
    && current.status !== "unknown"
    && next
    && next.status === "unknown"
    && next.files.length === 0
  )
}

function sameSchedules(left: ChatSnapshot["schedules"] | null | undefined, right: ChatSnapshot["schedules"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => {
    const l = left[key]
    const r = right[key]
    if (!l || !r) return false
    return l.state === r.state
      && l.scheduledAt === r.scheduledAt
      && l.resetAt === r.resetAt
      && l.detectedAt === r.detectedAt
      && l.tz === r.tz
  })
}

function sameTunnels(left: Record<string, CloudflareTunnelRecord> | null | undefined, right: Record<string, CloudflareTunnelRecord> | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => {
    const l = left[key]
    const r = right[key]
    if (!l || !r) return false
    return l.state === r.state
      && l.url === r.url
      && l.error === r.error
      && l.port === r.port
      && l.activatedAt === r.activatedAt
      && l.stoppedAt === r.stoppedAt
  })
}

export function sameChatSnapshotCore(left: ChatSnapshot | null, right: ChatSnapshot | null) {
  if (left === right) return true
  if (!left || !right) return false
  return sameRuntime(left.runtime, right.runtime)
    && sameQueuedMessages(left.queuedMessages, right.queuedMessages)
    && sameTranscriptEntries(left.messages, right.messages)
    && sameHistory(left.history, right.history)
    && sameProviders(left.availableProviders, right.availableProviders)
    && sameSchedules(left.schedules, right.schedules)
    && left.liveScheduleId === right.liveScheduleId
    && sameTunnels(left.tunnels, right.tunnels)
    && left.liveTunnelId === right.liveTunnelId
}

function mergeTranscriptEntries(olderHistoryEntries: TranscriptEntry[], recentEntries: TranscriptEntry[]) {
  const deduped = new Map<string, TranscriptEntry>()
  for (const entry of olderHistoryEntries) {
    deduped.set(entry._id, entry)
  }
  for (const entry of recentEntries) {
    deduped.set(entry._id, entry)
  }
  return [...deduped.values()]
}

export function getPreviousPrompt(messages: ReturnType<typeof processTranscriptMessages>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.kind === "user_prompt" && message.content.trim().length > 0) {
      return message.content
    }
  }
  return null
}

const NEW_CHAT_OPTIMISTIC_SCOPE = "__new_chat__"

export interface OptimisticUserPrompt {
  id: string
  scopeId: string
  signature: string
  requiredMatchCount: number
  entry: UserPromptEntry
}

interface OptimisticProcessingState {
  scopeId: string
  ackedAt: number | null
}

function serializeAttachmentSignature(attachment: ChatAttachment) {
  return JSON.stringify({
    id: attachment.id,
    kind: attachment.kind,
    displayName: attachment.displayName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    size: attachment.size,
    contentUrl: attachment.contentUrl,
  })
}

export function getUserPromptSignature(content: string, attachments: ChatAttachment[] = []) {
  return JSON.stringify({
    content,
    attachments: attachments.map(serializeAttachmentSignature),
  })
}

export function countMatchingUserPrompts(entries: TranscriptEntry[], signature: string) {
  return entries.reduce((count, entry) => {
    if (entry.kind !== "user_prompt") return count
    return count + (getUserPromptSignature(entry.content, entry.attachments ?? []) === signature ? 1 : 0)
  }, 0)
}

export function reconcileOptimisticUserPrompts(
  optimisticPrompts: OptimisticUserPrompt[],
  scopeId: string,
  serverEntries: TranscriptEntry[],
) {
  const matchCounts = new Map<string, number>()
  for (const entry of serverEntries) {
    if (entry.kind !== "user_prompt") continue
    const signature = getUserPromptSignature(entry.content, entry.attachments ?? [])
    matchCounts.set(signature, (matchCounts.get(signature) ?? 0) + 1)
  }

  return optimisticPrompts.filter((prompt) => {
    if (prompt.scopeId !== scopeId) return true
    return (matchCounts.get(prompt.signature) ?? 0) < prompt.requiredMatchCount
  })
}

const INITIAL_CHAT_RECENT_LIMIT = 200
const CHAT_HISTORY_PAGE_SIZE = 500

export function getNewestRemainingChatId(projectGroups: SidebarData["projectGroups"], activeChatId: string): string | null {
  const projectGroup = projectGroups.find((group) => group.chats.some((chat) => chat.chatId === activeChatId))
  if (!projectGroup) return null

  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId)?.chatId ?? null
}

export function applySidebarProjectOrder(
  projectGroups: SidebarData["projectGroups"],
  projectIds: string[] | null | undefined
) {
  if (!projectIds?.length || projectGroups.length <= 1) {
    return projectGroups
  }

  const indexByProjectId = new Map(projectGroups.map((group, index) => [group.groupKey, index]))
  const seen = new Set<string>()
  const orderedGroups = projectIds
    .map((projectId) => {
      if (seen.has(projectId)) {
        return null
      }
      seen.add(projectId)
      const index = indexByProjectId.get(projectId)
      return index === undefined ? null : projectGroups[index]
    })
    .filter((group): group is SidebarData["projectGroups"][number] => Boolean(group))

  if (orderedGroups.length === 0) {
    return projectGroups
  }

  const nextProjectGroups = [
    ...orderedGroups,
    ...projectGroups.filter((group) => !seen.has(group.groupKey)),
  ]

  return nextProjectGroups.every((group, index) => group === projectGroups[index])
    ? projectGroups
    : nextProjectGroups
}

export function shouldMarkActiveChatRead(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState === "visible" && doc.hasFocus()
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

function useKannaSocket() {
  const socketRef = useRef<KannaSocket | null>(null)
  if (!socketRef.current) {
    socketRef.current = new KannaSocket(wsUrl())
  }

  useEffect(() => {
    const socket = socketRef.current
    socket?.start()
    return () => {
      socket?.dispose()
    }
  }, [])

  return socketRef.current as KannaSocket
}

function logKannaState(message: string, details?: unknown) {
  void message
  void details
}

const SEND_TO_STARTING_PROFILE_STORAGE_KEY = "kanna:profile-send-to-starting"

interface SendToStartingTrace {
  traceId: string
  optimisticId: string
  startedAt: number
  serverChatId: string | null
  routeChatIdAtSend: string | null
  contentPreview: string
  ackAt?: number
  snapshotAt?: number
  startingStatusAt?: number
  startingRenderedAt?: number
}

function isSendToStartingProfilingEnabled() {
  try {
    return window.sessionStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
      || window.localStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function elapsedTraceMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

function logSendToStartingTrace(
  trace: SendToStartingTrace | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!trace || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.debug("[kanna/send->starting][client]", {
    traceId: trace.traceId,
    stage,
    elapsedMs: elapsedTraceMs(trace.startedAt),
    serverChatId: trace.serverChatId,
    routeChatIdAtSend: trace.routeChatIdAtSend,
    ...details,
  })
}

function composerStateFromSendOptions(options?: {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
}): ComposerState | null {
  if (options?.provider === "claude" && options.model && options.modelOptions?.claude) {
    return {
      provider: "claude",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.claude.reasoningEffort ?? "high",
        contextWindow: options.modelOptions.claude.contextWindow ?? "200k",
      },
      planMode: Boolean(options.planMode),
    }
  }

  if (options?.provider === "codex" && options.model && options.modelOptions?.codex) {
    return {
      provider: "codex",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.codex.reasoningEffort ?? "high",
        fastMode: options.modelOptions.codex.fastMode ?? false,
      },
      planMode: Boolean(options.planMode),
    }
  }

  return null
}

function getProjectIdForChat(projectGroups: SidebarData["projectGroups"], chatId: string | null) {
  if (!chatId) return null
  return projectGroups.find((group) => group.chats.some((chat) => chat.chatId === chatId))?.groupKey ?? null
}

export function shouldAutoFollowTranscript(distanceFromBottom: number) {
  return distanceFromBottom < 24
}

export function getUiUpdateRestartReconnectAction(
  phase: string | null,
  connectionStatus: SocketStatus
): "none" | "awaiting_server_ready" {
  if (phase === "awaiting_disconnect" && connectionStatus === "disconnected") {
    return "awaiting_server_ready"
  }

  return "none"
}

export const TRANSCRIPT_PADDING_BOTTOM_OFFSET = 30
const UI_UPDATE_RESTART_STORAGE_KEY = "kanna:ui-update-restart"
const UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY = "kanna:last-update-reload-request"

export function getTranscriptPaddingBottom(inputHeight: number) {
  return inputHeight + TRANSCRIPT_PADDING_BOTTOM_OFFSET
}

export function getNextMeasuredInputHeight(previousHeight: number, measuredHeight: number) {
  return measuredHeight > 0 ? measuredHeight : previousHeight
}

function getUiUpdateRestartPhase() {
  return window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function setUiUpdateRestartPhase(phase: "awaiting_disconnect" | "awaiting_server_ready") {
  window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, phase)
}

function clearUiUpdateRestartPhase() {
  window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

export function shouldHandleUiUpdateReloadRequest(
  reloadRequestedAt: number | null | undefined,
  lastHandledReloadRequest: string | null
) {
  if (!reloadRequestedAt) return false
  return String(reloadRequestedAt) !== lastHandledReloadRequest
}

function getLastHandledUiUpdateReloadRequest() {
  return window.sessionStorage.getItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY)
}

function setLastHandledUiUpdateReloadRequest(reloadRequestedAt: number) {
  window.sessionStorage.setItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY, String(reloadRequestedAt))
}

export function getUiUpdateReadinessPath() {
  return "/auth/status"
}

async function isServerReady(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(getUiUpdateReadinessPath(), {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  })

  return response.ok
}

export interface ProjectRequest {
  mode: "new" | "existing"
  localPath: string
  title: string
}

export type StartChatIntent =
  | { kind: "project_id"; projectId: string }
  | { kind: "local_path"; localPath: string }
  | { kind: "project_request"; project: ProjectRequest }

export function resolveComposeIntent(params: {
  selectedProjectId: string | null
  sidebarProjectId?: string | null
  fallbackLocalProjectPath?: string | null
}): StartChatIntent | null {
  const projectId = params.selectedProjectId ?? params.sidebarProjectId ?? null
  if (projectId) {
    return { kind: "project_id", projectId }
  }

  if (params.fallbackLocalProjectPath) {
    return { kind: "local_path", localPath: params.fallbackLocalProjectPath }
  }

  return null
}

export function getActiveChatSnapshot(chatSnapshot: ChatSnapshot | null, activeChatId: string | null): ChatSnapshot | null {
  if (!chatSnapshot) return null
  if (!activeChatId) return null
  if (chatSnapshot.runtime.chatId !== activeChatId) {
    logKannaState("stale snapshot masked", {
      routeChatId: activeChatId,
      snapshotChatId: chatSnapshot.runtime.chatId,
      snapshotProvider: chatSnapshot.runtime.provider,
    })
    return null
  }
  return chatSnapshot
}

export interface KannaState {
  socket: KannaSocket
  activeChatId: string | null
  activeProjectId: string | null
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  updateSnapshot: UpdateSnapshot | null
  chatSnapshot: ChatSnapshot | null
  chatDiffSnapshot: ChatDiffSnapshot | null
  keybindings: KeybindingsSnapshot | null
  appSettings: AppSettingsSnapshot | null
  llmProvider: LlmProviderSnapshot | null
  connectionStatus: SocketStatus
  sidebarReady: boolean
  localProjectsReady: boolean
  commandError: string | null
  startingLocalPath: string | null
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  messages: ReturnType<typeof processTranscriptMessages>
  queuedMessages: QueuedChatMessage[]
  previousPrompt: string | null
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  runtimeStatus: string | null
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  availableProviders: ProviderCatalogEntry[]
  isProcessing: boolean
  canCancel: boolean
  isDraining: boolean
  navbarLocalPath?: string
  editorLabel: string
  hasSelectedProject: boolean
  addProjectModalOpen: boolean
  openSidebar: () => void
  closeSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  openAddProjectModal: () => void
  closeAddProjectModal: () => void
  loadOlderHistory: () => Promise<void>
  handleCreateChat: (projectId: string) => Promise<void>
  handleForkChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleCheckForUpdates: (options?: { force?: boolean }) => Promise<void>
  handleInstallUpdate: () => Promise<void>
  handleForceReload: () => Promise<void>
  handleReadAppSettings: () => Promise<void>
  handleWriteAppSettings: (value: Pick<AppSettingsSnapshot, "analyticsEnabled">) => Promise<void>
  handleWriteCloudflareTunnel: (patch: Partial<CloudflareTunnelSettings>) => Promise<void>
  handleReadLlmProvider: () => Promise<void>
  handleWriteLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<void>
  handleValidateLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  handleSignOut: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }) => Promise<void>
  handleSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleCancel: () => Promise<void>
  handleStopDraining: () => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleRemoveProject: (projectId: string) => Promise<void>
  handleReorderProjectGroups: (projectIds: string[]) => Promise<void>
  importClaudeSessions: () => Promise<{ imported: number; updated: number; skipped: number; failed: number; newProjects: number }>
  handleCopyPath: (localPath: string) => Promise<void>
  handleOpenExternal: (action: "open_finder" | "open_terminal" | "open_editor") => Promise<void>
  handleOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => Promise<void>
  handleOpenLocalLink: (target: { path: string; line?: number; column?: number }) => Promise<void>
  handleCompose: () => void
  handleAskUserQuestion: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => Promise<void>
  handleExitPlanMode: (
    toolUseId: string,
    confirmed: boolean,
    clearContext?: boolean,
    message?: string
  ) => Promise<void>
}

export function useKannaState(activeChatId: string | null): KannaState {
  const navigate = useNavigate()
  const socket = useKannaSocket()
  const dialog = useAppDialog()

  const [sidebarData, setSidebarData] = useState<SidebarData>({ projectGroups: [] })
  const [optimisticSidebarProjectOrder, setOptimisticSidebarProjectOrder] = useState<string[] | null>(null)
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null)
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  const [olderHistoryEntries, setOlderHistoryEntries] = useState<TranscriptEntry[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [projectDiffSnapshots, setProjectDiffSnapshots] = useState<Record<string, ChatDiffSnapshot | null>>({})
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettingsSnapshot | null>(null)
  const [llmProvider, setLlmProvider] = useState<LlmProviderSnapshot | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [sidebarReady, setSidebarReady] = useState(false)
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [addProjectModalOpen, setAddProjectModalOpen] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  const [optimisticUserPrompts, setOptimisticUserPrompts] = useState<OptimisticUserPrompt[]>([])
  const [optimisticProcessing, setOptimisticProcessing] = useState<OptimisticProcessingState | null>(null)
  const [focusEpoch, setFocusEpoch] = useState(0)
  const sendToStartingProfilesRef = useRef<Map<string, SendToStartingTrace>>(new Map())
  const draftChatIds = useChatInputStore(useShallow((state) => Object.keys(state.drafts).sort()))
  const attachmentDraftChatIds = useChatInputStore(
    useShallow((state) => Object.keys(state.attachmentDrafts).sort())
  )
  const chatSubscriptionDebugRef = useRef(0)
  const lastStartingRenderedTraceIdRef = useRef<string | null>(null)
  const lastActiveProjectDiffRef = useRef<{ projectId: string | null; diffs: ChatDiffSnapshot | null }>({
    projectId: null,
    diffs: null,
  })
  const editorLabel = getEditorPresetLabel(useTerminalPreferencesStore((store) => store.editorPreset))
  const sidebarProjectGroups = useMemo(
    () => applySidebarProjectOrder(sidebarData.projectGroups, optimisticSidebarProjectOrder),
    [optimisticSidebarProjectOrder, sidebarData.projectGroups]
  )
  const resolvedSidebarData = useMemo(
    () => (
      sidebarProjectGroups === sidebarData.projectGroups
        ? sidebarData
        : {
            ...sidebarData,
            projectGroups: sidebarProjectGroups,
          }
    ),
    [sidebarData, sidebarProjectGroups]
  )

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  useEffect(() => {
    return socket.subscribe<SidebarData>({ type: "sidebar" }, (snapshot) => {
      setSidebarData(snapshot)
      setOptimisticSidebarProjectOrder((current) => (
        current && applySidebarProjectOrder(snapshot.projectGroups, current) === snapshot.projectGroups
          ? null
          : current
      ))
      setSidebarReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return

    const protectedChatIds = [...new Set([...draftChatIds, ...attachmentDraftChatIds])].sort()
    void socket.command({ type: "chat.setDraftProtection", chatIds: protectedChatIds }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [attachmentDraftChatIds, connectionStatus, draftChatIds, socket])

  useEffect(() => {
    return socket.subscribe<LocalProjectsSnapshot>({ type: "local-projects" }, (snapshot) => {
      setLocalProjects(snapshot)
      setLocalProjectsReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<UpdateSnapshot>({ type: "update" }, (snapshot) => {
      setUpdateSnapshot(snapshot)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void socket.command<UpdateSnapshot>({ type: "update.check", force: true }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [connectionStatus, socket])

  useEffect(() => {
    const reloadRequestedAt = updateSnapshot?.reloadRequestedAt
    if (!shouldHandleUiUpdateReloadRequest(reloadRequestedAt, getLastHandledUiUpdateReloadRequest())) {
      return
    }
    if (!reloadRequestedAt) {
      return
    }

    setLastHandledUiUpdateReloadRequest(reloadRequestedAt)
    setUiUpdateRestartPhase("awaiting_disconnect")
  }, [updateSnapshot?.reloadRequestedAt])

  useEffect(() => {
    const phase = getUiUpdateRestartPhase()
    const reconnectAction = getUiUpdateRestartReconnectAction(phase, connectionStatus)
    if (reconnectAction === "awaiting_server_ready") {
      setUiUpdateRestartPhase("awaiting_server_ready")
      return
    }
  }, [connectionStatus])

  useEffect(() => {
    if (getUiUpdateRestartPhase() !== "awaiting_server_ready") {
      return
    }

    let cancelled = false
    let timeoutId: number | null = null

    const pollServerReadiness = async () => {
      try {
        if (await isServerReady()) {
          if (cancelled) return
          clearUiUpdateRestartPhase()
          window.location.reload()
          return
        }
      } catch {
        // Keep polling while the process restarts.
      }

      if (cancelled) return
      timeoutId = window.setTimeout(() => {
        void pollServerReadiness()
      }, 500)
    }

    void pollServerReadiness()

    return () => {
      cancelled = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [connectionStatus])

  useEffect(() => {
    function handleWindowFocus() {
      if (!updateSnapshot?.lastCheckedAt) return
      if (Date.now() - updateSnapshot.lastCheckedAt <= 60 * 60 * 1000) return
      void socket.command<UpdateSnapshot>({ type: "update.check" }).catch((error) => {
        setCommandError(error instanceof Error ? error.message : String(error))
      })
    }

    window.addEventListener("focus", handleWindowFocus)
    return () => {
      window.removeEventListener("focus", handleWindowFocus)
    }
  }, [socket, updateSnapshot?.lastCheckedAt])

  useEffect(() => {
    return socket.subscribe<KeybindingsSnapshot>({ type: "keybindings" }, (snapshot) => {
      setKeybindings(snapshot)
      setCommandError(null)
    })
  }, [socket])

  const handleReadAppSettings = useCallback(async () => {
    try {
      const snapshot = await socket.command<AppSettingsSnapshot>({ type: "settings.readAppSettings" })
      setAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleWriteAppSettings = useCallback(async (
    value: Pick<AppSettingsSnapshot, "analyticsEnabled">
  ) => {
    try {
      const snapshot = await socket.command<AppSettingsSnapshot>({
        type: "settings.writeAppSettings",
        analyticsEnabled: value.analyticsEnabled,
      })
      setAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [socket])

  const handleWriteCloudflareTunnel = useCallback(async (patch: Partial<CloudflareTunnelSettings>) => {
    try {
      const snapshot = await socket.command<AppSettingsSnapshot>({
        type: "appSettings.setCloudflareTunnel",
        patch,
      })
      setAppSettings(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [socket])

  const handleReadLlmProvider = useCallback(async () => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({ type: "settings.readLlmProvider" })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleWriteLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    try {
      const snapshot = await socket.command<LlmProviderSnapshot>({
        type: "settings.writeLlmProvider",
        provider: value.provider,
        apiKey: value.apiKey,
        model: value.model,
        baseUrl: value.baseUrl,
      })
      setLlmProvider(snapshot)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [socket])

  const handleValidateLlmProvider = useCallback(async (
    value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
  ) => {
    return await socket.command<LlmProviderValidationResult>({
      type: "settings.validateLlmProvider",
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      baseUrl: value.baseUrl,
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadAppSettings()
  }, [connectionStatus, handleReadAppSettings])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void handleReadLlmProvider()
  }, [connectionStatus, handleReadLlmProvider])

  useEffect(() => {
    function handleFocusSignal() {
      setFocusEpoch((value) => value + 1)
    }

    window.addEventListener("focus", handleFocusSignal)
    document.addEventListener("visibilitychange", handleFocusSignal)

    return () => {
      window.removeEventListener("focus", handleFocusSignal)
      document.removeEventListener("visibilitychange", handleFocusSignal)
    }
  }, [])

  useEffect(() => {
    if (!activeChatId) {
      logKannaState("clearing chat snapshot for non-chat route")
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    const subscriptionId = ++chatSubscriptionDebugRef.current
    logKannaState("subscribing to chat", {
      subscriptionId,
      activeChatId,
      sidebarProjectGroups: sidebarProjectGroups.length,
      sidebarChatCount: sidebarProjectGroups.reduce((count, group) => count + group.chats.length, 0),
    })
    setChatSnapshot(null)
    setChatReady(false)
    const unsubscribe = socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId: activeChatId, recentLimit: INITIAL_CHAT_RECENT_LIMIT }, (snapshot) => {
      if (snapshot?.runtime.chatId) {
        const matchingTrace = [...sendToStartingProfilesRef.current.values()]
          .filter((trace) => trace.serverChatId === snapshot.runtime.chatId)
          .sort((left, right) => right.startedAt - left.startedAt)[0]
        if (matchingTrace && matchingTrace.snapshotAt === undefined) {
          matchingTrace.snapshotAt = performance.now()
          logSendToStartingTrace(matchingTrace, "chat_snapshot_received", {
            status: snapshot.runtime.status,
            messageCount: snapshot.messages.length,
          })
        }
      }
      setChatSnapshot((current) => {
        const reused = sameChatSnapshotCore(current, snapshot)
        logKannaState("chat snapshot received", {
          subscriptionId,
          activeChatId,
          snapshotChatId: snapshot?.runtime.chatId ?? null,
          snapshotProvider: snapshot?.runtime.provider ?? null,
          snapshotStatus: snapshot?.runtime.status ?? null,
          messageCount: snapshot?.messages.length ?? 0,
          diffStatus: null,
          diffFileCount: 0,
          reusedSnapshot: reused,
        })
        return reused ? current : snapshot
      })
      setHistoryCursor(snapshot?.history.olderCursor ?? null)
      setHasOlderHistory(snapshot?.history.hasOlder ?? false)
      setChatReady(true)
      setCommandError(null)
      if (snapshot) {
        const store = useSlashCommandsStore.getState()
        store.setForChat(snapshot.runtime.chatId, snapshot.slashCommands ?? [])
        store.setLoadingForChat(
          snapshot.runtime.chatId,
          snapshot.slashCommandsLoading ?? false,
        )
      }
    })
    return () => {
      logKannaState("unsubscribing from chat", {
        subscriptionId,
        activeChatId,
        sidebarProjectGroups: sidebarProjectGroups.length,
        sidebarChatCount: sidebarProjectGroups.reduce((count, group) => count + group.chats.length, 0),
      })
      unsubscribe()
    }
  }, [activeChatId, socket])

  useEffect(() => {
    if (selectedProjectId) return
    const firstGroup = sidebarProjectGroups[0]
    if (firstGroup) {
      setSelectedProjectId(firstGroup.groupKey)
    }
  }, [selectedProjectId, sidebarProjectGroups])

  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    const exists = sidebarProjectGroups.some((group) => group.chats.some((chat) => chat.chatId === activeChatId))
    if (exists) {
      if (pendingChatId === activeChatId) {
        setPendingChatId(null)
      }
      return
    }
    if (pendingChatId === activeChatId) {
      return
    }
    navigate("/")
  }, [activeChatId, chatReady, navigate, pendingChatId, sidebarProjectGroups, sidebarReady])

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
    if (pendingChatId === chatSnapshot.runtime.chatId) {
      setPendingChatId(null)
    }
  }, [chatSnapshot, pendingChatId])

  useEffect(() => {
    if (!activeChatId || !sidebarReady) return
    if (!shouldMarkActiveChatRead()) return
    const activeSidebarChat = sidebarProjectGroups
      .flatMap((group) => group.chats)
      .find((chat) => chat.chatId === activeChatId)
    if (!activeSidebarChat?.unread) return
    void socket.command({ type: "chat.markRead", chatId: activeChatId }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [activeChatId, focusEpoch, sidebarProjectGroups, sidebarReady, socket])

  useEffect(() => {
    setOlderHistoryEntries([])
    setIsHistoryLoading(false)
    setHistoryCursor(null)
    setHasOlderHistory(false)
  }, [activeChatId])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )
  const activeProjectId = useMemo(
    () => activeChatSnapshot?.runtime.projectId
      ?? getProjectIdForChat(sidebarProjectGroups, activeChatId)
      ?? selectedProjectId,
    [activeChatId, activeChatSnapshot?.runtime.projectId, selectedProjectId, sidebarProjectGroups]
  )
  const chatDiffSnapshot = useMemo(() => {
    const currentDiffs = activeProjectId ? (projectDiffSnapshots[activeProjectId] ?? null) : null
    if (activeProjectId && currentDiffs) {
      lastActiveProjectDiffRef.current = {
        projectId: activeProjectId,
        diffs: currentDiffs,
      }
      return currentDiffs
    }

    if (activeProjectId && lastActiveProjectDiffRef.current.projectId === activeProjectId) {
      return lastActiveProjectDiffRef.current.diffs
    }

    return currentDiffs
  }, [activeProjectId, projectDiffSnapshots])

  useEffect(() => {
    if (!activeProjectId) {
      return
    }

    const unsubscribe = socket.subscribe<ChatDiffSnapshot | null>({ type: "project-git", projectId: activeProjectId }, (snapshot) => {
      setProjectDiffSnapshots((current) => {
        const nextDiffs = snapshot ?? null
        if (shouldPreserveExistingProjectDiffs(current[activeProjectId] ?? null, nextDiffs)) {
          return current
        }
        if (sameDiffs(current[activeProjectId] ?? null, nextDiffs)) {
          return current
        }
        return {
          ...current,
          [activeProjectId]: nextDiffs,
        }
      })
      setCommandError(null)
    })

    return unsubscribe
  }, [activeProjectId, socket])
  useEffect(() => {
    logKannaState("active snapshot resolved", {
      routeChatId: activeChatId,
      rawSnapshotChatId: chatSnapshot?.runtime.chatId ?? null,
      rawSnapshotProvider: chatSnapshot?.runtime.provider ?? null,
      activeSnapshotChatId: activeChatSnapshot?.runtime.chatId ?? null,
      activeSnapshotProvider: activeChatSnapshot?.runtime.provider ?? null,
      pendingChatId,
    })
  }, [activeChatId, activeChatSnapshot, chatSnapshot, pendingChatId])
  const serverTranscriptEntries = useMemo(
    () => mergeTranscriptEntries(olderHistoryEntries, activeChatSnapshot?.messages ?? []),
    [activeChatSnapshot?.messages, olderHistoryEntries]
  )
  const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
  const optimisticTranscriptEntries = useMemo(
    () => optimisticUserPrompts
      .filter((prompt) => prompt.scopeId === optimisticScopeId)
      .map((prompt) => prompt.entry),
    [optimisticScopeId, optimisticUserPrompts]
  )
  const transcriptEntries = useMemo(
    () => [...serverTranscriptEntries, ...optimisticTranscriptEntries],
    [optimisticTranscriptEntries, serverTranscriptEntries]
  )
  const messages = useMemo(() => processTranscriptMessages(transcriptEntries), [transcriptEntries])
  const previousPrompt = useMemo(() => getPreviousPrompt(messages), [messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const runtime = activeChatSnapshot?.runtime ?? null
  const queuedMessages = activeChatSnapshot?.queuedMessages ?? []
  const optimisticRuntimeStatus = optimisticProcessing?.scopeId === optimisticScopeId && (!runtime || runtime.status === "idle")
    ? "starting"
    : null
  const effectiveRuntimeStatus = optimisticRuntimeStatus ?? runtime?.status ?? null
  const availableProviders = activeChatSnapshot?.availableProviders ?? PROVIDERS
  const isProcessing = isProcessingStatus(effectiveRuntimeStatus ?? undefined)
  const canCancel = canCancelStatus(effectiveRuntimeStatus ?? undefined)
  const isDraining = runtime?.isDraining ?? false
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const navbarLocalPath =
    runtime?.localPath
    ?? fallbackLocalProjectPath
    ?? sidebarProjectGroups[0]?.localPath
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? sidebarProjectGroups[0]?.groupKey
    ?? fallbackLocalProjectPath
  )

  useEffect(() => {
    if (optimisticProcessing?.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      setOptimisticProcessing(null)
    }
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!optimisticProcessing?.ackedAt || optimisticProcessing.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && runtime.status !== "idle") {
      return
    }
    const timeoutId = window.setTimeout(() => {
      setOptimisticProcessing((current) => (
        current?.scopeId === optimisticScopeId && current.ackedAt === optimisticProcessing.ackedAt
          ? null
          : current
      ))
    }, 300)
    return () => window.clearTimeout(timeoutId)
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    if (!activeChatId || runtime?.status !== "starting") {
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace || matchingTrace.startingStatusAt !== undefined) {
      return
    }

    matchingTrace.startingStatusAt = performance.now()
    logSendToStartingTrace(matchingTrace, "runtime_status_starting", {
      status: runtime.status,
    })
  }, [activeChatId, runtime?.status])

  useEffect(() => {
    if (!activeChatId || !runtime || runtime.status === "starting") {
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace || matchingTrace.startingRenderedAt !== undefined) {
      return
    }

    logSendToStartingTrace(matchingTrace, "starting_not_observed", {
      status: runtime.status,
    })
    sendToStartingProfilesRef.current.delete(matchingTrace.traceId)
  }, [activeChatId, runtime])

  useLayoutEffect(() => {
    if (!activeChatId || runtime?.status !== "starting") {
      lastStartingRenderedTraceIdRef.current = null
      return
    }

    const matchingTrace = [...sendToStartingProfilesRef.current.values()]
      .filter((trace) => trace.serverChatId === activeChatId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    if (!matchingTrace) {
      return
    }

    if (lastStartingRenderedTraceIdRef.current === matchingTrace.traceId) {
      return
    }

    lastStartingRenderedTraceIdRef.current = matchingTrace.traceId
    matchingTrace.startingRenderedAt = performance.now()
    logSendToStartingTrace(matchingTrace, "starting_render_committed", {
      totalMs: elapsedTraceMs(matchingTrace.startedAt),
    })
    sendToStartingProfilesRef.current.delete(matchingTrace.traceId)
  }, [activeChatId, runtime?.status])

  useEffect(() => {
    setOptimisticUserPrompts((current) => {
      const reconciled = reconcileOptimisticUserPrompts(current, optimisticScopeId, serverTranscriptEntries)
      if (reconciled.length === current.length && reconciled.every((prompt, index) => prompt === current[index])) {
        return current
      }
      return reconciled
    })
  }, [optimisticScopeId, serverTranscriptEntries])

  const loadOlderHistory = useCallback(async () => {
    if (!activeChatId || !historyCursor || isHistoryLoading || !hasOlderHistory) {
      return
    }

    setIsHistoryLoading(true)
    try {
      const page = await socket.command<ChatHistoryPage>({
        type: "chat.loadHistory",
        chatId: activeChatId,
        beforeCursor: historyCursor,
        limit: CHAT_HISTORY_PAGE_SIZE,
      })
      setOlderHistoryEntries((current) => mergeTranscriptEntries(page.messages, current))
      setHistoryCursor(page.olderCursor)
      setHasOlderHistory(page.hasOlder)
      setCommandError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setCommandError(message)
    } finally {
      setIsHistoryLoading(false)
    }
  }, [activeChatId, hasOlderHistory, historyCursor, isHistoryLoading, socket])

  const createChatForProject = useCallback(async (projectId: string) => {
    const chatPreferences = useChatPreferencesStore.getState()
    const sourceComposerState = activeChatId
      ? chatPreferences.getComposerState(activeChatId)
      : chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
    const result = await socket.command<{ chatId: string }>({ type: "chat.create", projectId })
    chatPreferences.initializeComposerForChat(result.chatId, { sourceState: sourceComposerState })
    setSelectedProjectId(projectId)
    setPendingChatId(result.chatId)
    navigate(`/chat/${result.chatId}`)
    setSidebarOpen(false)
    setCommandError(null)
  }, [activeChatId, navigate, socket])

  const resolveProjectIdForStartChat = useCallback(async (intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> => {
    if (intent.kind === "project_id") {
      return { projectId: intent.projectId }
    }

    if (intent.kind === "local_path") {
      const result = await socket.command<{ projectId: string }>({ type: "project.open", localPath: intent.localPath })
      return { projectId: result.projectId, localPath: intent.localPath }
    }

    const result = await socket.command<{ projectId: string }>(
      intent.project.mode === "new"
        ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
        : { type: "project.open", localPath: intent.project.localPath }
    )
    return { projectId: result.projectId, localPath: intent.project.localPath }
  }, [socket])

  const startChatFromIntent = useCallback(async (intent: StartChatIntent) => {
    try {
      const localPath = intent.kind === "project_id"
        ? null
        : intent.kind === "local_path"
          ? intent.localPath
          : intent.project.localPath
      if (localPath) {
        setStartingLocalPath(localPath)
      }

      const { projectId } = await resolveProjectIdForStartChat(intent)
      await createChatForProject(projectId)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingLocalPath(null)
    }
  }, [createChatForProject, resolveProjectIdForStartChat])

  const handleCreateChat = useCallback(async (projectId: string) => {
    await startChatFromIntent({ kind: "project_id", projectId })
  }, [startChatFromIntent])

  const handleForkChat = useCallback(async (chat: SidebarChatRow) => {
    try {
      const result = await socket.command<{ chatId: string }>({
        type: "chat.fork",
        chatId: chat.chatId,
      })
      const chatPreferences = useChatPreferencesStore.getState()
      chatPreferences.initializeComposerForChat(result.chatId, {
        sourceState: chatPreferences.getComposerState(chat.chatId),
      })
      setPendingChatId(result.chatId)
      navigate(`/chat/${result.chatId}`)
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, socket])

  const handleOpenLocalProject = useCallback(async (localPath: string) => {
    await startChatFromIntent({ kind: "local_path", localPath })
  }, [startChatFromIntent])

  const handleCreateProject = useCallback(async (project: ProjectRequest) => {
    await startChatFromIntent({ kind: "project_request", project })
  }, [startChatFromIntent])

  const handleCheckForUpdates = useCallback(async (options?: { force?: boolean }) => {
    try {
      await socket.command<UpdateSnapshot>({ type: "update.check", force: options?.force })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleInstallUpdate = useCallback(async () => {
    try {
      const result = await socket.command<UpdateInstallResult>({ type: "update.install" })
      if (!result.ok) {
        clearUiUpdateRestartPhase()
        setCommandError(null)
        await dialog.alert({
          title: result.userTitle ?? "Update failed",
          description: result.userMessage ?? "Kanna could not install the update. Try again later.",
          closeLabel: "OK",
        })
        return
      }

      if (result.ok && result.action === "reload") {
        window.location.reload()
        return
      }

      if (result.ok && result.action === "restart") {
        setUiUpdateRestartPhase("awaiting_disconnect")
      }
      setCommandError(null)
    } catch (error) {
      clearUiUpdateRestartPhase()
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleForceReload = useCallback(async () => {
    try {
      const result = await socket.command<UpdateInstallResult>({ type: "update.reload" })
      if (!result.ok) {
        clearUiUpdateRestartPhase()
        setCommandError(null)
        await dialog.alert({
          title: result.userTitle ?? "Re-deploy failed",
          description: result.userMessage ?? "Kanna could not re-deploy. Try again later.",
          closeLabel: "OK",
        })
        return
      }

      if (result.action === "reload") {
        window.location.reload()
        return
      }

      setUiUpdateRestartPhase("awaiting_disconnect")
      setCommandError(null)
    } catch (error) {
      clearUiUpdateRestartPhase()
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, socket])

  const handleSignOut = useCallback(async () => {
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        throw new Error(`Sign out failed with status ${response.status}`)
      }

      setCommandError(null)
      window.location.reload()
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const handleSend = useCallback(async (
    content: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; attachments?: import("../../shared/types").ChatAttachment[] }
  ) => {
    const attachments = options?.attachments ?? []
    if (activeChatId && isProcessing) {
      try {
        const autoResumeOnRateLimit = usePreferencesStore.getState().autoResumeOnRateLimit
        await socket.command<{ queuedMessageId: string }>({
          type: "message.enqueue",
          chatId: activeChatId,
          content,
          attachments,
          provider: options?.provider,
          model: options?.model,
          modelOptions: options?.modelOptions,
          planMode: options?.planMode,
          autoResumeOnRateLimit,
        })
        setCommandError(null)
        return
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    const optimisticId = generateUUID()
    const clientTraceId = generateUUID()
    const signature = getUserPromptSignature(content, attachments)
    const optimisticScopeId = activeChatId ?? NEW_CHAT_OPTIMISTIC_SCOPE
    setOptimisticProcessing({
      scopeId: optimisticScopeId,
      ackedAt: null,
    })
    const sendTrace: SendToStartingTrace = {
      traceId: clientTraceId,
      optimisticId,
      startedAt: performance.now(),
      serverChatId: activeChatId,
      routeChatIdAtSend: activeChatId,
      contentPreview: content.slice(0, 80),
    }
    sendToStartingProfilesRef.current.set(clientTraceId, sendTrace)
    logSendToStartingTrace(sendTrace, "handle_send_called", {
      optimisticScopeId,
      attachments: attachments.length,
      contentLength: content.length,
      contentPreview: sendTrace.contentPreview,
    })
    const requiredMatchCount = countMatchingUserPrompts(serverTranscriptEntries, signature)
      + optimisticUserPrompts.filter((prompt) => prompt.scopeId === optimisticScopeId && prompt.signature === signature).length
      + 1

    setOptimisticUserPrompts((current) => [...current, {
      id: optimisticId,
      scopeId: optimisticScopeId,
      signature,
      requiredMatchCount,
      entry: {
        _id: `optimistic:${optimisticId}`,
        kind: "user_prompt",
        content,
        attachments,
        createdAt: Date.now(),
      },
    }])
    logSendToStartingTrace(sendTrace, "optimistic_prompt_added", {
      optimisticId,
      optimisticScopeId,
    })

    try {
      let projectId = selectedProjectId ?? sidebarProjectGroups[0]?.groupKey ?? null
      if (!activeChatId && !projectId && fallbackLocalProjectPath) {
        const project = await socket.command<{ projectId: string }>({
          type: "project.open",
          localPath: fallbackLocalProjectPath,
        })
        projectId = project.projectId
        setSelectedProjectId(projectId)
      }

      if (!activeChatId && !projectId) {
        throw new Error("Open a project first")
      }

      const autoResumeOnRateLimit = usePreferencesStore.getState().autoResumeOnRateLimit
      const result = await socket.command<{ chatId?: string }>({
        type: "chat.send",
        chatId: activeChatId ?? undefined,
        projectId: activeChatId ? undefined : projectId ?? undefined,
        clientTraceId,
        provider: options?.provider,
        content,
        attachments,
        model: options?.model,
        modelOptions: options?.modelOptions,
        planMode: options?.planMode,
        autoResumeOnRateLimit,
      })
      sendTrace.ackAt = performance.now()
      sendTrace.serverChatId = result.chatId ?? sendTrace.serverChatId
      setOptimisticProcessing((current) => {
        if (!current) return current
        const nextScopeId = !activeChatId && result.chatId ? result.chatId : current.scopeId
        return {
          scopeId: nextScopeId,
          ackedAt: performance.now(),
        }
      })
      logSendToStartingTrace(sendTrace, "chat_send_ack_received", {
        resultChatId: result.chatId ?? null,
      })

      if (!activeChatId && result.chatId) {
        setOptimisticUserPrompts((current) => current.map((prompt) => (
          prompt.id === optimisticId ? { ...prompt, scopeId: result.chatId! } : prompt
        )))
        const chatPreferences = useChatPreferencesStore.getState()
        chatPreferences.setComposerState(
          result.chatId,
          composerStateFromSendOptions(options) ?? chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
        )
        setPendingChatId(result.chatId)
        navigate(`/chat/${result.chatId}`)
      }
      setCommandError(null)
    } catch (error) {
      setOptimisticUserPrompts((current) => current.filter((prompt) => prompt.id !== optimisticId))
      setOptimisticProcessing(null)
      logSendToStartingTrace(sendTrace, "handle_send_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      sendToStartingProfilesRef.current.delete(clientTraceId)
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [activeChatId, fallbackLocalProjectPath, isProcessing, navigate, optimisticUserPrompts, selectedProjectId, serverTranscriptEntries, sidebarProjectGroups, socket])

  const handleSteerQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "message.steer",
        chatId: activeChatId,
        queuedMessageId,
      })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleRemoveQueuedMessage = useCallback(async (queuedMessageId: string) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "message.dequeue",
        chatId: activeChatId,
        queuedMessageId,
      })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleCancel = useCallback(async () => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.cancel", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleStopDraining = useCallback(async () => {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.stopDraining", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleDeleteChat = useCallback(async (chat: SidebarChatRow) => {
    const confirmed = await dialog.confirm({
      title: "Delete Chat",
      description: `Delete "${chat.title}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive",
    })
    if (!confirmed) return
    try {
      await socket.command({ type: "chat.delete", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarProjectGroups, chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, dialog, navigate, sidebarProjectGroups, socket])

  const handleRemoveProject = useCallback(async (projectId: string) => {
    const project = sidebarProjectGroups.find((group) => group.groupKey === projectId)
    if (!project) return
    const projectName = project.localPath.split("/").filter(Boolean).pop() ?? project.localPath
    const confirmed = await dialog.confirm({
      title: "Remove",
      description: `Remove "${projectName}" from the sidebar? Existing chats will be removed from ${APP_NAME}.`,
      confirmLabel: "Remove",
      confirmVariant: "destructive",
    })
    if (!confirmed) return

    try {
      await socket.command({ type: "project.remove", projectId })
      useTerminalLayoutStore.getState().clearProject(projectId)
      useRightSidebarStore.getState().clearProject(projectId)
      if (runtime?.projectId === projectId) {
        navigate("/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, navigate, runtime?.projectId, sidebarProjectGroups, socket])

  const handleReorderProjectGroups = useCallback(async (projectIds: string[]) => {
    setOptimisticSidebarProjectOrder(projectIds)
    try {
      await socket.command({ type: "sidebar.reorderProjectGroups", projectIds })
      setCommandError(null)
    } catch (error) {
      setOptimisticSidebarProjectOrder(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const importClaudeSessions = useCallback(async () => {
    const result = await socket.command<{ imported: number; updated: number; skipped: number; failed: number; newProjects: number }>({ type: "sessions.importClaude" })
    return result
  }, [socket])

  const openExternal = useCallback(async (command: {
    action: "open_finder" | "open_terminal" | "open_editor"
    localPath: string
    line?: number
    column?: number
  }) => {
    const preferences = useTerminalPreferencesStore.getState()
    setCommandError(null)
    await socket.command({
      type: "system.openExternal",
      ...command,
      editor: command.action === "open_editor"
        ? {
            preset: preferences.editorPreset,
            commandTemplate: preferences.editorCommandTemplate,
          }
        : undefined,
    })
  }, [socket])

  const handleOpenExternal = useCallback(async (action: "open_finder" | "open_terminal" | "open_editor") => {
    const localPath = runtime?.localPath ?? localProjects?.projects[0]?.localPath ?? sidebarProjectGroups[0]?.localPath
    if (!localPath) return
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [localProjects?.projects, openExternal, runtime?.localPath, sidebarProjectGroups])

  const handleCopyPath = useCallback(async (localPath: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available")
      }
      await navigator.clipboard.writeText(localPath)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const handleOpenLocalLink = useCallback(async (target: { path: string; line?: number; column?: number }) => {
    try {
      await openExternal({
        action: "open_editor",
        localPath: target.path,
        line: target.line,
        column: target.column,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [openExternal])

  const handleOpenExternalPath = useCallback(async (action: "open_finder" | "open_editor", localPath: string) => {
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [openExternal])

  const handleCompose = useCallback(() => {
    const intent = resolveComposeIntent({
      selectedProjectId,
      sidebarProjectId: sidebarProjectGroups[0]?.groupKey,
      fallbackLocalProjectPath,
    })
    if (intent) {
      void startChatFromIntent(intent)
      return
    }

    navigate("/")
  }, [fallbackLocalProjectPath, navigate, selectedProjectId, sidebarProjectGroups, startChatFromIntent])

  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [])
  const expandSidebar = useCallback(() => setSidebarCollapsed(false), [])
  const openAddProjectModal = useCallback(() => setAddProjectModalOpen(true), [])
  const closeAddProjectModal = useCallback(() => setAddProjectModalOpen(false), [])

  const handleAskUserQuestion = useCallback(async (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: { questions, answers },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  const handleExitPlanMode = useCallback(async (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => {
    if (!activeChatId) return
    if (confirmed) {
      useChatPreferencesStore.getState().setChatComposerPlanMode(activeChatId, false)
    }
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: {
          confirmed,
          ...(clearContext ? { clearContext: true } : {}),
          ...(message ? { message } : {}),
        },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, socket])

  return {
    socket,
    activeChatId,
    activeProjectId,
    sidebarData: resolvedSidebarData,
    localProjects,
    updateSnapshot,
    chatSnapshot,
    chatDiffSnapshot,
    keybindings,
    appSettings,
    llmProvider,
    connectionStatus,
    sidebarReady,
    localProjectsReady,
    commandError,
    startingLocalPath,
    sidebarOpen,
    sidebarCollapsed,
    messages,
    queuedMessages,
    previousPrompt,
    latestToolIds,
    runtime,
    runtimeStatus: effectiveRuntimeStatus,
    isHistoryLoading,
    hasOlderHistory,
    availableProviders,
    isProcessing,
    canCancel,
    isDraining,
    navbarLocalPath,
    editorLabel,
    hasSelectedProject,
    addProjectModalOpen,
    openSidebar,
    closeSidebar,
    collapseSidebar,
    expandSidebar,
    openAddProjectModal,
    closeAddProjectModal,
    loadOlderHistory,
    handleCreateChat,
    handleForkChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleCheckForUpdates,
    handleInstallUpdate,
    handleForceReload,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleWriteCloudflareTunnel,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleValidateLlmProvider,
    handleSignOut,
    handleSend,
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleDeleteChat,
    handleRemoveProject,
    handleReorderProjectGroups,
    importClaudeSessions,
    handleCopyPath,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleExitPlanMode,
  }
}

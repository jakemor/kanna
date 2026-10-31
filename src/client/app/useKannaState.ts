import { recordClientPerformance, startClientPerformance } from "./clientPerformance"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useShallow } from "zustand/react/shallow"
import { PROVIDERS, withPiFaveModels, type AgentProvider, type AppSettingsPatch, type AskUserQuestionAnswerMap, type AppSettingsSnapshot, type ChatDiffSnapshot, type FaveModel, type KeybindingsSnapshot, type LlmProviderSnapshot, type LlmProviderValidationResult, type ModelOptions, type ProviderCatalogEntry, type QueuedChatMessage, type StandaloneTranscriptExportCommandResult, type TranscriptEntry, type UpdateSnapshot } from "../../shared/types"
import { NEW_CHAT_COMPOSER_ID, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { usePreviewedChatId } from "../stores/viewerStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { useEffectiveEditorPreset } from "../components/open-external-menu"
import { useChatInputStore } from "../stores/chatInputStore"
import { generateUUID } from "../lib/utils"
import { getViewedChatIds } from "../lib/lastViewedChats"
import { resolveProjectNewChat } from "../lib/new-chat-resume"
import { resolveForkBoundary, type ForkBoundary } from "../lib/fork-boundary"
import { flattenSidebarThreads } from "../lib/thread-sections"
import {
  findSidebarChat,
  getSidebarProjectGroups,
  useChatExists,
  useFirstProjectGroup,
  useNavbarRepoLabel,
  useProjectIdForChat,
  useSidebarChatStatus,
  useSidebarReady,
  useSidebarStore,
} from "../stores/sidebarStore"
import type { BranchActionFailure, BranchActionSuccess, ChatSnapshot, HydratedTranscriptMessage, LocalProjectsSnapshot, SidebarChatRow, SidebarData, TranscriptOutlineEntry } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import type { OpenLocalLinkTarget } from "../components/messages/shared"
import { useAppDialog } from "../components/ui/app-dialog"
import { useTheme } from "../hooks/useTheme"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { canCancelStatus, getLatestToolIds, hasNoTurnStatus, isProcessingStatus } from "./derived"
import {
  getActiveChatSnapshot,
  getMostRecentlyActiveProjectId,
  getNewestRemainingChatId,
  getPreviousPrompt,
  getProjectIdForChat,
  NEW_CHAT_OPTIMISTIC_SCOPE,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  type OptimisticProcessingState,
  type OptimisticUserPrompt,
  type ProjectRequest,
  type StartChatIntent,
} from "./kannaStateHelpers"
import {
  foldChatSnapshot,
  sameDiffs,
  shouldPreserveExistingProjectDiffs,
} from "./snapshotEquality"
import {
  cachedWindowToMessages,
  canPaintCachedWindow,
  createTranscriptCacheWriter,
  peekPaintableMemoryWindow,
  readCachedWindow,
  readMemoryCachedWindow,
  trimCachedWindow,
  type CachedTranscriptWindow,
} from "./chatTranscriptCache"
import { DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES } from "../../shared/transcript-window"
import { CLOUD_WS_ENDPOINT_PATH, type CloudWsEndpointResponse } from "../../shared/cloud-api"
import { KannaSocket, type SocketStatus } from "./socket"
import { visibleCommandError, type ConnectionHealth } from "./connectionHealth"
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "../lib/storageKeys"
import { useAppSettingsSync } from "./useAppSettingsSync"
import { useBackgroundChatSubscriptions } from "./useBackgroundChatSubscriptions"
import { useChatCommands } from "./useChatCommands"
import { useChatReadAnchor, type ChatReadAnchorState, type ReadAnchorLayoutSource } from "./useChatReadAnchor"
import { useSendMessage } from "./useSendMessage"
import { useTakeUpNextRun } from "../hooks/useComposer"
import { useShareExport } from "./useShareExport"
import { useUpdateRestart } from "./useUpdateRestart"
import type { EditorOpenSettings, OpenExternalAction, TerminalPreset } from "../../shared/protocol"
import { applySidebarPatch, type SidebarPatch } from "../../shared/sidebar-patch"

export {
  getUiUpdateReadinessPath,
  getUiUpdateRestartReconnectAction,
  shouldHandleUiUpdateReloadRequest,
} from "./useUpdateRestart"

export {
  applySidebarProjectOrder,
  countMatchingUserPrompts,
  getActiveChatSnapshot,
  getMostRecentlyActiveProjectId,
  getNewestRemainingChatId,
  getNextMeasuredInputHeight,
  getPreviousPrompt,
  getTranscriptPaddingBottom,
  getUserPromptSignature,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  shouldAutoFollowTranscript,
  shouldMarkActiveChatRead,
  TRANSCRIPT_PADDING_BOTTOM_OFFSET,
  type OptimisticUserPrompt,
  type ProjectRequest,
  type StartChatIntent,
} from "./kannaStateHelpers"

/** Stable identity so an empty transcript does not re-derive rows each render. */
const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = []
const EMPTY_OUTLINE: TranscriptOutlineEntry[] = []
// `queuedMessages` is a prop of the memoized transcript viewport. A fresh `[]`
// per render failed its shallow compare and re-rendered the whole viewport on
// every push.
const EMPTY_QUEUED_MESSAGES: ChatSnapshot["queuedMessages"] = []
/** How long a chat open waits on the disk cache before subscribing without it. */
const DISK_CACHE_WAIT_MS = 30

function sameOriginWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

/**
 * Resolved before every (re)connect. The machine always serves
 * /api/cloud/ws-endpoint: through the kanna.sh proxy it returns the direct
 * tunnel URL plus a fresh short-lived connect token (so the WebSocket
 * bypasses the proxy); locally it returns wsUrl null and we connect
 * same-origin. Any failure falls back to same-origin, keeping local behavior
 * unchanged.
 */
async function wsUrlProvider(): Promise<string> {
  try {
    const response = await fetch(CLOUD_WS_ENDPOINT_PATH, {
      headers: { Accept: "application/json" },
    })
    if (response.ok) {
      const payload = await response.json() as CloudWsEndpointResponse
      if (payload.wsUrl) {
        const url = new URL(payload.wsUrl)
        if (payload.connectToken) {
          url.searchParams.set("token", payload.connectToken)
        }
        return url.toString()
      }
    }
  } catch {
    // Endpoint unreachable — connect same-origin.
  }
  return sameOriginWsUrl()
}

/**
 * A socket for pages that live outside KannaLayout (e.g. the OpenRouter OAuth
 * callback popup) — same URL resolution as the main app socket.
 */
export function createStandaloneKannaSocket() {
  return new KannaSocket(wsUrlProvider)
}

function useKannaSocket() {
  const socketRef = useRef<KannaSocket | null>(null)
  if (!socketRef.current) {
    socketRef.current = new KannaSocket(wsUrlProvider)
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

export interface KannaState {
  socket: KannaSocket
  activeChatId: string | null
  activeProjectId: string | null
  localProjects: LocalProjectsSnapshot | null
  updateSnapshot: UpdateSnapshot | null
  chatSnapshot: ChatSnapshot | null
  /** Server-stored read position for the active chat; drives restore on open. */
  readAnchorState: ChatReadAnchorState
  /** Report the message at the top of the viewport (throttled write). */
  reportReadAnchor: (messageId: string, atEnd: boolean, layout?: ReadAnchorLayoutSource) => void
  /** Entries exist before the loaded window; "load earlier" has somewhere to go. */
  hasOlderMessages: boolean
  /** Every user prompt in the chat, loaded or not (see shared/transcript-window.ts). */
  transcriptOutline: TranscriptOutlineEntry[]
  /** On a fork whose copied history is loaded: where it ends. */
  forkBoundary: ForkBoundary | null
  /** Widen the window toward the start; the rows arrive on the subscription. */
  loadOlderMessages: (options?: { untilMessageId?: string; all?: boolean }) => Promise<void>
  isLoadingOlderMessages: boolean
  chatDiffSnapshot: ChatDiffSnapshot | null
  keybindings: KeybindingsSnapshot | null
  appSettings: AppSettingsSnapshot | null
  llmProvider: LlmProviderSnapshot | null
  connectionStatus: SocketStatus
  /** What to tell a person about the connection: quiet while reconnecting, loud once lost. */
  connectionHealth: ConnectionHealth
  sidebarReady: boolean
  localProjectsReady: boolean
  commandError: string | null
  startingLocalPath: string | null
  sidebarCollapsed: boolean
  messages: ReturnType<typeof processTranscriptMessages>
  queuedMessages: QueuedChatMessage[]
  previousPrompt: string | null
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  runtimeStatus: string | null
  availableProviders: ProviderCatalogEntry[]
  isProcessing: boolean
  canCancel: boolean
  isDraining: boolean
  isExportingStandalone: boolean
  standaloneShareUrl: string | null
  standaloneShareComplete: boolean
  navbarLocalPath?: string
  /**
   * `repo/branch` for the project `navbarLocalPath` points at, null when that
   * folder isn't in a repo (or hasn't been probed) — the composer placeholder
   * names the checkout when there is one and the path when there isn't.
   */
  navbarRepoLabel: string | null
  editorLabel: string
  hasSelectedProject: boolean
  openSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  /**
   * The open chat is one this client started a moment ago and has not heard
   * back about (`createChatForProject`). It is known to be empty, so its page
   * is the new chat page without waiting to be told.
   */
  activeChatStarted: boolean
  handleCreateChat: (projectId: string) => Promise<void>
  /**
   * A click on a project, as against on something that says New Chat: the
   * chat in it last viewed here, and failing that its new chat page, which
   * is the one already being written if there is one
   * (`resolveProjectNewChat`), and a fresh chat if not.
   */
  handleOpenProjectNewChat: (projectId: string) => void
  handleForkChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleCheckForUpdates: (options?: { force?: boolean }) => Promise<void>
  handleInstallUpdate: () => Promise<void>
  handleInstallNightly: () => Promise<void>
  handleInstallStable: () => Promise<void>
  handleReadAppSettings: () => Promise<void>
  handleWriteAppSettings: (patch: AppSettingsPatch) => Promise<void>
  handleReadLlmProvider: () => Promise<void>
  handleWriteLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<void>
  handleWriteFaveModels: (faveModels: FaveModel[]) => Promise<void>
  handleValidateLlmProvider: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  handleSignOut: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; autoPlan?: boolean }) => Promise<void>
  handleSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  handleCancel: (options?: { cascade?: boolean }) => Promise<void>
  handleStopDraining: () => Promise<void>
  handleRenameChat: (chat: SidebarChatRow) => Promise<void>
  handleRenameProject: (target: string | { localPath: string }, sidebarTitle: string | undefined, realTitle: string) => Promise<void>
  handleShareChat: (chatId?: string | null) => Promise<void>
  handleToggleChatPin: (chat: SidebarChatRow) => Promise<void>
  handleArchiveChat: (chat: SidebarChatRow) => Promise<void>
  handleOpenArchivedChat: (chatId: string) => Promise<void>
  handleRestoreChat: (chatId: string) => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleSetupGit: (chatId: string) => Promise<void>
  handleHideProject: (target: string | { localPath: string }) => Promise<void>
  handleReorderProjectGroups: (projectIds: string[]) => Promise<void>
  handleCopyPath: (localPath: string) => Promise<void>
  handleOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => Promise<void>
  handleOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => Promise<void>
  handleOpenLocalLink: (target: OpenLocalLinkTarget, action?: OpenExternalAction, editor?: EditorOpenSettings) => Promise<void>
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
  handleExportStandalone: (chatId?: string | null) => Promise<StandaloneTranscriptExportCommandResult | null>
  handleCloseStandaloneShareDialog: () => void
  handleOpenStandaloneShareLink: () => void
  handleCopyStandaloneShareLink: () => Promise<boolean>
}

export function useKannaState(activeChatId: string | null): KannaState {
  const navigate = useNavigate()
  const socket = useKannaSocket()
  const dialog = useAppDialog()
  const { resolvedTheme } = useTheme()

  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  const [cachedTranscript, setCachedTranscript] = useState<CachedTranscriptWindow | null>(null)
  const openTiming = useRef({ chatId: activeChatId, started: performance.now(), displayed: false })
  if (openTiming.current.chatId !== activeChatId) openTiming.current = { chatId: activeChatId, started: performance.now(), displayed: false }
  useEffect(() => startClientPerformance(() => socket.getResourceCounts()), [socket])
  const transcriptCacheWriter = useMemo(() => createTranscriptCacheWriter(), [])
  const [projectDiffSnapshots, setProjectDiffSnapshots] = useState<Record<string, ChatDiffSnapshot | null>>({})
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealth>("connecting")
  const sidebarReady = useSidebarReady()
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  // Remembered in this browser: collapsing the sidebar is how a window is
  // arranged, and a reload should not put it back.
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1"
  )
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed)
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0")
  }, [])
  const [commandError, setCommandError] = useState<string | null>(null)
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  // A chat this client has asked for and gone to without waiting to hear that
  // it exists (`createChatForProject`). Until its snapshot comes this is all
  // that is known of it: that it is empty, and which project it is in.
  const [startedChat, setStartedChat] = useState<{ chatId: string; projectId: string } | null>(null)
  // The ids of the ones whose `chat.create` is still in flight, for the chat
  // subscription, which reads it outside a render.
  const startingChatIdsRef = useRef(new Set<string>())
  const activeChatIdRef = useRef(activeChatId)
  useEffect(() => {
    activeChatIdRef.current = activeChatId
  }, [activeChatId])
  const [optimisticUserPrompts, setOptimisticUserPrompts] = useState<OptimisticUserPrompt[]>([])
  const [optimisticProcessing, setOptimisticProcessing] = useState<OptimisticProcessingState | null>(null)
  const draftChatIds = useChatInputStore(useShallow((state) => Object.keys(state.drafts).sort()))
  const attachmentDraftChatIds = useChatInputStore(
    useShallow((state) => Object.keys(state.attachmentDrafts).sort())
  )
  const lastActiveProjectDiffRef = useRef<{ projectId: string | null; diffs: ChatDiffSnapshot | null }>({
    projectId: null,
    diffs: null,
  })
  // Not the raw preference: every plain "Open in X" in the app names the
  // editor the navbar button would open, which is the one you last picked
  // there and never one this machine doesn't have.
  const editorLabel = getEditorPresetLabel(
    useEffectiveEditorPreset(useTerminalPreferencesStore((store) => store.editorPreset))
  )

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])
  useEffect(() => socket.onHealth(setConnectionHealth), [socket])

  // Straight into the store, never into React state: a running turn moves a
  // sidebar field several times a second, and holding the snapshot here would
  // re-render this hook's whole subtree — the chat page included — every time.
  // Consumers select the slice they paint (see stores/sidebarStore).
  //
  // Patches rather than full snapshots (see shared/sidebar-patch.ts). They
  // apply to `held`, the server's last snapshot as sent, not to the store,
  // which also carries the local drag order. A patch that doesn't start from
  // `held` means the two fell out of step; a fresh subscription starts over
  // with a reset. A full snapshot still arrives when the server can't patch.
  useEffect(() => {
    let held: { revision: number | null; data: SidebarData } | null = null
    let unsubscribe = () => {}
    const subscribe = () => {
      held = null
      unsubscribe = socket.subscribe<SidebarData | SidebarPatch>({ type: "sidebar", patches: true }, (snapshot) => {
        let data: SidebarData
        if ("projectGroups" in snapshot) {
          data = snapshot
          held = { revision: null, data }
        } else {
          if (snapshot.from !== null && snapshot.from !== held?.revision) {
            resubscribe()
            return
          }
          try {
            data = applySidebarPatch(held?.data ?? null, snapshot)
          } catch (error) {
            console.warn("[sidebar] patch did not apply, resubscribing:", error)
            resubscribe()
            return
          }
          held = { revision: snapshot.to, data }
        }
        useSidebarStore.getState().setSnapshot(data)
        setCommandError(null)
      })
    }
    const resubscribe = () => {
      unsubscribe()
      subscribe()
    }
    subscribe()
    return () => unsubscribe()
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

  const { updateSnapshot, handleCheckForUpdates, handleInstallUpdate, handleInstallNightly, handleInstallStable } = useUpdateRestart({
    socket,
    connectionStatus,
    dialog,
    setCommandError,
  })

  const {
    keybindings,
    appSettings,
    llmProvider,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleWriteFaveModels,
    handleValidateLlmProvider,
  } = useAppSettingsSync({ socket, connectionStatus, setCommandError })

  // Read through a ref by the chat subscription, which must not re-run (and
  // re-send the transcript) every time settings change.
  const transcriptWindowSizeRef = useRef(DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES)
  transcriptWindowSizeRef.current = appSettings?.transcript?.windowAssistantMessages ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES

  // A chat held in memory is drawn in the render that switches to it. The
  // subscription effect below reads the same window, but it runs after that
  // render has been committed and painted, so the switch used to show an
  // empty transcript for a frame, and the transcript's rows arrived in a
  // later commit than the one that mounted it. Set while rendering so the
  // chat's first frame is its rows, at the place its reader left it.
  const [seededChatId, setSeededChatId] = useState<string | null>(null)
  if (seededChatId !== activeChatId) {
    setSeededChatId(activeChatId)
    setCachedTranscript(activeChatId ? peekPaintableMemoryWindow(activeChatId, transcriptWindowSizeRef.current) : null)
  }

  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  /**
   * Widen the open chat's window toward the start. The older slice arrives
   * as a push on the subscription, not in the ack, so callers wait on the
   * snapshot rather than on this promise for rows.
   */
  const loadOlderMessages = useCallback(async (options?: { untilMessageId?: string; all?: boolean }) => {
    if (!activeChatId) return
    setIsLoadingOlderMessages(true)
    try {
      await socket.command<{ startIndex: number }>({
        type: "chat.loadOlder",
        chatId: activeChatId,
        ...(options?.untilMessageId !== undefined ? { untilMessageId: options.untilMessageId } : {}),
        ...(options?.all ? { all: true } : {}),
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [activeChatId, socket])

  // The span this client holds for the open chat, for resubscribing after a
  // reconnect. Read from a ref: the subscription outlives any one render.
  const heldChatSpanRef = useRef<{ chatId: string; span: { start: number; end: number; endEntryId: string } } | null>(null)
  useEffect(() => {
    const last = chatSnapshot?.messages[chatSnapshot.messages.length - 1]
    heldChatSpanRef.current = chatSnapshot && activeChatId && last
      ? {
        chatId: activeChatId,
        span: {
          start: chatSnapshot.startIndex,
          end: chatSnapshot.startIndex + chatSnapshot.messages.length,
          endEntryId: last._id,
        },
      }
      : null
  }, [activeChatId, chatSnapshot])

  useEffect(() => {
    if (!activeChatId) {
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    setChatSnapshot(null)
    setCachedTranscript(null)
    setChatReady(false)

    // Narrowed once for the closures below, which lose it otherwise.
    const chatId = activeChatId
    let cancelled = false
    let receivedSnapshot = false
    const openedAt = performance.now()
    let unsubscribe: (() => void) | null = null
    // Base for the first incremental push: the server resumes from the cached
    // span, so its first body starts where this window ends rather than
    // repeating it.
    let base: { messages: TranscriptEntry[]; startIndex: number } | null = null

    function handleSnapshot(snapshot: ChatSnapshot | null) {
      if (cancelled) return
      if (!receivedSnapshot) recordClientPerformance("chat_server_ready_ms", performance.now() - openedAt)
      receivedSnapshot = true
      setCachedTranscript(null)
      // `foldChatSnapshot` is pure by contract — see its comment. Keep this
      // updater a bare call to it and nothing else; the last thing that folded
      // inline also cleared `base` as it went, and React re-running the updater
      // then left the transcript blank.
      setChatSnapshot((current) => foldChatSnapshot(current, base, snapshot))
      setChatReady(true)
      setCommandError(null)
    }

    let subscribed = false
    function subscribeToChat(cached: CachedTranscriptWindow | null) {
      if (cancelled || subscribed) return
      subscribed = true
      // A cache written before windows existed holds the whole chat. Cut it
      // to the window a fresh open would get before painting from it, so a
      // cached chat is not the one case that still mounts every row. The span
      // sent to the server is the trimmed one, so it resumes from there.
      const trimmed = cached ? trimCachedWindow(cached, transcriptWindowSizeRef.current) : null
      const lastEntryId = trimmed?.entries[trimmed.entries.length - 1]?._id
      const span = trimmed && lastEntryId
        ? { start: trimmed.startIndex, end: trimmed.startIndex + trimmed.entries.length, endEntryId: lastEntryId }
        : null
      if (trimmed && span) {
        base = cachedWindowToMessages(trimmed)
        // Drawn now only if it can be drawn in place (`canPaintCachedWindow`).
        // It seeds the subscription either way.
        if (canPaintCachedWindow(trimmed)) {
          setCachedTranscript(trimmed)
          recordClientPerformance("chat_cache_ready_ms", performance.now() - openedAt)
        }
      }
      // The server sizes the window (the transcript-window setting, widened
      // to reach the stored read anchor) and returns the anchor inline.
      unsubscribe = socket.subscribe<ChatSnapshot | null>(
        { type: "chat", chatId, ...(span ? { cachedSpan: span } : {}) },
        handleSnapshot,
        undefined,
        {
          // A reconnect used to resubscribe with the topic from the first
          // open, so every socket drop cost a full window (20 KB on a long
          // chat). Naming what is held by now makes it a tail, or nothing.
          topicOnReconnect: () => {
            const held = heldChatSpanRef.current
            return held && held.chatId === chatId
              ? { type: "chat", chatId, cachedSpan: held.span }
              : { type: "chat", chatId }
          },
        }
      )
    }

    // Memory seeds the subscription at once. On a miss the disk read gets a
    // short head start: it averages under 10 ms, and a subscription that names
    // the span it holds gets a tail back instead of the whole window, which
    // otherwise lands as a second full render on top of the cached one. A read
    // slower than the cap subscribes without it and still paints if it can.
    //
    // A chat started a moment ago has no cache to wait on, on disk or
    // anywhere. Its subscription goes out right behind its `chat.create`,
    // and the server answers it once the chat is written.
    let diskWait: ReturnType<typeof setTimeout> | null = null
    const memory = readMemoryCachedWindow(chatId)
    if (memory) {
      subscribeToChat(memory)
    } else if (startingChatIdsRef.current.has(chatId)) {
      subscribeToChat(null)
    } else {
      diskWait = setTimeout(() => {
        diskWait = null
        subscribeToChat(null)
      }, DISK_CACHE_WAIT_MS)
      void readCachedWindow(chatId).then(cached => {
        if (cancelled) return
        if (!subscribed) {
          if (diskWait !== null) clearTimeout(diskWait)
          diskWait = null
          subscribeToChat(cached)
          return
        }
        if (receivedSnapshot || !cached) return
        const trimmed = trimCachedWindow(cached, transcriptWindowSizeRef.current)
        if (!canPaintCachedWindow(trimmed)) return
        setCachedTranscript(trimmed)
        recordClientPerformance("chat_cache_ready_ms", performance.now() - openedAt)
      })
    }

    return () => {
      cancelled = true
      if (diskWait !== null) clearTimeout(diskWait)
      unsubscribe?.()
      // A chat closed mid-turn never reaches a settled write, so take what is
      // pending rather than lose the window.
      transcriptCacheWriter.flush()
    }
  }, [activeChatId, socket, transcriptCacheWriter])


  // Seeded once the snapshot lands. Reads the groups off the store rather than
  // subscribing to them: the seed only has to be right the first time, and a
  // subscription here would drag every sidebar push back into this hook.
  useEffect(() => {
    if (selectedProjectId || !sidebarReady) return
    const seed = getMostRecentlyActiveProjectId(getSidebarProjectGroups())
    if (seed) {
      setSelectedProjectId(seed)
    }
  }, [selectedProjectId, sidebarReady])

  // Archived chats are viewable in place (viewing doesn't unarchive), so they
  // count as existing — only truly unknown/deleted chats bounce home.
  const activeChatExists = useChatExists(activeChatId)
  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    if (activeChatExists) {
      if (pendingChatId === activeChatId) {
        setPendingChatId(null)
      }
      return
    }
    if (pendingChatId === activeChatId) {
      return
    }
    navigate("/")
  }, [activeChatExists, activeChatId, chatReady, navigate, pendingChatId, sidebarReady])

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
    if (pendingChatId === chatSnapshot.runtime.chatId) {
      setPendingChatId(null)
    }
    // The server has spoken for the chat; from here it is drawn from that.
    setStartedChat((current) => (current?.chatId === chatSnapshot.runtime.chatId ? null : current))
  }, [chatSnapshot, pendingChatId])

  // Mark a chat read when the user navigates *away* from it, not when it opens.
  // A chat that receives new activity while it's the active chat stays unread
  // (badge visible) until the user leaves it. The outgoing chat's unread state
  // is read off the store at the moment of the switch, so this effect only runs
  // on chat switches, and chats that no longer exist are skipped (which avoids
  // spurious markRead commands).
  const previousActiveChatIdRef = useRef<string | null>(null)
  useEffect(() => {
    const previousChatId = previousActiveChatIdRef.current
    previousActiveChatIdRef.current = activeChatId ?? null
    if (!previousChatId || previousChatId === activeChatId) return
    if (!findSidebarChat(previousChatId)?.unread) return
    void socket.command({ type: "chat.markRead", chatId: previousChatId }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [activeChatId, socket])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )

  // Reads the anchor off the snapshot (the server resolves it against the
  // window it chose) and owns the throttled write-back.
  const {
    anchorState: readAnchorState,
    reportReadAnchor,
  } = useChatReadAnchor(socket, activeChatId, activeChatSnapshot?.readAnchor, chatReady)

  const sidebarProjectIdForChat = useProjectIdForChat(activeChatId)
  const activeChatStarted = Boolean(activeChatId && startedChat?.chatId === activeChatId && !activeChatSnapshot)
  // A started chat names its own project. `selectedProjectId` cannot stand in
  // for it: the effect above sets that back to the project of the chat being
  // left, whose snapshot is still held when the click is handled.
  const activeProjectId = activeChatSnapshot?.runtime.projectId
    ?? sidebarProjectIdForChat
    ?? (activeChatStarted ? startedChat?.projectId : null)
    ?? selectedProjectId
  // The open chat's project folder as the sidebar has it, for before the
  // chat's snapshot says so. Without it a chat in any project but the first
  // opened under the first one's path and changed to its own a beat later.
  const activeProjectLocalPath = useSidebarStore((state) => (
    activeChatId && activeProjectId
      ? state.data.projectGroups.find((group) => group.groupKey === activeProjectId)?.localPath ?? null
      : null
  ))
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
  const serverTranscriptEntries = activeChatSnapshot?.messages
    ?? (cachedTranscript?.chatId === activeChatId ? cachedTranscript.entries : EMPTY_TRANSCRIPT_ENTRIES)
  useEffect(() => {
    const timing = openTiming.current
    if (!activeChatId || !serverTranscriptEntries.length || timing.displayed || document.visibilityState !== "visible") return
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (openTiming.current !== timing) return
        timing.displayed = true
        recordClientPerformance("chat_display_ms", performance.now() - timing.started)
      })
    })
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame) }
  }, [activeChatId, serverTranscriptEntries])
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
  // Hands the previous result back in so a push that appended entries hydrates
  // only the new ones. See `processTranscriptMessages` for the prefix rule.
  const previousMessagesRef = useRef<HydratedTranscriptMessage[] | null>(null)
  const messages = useMemo(() => {
    const started = performance.now()
    const next = processTranscriptMessages(transcriptEntries, previousMessagesRef.current)
    recordClientPerformance("transcript_hydrate_ms", performance.now() - started)
    recordClientPerformance("transcript_entries", transcriptEntries.length)
    previousMessagesRef.current = next
    return next
  }, [transcriptEntries])
  const previousPrompt = useMemo(() => getPreviousPrompt(messages), [messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const runtime = activeChatSnapshot?.runtime ?? null
  useTakeUpNextRun(runtime)
  const forkBoundary = useMemo(
    () => (activeChatSnapshot
      ? resolveForkBoundary(activeChatSnapshot.runtime.forkedFrom, activeChatSnapshot.messages, activeChatSnapshot.startIndex, messages)
      : null),
    [activeChatSnapshot, messages],
  )
  const queuedMessages = activeChatSnapshot?.queuedMessages ?? EMPTY_QUEUED_MESSAGES
  const optimisticRuntimeStatus = optimisticProcessing?.scopeId === optimisticScopeId && (!runtime || hasNoTurnStatus(runtime.status))
    ? "starting"
    : null
  // The chat's snapshot waits on the server reading the transcript off disk,
  // but the cached transcript paints before that. Without a status in the gap,
  // a running chat opens with no footer indicator and gains one a beat later,
  // shoving the text up. The sidebar already knows the status, so use it until
  // the snapshot lands.
  const sidebarChatStatus = useSidebarChatStatus(activeChatId)
  const loadingRuntimeStatus = activeChatId && !activeChatSnapshot ? sidebarChatStatus : null
  const effectiveRuntimeStatus = optimisticRuntimeStatus ?? runtime?.status ?? loadingRuntimeStatus ?? null
  // Outside a chat snapshot (new-chat composer, settings) the catalog is the
  // live one the app-settings snapshot carries, so runtime-discovered models
  // show before any chat is opened; the static list covers a cold start. The
  // pi catalog is derived from the same fave models the server applies, so
  // both always match.
  const fallbackProviders = useMemo(
    () => withPiFaveModels(appSettings?.availableProviders ?? PROVIDERS, llmProvider?.faveModels ?? []),
    [appSettings?.availableProviders, llmProvider?.faveModels]
  )
  const availableProviders = activeChatSnapshot?.availableProviders ?? fallbackProviders
  const isProcessing = isProcessingStatus(effectiveRuntimeStatus ?? undefined)

  // Written after a turn settles, not during: the window changes many times a
  // second while streaming and the server is the source of truth throughout.
  useEffect(() => {
    if (!activeChatId || !chatSnapshot || chatSnapshot.runtime.chatId !== activeChatId) return
    transcriptCacheWriter.schedule(activeChatId, chatSnapshot, isProcessing)
  }, [activeChatId, chatSnapshot, isProcessing, transcriptCacheWriter])

  // A chat left mid-turn is followed from the window it was just showing: the
  // chat subscription's cleanup flushes that window before this effect runs.
  // Nor the chat in the previewer, which holds a subscription of its own
  // while it is there (`useChatSession`).
  useBackgroundChatSubscriptions(socket, activeChatId, transcriptWindowSizeRef, usePreviewedChatId())

  const canCancel = canCancelStatus(effectiveRuntimeStatus ?? undefined)
  const isDraining = runtime?.isDraining ?? false
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const firstProjectGroup = useFirstProjectGroup()
  const navbarLocalPath =
    runtime?.localPath
    ?? activeProjectLocalPath
    ?? fallbackLocalProjectPath
    ?? firstProjectGroup.localPath
    ?? undefined
  // The composer names the project the way the sidebar does — `repo/branch` —
  // so the id is matched first and the path only stands in when there's no
  // active project (the new-chat composer falling back to a local project).
  const navbarRepoLabel = useNavbarRepoLabel(activeProjectId, navbarLocalPath)
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? firstProjectGroup.groupKey
    ?? fallbackLocalProjectPath
  )

  useEffect(() => {
    if (optimisticProcessing?.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && !hasNoTurnStatus(runtime.status)) {
      setOptimisticProcessing(null)
    }
  }, [optimisticProcessing, optimisticScopeId, runtime?.status])

  // After the ack, the optimistic status holds until a chat snapshot that
  // arrived after the ack still says idle. The server queues its "running"
  // push before it acks, so the first push after the ack is the answer. A fixed
  // grace period used to decide this instead, and it lost to the snapshot on a
  // new chat (navigate, subscribe, first push), so the indicator blinked out
  // and back. The fallback only covers a push that never comes.
  const ackedSnapshotRef = useRef<{ ackedAt: number; snapshot: ChatSnapshot | null } | null>(null)
  useEffect(() => {
    if (!optimisticProcessing?.ackedAt || optimisticProcessing.scopeId !== optimisticScopeId) {
      return
    }
    if (runtime?.status && !hasNoTurnStatus(runtime.status)) {
      return
    }
    const { ackedAt } = optimisticProcessing
    if (ackedSnapshotRef.current?.ackedAt !== ackedAt) {
      ackedSnapshotRef.current = { ackedAt, snapshot: activeChatSnapshot }
    }
    const heardBack = activeChatSnapshot !== null && activeChatSnapshot !== ackedSnapshotRef.current.snapshot
    const timeoutId = window.setTimeout(() => {
      setOptimisticProcessing((current) => (
        current?.scopeId === optimisticScopeId && current.ackedAt === ackedAt
          ? null
          : current
      ))
    }, heardBack ? 0 : 5_000)
    return () => window.clearTimeout(timeoutId)
  }, [activeChatSnapshot, optimisticProcessing, optimisticScopeId, runtime?.status])

  useEffect(() => {
    setOptimisticUserPrompts((current) => {
      const reconciled = reconcileOptimisticUserPrompts(current, optimisticScopeId, serverTranscriptEntries)
      if (reconciled.length === current.length && reconciled.every((prompt, index) => prompt === current[index])) {
        return current
      }
      return reconciled
    })
  }, [optimisticScopeId, serverTranscriptEntries])

  // Goes to the new chat's page at once and creates the chat behind it. The
  // click used to wait on two trips to the server: `chat.create` before the
  // navigation, then the new chat's first snapshot before the page could say
  // it was empty. Each is a round trip, so through a tunnel the click did
  // nothing for a few hundred milliseconds, and what was typed meanwhile went
  // to the composer of the chat being left.
  //
  // The id is made here so the page has an address before the server answers
  // (`chat.create` takes it), and `startedChat` is what the page is drawn from
  // until the chat's snapshot arrives. Nothing else is assumed: the sidebar
  // row comes with the server's push, as it always did.
  //
  // `carryDraftFrom` names a new chat that is gone and left a draft behind
  // (`resolveProjectNewChat`). The draft, and the model it was being written
  // for, come over to this chat before its page is up, so the composer mounts
  // holding them.
  const createChatForProject = useCallback((projectId: string, options?: { carryDraftFrom?: string }) => {
    const chatPreferences = useChatPreferencesStore.getState()
    const chatInput = useChatInputStore.getState()
    const carriedFrom = options?.carryDraftFrom
    const sourceComposerState = carriedFrom && chatPreferences.chatStates[carriedFrom]
      ? chatPreferences.getComposerState(carriedFrom)
      : activeChatId
        ? chatPreferences.getComposerState(activeChatId)
        : chatPreferences.getComposerState(NEW_CHAT_COMPOSER_ID)
    const chatId = generateUUID()
    if (carriedFrom) {
      chatInput.moveDraft(carriedFrom, chatId)
      chatInput.forgetStartedChat(carriedFrom)
    }
    chatInput.rememberStartedChat(chatId, projectId)
    const cameFrom = `${window.location.pathname}${window.location.search}`
    const sentAt = performance.now()
    // Sent before the navigation, so it is on the wire ahead of everything the
    // page sends about the chat: its subscription, a git refresh, a message
    // typed and sent at once. The server holds those until the chat is
    // written (`chatCreations` in ws-router), so none of them can find it
    // missing.
    const created = socket.command<{ chatId: string }>({ type: "chat.create", projectId, chatId }).then((result) => {
      recordClientPerformance("chat_create_ack_ms", performance.now() - sentAt)
      if (result.chatId === chatId) return
      // A server from before it took an id made its own. Follow it there,
      // with whatever has been typed by now.
      chatInput.moveDraft(chatId, result.chatId)
      chatInput.forgetStartedChat(chatId)
      chatInput.rememberStartedChat(result.chatId, projectId)
      chatPreferences.initializeComposerForChat(result.chatId, { sourceState: sourceComposerState })
      setStartedChat((current) => (current?.chatId === chatId ? { chatId: result.chatId, projectId } : current))
      setPendingChatId((current) => (current === chatId ? result.chatId : current))
      if (activeChatIdRef.current === chatId) navigate(`/chat/${result.chatId}`, { replace: true })
    })
    startingChatIdsRef.current.add(chatId)
    chatPreferences.initializeComposerForChat(chatId, { sourceState: sourceComposerState })
    setSelectedProjectId(projectId)
    setPendingChatId(chatId)
    setStartedChat({ chatId, projectId })
    navigate(`/chat/${chatId}`)
    setCommandError(null)
    created.then(() => {
      startingChatIdsRef.current.delete(chatId)
    }, (error) => {
      startingChatIdsRef.current.delete(chatId)
      // The chat was not made, so its page comes down: the page the click was
      // on takes its place in the history, with the reason. `pendingChatId`
      // is left as it is. Clearing it would let the "unknown chat" bounce
      // send this page to `/` before the navigation below has landed, and
      // nothing is left in the history that could come back to this id.
      setStartedChat((current) => (current?.chatId === chatId ? null : current))
      if (activeChatIdRef.current === chatId) navigate(cameFrom, { replace: true })
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [activeChatId, navigate, socket])

  const resolveProjectIdForStartChat = useCallback(async (intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> => {
    if (intent.kind === "project_id") {
      return { projectId: intent.projectId }
    }

    if (intent.kind === "local_path") {
      const result = await socket.command<{ projectId: string }>({ type: "project.open", localPath: intent.localPath })
      return { projectId: result.projectId, localPath: intent.localPath }
    }

    const command: Parameters<typeof socket.command>[0] = intent.project.mode === "clone" && intent.project.cloneUrl
      ? { type: "project.clone", cloneUrl: intent.project.cloneUrl, localPath: intent.project.localPath, fallbackPath: intent.project.fallbackPath, title: intent.project.title }
      : intent.project.mode === "create"
        ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
        : { type: "project.open", localPath: intent.project.localPath }
    const result = await socket.command<{ projectId: string; localPath?: string }>(command)
    return { projectId: result.projectId, localPath: result.localPath ?? intent.project.localPath }
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

      // A project that is already known is gone to in the same tick as the
      // click, before anything is awaited. That includes one named by its
      // folder (a card on the home page) when the sidebar lists that folder:
      // `project.open` only hands back the id of a project that is there.
      const knownProjectId = intent.kind === "project_id"
        ? intent.projectId
        : intent.kind === "local_path"
          ? getSidebarProjectGroups().find((group) => group.localPath === intent.localPath)?.groupKey
          : undefined
      const projectId = knownProjectId ?? (await resolveProjectIdForStartChat(intent)).projectId
      createChatForProject(projectId)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      // Re-throw project requests so the command palette can show the
      // failure inline (clone/create/open rows).
      if (intent.kind === "project_request") {
        throw error
      }
    } finally {
      setStartingLocalPath(null)
    }
  }, [createChatForProject, resolveProjectIdForStartChat])

  const handleCreateChat = useCallback(async (projectId: string) => {
    await startChatFromIntent({ kind: "project_id", projectId })
  }, [startChatFromIntent])

  // A click on a project goes back to the chat in it last viewed here.
  // Clicking away from a new chat and clicking its project again comes back
  // to what was being written. Nothing is made when the chat is still there,
  // and the page is drawn from what the sidebar already says of it. See
  // `resolveProjectNewChat` for which chat, and for what makes one instead.
  const handleOpenProjectNewChat = useCallback((projectId: string) => {
    const sidebar = useSidebarStore.getState()
    const chatInput = useChatInputStore.getState()
    const group = sidebar.data.projectGroups.find((item) => item.groupKey === projectId)
    const decision = resolveProjectNewChat({
      entry: "project",
      projectId,
      projectThreads: group ? flattenSidebarThreads({ projectGroups: [group] }) : [],
      isListed: sidebar.ready
        ? (chatId) => getProjectIdForChat(sidebar.data.projectGroups, chatId) !== null
        : null,
      drafts: {
        text: chatInput.drafts,
        attachments: chatInput.attachmentDrafts,
        touchedAt: chatInput.draftTouchedAt,
        startedAt: chatInput.draftStartedAt,
      },
      startedChats: chatInput.startedChats,
      startingChatIds: startingChatIdsRef.current,
      viewedChatIds: getViewedChatIds(projectId),
    })
    if (decision.kind !== "open") {
      createChatForProject(projectId, decision.kind === "carry" ? { carryDraftFrom: decision.fromChatId } : undefined)
      return
    }
    // One whose `chat.create` has not been answered is not in the sidebar
    // yet, so its page is still drawn from `startedChat`, which a chat
    // started since may have taken over.
    if (startingChatIdsRef.current.has(decision.chatId)) {
      setPendingChatId(decision.chatId)
      setStartedChat({ chatId: decision.chatId, projectId })
    }
    setSelectedProjectId(projectId)
    navigate(`/chat/${decision.chatId}`)
    setCommandError(null)
  }, [createChatForProject, navigate])

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

  const handleSend = useSendMessage({
    socket,
    navigate,
    activeChatId,
    setCommandError,
    setSelectedProjectId,
    setPendingChatId,
    setOptimisticProcessing,
    setOptimisticUserPrompts,
    sendContext: {
      isProcessing,
      optimisticUserPrompts,
      serverTranscriptEntries,
      selectedProjectId,
      fallbackLocalProjectPath,
    },
  })

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
      // Put away on purpose: a draft left in it is not to come back when its
      // project is next clicked (`resolveProjectNewChat`).
      useChatInputStore.getState().forgetStartedChat(chat.chatId)
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(getSidebarProjectGroups(), chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, dialog, navigate, socket])

  const handleToggleChatPin = useCallback(async (chat: SidebarChatRow) => {
    try {
      await socket.command({ type: "chat.setPinned", chatId: chat.chatId, pinned: !chat.pinnedAt })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const handleArchiveChat = useCallback(async (chat: SidebarChatRow) => {
    try {
      await socket.command({ type: "chat.archive", chatId: chat.chatId })
      // As for a delete: archiving a chat with no messages is one.
      useChatInputStore.getState().forgetStartedChat(chat.chatId)
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(getSidebarProjectGroups(), chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [activeChatId, navigate, socket])

  // Viewing an archived chat is read-only navigation — it stays archived.
  // Restoring is explicit (context menu) or implicit via sending a message
  // (the server unarchives on chat.send).
  const handleOpenArchivedChat = useCallback(async (chatId: string) => {
    navigate(`/chat/${chatId}`)
  }, [navigate])

  const handleRestoreChat = useCallback(async (chatId: string) => {
    try {
      await socket.command({ type: "chat.unarchive", chatId })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  /**
   * "Setup Git" from a sidebar hover card: confirm, then `git init`, for a
   * chat that isn't necessarily the one you have open. The server resolves the project from the chat, and
   * `chat.initGit` is a no-op success on a folder that turns out to already be
   * a repo — so a stale snapshot costs nothing.
   * It doesn't open the widgets afterwards: you were pointing at a row in the
   * sidebar, not asking to go anywhere.
   */
  const handleSetupGit = useCallback(async (chatId: string) => {
    const confirmed = await dialog.confirm({
      title: "Initialize Git?",
      description: "Initialize a local git repository in this project?",
      confirmLabel: "Init Git",
      cancelLabel: "Cancel",
    })
    if (!confirmed) return

    try {
      const result = await socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.initGit",
        chatId,
      })
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
    } catch (error) {
      await dialog.alert({
        title: "Initialize git failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
    }
  }, [dialog, socket])

  const handleHideProject = useCallback(async (target: string | { localPath: string }) => {
    try {
      const { projectId } = await socket.command<{ projectId: string }>({
        type: "project.remove",
        ...(typeof target === "string" ? { projectId: target } : target),
      })
      useTerminalLayoutStore.getState().clearProject(projectId)
      useRightSidebarStore.getState().clearProject(projectId)
      if (runtime?.projectId === projectId) {
        navigate("/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [navigate, runtime?.projectId, socket])

  const handleReorderProjectGroups = useCallback(async (projectIds: string[]) => {
    useSidebarStore.getState().setOptimisticProjectOrder(projectIds)
    try {
      await socket.command({ type: "sidebar.reorderProjectGroups", projectIds })
      setCommandError(null)
    } catch (error) {
      useSidebarStore.getState().setOptimisticProjectOrder(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [socket])

  const {
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleRenameChat,
    handleRenameProject,
    handleAskUserQuestion,
    handleExitPlanMode,
    handleCopyPath,
    handleOpenExternal,
    handleOpenLocalLink,
    handleOpenExternalPath,
  } = useChatCommands({
    socket,
    dialog,
    activeChatId,
    setCommandError,
    defaultOpenLocalPath: navbarLocalPath,
  })

  const {
    isExportingStandalone,
    standaloneShareUrl,
    standaloneShareComplete,
    handleExportStandalone,
    handleShareChat,
    handleCloseStandaloneShareDialog,
    handleCopyStandaloneShareLink,
    handleOpenStandaloneShareLink,
  } = useShareExport({ socket, activeChatId, resolvedTheme, dialog, setCommandError })

  // The sidebar's New Chat: a chat in the project you're looking at, like the
  // iOS app. Picking another project is the empty chat's path button.
  const handleCompose = useCallback(() => {
    const intent = resolveComposeIntent({
      selectedProjectId: activeProjectId,
      sidebarProjectId: getMostRecentlyActiveProjectId(getSidebarProjectGroups()),
      fallbackLocalProjectPath,
    })
    if (intent) {
      void startChatFromIntent(intent)
      return
    }

    navigate("/")
  }, [activeProjectId, fallbackLocalProjectPath, navigate, startChatFromIntent])

  // On mobile the sidebar is a page rather than an overlay (`/`, or a
  // project's page of chats), so "open" means go to it. That is back to
  // wherever the chat was opened from, through the history, so the chat's
  // Back button and the system's swipe back agree; and `/` for a chat opened
  // directly, with nothing behind it. Desktop always shows the sidebar and
  // never calls this.
  const openSidebar = useCallback(() => {
    if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) navigate(-1)
    else navigate("/")
  }, [navigate])
  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed])
  const expandSidebar = useCallback(() => setSidebarCollapsed(false), [setSidebarCollapsed])

  return {
    socket,
    activeChatId,
    activeProjectId,
    localProjects,
    updateSnapshot,
    chatSnapshot,
    readAnchorState,
    reportReadAnchor,
    // From the cached window until the snapshot says. Load More is part of
    // the transcript's height, and a button that came in with the snapshot
    // pushed a transcript already on screen down by its height.
    hasOlderMessages: (
      activeChatSnapshot?.startIndex
      ?? (cachedTranscript?.chatId === activeChatId ? cachedTranscript.startIndex : 0)
    ) > 0,
    transcriptOutline: activeChatSnapshot?.outline ?? EMPTY_OUTLINE,
    forkBoundary,
    loadOlderMessages,
    isLoadingOlderMessages,
    chatDiffSnapshot,
    keybindings,
    appSettings,
    llmProvider,
    connectionStatus,
    connectionHealth,
    sidebarReady,
    localProjectsReady,
    commandError: visibleCommandError(commandError, connectionHealth),
    startingLocalPath,
    sidebarCollapsed,
    messages,
    queuedMessages,
    previousPrompt,
    latestToolIds,
    runtime,
    runtimeStatus: effectiveRuntimeStatus,
    availableProviders,
    isProcessing,
    canCancel,
    isDraining,
    isExportingStandalone,
    standaloneShareUrl,
    standaloneShareComplete,
    navbarLocalPath,
    navbarRepoLabel,
    editorLabel,
    hasSelectedProject,
    openSidebar,
    collapseSidebar,
    expandSidebar,
    activeChatStarted,
    handleCreateChat,
    handleOpenProjectNewChat,
    handleForkChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleCheckForUpdates,
    handleInstallUpdate,
    handleInstallNightly,
    handleInstallStable,
    handleReadAppSettings,
    handleWriteAppSettings,
    handleReadLlmProvider,
    handleWriteLlmProvider,
    handleWriteFaveModels,
    handleValidateLlmProvider,
    handleSignOut,
    handleSend,
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleRenameChat,
    handleRenameProject,
    handleShareChat,
    handleToggleChatPin,
    handleArchiveChat,
    handleOpenArchivedChat,
    handleRestoreChat,
    handleDeleteChat,
    handleSetupGit,
    handleHideProject,
    handleReorderProjectGroups,
    handleCopyPath,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleExitPlanMode,
    handleExportStandalone,
    handleCloseStandaloneShareDialog,
    handleOpenStandaloneShareLink,
    handleCopyStandaloneShareLink,
  }
}

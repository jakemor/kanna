import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { PROVIDERS, type AgentProvider, type AskUserQuestionAnswerMap, type KeybindingsSnapshot, type ModelOptions, type ProviderCatalogEntry, type UpdateInstallResult, type UpdateSnapshot } from "../../shared/types"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import type { ChatSnapshot, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import { useAppDialog } from "../components/ui/app-dialog"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { canCancelStatus, getLatestToolIds, isProcessingStatus } from "./derived"
import { KannaSocket, type SocketStatus } from "./socket"

export function getNewestRemainingChatId(projectGroups: SidebarData["projectGroups"], activeChatId: string): string | null {
  const projectGroup = projectGroups.find((group) => group.chats.some((chat) => chat.chatId === activeChatId))
  if (!projectGroup) return null

  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId)?.chatId ?? null
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
  if (details === undefined) {
    console.info(`[useKannaState] ${message}`)
    return
  }

  console.info(`[useKannaState] ${message}`, details)
}

export function shouldPinTranscriptToBottom(distanceFromBottom: number) {
  return distanceFromBottom < 120
}

export function getUiUpdateRestartReconnectAction(
  phase: string | null,
  connectionStatus: SocketStatus
): "none" | "awaiting_reconnect" | "navigate_changelog" {
  if (phase === "awaiting_disconnect" && connectionStatus === "disconnected") {
    return "awaiting_reconnect"
  }

  if (phase === "awaiting_reconnect" && connectionStatus === "connected") {
    return "navigate_changelog"
  }

  return "none"
}

const FIXED_TRANSCRIPT_PADDING_BOTTOM = 320
const UI_UPDATE_RESTART_STORAGE_KEY = "kanna:ui-update-restart"

function getUiUpdateRestartPhase() {
  return window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function setUiUpdateRestartPhase(phase: "awaiting_disconnect" | "awaiting_reconnect") {
  window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, phase)
}

function clearUiUpdateRestartPhase() {
  window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
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
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  updateSnapshot: UpdateSnapshot | null
  chatSnapshot: ChatSnapshot | null
  keybindings: KeybindingsSnapshot | null
  connectionStatus: SocketStatus
  sidebarReady: boolean
  localProjectsReady: boolean
  commandError: string | null
  startingLocalPath: string | null
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLDivElement | null>
  messages: ReturnType<typeof processTranscriptMessages>
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  availableProviders: ProviderCatalogEntry[]
  isProcessing: boolean
  canCancel: boolean
  transcriptPaddingBottom: number
  showScrollButton: boolean
  navbarLocalPath?: string
  editorLabel: string
  hasSelectedProject: boolean
  openSidebar: () => void
  closeSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  updateScrollState: () => void
  scrollToBottom: () => void
  handleCreateChat: (projectId: string) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleCheckForUpdates: (options?: { force?: boolean }) => Promise<void>
  handleInstallUpdate: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }) => Promise<void>
  handleCancel: () => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleRemoveProject: (projectId: string) => Promise<void>
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
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null)
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [sidebarReady, setSidebarReady] = useState(false)
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [inputHeight, setInputHeight] = useState(148)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  const editorLabel = getEditorPresetLabel(useTerminalPreferencesStore((store) => store.editorPreset))

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  useEffect(() => {
    return socket.subscribe<SidebarData>({ type: "sidebar" }, (snapshot) => {
      setSidebarData(snapshot)
      setSidebarReady(true)
      setCommandError(null)
    })
  }, [socket])

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
    const phase = getUiUpdateRestartPhase()
    const reconnectAction = getUiUpdateRestartReconnectAction(phase, connectionStatus)
    if (reconnectAction === "awaiting_reconnect") {
      setUiUpdateRestartPhase("awaiting_reconnect")
      return
    }

    if (reconnectAction === "navigate_changelog") {
      clearUiUpdateRestartPhase()
      navigate("/settings/changelog", { replace: true })
    }
  }, [connectionStatus, navigate])

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

  useEffect(() => {
    if (!activeChatId) {
      logKannaState("clearing chat snapshot for non-chat route")
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    logKannaState("subscribing to chat", { activeChatId })
    setChatSnapshot(null)
    setChatReady(false)
    return socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId: activeChatId }, (snapshot) => {
      logKannaState("chat snapshot received", {
        activeChatId,
        snapshotChatId: snapshot?.runtime.chatId ?? null,
        snapshotProvider: snapshot?.runtime.provider ?? null,
        snapshotStatus: snapshot?.runtime.status ?? null,
      })
      setChatSnapshot(snapshot)
      setChatReady(true)
      setCommandError(null)
    })
  }, [activeChatId, socket])

  useEffect(() => {
    if (selectedProjectId) return
    const firstGroup = sidebarData.projectGroups[0]
    if (firstGroup) {
      setSelectedProjectId(firstGroup.groupKey)
    }
  }, [selectedProjectId, sidebarData.projectGroups])

  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    const exists = sidebarData.projectGroups.some((group) => group.chats.some((chat) => chat.chatId === activeChatId))
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
  }, [activeChatId, chatReady, navigate, pendingChatId, sidebarData.projectGroups, sidebarReady])

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
    if (pendingChatId === chatSnapshot.runtime.chatId) {
      setPendingChatId(null)
    }
  }, [chatSnapshot, pendingChatId])

  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      setInputHeight(element.getBoundingClientRect().height)
    })
    observer.observe(element)
    setInputHeight(element.getBoundingClientRect().height)
    return () => observer.disconnect()
  }, [])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )
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
  const messages = useMemo(() => processTranscriptMessages(activeChatSnapshot?.messages ?? []), [activeChatSnapshot?.messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const runtime = activeChatSnapshot?.runtime ?? null
  const availableProviders = activeChatSnapshot?.availableProviders ?? PROVIDERS
  const isProcessing = isProcessingStatus(runtime?.status)
  const canCancel = canCancelStatus(runtime?.status)
  const transcriptPaddingBottom = FIXED_TRANSCRIPT_PADDING_BOTTOM
  const showScrollButton = !isAtBottom && messages.length > 0
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const navbarLocalPath =
    runtime?.localPath
    ?? fallbackLocalProjectPath
    ?? sidebarData.projectGroups[0]?.localPath
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? sidebarData.projectGroups[0]?.groupKey
    ?? fallbackLocalProjectPath
  )

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (shouldPinTranscriptToBottom(distance)) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
    }
  }, [activeChatId, inputHeight, messages.length, runtime?.status])

  function updateScrollState() {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setIsAtBottom(distance < 24)
  }

  function scrollToBottom() {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }

  async function createChatForProject(projectId: string) {
    useChatPreferencesStore.getState().initializeComposerForNewChat()
    const result = await socket.command<{ chatId: string }>({ type: "chat.create", projectId })
    setSelectedProjectId(projectId)
    setPendingChatId(result.chatId)
    navigate(`/chat/${result.chatId}`)
    setSidebarOpen(false)
    setCommandError(null)
  }

  async function resolveProjectIdForStartChat(intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> {
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
  }

  async function startChatFromIntent(intent: StartChatIntent) {
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
  }

  async function handleCreateChat(projectId: string) {
    await startChatFromIntent({ kind: "project_id", projectId })
  }

  async function handleOpenLocalProject(localPath: string) {
    await startChatFromIntent({ kind: "local_path", localPath })
  }

  async function handleCreateProject(project: ProjectRequest) {
    await startChatFromIntent({ kind: "project_request", project })
  }

  async function handleCheckForUpdates(options?: { force?: boolean }) {
    try {
      await socket.command<UpdateSnapshot>({ type: "update.check", force: options?.force })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleInstallUpdate() {
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
  }

  async function handleSend(
    content: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }
  ) {
    try {
      let projectId = selectedProjectId ?? sidebarData.projectGroups[0]?.groupKey ?? null
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

      const result = await socket.command<{ chatId?: string }>({
        type: "chat.send",
        chatId: activeChatId ?? undefined,
        projectId: activeChatId ? undefined : projectId ?? undefined,
        provider: options?.provider,
        content,
        model: options?.model,
        modelOptions: options?.modelOptions,
        planMode: options?.planMode,
      })

      if (!activeChatId && result.chatId) {
        setPendingChatId(result.chatId)
        navigate(`/chat/${result.chatId}`)
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async function handleCancel() {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.cancel", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleDeleteChat(chat: SidebarChatRow) {
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
        const nextChatId = getNewestRemainingChatId(sidebarData.projectGroups, chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleRemoveProject(projectId: string) {
    const project = sidebarData.projectGroups.find((group) => group.groupKey === projectId)
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
  }

  async function handleOpenExternal(action: "open_finder" | "open_terminal" | "open_editor") {
    const localPath = runtime?.localPath ?? localProjects?.projects[0]?.localPath ?? sidebarData.projectGroups[0]?.localPath
    if (!localPath) return
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleOpenLocalLink(target: { path: string; line?: number; column?: number }) {
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
  }

  async function handleOpenExternalPath(action: "open_finder" | "open_editor", localPath: string) {
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function openExternal(command: {
    action: "open_finder" | "open_terminal" | "open_editor"
    localPath: string
    line?: number
    column?: number
  }) {
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
  }

  function handleCompose() {
    const intent = resolveComposeIntent({
      selectedProjectId,
      sidebarProjectId: sidebarData.projectGroups[0]?.groupKey,
      fallbackLocalProjectPath,
    })
    if (intent) {
      void startChatFromIntent(intent)
      return
    }

    navigate("/")
  }

  async function handleAskUserQuestion(
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) {
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
  }

  async function handleExitPlanMode(toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) {
    if (!activeChatId) return
    if (confirmed) {
      useChatPreferencesStore.getState().setComposerPlanMode(false)
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
  }

  return {
    socket,
    activeChatId,
    sidebarData,
    localProjects,
    updateSnapshot,
    chatSnapshot,
    keybindings,
    connectionStatus,
    sidebarReady,
    localProjectsReady,
    commandError,
    startingLocalPath,
    sidebarOpen,
    sidebarCollapsed,
    scrollRef,
    inputRef,
    messages,
    latestToolIds,
    runtime,
    availableProviders,
    isProcessing,
    canCancel,
    transcriptPaddingBottom,
    showScrollButton,
    navbarLocalPath,
    editorLabel,
    hasSelectedProject,
    openSidebar: () => setSidebarOpen(true),
    closeSidebar: () => setSidebarOpen(false),
    collapseSidebar: () => setSidebarCollapsed(true),
    expandSidebar: () => setSidebarCollapsed(false),
    updateScrollState,
    scrollToBottom,
    handleCreateChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleCheckForUpdates,
    handleInstallUpdate,
    handleSend,
    handleCancel,
    handleDeleteChat,
    handleRemoveProject,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleExitPlanMode,
  }
}

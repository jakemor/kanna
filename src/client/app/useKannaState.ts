import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { PROVIDERS, type AgentProvider, type AskUserQuestionAnswerMap, type ChatUserMessage, type ModelOptions, type ProviderCatalogEntry } from "../../shared/types"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import type { ChatSnapshot, ChatUsageSnapshot, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
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

export function getProjectIdForChat(projectGroups: SidebarData["projectGroups"], chatId: string): string | null {
  return projectGroups.find((group) => group.chats.some((chat) => chat.chatId === chatId))?.groupKey ?? null
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

export function shouldPinTranscriptToBottom(distanceFromBottom: number) {
  return distanceFromBottom < 120
}

const FIXED_TRANSCRIPT_PADDING_BOTTOM = 320

export interface KannaState {
  socket: KannaSocket
  activeChatId: string | null
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  chatSnapshot: ChatSnapshot | null
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
  usage: ChatUsageSnapshot | null
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
  handleHideLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: { mode: "new" | "existing"; localPath: string; title: string }) => Promise<void>
  handleSend: (message: ChatUserMessage, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }) => Promise<void>
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
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
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
  const setRightSidebarVisibility = useRightSidebarStore((store) => store.setVisibility)

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
    if (!activeChatId) {
      setChatSnapshot(null)
      setChatReady(true)
      return
    }

    setChatReady(false)
    return socket.subscribe<ChatSnapshot | null>({ type: "chat", chatId: activeChatId }, (snapshot) => {
      setChatSnapshot(snapshot)
      setChatReady(true)
      setCommandError(null)
    })
  }, [activeChatId, socket])

  useEffect(() => {
    if (!activeChatId) return
    const projectId = getProjectIdForChat(sidebarData.projectGroups, activeChatId)
    if (!projectId) return
    setRightSidebarVisibility(projectId, false)
  }, [activeChatId, setRightSidebarVisibility, sidebarData.projectGroups])

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

  const messages = useMemo(() => processTranscriptMessages(chatSnapshot?.messages ?? []), [chatSnapshot?.messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const runtime = chatSnapshot?.runtime ?? null
  const usage = chatSnapshot?.usage ?? null
  const availableProviders = chatSnapshot?.availableProviders ?? PROVIDERS
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

  async function handleCreateChat(projectId: string) {
    try {
      setRightSidebarVisibility(projectId, false)
      const result = await socket.command<{ chatId: string }>({ type: "chat.create", projectId })
      setSelectedProjectId(projectId)
      setPendingChatId(result.chatId)
      navigate(`/chat/${result.chatId}`)
      setSidebarOpen(false)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleOpenLocalProject(localPath: string) {
    try {
      setStartingLocalPath(localPath)
      const result = await socket.command<{ projectId: string; chatId?: string | null }>({ type: "project.open", localPath })
      setRightSidebarVisibility(result.projectId, false)
      setSelectedProjectId(result.projectId)
      if (result.chatId) {
        setPendingChatId(result.chatId)
        navigate(`/chat/${result.chatId}`)
      } else {
        const chat = await socket.command<{ chatId: string }>({ type: "chat.create", projectId: result.projectId })
        setPendingChatId(chat.chatId)
        navigate(`/chat/${chat.chatId}`)
      }
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingLocalPath(null)
    }
  }

  async function handleHideLocalProject(localPath: string) {
    const projectName = localPath.split("/").filter(Boolean).pop() ?? localPath
    const confirmed = await dialog.confirm({
      title: "Hide Project",
      description: `Hide "${projectName}" from ${APP_NAME}? This only removes it from Kanna until you re-add it or reset local state.`,
      confirmLabel: "Hide",
      confirmVariant: "destructive",
    })
    if (!confirmed) return

    try {
      await socket.command({ type: "project.hide", localPath })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleCreateProject(project: { mode: "new" | "existing"; localPath: string; title: string }) {
    try {
      setStartingLocalPath(project.localPath)
      const result = await socket.command<{ projectId: string; chatId?: string | null }>(
        project.mode === "new"
          ? { type: "project.create", localPath: project.localPath, title: project.title }
          : { type: "project.open", localPath: project.localPath }
      )
      setRightSidebarVisibility(result.projectId, false)
      setSelectedProjectId(result.projectId)
      if (result.chatId) {
        setPendingChatId(result.chatId)
        navigate(`/chat/${result.chatId}`)
      } else {
        const chat = await socket.command<{ chatId: string }>({ type: "chat.create", projectId: result.projectId })
        setPendingChatId(chat.chatId)
        navigate(`/chat/${chat.chatId}`)
      }
      setSidebarOpen(false)
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingLocalPath(null)
    }
  }

  async function handleSend(
    message: ChatUserMessage,
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
        message,
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
      title: "Hide Project",
      description: `Hide "${projectName}" from ${APP_NAME}? Existing chats for this project will be removed from Kanna, but the project itself is not deleted.`,
      confirmLabel: "Hide",
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
    const projectId = selectedProjectId ?? sidebarData.projectGroups[0]?.groupKey
    if (projectId) {
      void handleCreateChat(projectId)
      return
    }

    const firstLocalProject = localProjects?.projects[0]?.localPath
    if (firstLocalProject) {
      void handleOpenLocalProject(firstLocalProject)
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
      useChatPreferencesStore.getState().setPlanMode(false)
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
    chatSnapshot,
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
    usage,
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
    handleHideLocalProject,
    handleCreateProject,
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

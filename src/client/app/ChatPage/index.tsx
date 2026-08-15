import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react"
import type { GroupImperativeHandle } from "react-resizable-panels"
import { useOutletContext } from "react-router-dom"
import type { ChatInputHandle } from "../../components/chat-ui/ChatInput"
import { ChatNavbar } from "../../components/chat-ui/ChatNavbar"
import { BrowserPanel } from "../../components/chat-ui/BrowserPanel"
import { GitPanel } from "../../components/chat-ui/GitPanel"
import { useAppDialog } from "../../components/ui/app-dialog"
import { Card, CardContent } from "../../components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../../components/ui/resizable"
import { actionMatchesEvent, getResolvedKeybindings } from "../../lib/keybindings"
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow"
import { cn } from "../../lib/utils"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "../../stores/rightSidebarStore"
import { useProjectRepoUrl } from "../../stores/sidebarStore"
import { DEFAULT_PROJECT_TERMINAL_LAYOUT, useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { useTranscriptDetail } from "../../stores/transcriptDetailStore"
import { shouldCloseTerminalPane } from "../terminalLayoutResize"
import { TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "../terminalToggleAnimation"
import { useRightSidebarToggleAnimation } from "../useRightSidebarToggleAnimation"
import { useStickyChatFocus } from "../useStickyChatFocus"
import { useTerminalToggleAnimation } from "../useTerminalToggleAnimation"
import type { AgentProvider, ChatSkillsSnapshot, TranscriptEntry } from "../../../shared/types"
import type { KannaState } from "../useKannaState"
import { getNextMeasuredInputHeight, getTranscriptPaddingBottom } from "../useKannaState"
import { ChatInputDock } from "./ChatInputDock"
import { DefaultModelsDialog } from "../../components/DefaultModelsDialog"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "./ChatTranscriptViewport"
import { TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { ToolPayloadProvider } from "../../components/messages/tool-payload-context"
import { createToolPayloadStore } from "./toolPayloadStore"
import { TerminalWorkspaceShell } from "./TerminalWorkspaceShell"
import { useChatPageSidebarActions, EMPTY_DIFF_SNAPSHOT } from "./useChatPageSidebarActions"
import { useTranscriptJumpRequest } from "./useTranscriptJumpRequest"
import {
  EMPTY_STATE_TEXT,
  EMPTY_STATE_TYPING_INTERVAL_MS,
  hasFileDragTypes,
  sameContextWindowSnapshot,
} from "./utils"

export {
  getIgnoreFolderEntryFromDiffPath,
  hasFileDragTypes,
  shouldAutoFollowTranscriptResize,
} from "./utils"

function useEmptyStateTyping(showEmptyState: boolean, activeChatId: string | null) {
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("")
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] = useState(false)

  useEffect(() => {
    if (!showEmptyState) return

    setTypedEmptyStateText("")
    setIsEmptyStateTypingComplete(false)

    let characterIndex = 0
    const interval = window.setInterval(() => {
      characterIndex += 1
      setTypedEmptyStateText(EMPTY_STATE_TEXT.slice(0, characterIndex))

      if (characterIndex >= EMPTY_STATE_TEXT.length) {
        window.clearInterval(interval)
        setIsEmptyStateTypingComplete(true)
      }
    }, EMPTY_STATE_TYPING_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [showEmptyState, activeChatId])

  return { typedEmptyStateText, isEmptyStateTypingComplete }
}

function usePageFileDrop(args: {
  hasSelectedProject: boolean
  onFilesDropped: (files: File[]) => void
}) {
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false)
  const pageFileDragDepthRef = useRef(0)

  const hasDraggedFiles = useCallback((event: DragEvent) => hasFileDragTypes(event.dataTransfer?.types ?? []), [])

  const handleTranscriptDragEnter = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current += 1
    setIsPageFileDragActive(true)
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDragOver = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    if (!isPageFileDragActive) {
      setIsPageFileDragActive(true)
    }
  }, [args.hasSelectedProject, hasDraggedFiles, isPageFileDragActive])

  const handleTranscriptDragLeave = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = Math.max(0, pageFileDragDepthRef.current - 1)
    if (pageFileDragDepthRef.current === 0) {
      setIsPageFileDragActive(false)
    }
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDrop = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = 0
    setIsPageFileDragActive(false)
    args.onFilesDropped([...event.dataTransfer.files])
  }, [args, hasDraggedFiles])

  return {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  }
}

function useLayoutWidth(ref: RefObject<HTMLDivElement | null>) {
  const [layoutWidth, setLayoutWidth] = useState(0)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const updateWidth = () => {
      const nextWidth = element.clientWidth
      setLayoutWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    updateWidth()

    return () => observer.disconnect()
  }, [ref])

  return layoutWidth
}

function useTranscriptPaddingBottom() {
  const inputRef = useRef<HTMLDivElement>(null)
  const [inputHeight, setInputHeight] = useState(148)

  const syncInputHeight = useCallback(() => {
    const element = inputRef.current
    if (!element) return
    const measuredHeight = element.getBoundingClientRect().height
    setInputHeight((current) => getNextMeasuredInputHeight(current, measuredHeight))
  }, [])

  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      syncInputHeight()
    })
    observer.observe(element)
    syncInputHeight()
    return () => observer.disconnect()
  }, [syncInputHeight])

  return {
    inputRef,
    syncInputHeight,
    transcriptPaddingBottom: getTranscriptPaddingBottom(inputHeight),
  }
}

const MOBILE_BREAKPOINT_PX = 768
const RIGHT_SIDEBAR_MIN_WORKSPACE_SIZE_PERCENT = 20
const RIGHT_SIDEBAR_MAX_SIZE_PERCENT = 100 - RIGHT_SIDEBAR_MIN_WORKSPACE_SIZE_PERCENT

/** The chat pane never shrinks past this, so it also fixes the terminal's ceiling. */
export const CHAT_MIN_SIZE_PERCENT = 25
export const MAX_TERMINAL_MAIN_SIZES: [number, number] = [CHAT_MIN_SIZE_PERCENT, 100 - CHAT_MIN_SIZE_PERCENT]

export function shouldUseMobileRightSidebarOverlay(viewportWidth: number) {
  return viewportWidth > 0 && viewportWidth < MOBILE_BREAKPOINT_PX
}

/**
 * Mobile pins the terminal to its ceiling: a 32%-tall pane on a phone is a few
 * usable rows, and the drag handle is too fine a target to fix that with. The
 * clamp is derived rather than written back to the store so the project keeps
 * whatever split it was given on a desktop.
 */
export function getEffectiveTerminalMainSizes(mainSizes: [number, number], clampToMax: boolean): [number, number] {
  return clampToMax ? MAX_TERMINAL_MAIN_SIZES : mainSizes
}

export function getRightSidebarSizePercent(sizePx: number, layoutWidth: number) {
  if (!Number.isFinite(sizePx) || !Number.isFinite(layoutWidth) || layoutWidth <= 0) {
    return 0
  }

  const minSizePercent = (RIGHT_SIDEBAR_MIN_WIDTH_PX / layoutWidth) * 100
  const requestedSizePercent = (Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, sizePx) / layoutWidth) * 100
  return Math.min(RIGHT_SIDEBAR_MAX_SIZE_PERCENT, Math.max(minSizePercent, requestedSizePercent))
}

export function getRightSidebarSizePx(sizePercent: number, layoutWidth: number) {
  if (!Number.isFinite(sizePercent) || !Number.isFinite(layoutWidth) || layoutWidth <= 0) {
    return DEFAULT_RIGHT_SIDEBAR_SIZE
  }

  return Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, layoutWidth * (sizePercent / 100))
}

function useIsMobileViewport() {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth))

  useEffect(() => {
    if (typeof window === "undefined") return

    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    updateViewportWidth()
    window.addEventListener("resize", updateViewportWidth)
    return () => window.removeEventListener("resize", updateViewportWidth)
  }, [])

  return shouldUseMobileRightSidebarOverlay(viewportWidth)
}

function useFixedTerminalHeight(args: {
  layoutRootRef: RefObject<HTMLDivElement | null>
  shouldRenderTerminalLayout: boolean
  terminalMainSizes: [number, number]
}) {
  const [fixedTerminalHeight, setFixedTerminalHeight] = useState(0)

  useEffect(() => {
    const element = args.layoutRootRef.current
    if (!element) return

    const updateHeight = () => {
      const containerHeight = element.getBoundingClientRect().height

      if (!args.shouldRenderTerminalLayout) {
        return
      }

      if (containerHeight <= 0) return
      const nextHeight = containerHeight * (args.terminalMainSizes[1] / 100)
      if (nextHeight <= 0) return
      setFixedTerminalHeight((current) => (Math.abs(current - nextHeight) < 1 ? current : nextHeight))
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()

    return () => observer.disconnect()
  }, [args.layoutRootRef, args.shouldRenderTerminalLayout, args.terminalMainSizes])

  return fixedTerminalHeight
}

interface ChatWorkspaceProps {
  chatCard: ReactNode
  projectId: string
  shouldRenderTerminalLayout: boolean
  showTerminalPane: boolean
  clampTerminalToMaxHeight: boolean
  terminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["projects"][string]
  mainPanelGroupRef: RefObject<GroupImperativeHandle | null>
  terminalPanelRef: RefObject<HTMLDivElement | null>
  terminalVisualRef: RefObject<HTMLDivElement | null>
  fixedTerminalHeight: number
  terminalFocusRequestVersion: number
  addTerminal: ReturnType<typeof useTerminalLayoutStore.getState>["addTerminal"]
  socket: KannaState["socket"]
  connectionStatus: KannaState["connectionStatus"]
  scrollback: number
  minColumnWidth: number
  splitTerminalShortcut?: string[]
  pendingCommandsByTerminalId?: Record<string, string>
  onTerminalCommandSent?: () => void
  onInitialTerminalCommandSent?: (terminalId: string) => void
  onRemoveTerminal: (projectId: string, terminalId: string) => void
  onTerminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["setTerminalSizes"]
  onLayoutChanged: (layout: Record<string, number>) => void
}

type ChatSidebarContentProps = ComponentProps<typeof GitPanel>

const ChatSidebarContent = memo(function ChatSidebarContent(props: ChatSidebarContentProps) {
  return (
    <GitPanel
      {...props}
      diffs={props.diffs ?? EMPTY_DIFF_SNAPSHOT}
    />
  )
})

export function getTerminalPanelDefaultSizes(showTerminalPane: boolean, mainSizes: [number, number]): [number, number] {
  return showTerminalPane ? mainSizes : [100, 0]
}

interface DesktopSidebarPaneProps {
  showRightSidebar: boolean
  sizePercent: number
  sidebarPanelRef: RefObject<HTMLDivElement | null>
  sidebarVisualRef: RefObject<HTMLDivElement | null>
  content: ReactNode
}

const DesktopSidebarPane = memo(function DesktopSidebarPane({
  showRightSidebar,
  sizePercent,
  sidebarPanelRef,
  sidebarVisualRef,
  content,
}: DesktopSidebarPaneProps) {
  return (
    <ResizablePanel
      id="rightSidebar"
      defaultSize={`${sizePercent}%`}
      className="min-h-0 min-w-0"
      elementRef={sidebarPanelRef}
      groupResizeBehavior="preserve-pixel-size"
    >
      <div
        ref={sidebarVisualRef}
        className="h-full min-h-0 overflow-hidden"
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
        style={{
          "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
        } as CSSProperties}
      >
        {content}
      </div>
    </ResizablePanel>
  )
})

interface MobileSidebarPaneProps {
  projectId: string | null
  showRightSidebar: boolean
  sidebarVisualRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  content: ReactNode
}

const MobileSidebarPane = memo(function MobileSidebarPane({
  projectId,
  showRightSidebar,
  sidebarVisualRef,
  onClose,
  content,
}: MobileSidebarPaneProps) {
  if (!projectId) {
    return null
  }

  return (
    <div
      className={cn(
        "absolute inset-0 z-40 transition-opacity duration-300 ease-out",
        showRightSidebar ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      aria-hidden={showRightSidebar ? undefined : true}
      data-mobile-right-sidebar-overlay
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Close changes sidebar"
        onClick={onClose}
      />
      <div
        ref={sidebarVisualRef}
        className={cn(
          "absolute inset-y-0 right-0 flex w-[min(92vw,30rem)] max-w-full min-h-0 flex-col overflow-hidden border-l border-border bg-background shadow-2xl transition-transform duration-300 ease-out",
          "pt-[max(env(safe-area-inset-top),0px)] pb-[max(env(safe-area-inset-bottom),0px)]",
          showRightSidebar ? "translate-x-0" : "translate-x-full",
        )}
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
      >
        {content}
      </div>
    </div>
  )
})

function ChatWorkspace({
  chatCard,
  projectId,
  shouldRenderTerminalLayout,
  showTerminalPane,
  clampTerminalToMaxHeight,
  terminalLayout,
  mainPanelGroupRef,
  terminalPanelRef,
  terminalVisualRef,
  fixedTerminalHeight,
  terminalFocusRequestVersion,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  pendingCommandsByTerminalId,
  onTerminalCommandSent,
  onInitialTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
  onLayoutChanged,
}: ChatWorkspaceProps) {
  if (!shouldRenderTerminalLayout) {
    return <>{chatCard}</>
  }

  const terminalPanelDefaultSizes = getTerminalPanelDefaultSizes(showTerminalPane, terminalLayout.mainSizes)

  return (
    <ResizablePanelGroup
      key={projectId}
      groupRef={mainPanelGroupRef}
      orientation="vertical"
      className="flex-1 min-h-0"
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel id="chat" defaultSize={`${terminalPanelDefaultSizes[0]}%`} minSize={`${CHAT_MIN_SIZE_PERCENT}%`} className="min-h-0">
        {chatCard}
      </ResizablePanel>
      <ResizableHandle
        // Nothing to drag to when the terminal is pinned at its ceiling; the
        // pane's own close button is the way out on mobile.
        withHandle={!clampTerminalToMaxHeight}
        orientation="vertical"
        disabled={!showTerminalPane || clampTerminalToMaxHeight}
        className={cn(!showTerminalPane && "pointer-events-none opacity-0")}
      />
      <ResizablePanel
        id="terminal"
        defaultSize={`${terminalPanelDefaultSizes[1]}%`}
        minSize="0%"
        className="min-h-0"
        elementRef={terminalPanelRef}
      >
        <div
          ref={terminalVisualRef}
          className="h-full min-h-0 overflow-hidden relative"
          data-terminal-open={showTerminalPane ? "true" : "false"}
          data-terminal-animated="false"
          data-terminal-visual
          style={{
            "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
          } as CSSProperties}
        >
          <TerminalWorkspaceShell
            projectId={projectId}
            fixedTerminalHeight={fixedTerminalHeight}
            terminalLayout={terminalLayout}
            addTerminal={addTerminal}
            socket={socket}
            connectionStatus={connectionStatus}
            scrollback={scrollback}
            minColumnWidth={minColumnWidth}
            splitTerminalShortcut={splitTerminalShortcut}
            pendingCommandsByTerminalId={pendingCommandsByTerminalId}
            focusRequestVersion={terminalFocusRequestVersion}
            onTerminalCommandSent={onTerminalCommandSent}
            onInitialTerminalCommandSent={onInitialTerminalCommandSent}
            onRemoveTerminal={onRemoveTerminal}
            onTerminalLayout={onTerminalLayout}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

export function ChatPage() {
  const state = useOutletContext<KannaState>()
  const dialog = useAppDialog()
  const layoutRootRef = useRef<HTMLDivElement>(null)
  const transcriptListRef = useRef<TranscriptScrollHandle | null>(null)
  const isAtEndRef = useRef(true)
  const showScrollTimeoutRef = useRef<number | null>(null)
  const chatCardRef = useRef<HTMLDivElement>(null)
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const { inputRef, syncInputHeight, transcriptPaddingBottom } = useTranscriptPaddingBottom()
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [pendingTerminalCommands, setPendingTerminalCommands] = useState<Record<string, string>>({})
  const [defaultModelsDialogOpen, setDefaultModelsDialogOpen] = useState(false)
  const showEmptyState = state.messages.length === 0 && state.runtime?.title === "New Chat"
  const transcriptDetail = useTranscriptDetail(state.activeChatId)
  const projectId = state.activeProjectId
  const projectTerminalLayout = useTerminalLayoutStore((store) => (projectId ? store.projects[projectId] : undefined))
  const storedTerminalLayout = projectTerminalLayout ?? DEFAULT_PROJECT_TERMINAL_LAYOUT
  const projectRightSidebarVisibility = useRightSidebarStore((store) => (projectId ? store.projects[projectId] : undefined))
  const rightSidebarVisibility = projectRightSidebarVisibility ?? DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE
  const globalRightSidebarSize = useRightSidebarStore((store) => store.size)
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const toggleVisibility = useTerminalLayoutStore((store) => store.toggleVisibility)
  const hideTerminals = useTerminalLayoutStore((store) => store.hideTerminals)
  const resetMainSizes = useTerminalLayoutStore((store) => store.resetMainSizes)
  const setMainSizes = useTerminalLayoutStore((store) => store.setMainSizes)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)
  const toggleRightPanel = useRightSidebarStore((store) => store.togglePanel)
  const hideRightPanel = useRightSidebarStore((store) => store.hidePanel)
  const setRightSidebarSize = useRightSidebarStore((store) => store.setSize)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const baseContextWindowSnapshotRef = useRef<ReturnType<typeof deriveLatestContextWindowSnapshot>>(null)
  const contextWindowSnapshot = useMemo(() => {
    const derivedSnapshot = deriveLatestContextWindowSnapshot(state.chatSnapshot?.messages ?? [])
    const previousSnapshot = baseContextWindowSnapshotRef.current
    if (sameContextWindowSnapshot(previousSnapshot, derivedSnapshot)) {
      return previousSnapshot
    }
    baseContextWindowSnapshotRef.current = derivedSnapshot
    return derivedSnapshot
  }, [state.chatSnapshot?.messages])

  const isMobileViewport = useIsMobileViewport()
  const terminalLayout = useMemo(() => {
    const mainSizes = getEffectiveTerminalMainSizes(storedTerminalLayout.mainSizes, isMobileViewport)
    return mainSizes === storedTerminalLayout.mainSizes ? storedTerminalLayout : { ...storedTerminalLayout, mainSizes }
  }, [isMobileViewport, storedTerminalLayout])
  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && terminalLayout.isVisible && hasTerminals)
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals)
  const activeRightPanel = projectId ? rightSidebarVisibility.rightPanel : "hidden"
  const showRightSidebar = Boolean(projectId && activeRightPanel !== "hidden")
  const showGitPanel = Boolean(projectId && activeRightPanel === "git")
  const shouldRenderRightSidebarLayout = Boolean(projectId)
  const shouldRenderDesktopRightSidebarLayout = shouldRenderRightSidebarLayout && !isMobileViewport
  const layoutWidth = useLayoutWidth(layoutRootRef)
  const effectiveRightSidebarSize = getRightSidebarSizePercent(
    globalRightSidebarSize ?? DEFAULT_RIGHT_SIDEBAR_SIZE,
    layoutWidth,
  )
  const fixedTerminalHeight = useFixedTerminalHeight({
    layoutRootRef,
    shouldRenderTerminalLayout,
    terminalMainSizes: terminalLayout.mainSizes,
  })

  const {
    isAnimating: isTerminalAnimating,
    mainPanelGroupRef,
    terminalFocusRequestVersion,
    terminalPanelRef,
    terminalVisualRef,
  } = useTerminalToggleAnimation({
    showTerminalPane,
    shouldRenderTerminalLayout,
    projectId,
    terminalLayout,
    chatInputRef: chatInputElementRef,
  })
  const {
    isAnimating: isRightSidebarAnimating,
    panelGroupRef: rightSidebarPanelGroupRef,
    sidebarPanelRef,
    sidebarVisualRef,
  } = useRightSidebarToggleAnimation({
    projectId,
    shouldRenderRightSidebarLayout: shouldRenderDesktopRightSidebarLayout,
    showRightSidebar,
    rightSidebarSizePercent: effectiveRightSidebarSize,
  })

  const {
    diffRenderMode,
    wrapDiffLines,
    setDiffRenderMode,
    setWrapDiffLines,
    scheduleTerminalDiffRefresh,
    handleOpenDiffFile,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleLoadDiffPatch,
    handleDiscardDiffFile,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleOpenDiffInFinder,
    handleCommitDiffs,
    handleSyncBranch,
    handleGenerateCommitMessage,
    handleInitializeGit,
    handleGetGitHubPublishInfo,
    handleCheckGitHubRepoAvailability,
    handleSetupGitHub,
    handleListBranches,
    handleCheckoutBranch,
    handlePreviewMergeBranch,
    handleMergeBranch,
    handleCreateBranch,
  } = useChatPageSidebarActions({
    state,
    projectId,
    showRightSidebar: showGitPanel,
  })

  const { typedEmptyStateText, isEmptyStateTypingComplete } = useEmptyStateTyping(showEmptyState, state.activeChatId)

  // Read off the sidebar snapshot rather than the git one: the sidebar carries
  // a resolved forge URL for every project, while `project-git` only knows a
  // GitHub slug and only for the project currently subscribed.
  const activeProjectRepoUrl = useProjectRepoUrl(projectId)

  // "Open this chat at this message", carried in router state by the sidebar's
  // hover card. Held here rather than read in the viewport so the viewport
  // stays a pure consumer of props and the export viewer, which has no router,
  // simply never passes one.
  const { jumpRequest, onJumpRequestHandled } = useTranscriptJumpRequest()

  useStickyChatFocus({
    rootRef: chatCardRef,
    fallbackRef: chatInputElementRef,
    enabled: state.hasSelectedProject,
    canCancel: state.canCancel,
  })

  const enqueueDroppedFiles = useCallback((files: File[]) => {
    if (!state.hasSelectedProject || files.length === 0) {
      return
    }
    chatInputRef.current?.enqueueFiles(files)
  }, [state.hasSelectedProject])

  const {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  } = usePageFileDrop({
    hasSelectedProject: state.hasSelectedProject,
    onFilesDropped: enqueueDroppedFiles,
  })

  const handleToggleEmbeddedTerminal = useCallback(() => {
    if (!projectId) return
    if (hasTerminals) {
      toggleVisibility(projectId)
      return
    }

    addTerminal(projectId)
  }, [addTerminal, hasTerminals, projectId, toggleVisibility])

  const handleTerminalResize = useCallback((layout: Record<string, number>) => {
    if (!projectId || !showTerminalPane || isTerminalAnimating.current) {
      return
    }

    // Mobile pins the pane to its ceiling, so any layout event here is the clamp
    // settling rather than the user resizing — persisting it would overwrite the
    // split this project was given on a desktop.
    if (isMobileViewport) {
      return
    }

    const chatSize = layout.chat
    const terminalSize = layout.terminal
    if (!Number.isFinite(chatSize) || !Number.isFinite(terminalSize)) {
      return
    }

    const containerHeight = layoutRootRef.current?.getBoundingClientRect().height ?? 0
    if (shouldCloseTerminalPane(containerHeight, terminalSize)) {
      resetMainSizes(projectId)
      toggleVisibility(projectId)
      return
    }

    setMainSizes(projectId, [chatSize, terminalSize])
  }, [isMobileViewport, isTerminalAnimating, projectId, resetMainSizes, setMainSizes, showTerminalPane, toggleVisibility])

  const handleCloseRightSidebar = useCallback(() => {
    if (!projectId) return
    hideRightPanel(projectId)
  }, [hideRightPanel, projectId])

  const handleToggleGitPanel = useCallback(() => {
    if (!projectId) return

    if (activeRightPanel === "git") {
      hideRightPanel(projectId)
      return
    }

    if (state.chatDiffSnapshot?.status === "no_repo") {
      void (async () => {
        const confirmed = await dialog.confirm({
          title: "Initialize Git?",
          description: "Initialize a local git repository in this project?",
          confirmLabel: "Init Git",
          cancelLabel: "Cancel",
        })
        if (!confirmed) return

        const result = await handleInitializeGit()
        if (result?.ok) {
          toggleRightPanel(projectId, "git")
        }
      })()
      return
    }

    toggleRightPanel(projectId, "git")
  }, [activeRightPanel, dialog, handleInitializeGit, hideRightPanel, projectId, state.chatDiffSnapshot?.status, toggleRightPanel])

  const handleToggleBrowserPanel = useCallback(() => {
    if (!projectId) return
    toggleRightPanel(projectId, "browser")
  }, [projectId, toggleRightPanel])

  const handleRunQuickAction = useCallback((command: string) => {
    if (!projectId) return
    const terminalId = addTerminal(projectId)
    setPendingTerminalCommands((current) => ({
      ...current,
      [terminalId]: command,
    }))
  }, [addTerminal, projectId])

  const handleInitialTerminalCommandSent = useCallback((terminalId: string) => {
    setPendingTerminalCommands((current) => {
      if (!(terminalId in current)) return current
      const { [terminalId]: _sent, ...rest } = current
      return rest
    })
  }, [])

  const handleCancel = useCallback(() => {
    void state.handleCancel()
  }, [state.handleCancel])

  const handleOpenExternal = useCallback<NonNullable<ComponentProps<typeof ChatNavbar>["onOpenExternal"]>>((action, editor) => {
    void state.handleOpenExternal(action, editor)
  }, [state.handleOpenExternal])

  // Stable so the memoized navbar can actually skip a render; an inline arrow
  // here would be a new prop on every streamed entry.
  const handleExportTranscript = useCallback(() => {
    void state.handleShareChat(state.activeChatId)
  }, [state.activeChatId, state.handleShareChat])

  const handleRemoveTerminal = useCallback((currentProjectId: string, terminalId: string) => {
    const paneCount = useTerminalLayoutStore.getState().projects[currentProjectId]?.terminals.length ?? 0
    if (paneCount <= 1) {
      // Closing the only pane hides the panel instead of killing the shell:
      // the pane stays mounted, so reopening returns to the same session and
      // scrollback with whatever was running still running.
      hideTerminals(currentProjectId)
      return
    }

    // A split pane is unreachable once removed, so closing it does kill it.
    void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
    removeTerminal(currentProjectId, terminalId)
  }, [hideTerminals, removeTerminal, state.socket])

  const clearShowScrollTimeout = useCallback(() => {
    if (showScrollTimeoutRef.current !== null) {
      window.clearTimeout(showScrollTimeoutRef.current)
      showScrollTimeoutRef.current = null
    }
  }, [])

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return
    isAtEndRef.current = isAtEnd
    if (isAtEnd) {
      clearShowScrollTimeout()
      setShowScrollToBottom(false)
      return
    }

    clearShowScrollTimeout()
    showScrollTimeoutRef.current = window.setTimeout(() => {
      setShowScrollToBottom(true)
      showScrollTimeoutRef.current = null
    }, 150)
  }, [clearShowScrollTimeout])

  const scrollToTranscriptEnd = useCallback(() => {
    isAtEndRef.current = true
    clearShowScrollTimeout()
    setShowScrollToBottom(false)
    transcriptListRef.current?.scrollToEnd()
  }, [clearShowScrollTimeout])

  const handleChatSubmit = useCallback(async (
    content: string,
    options?: Parameters<typeof state.handleSend>[1],
  ) => {
    // No scroll here: the transcript pins the new prompt to the top of the
    // viewport once it renders (see ChatTranscriptViewport's pin effect).
    await state.handleSend(content, options)
  }, [state.handleSend])

  const handleListSkills = useCallback(
    (provider: AgentProvider) =>
      state.socket.command<ChatSkillsSnapshot>({
        type: "chat.listSkills",
        provider,
        chatId: state.activeChatId ?? undefined,
        projectId: projectId ?? undefined,
      }),
    [state.socket, state.activeChatId, projectId]
  )

  // Snapshots omit `debugRaw` (it duplicates `content` and dominated the
  // payload), so the raw JSON view pulls one entry's payload when expanded.
  const loadEntryDebugRaw = useCallback(
    async (entryId: string) => {
      if (!state.activeChatId) return null
      return await state.socket.command<string | null>({
        type: "chat.getEntryDebugRaw",
        chatId: state.activeChatId,
        entryId,
      })
    },
    [state.socket, state.activeChatId]
  )

  const transcriptRenderOptions = useMemo(() => ({ loadEntryDebugRaw }), [loadEntryDebugRaw])

  // One cache per chat: entry ids are chat-scoped, and leaving a chat should
  // not keep its payloads resident.
  const toolPayloadStore = useMemo(
    () => createToolPayloadStore(async (entryIds) => {
      if (!state.activeChatId) return []
      return await state.socket.command<TranscriptEntry[]>({
        type: "chat.getToolEntries",
        chatId: state.activeChatId,
        entryIds,
      }) ?? []
    }),
    [state.socket, state.activeChatId]
  )

  useEffect(() => {
    return () => clearShowScrollTimeout()
  }, [clearShowScrollTimeout])

  useEffect(() => {
    isAtEndRef.current = true
    clearShowScrollTimeout()
    setShowScrollToBottom(false)
  }, [clearShowScrollTimeout, state.activeChatId])

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      if (!projectId) return
      if (actionMatchesEvent(resolvedKeybindings, "toggleEmbeddedTerminal", event)) {
        event.preventDefault()
        handleToggleEmbeddedTerminal()
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "toggleRightSidebar", event)) {
        event.preventDefault()
        handleToggleGitPanel()
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInFinder", event)) {
        event.preventDefault()
        void state.handleOpenExternal("open_finder")
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInEditor", event)) {
        event.preventDefault()
        void state.handleOpenExternal("open_editor")
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "addSplitTerminal", event)) {
        event.preventDefault()
        addTerminal(projectId)
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [addTerminal, handleToggleEmbeddedTerminal, handleToggleGitPanel, projectId, resolvedKeybindings, state.handleOpenExternal])

  // Re-checking "is the reader at the end" after a terminal toggle or a window
  // resize used to live here. The transcript observes its own element now, so
  // it sees those the moment they change the scroll box.

  useEffect(() => {
    if (!showRightSidebar || !isMobileViewport) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isMobileViewport, showRightSidebar])

  useEffect(() => {
    if (!showRightSidebar || !isMobileViewport) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      handleCloseRightSidebar()
    }

    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [handleCloseRightSidebar, isMobileViewport, showRightSidebar])

  // Following the stream is the list's job, via `maintainScrollAtEnd`. This
  // used to also force two `scrollToEnd`s per frame on message/status churn,
  // which meant three actors could move the scroll position in the same frame
  // — the list on item layout, this effect on state change, and the restore
  // pass on open. They disagreed about what counted as "at the end", so the
  // losing ones fought the winner and the result read as jitter.

  useLayoutEffect(() => {
    if (!showRightSidebar || isMobileViewport || layoutWidth <= 0 || isRightSidebarAnimating.current) {
      return
    }

    const clampedRightSidebarSize = getRightSidebarSizePercent(globalRightSidebarSize, layoutWidth)
    const currentLayout = rightSidebarPanelGroupRef.current?.getLayout()
    if (!currentLayout) return
    if (Math.abs((currentLayout.rightSidebar ?? 0) - clampedRightSidebarSize) < 0.1) {
      return
    }

    rightSidebarPanelGroupRef.current?.setLayout({
      workspace: 100 - clampedRightSidebarSize,
      rightSidebar: clampedRightSidebarSize,
    })
  }, [
    globalRightSidebarSize,
    isRightSidebarAnimating,
    layoutWidth,
    rightSidebarPanelGroupRef,
    showRightSidebar,
    isMobileViewport,
  ])

  const chatCard = (
    <Card
      ref={chatCardRef}
      className="bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative"
      onDragEnter={handleTranscriptDragEnter}
      onDragOver={handleTranscriptDragOver}
      onDragLeave={handleTranscriptDragLeave}
      onDrop={handleTranscriptDrop}
    >
      <CardContent className="flex flex-1 min-h-0 flex-col overflow-hidden p-0 relative">
        <ChatNavbar
          sidebarCollapsed={state.sidebarCollapsed}
          onOpenSidebar={state.openSidebar}
          onExpandSidebar={state.expandSidebar}
          onNewChat={state.handleCompose}
          localPath={state.navbarLocalPath}
          embeddedTerminalVisible={showTerminalPane}
          onToggleEmbeddedTerminal={projectId ? handleToggleEmbeddedTerminal : undefined}
          rightPanel={activeRightPanel}
          onToggleGitPanel={projectId ? handleToggleGitPanel : undefined}
          onToggleBrowserPanel={projectId ? handleToggleBrowserPanel : undefined}
          onOpenExternal={handleOpenExternal}
          onExportTranscript={state.activeChatId ? handleExportTranscript : undefined}
          canExportTranscript={Boolean(state.activeChatId) && !state.isExportingStandalone}
          isExportingTranscript={state.isExportingStandalone}
          exportTranscriptComplete={state.standaloneShareComplete}
          editorPreset={editorPreset}
          editorCommandTemplate={editorCommandTemplate}
          platform={state.localProjects?.machine.platform}
          finderShortcut={resolvedKeybindings.bindings.openInFinder}
          editorShortcut={resolvedKeybindings.bindings.openInEditor}
          terminalShortcut={resolvedKeybindings.bindings.toggleEmbeddedTerminal}
          rightSidebarShortcut={resolvedKeybindings.bindings.toggleRightSidebar}
          branchName={state.chatDiffSnapshot?.branchName}
          repoUrl={activeProjectRepoUrl}
          hasGitRepo={state.chatDiffSnapshot?.status !== "no_repo"}
          gitStatus={state.chatDiffSnapshot?.status}
        />
        <TranscriptRenderOptionsProvider value={transcriptRenderOptions}>
        <ToolPayloadProvider store={toolPayloadStore}>
        <ChatTranscriptViewport
          activeChatId={state.activeChatId}
          listRef={transcriptListRef}
          messages={state.messages}
          queuedMessages={state.queuedMessages}
          transcriptPaddingBottom={transcriptPaddingBottom}
          localPath={state.runtime?.localPath}
          latestToolIds={state.latestToolIds}
          transcriptDetail={transcriptDetail}
          isProcessing={state.isProcessing}
          runtimeStatus={state.runtimeStatus}
          isDraining={state.isDraining}
          commandError={state.commandError}
          onStopDraining={state.handleStopDraining}
          onSteerQueuedMessage={state.handleSteerQueuedMessage}
          onRemoveQueuedMessage={state.handleRemoveQueuedMessage}
          onOpenLocalLink={state.handleOpenLocalLink}
          editorPreset={editorPreset}
          editorCommandTemplate={editorCommandTemplate}
          platform={state.localProjects?.machine.platform}
          onAskUserQuestionSubmit={state.handleAskUserQuestion}
          onExitPlanModeConfirm={state.handleExitPlanMode}
          showScrollButton={showScrollToBottom && state.messages.length > 0}
          onIsAtEndChange={onIsAtEndChange}
          readAnchorState={state.readAnchorState}
          onReportReadAnchor={state.reportReadAnchor}
          jumpRequest={jumpRequest}
          onJumpRequestHandled={onJumpRequestHandled}
          scrollToBottom={scrollToTranscriptEnd}
          typedEmptyStateText={typedEmptyStateText}
          isEmptyStateTypingComplete={isEmptyStateTypingComplete}
          isPageFileDragActive={isPageFileDragActive}
          showEmptyState={showEmptyState}
          socket={state.socket}
          emptyStateProjectPath={state.navbarLocalPath}
          onOpenProjectExternal={handleOpenExternal}
          scrollbarGutterHostRef={chatCardRef}
        />
        </ToolPayloadProvider>
        </TranscriptRenderOptionsProvider>
      </CardContent>

      <ChatInputDock
        inputRef={inputRef}
        onLayoutChange={syncInputHeight}
        chatInputRef={chatInputRef}
        chatInputElementRef={chatInputElementRef}
        activeChatId={state.activeChatId}
        previousPrompt={state.previousPrompt}
        hasSelectedProject={state.hasSelectedProject}
        runtimeStatus={state.runtimeStatus}
        canCancel={state.canCancel}
        projectId={projectId}
        projectPath={state.navbarLocalPath ?? null}
        projectRepoLabel={state.navbarRepoLabel}
        activeProvider={state.runtime?.provider ?? null}
        availableProviders={state.availableProviders}
        contextWindowSnapshot={contextWindowSnapshot}
        onSubmit={handleChatSubmit}
        onCancel={handleCancel}
        onEditModels={() => setDefaultModelsDialogOpen(true)}
        onListSkills={handleListSkills}
      />
      <DefaultModelsDialog
        open={defaultModelsDialogOpen}
        onOpenChange={setDefaultModelsDialogOpen}
        faveModels={state.llmProvider?.faveModels ?? []}
        onSave={(faveModels) => {
          void state.handleWriteFaveModels(faveModels)
        }}
      />
    </Card>
  )

  const workspace = projectId ? (
    <ChatWorkspace
      chatCard={chatCard}
      projectId={projectId}
      shouldRenderTerminalLayout={shouldRenderTerminalLayout}
      showTerminalPane={showTerminalPane}
      clampTerminalToMaxHeight={isMobileViewport}
      terminalLayout={terminalLayout}
      mainPanelGroupRef={mainPanelGroupRef}
      terminalPanelRef={terminalPanelRef}
      terminalVisualRef={terminalVisualRef}
      fixedTerminalHeight={fixedTerminalHeight}
      terminalFocusRequestVersion={terminalFocusRequestVersion}
      addTerminal={addTerminal}
      socket={state.socket}
      connectionStatus={state.connectionStatus}
      scrollback={scrollback}
      minColumnWidth={minColumnWidth}
      splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
      pendingCommandsByTerminalId={pendingTerminalCommands}
      onTerminalCommandSent={scheduleTerminalDiffRefresh}
      onInitialTerminalCommandSent={handleInitialTerminalCommandSent}
      onRemoveTerminal={handleRemoveTerminal}
      onTerminalLayout={setTerminalSizes}
      onLayoutChanged={handleTerminalResize}
    />
  ) : (
    chatCard
  )

  const gitPanelContentProps = useMemo<ComponentProps<typeof ChatSidebarContent> | null>(() => {
    if (!projectId) {
      return null
    }

    return {
      projectId,
      diffs: state.chatDiffSnapshot ?? EMPTY_DIFF_SNAPSHOT,
      editorLabel: state.editorLabel,
      diffRenderMode,
      wrapLines: wrapDiffLines,
      onOpenFile: handleOpenDiffFile,
      onOpenInFinder: handleOpenDiffInFinder,
      onDiscardFile: handleDiscardDiffFile,
      onIgnoreFile: handleIgnoreDiffFile,
      onIgnoreFolder: handleIgnoreDiffFolder,
      onCopyFilePath: handleCopyDiffFilePath,
      onCopyRelativePath: handleCopyDiffRelativePath,
      onLoadPatch: handleLoadDiffPatch,
      onListBranches: handleListBranches,
      onPreviewMergeBranch: handlePreviewMergeBranch,
      onMergeBranch: handleMergeBranch,
      onCheckoutBranch: handleCheckoutBranch,
      onCreateBranch: handleCreateBranch,
      onGenerateCommitMessage: handleGenerateCommitMessage,
      onInitializeGit: handleInitializeGit,
      onGetGitHubPublishInfo: handleGetGitHubPublishInfo,
      onCheckGitHubRepoAvailability: handleCheckGitHubRepoAvailability,
      onSetupGitHub: handleSetupGitHub,
      onCommit: handleCommitDiffs,
      onSyncWithRemote: handleSyncBranch,
      onDiffRenderModeChange: setDiffRenderMode,
      onWrapLinesChange: setWrapDiffLines,
      onClose: handleCloseRightSidebar,
    }
  }, [
    diffRenderMode,
    handleCheckGitHubRepoAvailability,
    handleCheckoutBranch,
    handleCloseRightSidebar,
    handleCommitDiffs,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleCreateBranch,
    handleDiscardDiffFile,
    handleGenerateCommitMessage,
    handleGetGitHubPublishInfo,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleInitializeGit,
    handleListBranches,
    handleLoadDiffPatch,
    handleMergeBranch,
    handleOpenDiffFile,
    handleOpenDiffInFinder,
    handlePreviewMergeBranch,
    handleSetupGitHub,
    handleSyncBranch,
    projectId,
    setDiffRenderMode,
    setWrapDiffLines,
    state.chatDiffSnapshot,
    state.editorLabel,
    wrapDiffLines,
  ])
  const rightPanelContent = activeRightPanel === "browser" && projectId
    ? <BrowserPanel projectId={projectId} socket={state.socket} onClose={handleCloseRightSidebar} onRunQuickAction={handleRunQuickAction} />
    : gitPanelContentProps
      ? <ChatSidebarContent {...gitPanelContentProps} />
      : null

  return (
    <div ref={layoutRootRef} className="flex-1 flex flex-col min-w-0 relative">
      {shouldRenderDesktopRightSidebarLayout && projectId ? (
        <ResizablePanelGroup
          key={`${projectId}-right-sidebar`}
          groupRef={rightSidebarPanelGroupRef}
          orientation="horizontal"
          className="flex-1 min-h-0"
          onLayoutChange={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return
            }

            const clampedRightSidebarSize = getRightSidebarSizePercent(
              getRightSidebarSizePx(layout.rightSidebar, layoutWidth),
              layoutWidth,
            )
            if (Math.abs(clampedRightSidebarSize - layout.rightSidebar) < 0.1) {
              return
            }

            rightSidebarPanelGroupRef.current?.setLayout({
              workspace: 100 - clampedRightSidebarSize,
              rightSidebar: clampedRightSidebarSize,
            })
          }}
          onLayoutChanged={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return
            }

            setRightSidebarSize(getRightSidebarSizePx(layout.rightSidebar, layoutWidth))
          }}
        >
          <ResizablePanel
            id="workspace"
            defaultSize={`${100 - effectiveRightSidebarSize}%`}
            minSize="20%"
            className="min-h-0 min-w-0"
            groupResizeBehavior="preserve-relative-size"
          >
            {workspace}
          </ResizablePanel>
          <ResizableHandle
            withHandle={false}
            orientation="horizontal"
            disabled={!showRightSidebar}
            className={cn(!showRightSidebar && "pointer-events-none opacity-0")}
          />
          <DesktopSidebarPane
            showRightSidebar={showRightSidebar}
            sizePercent={effectiveRightSidebarSize}
            sidebarPanelRef={sidebarPanelRef}
            sidebarVisualRef={sidebarVisualRef}
            content={rightPanelContent}
          />
        </ResizablePanelGroup>
      ) : (
        workspace
      )}
      {isMobileViewport ? (
        <MobileSidebarPane
          projectId={projectId}
          showRightSidebar={showRightSidebar}
          sidebarVisualRef={sidebarVisualRef}
          onClose={handleCloseRightSidebar}
          content={rightPanelContent}
        />
      ) : null}
    </div>
  )
}

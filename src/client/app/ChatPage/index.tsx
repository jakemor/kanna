import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react"
import type { GroupImperativeHandle } from "react-resizable-panels"
import { flushSync } from "react-dom"
import { useLocation, useNavigate, useOutletContext } from "react-router-dom"
import type { ChatInputHandle } from "../../components/chat-ui/ChatInput"
import { ChatNavbar, ChatNavbarWash } from "../../components/chat-ui/ChatNavbar"
import { ChatNavbarTitle } from "../../components/chat-ui/ChatNavbarTitle"
import { ChatTabs } from "../../components/chat-ui/ChatTabs"
import { SidebarChatHoverCard } from "../../components/chat-ui/sidebar/ChatHoverCard"
import type { SidebarThread } from "../../lib/thread-sections"
import type { ThreadRowMenuActions } from "../../components/chat-ui/sidebar/ThreadRow"
import { WidgetsSidebar } from "../../components/chat-ui/widgets/WidgetsSidebar"
import { scheduleEditPrompt } from "../../components/chat-ui/widgets/SchedulesWidget"
import { ChatReferenceProvider, ChatSchedulesProvider, type ChatReferenceActions, type ChatSchedulesValue } from "../../components/chat-ui/chat-reference"
// Code-split: GitWidgets pulls @pierre/diffs, which pulls shiki core and ~300
// language grammars. The widget column is not first paint, so none of that
// belongs in the entry chunk. Type-only import keeps the prop types.
import type { GitWidgets as GitWidgetsComponent } from "../../components/chat-ui/widgets/GitWidgets"
const GitWidgets = lazy(() =>
  import("../../components/chat-ui/widgets/GitWidgets").then((m) => ({ default: m.GitWidgets }))
)
// Code-split: the graph view is its own route, and React Flow is all its.
const ChatGraphCanvas = lazy(() =>
  import("../ChatGraph/ChatGraphCanvas").then((m) => ({ default: m.ChatGraphCanvas }))
)
import { buildChatGraphLocationState, readChatGraphRequestedChatId, useOpenGraphChat } from "../ChatGraph/openGraphChat"
import type { ChatGraphHost } from "../ChatGraph/ChatGraphNode"
import { useChatGraphRootId } from "../ChatGraph/useChatGraph"
import { attachDelegationBlock } from "../../../shared/delegation-block"
import { Card, CardContent } from "../../components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../../components/ui/resizable"
import { actionMatchesEvent, getResolvedKeybindings } from "../../lib/keybindings"
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow"
import { cn } from "../../lib/utils"
import { buildChatJumpLocationState } from "../../lib/chat-navigation"
import { snapshotDroppedFiles } from "../../lib/snapshotDroppedFiles"
import { useRightSidebarStore, useWidgetsOpen } from "../../stores/rightSidebarStore"
import { ViewerLayer, usePresentedViewer, useViewerShown } from "../../components/viewer/ViewerLayer"
import { resolveViewerSplitMove, viewerPaneState, type ViewerPaneState } from "../../lib/viewer-split"
import { opensInViewer, projectRelativePath } from "../../components/viewer/localLinks"
import type { OpenLocalLinkTarget } from "../../components/messages/shared"
import { shouldOpenLocalFileLinkInEditor } from "../../lib/pathUtils"
import { getChatViewer, openViewer, useChatViewer, useViewerStore, viewerWidthClass } from "../../stores/viewerStore"
import type { ChatPreviewContext } from "./ChatPreview"
import { useOpenChat } from "../useOpenChat"
import type { DiffViewerContext } from "../../components/chat-ui/git/DiffViewer"
import { useProjectRepoUrl, useSidebarChatHasMessages } from "../../stores/sidebarStore"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { DEFAULT_PROJECT_TERMINAL_LAYOUT, isTerminalVisible, useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import { usePaneChatKey } from "../../lib/paneVisibility"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { shouldCloseTerminalPane } from "../terminalLayoutResize"

import { interpolateLayout, PANE_CLOSE_MS, PANE_EASING, PANE_OPEN_MS, paneDurationMs, prefersReducedMotion } from "../paneAnimation"
import { useStickyChatFocus } from "../useStickyChatFocus"
import { useTerminalToggleAnimation } from "../useTerminalToggleAnimation"
import type { AgentProvider, ChatPreview, ChatSkillsSnapshot, ChatTouchedFilesResult, ChatSchedule, SubagentActivity, TranscriptEntry } from "../../../shared/types"
import type { KannaState } from "../useKannaState"
import { ChatInputDock } from "./ChatInputDock"
import { DefaultModelsDialog } from "../../components/DefaultModelsDialog"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "./ChatTranscriptViewport"
import { TranscriptRenderOptionsProvider } from "../../components/messages/render-context"
import { ToolPayloadProvider } from "../../components/messages/tool-payload-context"
import { createToolPayloadStore } from "./toolPayloadStore"
import { TerminalWorkspaceShell } from "./TerminalWorkspaceShell"
import { CHAT_MIN_WORKSPACE_SIZE_PERCENT, WidgetsColumn } from "./WidgetsColumn"
import { useChatPageSidebarActions, EMPTY_DIFF_SNAPSHOT } from "./useChatPageSidebarActions"
import { useTranscriptJumpRequest } from "./useTranscriptJumpRequest"
import { useTranscriptPaddingBottom } from "./useTranscriptPaddingBottom"
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

/** Stable identity so a chat without a snapshot does not re-derive per render. */
const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = []
const EMPTY_SUBAGENTS: readonly SubagentActivity[] = []
const EMPTY_SCHEDULES: readonly ChatSchedule[] = []

/**
 * Types the empty-state line once each time the empty state appears. Not per
 * chat: going from one new chat to another (switching project from the path
 * button) keeps the empty state up, and retyping it read as the page reloading.
 */
function useEmptyStateTyping(showEmptyState: boolean) {
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("")
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] = useState(false)
  // Reset in the render the empty state appears, not in the effect after it:
  // the viewport decides on its entrance animation from the first frame, and
  // a stale "typing complete" there would skip it.
  const [wasShowingEmptyState, setWasShowingEmptyState] = useState(showEmptyState)
  if (wasShowingEmptyState !== showEmptyState) {
    setWasShowingEmptyState(showEmptyState)
    if (showEmptyState) {
      setTypedEmptyStateText("")
      setIsEmptyStateTypingComplete(false)
    }
  }

  useEffect(() => {
    if (!showEmptyState) return

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
  }, [showEmptyState])

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
    // Read the bytes now, while the drop event is still live. See
    // snapshotDroppedFiles for why a later read can come back empty on iOS.
    void snapshotDroppedFiles([...event.dataTransfer.files]).then(args.onFilesDropped)
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

const MOBILE_BREAKPOINT_PX = 768
/** Dragging the viewer's pane narrower than this closes it, as the terminal's does. */
const VIEWER_PANE_CLOSE_WIDTH_PX = 240
/**
 * The viewer's pane for anything but a review of changes (a file, an
 * attachment, a chart): room for the markdown preview's 72ch measure with
 * air either side, or about 100 columns of code, and no wider, so the chat
 * keeps the rest of the room.
 */
const VIEWER_PREVIEW_PANE_WIDTH_PX = 800
/**
 * The viewer's pane for a sub-chat: half the room, so the chat it reports to
 * keeps the other half, between a width its composer still fits in and the
 * transcript column's own.
 */
const VIEWER_CHAT_PANE_MIN_WIDTH_PX = 420
const VIEWER_CHAT_PANE_MAX_WIDTH_PX = 800

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
  /** Everything above the terminal: the chat, the viewer's pane and the widget column. */
  content: ReactNode
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

type GitWidgetsContentProps = ComponentProps<typeof GitWidgetsComponent>

const GitWidgetsContent = memo(function GitWidgetsContent(props: GitWidgetsContentProps) {
  return (
    <Suspense fallback={null}>
      <GitWidgets
        {...props}
        diffs={props.diffs ?? EMPTY_DIFF_SNAPSHOT}
      />
    </Suspense>
  )
})

export function getTerminalPanelDefaultSizes(showTerminalPane: boolean, mainSizes: [number, number]): [number, number] {
  return showTerminalPane ? mainSizes : [100, 0]
}

interface MobileSidebarPaneProps {
  projectId: string | null
  showRightSidebar: boolean
  onClose: () => void
  content: ReactNode
}

const MobileSidebarPane = memo(function MobileSidebarPane({
  projectId,
  showRightSidebar,
  onClose,
  content,
}: MobileSidebarPaneProps) {
  if (!projectId) {
    return null
  }

  return (
    <div
      // The pane clock and curve (paneAnimation.ts), in classes. Under reduced
      // motion the sheet stops sliding; the backdrop still fades.
      className={cn(
        "absolute inset-0 z-40 transition-opacity ease-glide",
        showRightSidebar ? "pointer-events-auto opacity-100 duration-300" : "pointer-events-none opacity-0 duration-[240ms]",
      )}
      aria-hidden={showRightSidebar ? undefined : true}
      data-mobile-right-sidebar-overlay
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Close widgets"
        onClick={onClose}
      />
      <div
        className={cn(
          "group/widgets absolute inset-y-0 right-0 flex w-[min(92vw,30rem)] max-w-full min-h-0 flex-col overflow-hidden transition-transform ease-glide motion-reduce:transition-none",
          "pt-[max(env(safe-area-inset-top),0px)] pb-[max(env(safe-area-inset-bottom),0px)]",
          showRightSidebar ? "translate-x-0 duration-300" : "translate-x-full duration-[240ms]",
        )}
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
        data-slideover
      >
        {content}
      </div>
    </div>
  )
})

/**
 * The terminal under everything right of the left sidebar: the chat, the
 * viewer's pane and the widget column above it, all as wide as it is.
 *
 * The split is there even with no terminals (the terminal at nothing), so
 * adding the first one doesn't move what's above to a new parent, which
 * would remount the transcript, the viewer and the widget column.
 */
function ChatWorkspace({
  content,
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
  const terminalPanelDefaultSizes = getTerminalPanelDefaultSizes(showTerminalPane, terminalLayout.mainSizes)

  return (
    <ResizablePanelGroup
      key={projectId}
      groupRef={mainPanelGroupRef}
      orientation="vertical"
      className="flex-1 min-h-0"
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel id="chat" defaultSize={`${terminalPanelDefaultSizes[0]}%`} minSize={`${CHAT_MIN_SIZE_PERCENT}%`} className="flex min-h-0 flex-col">
        {content}
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
            "--pane-duration": `${paneDurationMs(showTerminalPane)}ms`,
          } as CSSProperties}
        >
          {shouldRenderTerminalLayout ? <TerminalWorkspaceShell
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
          /> : null}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/**
 * What fills the middle of the page. `graph` (`/graph/:chatId`) is the same
 * page, navbar, composer, widget column and all, with the chat's tree of
 * sub-chats where its transcript would be (`ChatGraphCanvas`).
 */
export type ChatPageView = "transcript" | "graph"

export function ChatPage({ view = "transcript" }: { view?: ChatPageView }) {
  const state = useOutletContext<KannaState>()
  const graphView = view === "graph"
  const layoutRootRef = useRef<HTMLDivElement>(null)
  // Publishes the navbar's height as `--chat-navbar-h` on its parent, for
  // what starts below it (the widget column, the viewer) and the transcript's
  // fade under it. Its height moves with the viewport and the Mac app's
  // traffic lights.
  const navbarRef = useCallback((node: HTMLDivElement | null) => {
    const host = node?.parentElement
    if (!node || !host) return
    const publish = () => host.style.setProperty("--chat-navbar-h", `${node.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(node)
    return () => {
      observer.disconnect()
      host.style.removeProperty("--chat-navbar-h")
    }
  }, [])
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
  // While the next chat's snapshot loads there's no runtime to judge by, so the
  // empty state holds whatever it last was. Dropping it for that gap is what
  // made one new chat to another fade out and back in. Not for a chat the
  // sidebar knows has messages, though: that one is headed for a transcript,
  // and holding the empty state there left the new chat page's list over it
  // until the snapshot came.
  const settledShowEmptyStateRef = useRef(false)
  const isChatLoading = Boolean(state.activeChatId && !state.runtime)
  const activeChatHasMessages = useSidebarChatHasMessages(state.activeChatId)
  const showEmptyState = isChatLoading
    ? settledShowEmptyStateRef.current && !activeChatHasMessages
    : state.messages.length === 0 && state.runtime?.title === "New Chat"
  settledShowEmptyStateRef.current = showEmptyState
  const projectId = state.activeProjectId
  const projectTerminalLayout = useTerminalLayoutStore((store) => (projectId ? store.projects[projectId] : undefined))
  const storedTerminalLayout = projectTerminalLayout ?? DEFAULT_PROJECT_TERMINAL_LAYOUT
  // Set to the active chat when that pane opens and closes per chat, null when
  // it follows the project (see lib/paneVisibility).
  const widgetsChatKey = usePaneChatKey("widgets", state.activeChatId)
  const terminalChatKey = usePaneChatKey("terminal", state.activeChatId)
  const widgetsOpen = useWidgetsOpen(projectId, widgetsChatKey)
  const globalRightSidebarSize = useRightSidebarStore((store) => store.size)
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const toggleVisibility = useTerminalLayoutStore((store) => store.toggleVisibility)
  const hideTerminals = useTerminalLayoutStore((store) => store.hideTerminals)
  const resetMainSizes = useTerminalLayoutStore((store) => store.resetMainSizes)
  const setMainSizes = useTerminalLayoutStore((store) => store.setMainSizes)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)
  const toggleWidgets = useRightSidebarStore((store) => store.toggleWidgets)
  const hideWidgets = useRightSidebarStore((store) => store.hideWidgets)
  const viewerOpen = useViewerShown(projectId)
  const chatViewer = useChatViewer()
  const viewerExpanded = chatViewer?.expanded ?? false
  const viewerWidth = chatViewer ? viewerWidthClass(chatViewer.item) : null
  const viewerChatKey = useViewerStore((store) => store.chatKey)
  const setViewerChat = useViewerStore((store) => store.setChat)
  const toggleViewerExpanded = useViewerStore((store) => store.toggleExpanded)
  const setViewerWidth = useViewerStore((store) => store.setWidth)
  const closeViewerPane = useViewerStore((store) => store.closeAll)
  // The viewer is the chat's: this chat's opens here, and another chat's
  // waits in the store for you to go back to it. Before paint, so a switch
  // never shows one frame of the last chat's viewer.
  useLayoutEffect(() => {
    setViewerChat(state.activeChatId)
  }, [setViewerChat, state.activeChatId])
  const projectLocalPath = state.runtime?.localPath ?? state.navbarLocalPath ?? null
  // A file link that would open in the editor (or a CSV that would open in
  // Numbers) opens in the viewer instead, when it's a file in this project
  // (the only files the viewer can read); the editor is a button away there.
  // Anything else, and an explicit choice from a link's context menu, goes
  // where it always did.
  const handleOpenLocalLink = useCallback<KannaState["handleOpenLocalLink"]>((target, action = "open_editor", editor) => {
    if (projectId && opensInViewer(target.path, action) && !editor && target.trigger !== "contextmenu") {
      const path = projectRelativePath(projectLocalPath, target.path)
      if (path) {
        openViewer({ kind: "file", projectId, path, ...(target.line ? { line: target.line } : {}) })
        return Promise.resolve()
      }
    }
    return state.handleOpenLocalLink(target, action, editor)
  }, [projectId, projectLocalPath, state.handleOpenLocalLink])
  // A file link inside the viewer (a markdown preview's) follows the same
  // rule as one in the transcript.
  const handleViewerLocalLink = useCallback((target: OpenLocalLinkTarget) => {
    if (target.trigger === "contextmenu") return
    void handleOpenLocalLink(target, shouldOpenLocalFileLinkInEditor(target.path) ? "open_editor" : "open_default")
  }, [handleOpenLocalLink])
  const setRightSidebarSize = useRightSidebarStore((store) => store.setSize)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const baseContextWindowSnapshotRef = useRef<ReturnType<typeof deriveLatestContextWindowSnapshot>>(null)
  const contextWindowSnapshot = useMemo(() => {
    const derivedSnapshot = deriveLatestContextWindowSnapshot(state.chatSnapshot?.messages ?? EMPTY_TRANSCRIPT_ENTRIES)
    const previousSnapshot = baseContextWindowSnapshotRef.current
    if (sameContextWindowSnapshot(previousSnapshot, derivedSnapshot)) {
      return previousSnapshot
    }
    baseContextWindowSnapshotRef.current = derivedSnapshot
    return derivedSnapshot
  }, [state.chatSnapshot?.messages])

  const isMobileViewport = useIsMobileViewport()
  const navigate = useNavigate()
  // The graph of a sub-chat is the graph of its top-most ancestor, so the
  // URL is rewritten to name that chat. One tree then has one address, and
  // the page's own chat (the composer's, the widget column's, the navbar's)
  // is the head of the graph with nothing told apart from the route. The
  // chat that was asked for rides along in router state, to be marked.
  const location = useLocation()
  const graphRootId = useChatGraphRootId(graphView ? state.activeChatId : null)
  const graphRequestedChatId = graphView
    ? readChatGraphRequestedChatId(location.state)
      ?? (graphRootId && graphRootId !== state.activeChatId ? state.activeChatId : null)
    : null
  useEffect(() => {
    if (!graphView || !state.activeChatId || !graphRootId || graphRootId === state.activeChatId) return
    navigate(`/graph/${graphRootId}`, { replace: true, state: buildChatGraphLocationState(state.activeChatId) })
  }, [graphRootId, graphView, navigate, state.activeChatId])
  // On its own page a node opens as any chat shown inside another does: in
  // the previewer beside the graph. Except the head, which is this page's
  // own chat, the one the composer sends to: its node goes to its transcript.
  const openGraphChat = useOpenGraphChat()
  const graphPageHost = useMemo<ChatGraphHost>(() => ({ openChat: openGraphChat, currentChatId: null }), [openGraphChat])
  // The navbar's left end names the open chat (`ChatNavbarTitle`), or with
  // the Chat Tabs setting on holds every chat you have open, as tabs
  // (`ChatTabs`). Either way in every sidebar view.
  const chatTabsEnabled = useAppSettingsStore((store) => store.settings?.chatTabsEnabled === true)
  // The chat's sidebar-row menu, on the title or tab that stands in for that row.
  const navbarTitleActions = useMemo<ThreadRowMenuActions>(() => ({
    onCreateChat: (id) => { void state.handleCreateChat(id) },
    onMarkChatUnread: (chat) => { void state.handleMarkChatUnread(chat) },
    onRenameChat: (chat) => { void state.handleRenameChat(chat) },
    onShareChat: (id) => { void state.handleShareChat(id) },
    onCopyPath: (path) => { void state.handleCopyPath(path) },
    onOpenExternalPath: (action, path) => { void state.handleOpenExternalPath(action, path) },
    onForkChat: (chat) => { void state.handleForkChat(chat) },
    onToggleChatPin: (chat) => { void state.handleToggleChatPin(chat) },
    onArchiveChat: (chat) => { void state.handleArchiveChat(chat) },
    onRestoreChat: (id) => { void state.handleRestoreChat(id) },
    onDeleteChat: (chat) => { void state.handleDeleteChat(chat) },
  }), [state.handleMarkChatUnread, state.handleArchiveChat, state.handleCopyPath, state.handleCreateChat, state.handleDeleteChat, state.handleForkChat, state.handleOpenExternalPath, state.handleRenameChat, state.handleRestoreChat, state.handleShareChat, state.handleToggleChatPin])
  // Straight to the socket: the sidebar's rename asks for the name in a
  // dialog, and here it has already been typed, in the tab.
  const handleRenameChatTab = useCallback((chatId: string, title: string) => {
    void state.socket.command({ type: "chat.rename", chatId, title }).catch(() => {})
  }, [state.socket])
  const handleSelectChatTab = useCallback((chatId: string) => navigate(`/chat/${chatId}`), [navigate])
  // A chat opened from inside this one (a link, a card, a Tasks row), as
  // opposed to one navigated to from the tab bar above.
  const openChat = useOpenChat()
  const handleCloseLastChatTab = useCallback(() => navigate("/"), [navigate])
  // The sidebar's chat card, beneath a tab. The same fetches the sidebar's
  // makes, straight to the socket, since nothing here holds what they return.
  const renderChatTabHoverCard = useCallback((containerRef: RefObject<HTMLDivElement | null>, threads: SidebarThread[]) => (
    <SidebarChatHoverCard
      containerRef={containerRef}
      threads={threads}
      side="bottom"
      // Just clear of the tab; the default distance is a sidebar's edge.
      sideOffset={6}
      // Opening a chat in another project rebuilds this navbar, card and all.
      holdRowUnderPointerOnMount
      onSelectChat={handleSelectChatTab}
      onSelectMessage={(chatId, role) => navigate(`/chat/${chatId}`, { state: buildChatJumpLocationState(role) })}
      onOpenArchivedChat={(chatId) => { void state.handleOpenArchivedChat(chatId) }}
      onSetupGit={(chatId) => { void state.handleSetupGit(chatId) }}
      onLoadTouchedFiles={(chatId) => state.socket.command<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId })}
      onLoadPreview={(chatId) => state.socket.command<ChatPreview>({ type: "chat.getPreview", chatId })}
      onOpenExternalPath={(action, path) => { void state.handleOpenExternalPath(action, path) }}
    />
  ), [handleSelectChatTab, navigate, state.handleOpenArchivedChat, state.handleOpenExternalPath, state.handleSetupGit, state.socket])
  // What a chat shown inside this one needs to behave like its sidebar row:
  // the card where an agent started it, and its row in the Tasks widget.
  const chatReferenceActions = useMemo<ChatReferenceActions>(() => ({
    editorLabel: state.editorLabel,
    menu: navbarTitleActions,
    // Every way one of those opens its chat goes through `openChat`: in the
    // previewer beside this one, whatever the chat is to it. Archived ones
    // too; reading one unarchives nothing.
    card: {
      onSelectChat: openChat,
      onSelectMessage: (chatId, role) => openChat(chatId, { jump: role }),
      onOpenArchivedChat: openChat,
      onSetupGit: (chatId) => { void state.handleSetupGit(chatId) },
      onLoadTouchedFiles: (chatId) => state.socket.command<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId }),
      onLoadPreview: (chatId) => state.socket.command<ChatPreview>({ type: "chat.getPreview", chatId }),
      onOpenExternalPath: (action, path) => { void state.handleOpenExternalPath(action, path) },
    },
    onOpenChat: openChat,
    onOpenChatInTab: (chatId) => openChat(chatId, { target: "tab" }),
  }), [navbarTitleActions, openChat, state.editorLabel, state.handleOpenExternalPath, state.handleSetupGit, state.socket])
  // A schedule is changed by asking the agent, so Edit starts that sentence.
  const handleEditSchedule = useCallback((schedule: ChatSchedule) => {
    chatInputRef.current?.prefill(scheduleEditPrompt(schedule))
  }, [])
  const chatSchedules = useMemo<ChatSchedulesValue>(() => ({
    chatId: state.activeChatId,
    schedules: state.runtime?.schedules ?? EMPTY_SCHEDULES,
    onEdit: handleEditSchedule,
  }), [handleEditSchedule, state.activeChatId, state.runtime?.schedules])
  const handleRenameActiveChat = useCallback((title: string) => {
    if (state.activeChatId) handleRenameChatTab(state.activeChatId, title)
  }, [handleRenameChatTab, state.activeChatId])
  const handleOpenProjectFolder = useCallback(() => {
    void state.handleOpenExternal("open_finder")
  }, [state.handleOpenExternal])
  const navbarTitleText = state.runtime?.title
  const navbarBranchName = state.chatDiffSnapshot?.branchName
  // Memoized: the navbar it goes into is, and a new element each render
  // would re-render it with every streamed entry.
  const navbarTitle = useMemo(() => {
    if (chatTabsEnabled) {
      return (
        <ChatTabs
          activeChatId={state.activeChatId}
          editorLabel={state.editorLabel}
          actions={navbarTitleActions}
          onSelect={handleSelectChatTab}
          onRename={handleRenameChatTab}
          onCloseLast={handleCloseLastChatTab}
          onNewChat={state.handleCompose}
          renderHoverCard={renderChatTabHoverCard}
        />
      )
    }
    if (!state.activeChatId || !navbarTitleText) return null
    return (
      <ChatNavbarTitle
        chatId={state.activeChatId}
        title={navbarTitleText}
        branchName={navbarBranchName}
        editorLabel={state.editorLabel}
        actions={navbarTitleActions}
        onOpenFolder={handleOpenProjectFolder}
        onRename={handleRenameActiveChat}
      />
    )
  }, [chatTabsEnabled, handleCloseLastChatTab, handleOpenProjectFolder, handleRenameActiveChat, handleRenameChatTab, handleSelectChatTab, navbarBranchName, navbarTitleActions, navbarTitleText, renderChatTabHoverCard, state.activeChatId, state.editorLabel, state.handleCompose])
  const terminalLayout = useMemo(() => {
    const mainSizes = getEffectiveTerminalMainSizes(storedTerminalLayout.mainSizes, isMobileViewport)
    return mainSizes === storedTerminalLayout.mainSizes ? storedTerminalLayout : { ...storedTerminalLayout, mainSizes }
  }, [isMobileViewport, storedTerminalLayout])
  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && isTerminalVisible(terminalLayout, terminalChatKey) && hasTerminals)
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals)
  const showRightSidebar = Boolean(projectId && widgetsOpen)
  // The closed column shown over the chat (WidgetsColumn's peek): its widgets
  // are on screen then, so they load as they do when it is open.
  const [widgetsPeeking, setWidgetsPeeking] = useState(false)
  const shouldRenderDesktopRightSidebarLayout = Boolean(projectId) && !isMobileViewport
  const layoutWidth = useLayoutWidth(layoutRootRef)
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
    // The hooks read a change of this id as a switch, which snaps the pane
    // rather than animating it (and doesn't pull focus into the terminal).
    // Per chat, going to another chat is that switch too.
    projectId: terminalChatKey ?? projectId,
    terminalLayout,
    chatInputRef: chatInputElementRef,
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
    handleReadCommit,
    handleReadBranch,
  } = useChatPageSidebarActions({
    state,
    projectId,
    showRightSidebar,
  })

  const { typedEmptyStateText, isEmptyStateTypingComplete } = useEmptyStateTyping(showEmptyState)

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
    // Every navigation has its own key, one to the chat already open too.
    arrivalKey: location.key,
  })

  // The viewer takes focus when it opens (and the chat is inert under it
  // when it covers the chat), and going to a chat with nothing open closes
  // the last chat's viewer after that chat's composer mounted (and tried to
  // take focus). Hand focus back on close.
  const wasViewerOpenRef = useRef(viewerOpen)
  useEffect(() => {
    const wasViewerOpen = wasViewerOpenRef.current
    wasViewerOpenRef.current = viewerOpen
    if (wasViewerOpen && !viewerOpen) {
      chatInputElementRef.current?.focus({ preventScroll: true })
    }
  }, [viewerOpen])

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
      toggleVisibility(projectId, terminalChatKey)
      return
    }

    addTerminal(projectId, undefined, terminalChatKey)
  }, [addTerminal, hasTerminals, projectId, terminalChatKey, toggleVisibility])

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
      toggleVisibility(projectId, terminalChatKey)
      return
    }

    setMainSizes(projectId, [chatSize, terminalSize])
  }, [isMobileViewport, isTerminalAnimating, projectId, resetMainSizes, setMainSizes, showTerminalPane, terminalChatKey, toggleVisibility])

  const handleCloseRightSidebar = useCallback(() => {
    if (!projectId) return
    hideWidgets(projectId, widgetsChatKey)
  }, [hideWidgets, projectId, widgetsChatKey])

  const handleToggleWidgets = useCallback(() => {
    if (!projectId) return
    toggleWidgets(projectId, widgetsChatKey)
  }, [projectId, toggleWidgets, widgetsChatKey])

  const activeChatId = state.activeChatId
  const handleJumpToToolCall = useCallback((toolId: string) => {
    if (!activeChatId) return
    // The same one-shot jump request the left sidebar's hover card sends,
    // pointed at a tool call instead of a role.
    navigate(`/chat/${activeChatId}`, { state: buildChatJumpLocationState({ toolId }) })
    // On a phone the column is a sheet over the chat: close it so the jump
    // lands somewhere visible.
    if (isMobileViewport && projectId) hideWidgets(projectId, widgetsChatKey)
  }, [activeChatId, hideWidgets, isMobileViewport, navigate, projectId, widgetsChatKey])

  // On a phone the widget column is a sheet over the chat, and the viewer
  // opens over the chat: close the sheet so what you opened is what you see.
  useEffect(() => {
    if (viewerOpen && isMobileViewport && projectId) hideWidgets(projectId, widgetsChatKey)
  }, [hideWidgets, isMobileViewport, projectId, viewerOpen, widgetsChatKey])

  const handleRunQuickAction = useCallback((command: string) => {
    if (!projectId) return
    const terminalId = addTerminal(projectId, undefined, terminalChatKey)
    setPendingTerminalCommands((current) => ({
      ...current,
      [terminalId]: command,
    }))
  }, [addTerminal, projectId, terminalChatKey])

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

  // Same rule, for ChatInputDock: every other prop it takes is already stable,
  // so an inline arrow here was the one thing defeating its memo - and then
  // ChatInput's memo below it - on every streamed entry.
  const handleEditModels = useCallback(() => setDefaultModelsDialogOpen(true), [])

  const handleRemoveTerminal = useCallback((currentProjectId: string, terminalId: string) => {
    const paneCount = useTerminalLayoutStore.getState().projects[currentProjectId]?.terminals.length ?? 0
    if (paneCount <= 1) {
      // Closing the only pane hides the panel instead of killing the shell:
      // the pane stays mounted, so reopening returns to the same session and
      // scrollback with whatever was running still running.
      hideTerminals(currentProjectId, terminalChatKey)
      return
    }

    // A split pane is unreachable once removed, so closing it does kill it.
    void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
    removeTerminal(currentProjectId, terminalId)
    // Dynamic so this one helper does not pin the five xterm packages into the
    // entry chunk. Removing a terminal implies the module is already loaded, so
    // this resolves from cache.
    void import("../../components/chat-ui/TerminalPane").then((m) => m.disposeCachedTerminal(terminalId))
  }, [hideTerminals, removeTerminal, state.socket, terminalChatKey])

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
    //
    // From the graph, a message asks for the work to be handed out, not done
    // (see `attachDelegationBlock`). It is attached here, where the view is
    // known, and from here on it is part of the message: sent, queued or
    // steered the same.
    await state.handleSend(graphView ? attachDelegationBlock(content) : content, options)
  }, [graphView, state.handleSend])

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
        handleToggleWidgets()
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
        addTerminal(projectId, undefined, terminalChatKey)
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [addTerminal, handleToggleEmbeddedTerminal, handleToggleWidgets, projectId, resolvedKeybindings, state.handleOpenExternal, terminalChatKey])

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

  // Beside the chat on anything wider than a phone: the viewer opens in a
  // pane between the chat and the widget column. Reviewing changes, the chat
  // narrows to its least so the review is the main thing; a file, attachment
  // or chart gets a reading width and the chat keeps the rest. The chat stays
  // live either way. Expanded, or on a phone, the viewer covers the chat as
  // it always did.
  const viewerPaneAvailable = !isMobileViewport
  const viewerPaneOpen = viewerPaneAvailable && viewerOpen
  const viewerDocked = viewerPaneOpen && !viewerExpanded
  const chatMinWidthPx = layoutWidth * (CHAT_MIN_WORKSPACE_SIZE_PERCENT / 100)
  const viewerSplitGroupRef = useRef<GroupImperativeHandle | null>(null)
  const viewerSplitElementRef = useRef<HTMLDivElement | null>(null)
  const viewerSplitAnimationRef = useRef<number | null>(null)
  const viewerSplitStateRef = useRef<{ group: GroupImperativeHandle | null; state: ViewerPaneState; chatKey: string }>({ group: null, state: "closed", chatKey: "" })
  // The split a docked pane takes for what's open: the width you dragged it
  // to, else the one for its kind.
  const dockedViewerSplit = (): [number, number] => {
    const splitWidth = viewerSplitElementRef.current?.clientWidth ?? 0
    if (splitWidth <= 0) return [100, 0]
    const pageWidth = layoutRootRef.current?.clientWidth ?? 0
    const chatMinPx = pageWidth * (CHAT_MIN_WORKSPACE_SIZE_PERCENT / 100)
    const draggedWidthPx = getChatViewer()?.widthPx
    const paneWidthPx = Math.min(
      splitWidth - chatMinPx,
      draggedWidthPx ?? (
        viewerWidth === "review"
          ? Infinity
          : viewerWidth === "chat"
            ? Math.min(VIEWER_CHAT_PANE_MAX_WIDTH_PX, Math.max(VIEWER_CHAT_PANE_MIN_WIDTH_PX, splitWidth / 2))
            : VIEWER_PREVIEW_PANE_WIDTH_PX
      ),
    )
    const panePercent = Math.max(0, (paneWidthPx / splitWidth) * 100)
    return [100 - panePercent, panePercent]
  }
  // What's on screen, which outlives a close by its exit animation. The
  // placement follows it, so a viewer closing over the chat leaves from
  // there rather than dropping into the pane.
  const presentedViewer = usePresentedViewer(projectId, viewerPaneAvailable)
  const presentedExpanded = presentedViewer.viewer?.expanded ?? false
  const viewerPlacement = useMemo(() => ({ expanded: presentedExpanded, onToggleExpanded: toggleViewerExpanded }), [presentedExpanded, toggleViewerExpanded])

  // Expanded as the layer is placed: against the whole workspace, or in its
  // pane. Expanding places it at once and its left edge slides from the
  // pane's out to the workspace's. Collapsing slides it back first, still
  // against the workspace, and only lands it in the pane at the end: the
  // pane clips what's in it, so the slide couldn't run from in there.
  const [viewerLayerExpanded, setViewerLayerExpanded] = useState(presentedExpanded)
  if (presentedExpanded && !viewerLayerExpanded) setViewerLayerExpanded(true)
  const viewerLayerRef = useRef<HTMLDivElement | null>(null)
  const viewerExpandAnimationRef = useRef<Animation | null>(null)
  const viewerExpandStateRef = useRef({ expanded: presentedExpanded, chatKey: viewerChatKey, shown: presentedViewer.viewer !== null })

  useLayoutEffect(() => {
    const previous = viewerExpandStateRef.current
    const shown = presentedViewer.viewer !== null
    viewerExpandStateRef.current = { expanded: presentedExpanded, chatKey: viewerChatKey, shown }
    if (previous.expanded === presentedExpanded) return

    const layer = viewerLayerRef.current
    const group = viewerSplitGroupRef.current
    const splitWidth = viewerSplitElementRef.current?.clientWidth ?? 0
    // Turned around mid-slide, it goes on from where it is.
    const running = viewerExpandAnimationRef.current
    const fromLeftPx = running && layer ? Number.parseFloat(getComputedStyle(layer).left) : null
    running?.cancel()
    viewerExpandAnimationRef.current = null

    const animate = layer && group && splitWidth > 0 && shown && previous.shown
      && previous.chatKey === viewerChatKey && !presentedViewer.exiting && !prefersReducedMotion()
    if (!animate) {
      setViewerLayerExpanded(presentedExpanded)
      return
    }

    // Collapsing lands in the pane as it is about to be: one opened straight
    // to expanded has no pane yet, and the split takes its docked width in
    // this same commit (below), after this has run.
    const paneLeftPx = splitWidth * ((presentedExpanded ? group.getLayout().chatColumn ?? 100 : dockedViewerSplit()[0]) / 100)
    if (presentedExpanded) {
      viewerExpandAnimationRef.current = layer.animate(
        [{ left: `${fromLeftPx ?? paneLeftPx}px` }, { left: "0px" }],
        { duration: PANE_OPEN_MS, easing: PANE_EASING },
      )
      return
    }

    const animation = layer.animate(
      [{ left: `${fromLeftPx ?? 0}px` }, { left: `${paneLeftPx}px` }],
      { duration: PANE_CLOSE_MS, easing: PANE_EASING, fill: "forwards" },
    )
    viewerExpandAnimationRef.current = animation
    animation.onfinish = () => {
      // Into the pane and off the held frame in one commit, before paint:
      // the held left would be measured from the pane's edge once it's in.
      flushSync(() => setViewerLayerExpanded(false))
      animation.cancel()
      if (viewerExpandAnimationRef.current === animation) viewerExpandAnimationRef.current = null
    }
  }, [presentedExpanded, presentedViewer.exiting, presentedViewer.viewer, viewerChatKey])

  useEffect(() => () => viewerExpandAnimationRef.current?.cancel(), [])

  // Opening slides the pane in, as the terminal and widget column slide, and
  // so does going between a review and a preview; closing slides it shut
  // around the viewer, which stays on screen for it (usePresentedViewer).
  // Another chat, or a group that's new (another project, a phone turned
  // desktop), takes its layout without the slide, as does reduced motion.
  // Stepping between files of one kind leaves the split as it is. A width
  // you dragged the pane to is the chat's, and it opens at it again.
  //
  // Expanded over the chat, the split is left alone, and coming out of
  // expanded it's set in one step behind the card: the chat's width is
  // layout, not worth moving where it can't be seen (`lib/viewer-split`).
  useLayoutEffect(() => {
    const group = viewerSplitGroupRef.current
    const previous = viewerSplitStateRef.current
    const state = viewerPaneState(viewerPaneOpen, viewerExpanded)
    viewerSplitStateRef.current = { group, state, chatKey: viewerChatKey }
    if (!group) return
    const move = resolveViewerSplitMove(
      previous.state,
      state,
      previous.group === group && previous.chatKey === viewerChatKey && !prefersReducedMotion(),
    )
    // A slide already under way goes on to where it was headed.
    if (move.to === "hold") return
    if (viewerSplitAnimationRef.current !== null) {
      window.cancelAnimationFrame(viewerSplitAnimationRef.current)
      viewerSplitAnimationRef.current = null
    }

    const target: [number, number] = move.to === "docked" ? dockedViewerSplit() : [100, 0]
    if (!move.animate) {
      group.setLayout({ chatColumn: target[0], viewerPane: target[1] })
      return
    }

    const current = group.getLayout()
    const from: [number, number] = previous.state === "docked"
      ? [current.chatColumn ?? 100, current.viewerPane ?? 0]
      : [100, 0]
    const startTime = performance.now()
    const durationMs = paneDurationMs(viewerPaneOpen)
    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs)
      const next = interpolateLayout(from, target, progress)
      group.setLayout({ chatColumn: next[0], viewerPane: next[1] })
      viewerSplitAnimationRef.current = progress < 1 ? window.requestAnimationFrame(step) : null
    }
    viewerSplitAnimationRef.current = window.requestAnimationFrame(step)
  }, [projectId, shouldRenderDesktopRightSidebarLayout, viewerChatKey, viewerExpanded, viewerPaneOpen, viewerWidth])

  useEffect(() => () => {
    if (viewerSplitAnimationRef.current !== null) window.cancelAnimationFrame(viewerSplitAnimationRef.current)
  }, [])

  const handleViewerSplitLayoutChanged = useCallback((layout: Record<string, number>, meta?: { isUserInteraction: boolean }) => {
    if (!meta?.isUserInteraction || !viewerDocked) return
    const splitWidth = viewerSplitElementRef.current?.clientWidth ?? 0
    const viewerWidth = splitWidth * ((layout.viewerPane ?? 0) / 100)
    if (splitWidth <= 0) return
    // Dragged shut is shut: not back to the chat preview under what was open.
    if (viewerWidth < VIEWER_PANE_CLOSE_WIDTH_PX) closeViewerPane()
    else setViewerWidth(Math.round(viewerWidth))
  }, [closeViewerPane, setViewerWidth, viewerDocked])

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
        <ChatNavbarWash resetKey={state.activeChatId} opaqueBar={chatTabsEnabled} />
        {graphView ? (
          state.activeChatId ? (
            <Suspense fallback={null}>
              <ChatGraphCanvas
                // By root, so the rewrite from a sub-chat's URL to its root's
                // keeps the canvas it started drawing.
                key={graphRootId ?? state.activeChatId}
                chatId={state.activeChatId}
                markedChatId={graphRequestedChatId}
                // A page is wide: a generation to a column.
                direction="columns"
                host={graphPageHost}
                underNavbar
                bottomInset={transcriptPaddingBottom}
                fitButton
              />
            </Suspense>
          ) : null
        ) : (
        <TranscriptRenderOptionsProvider value={transcriptRenderOptions}>
        <ToolPayloadProvider store={toolPayloadStore}>
        <ChatTranscriptViewport
          // Keyed by chat so a switch replaces the whole list in one
          // `removeChild`. Reusing the list container meant React removed
          // the old chat's rows one by one: 168 ms of pure DOM removal on
          // an 800-row chat before the new one could mount.
          key={state.activeChatId ?? "none"}
          activeChatId={state.activeChatId}
          listRef={transcriptListRef}
          messages={state.messages}
          queuedMessages={state.queuedMessages}
          transcriptPaddingBottom={transcriptPaddingBottom}
          localPath={state.runtime?.localPath}
          latestToolIds={state.latestToolIds}
          isProcessing={state.isProcessing}
          runtimeStatus={state.runtimeStatus}
          isDraining={state.isDraining}
          commandError={state.commandError}
          onStopDraining={state.handleStopDraining}
          onSteerQueuedMessage={state.handleSteerQueuedMessage}
          onRemoveQueuedMessage={state.handleRemoveQueuedMessage}
          onOpenLocalLink={handleOpenLocalLink}
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
          hasOlderMessages={state.hasOlderMessages}
          transcriptOutline={state.transcriptOutline}
          onLoadOlderMessages={state.loadOlderMessages}
          isLoadingOlderMessages={state.isLoadingOlderMessages}
          scrollToBottom={scrollToTranscriptEnd}
          typedEmptyStateText={typedEmptyStateText}
          isEmptyStateTypingComplete={isEmptyStateTypingComplete}
          isPageFileDragActive={isPageFileDragActive}
          showEmptyState={showEmptyState}
          socket={state.socket}
          emptyStateProjectPath={state.navbarLocalPath}
          emptyStateProjectId={projectId}
          showEmptyStateUsage={isMobileViewport}
          onOpenProjectExternal={handleOpenExternal}
          scrollbarGutterHostRef={chatCardRef}
        />
        </ToolPayloadProvider>
        </TranscriptRenderOptionsProvider>
        )}
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
        onEditModels={handleEditModels}
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

  // What the viewer needs to show diffs: this project's changed files, and
  // how to read, render and open them.
  const diffViewerContext = useMemo<DiffViewerContext | undefined>(() => (projectId ? {
    projectId,
    files: state.chatDiffSnapshot?.files ?? EMPTY_DIFF_SNAPSHOT.files,
    filesReady: state.chatDiffSnapshot?.status === "ready",
    editorLabel: state.editorLabel,
    diffRenderMode,
    wrapLines: wrapDiffLines,
    onDiffRenderModeChange: setDiffRenderMode,
    onWrapLinesChange: setWrapDiffLines,
    onLoadPatch: handleLoadDiffPatch,
    onOpenFile: handleOpenDiffFile,
    isMac: state.localProjects?.machine.platform === "darwin",
  } : undefined), [diffRenderMode, handleLoadDiffPatch, handleOpenDiffFile, projectId, setDiffRenderMode, setWrapDiffLines, state.chatDiffSnapshot?.files, state.chatDiffSnapshot?.status, state.editorLabel, state.localProjects?.machine.platform, wrapDiffLines])

  // What the viewer needs to show a sub-chat, live and with a composer.
  const chatPreviewContext = useMemo<ChatPreviewContext>(() => ({
    socket: state.socket,
    fallbackProviders: state.availableProviders,
    platform: state.localProjects?.machine.platform,
    onOpenLocalLink: handleOpenLocalLink,
    onEditModels: handleEditModels,
  }), [handleEditModels, handleOpenLocalLink, state.availableProviders, state.localProjects?.machine.platform, state.socket])

  // The chat, with the viewer beside it or over it. Over it, the chat stays
  // mounted underneath (the transcript keeps its place) but goes inert: the
  // viewer is the whole of what's interactive there, so Esc, typing and focus
  // can't reach the chat behind.
  const chatColumn = (
    <div inert={(viewerOpen && !viewerDocked) || undefined} className="flex h-full min-h-0 flex-1 flex-col">
      {chatCard}
    </div>
  )
  // No right padding beside the widget column: its own 8px gutter is the
  // gap, and the viewer's on top of it read as a double margin. On desktop
  // the navbar stays over the viewer, docked or expanded, so the card starts
  // below it, level with the widget column's top card (navbar + 1px, as
  // WidgetsSidebar and WidgetPresence place it); on a phone the viewer covers
  // the navbar too.
  const viewerLayer = (
    <ViewerLayer
      diff={diffViewerContext}
      chat={chatPreviewContext}
      onOpenLocalLink={handleViewerLocalLink}
      placement={viewerPaneAvailable ? viewerPlacement : undefined}
      presented={presentedViewer}
      layerRef={viewerLayerRef}
      className={isMobileViewport ? undefined : cn("pt-[calc(var(--chat-navbar-h,53px)+1px)]", showRightSidebar && "pr-0")}
    />
  )
  const workspace = viewerPaneAvailable ? (
    // The split is always there, the pane at nothing while the viewer's
    // closed, so opening one never moves the chat to a new parent (which
    // would remount the transcript and the terminals). The viewer is
    // positioned against its pane while docked; expanded, the pane lets go
    // and it's positioned against this wrapper, over the chat, without
    // remounting either.
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <ResizablePanelGroup
        groupRef={viewerSplitGroupRef}
        elementRef={viewerSplitElementRef}
        orientation="horizontal"
        className="flex-1 min-h-0"
        onLayoutChanged={handleViewerSplitLayoutChanged}
      >
        <ResizablePanel id="chatColumn" defaultSize="100%" minSize={chatMinWidthPx} className="flex min-h-0 min-w-0 flex-col">
          {chatColumn}
        </ResizablePanel>
        <ResizableHandle
          withHandle={false}
          orientation="horizontal"
          disabled={!viewerDocked}
          // The card sits 8px into its pane, so a handle centred on the pane's
          // edge missed the card's own border, the edge you reach for. This
          // one reaches from 4px into the chat to 4px past the border (still
          // no width of its own), over the card.
          className={cn("z-40 w-4 -ml-1 -mr-3", !viewerDocked && "pointer-events-none opacity-0")}
        />
        <ResizablePanel id="viewerPane" defaultSize="0%" minSize="0%" className={cn("min-h-0 min-w-0", !viewerLayerExpanded && "relative")}>
          {viewerLayer}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ) : (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {chatColumn}
      {viewerLayer}
    </div>
  )

  const gitWidgetsProps = useMemo<ComponentProps<typeof GitWidgetsContent> | null>(() => {
    if (!projectId) {
      return null
    }

    return {
      projectId,
      diffs: state.chatDiffSnapshot ?? EMPTY_DIFF_SNAPSHOT,
      editorLabel: state.editorLabel,
      onOpenFile: handleOpenDiffFile,
      onOpenInFinder: handleOpenDiffInFinder,
      onDiscardFile: handleDiscardDiffFile,
      onIgnoreFile: handleIgnoreDiffFile,
      onIgnoreFolder: handleIgnoreDiffFolder,
      onCopyFilePath: handleCopyDiffFilePath,
      onCopyRelativePath: handleCopyDiffRelativePath,
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
      onReadCommit: handleReadCommit,
      onReadBranch: handleReadBranch,
      onLoadPatch: handleLoadDiffPatch,
    }
  }, [
    handleCheckGitHubRepoAvailability,
    handleCheckoutBranch,
    handleCommitDiffs,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleCreateBranch,
    handleReadCommit,
    handleReadBranch,
    handleLoadDiffPatch,
    handleDiscardDiffFile,
    handleGenerateCommitMessage,
    handleGetGitHubPublishInfo,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleInitializeGit,
    handleListBranches,
    handleMergeBranch,
    handleOpenDiffFile,
    handleOpenDiffInFinder,
    handlePreviewMergeBranch,
    handleSetupGitHub,
    handleSyncBranch,
    projectId,
    state.chatDiffSnapshot,
    state.editorLabel,
  ])
  const rightPanelContent = projectId ? (
    // The chat's payload store: an Agents card fetches a prompt the
    // transcript left in the sidecar, as the chat's own rows do.
    <ToolPayloadProvider store={toolPayloadStore}>
    <WidgetsSidebar
      projectId={projectId}
      chatId={state.activeChatId}
      activeProvider={state.runtime?.provider ?? null}
      availableProviders={state.availableProviders}
      socket={state.socket}
      active={showRightSidebar || widgetsPeeking}
      entries={state.chatSnapshot?.messages ?? EMPTY_TRANSCRIPT_ENTRIES}
      subagents={state.runtime?.subagents ?? EMPTY_SUBAGENTS}
      schedules={state.runtime?.schedules ?? EMPTY_SCHEDULES}
      onEditSchedule={handleEditSchedule}
      onRunQuickAction={handleRunQuickAction}
      onJumpToToolCall={handleJumpToToolCall}
      gitWidgets={gitWidgetsProps ? <GitWidgetsContent {...gitWidgetsProps} /> : null}
      isNewChat={showEmptyState}
    />
    </ToolPayloadProvider>
  ) : null

  // The chat and the viewer, then the widget column, side by side: all that
  // sits above the terminal. The row is there on a phone too, without the
  // column, so the workspace keeps its parent either way.
  const panes = (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {workspace}
      </div>
      {shouldRenderDesktopRightSidebarLayout ? (
        <WidgetsColumn
          open={showRightSidebar}
          switchKey={widgetsChatKey ?? projectId}
          storedWidthPx={globalRightSidebarSize}
          layoutWidth={layoutWidth}
          onResize={setRightSidebarSize}
          onPeekChange={setWidgetsPeeking}
          content={rightPanelContent}
        />
      ) : null}
    </div>
  )

  // The navbar spans the chat, the viewer's pane and the widget column, over
  // the top of all three: the transcript and the widget column scroll under
  // it, and the viewer starts below it. The column slides in beneath it
  // rather than pushing its buttons along. Painted above the viewer (z-30)
  // and its resize handle (z-40) on desktop; on a phone the viewer covers
  // the chat, navbar included, as a sheet.
  const navbar = (
    <ChatNavbar
      headerRef={navbarRef}
      className={isMobileViewport ? undefined : "z-40"}
      inert={isMobileViewport && viewerOpen}
      sidebarCollapsed={state.sidebarCollapsed}
      onOpenSidebar={state.openSidebar}
      onExpandSidebar={state.expandSidebar}
      localPath={state.navbarLocalPath}
      embeddedTerminalVisible={showTerminalPane}
      onToggleEmbeddedTerminal={projectId ? handleToggleEmbeddedTerminal : undefined}
      widgetsOpen={showRightSidebar}
      onToggleWidgets={projectId ? handleToggleWidgets : undefined}
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
      titleSlot={navbarTitle}
      hideBranchLabel={chatTabsEnabled}
      repoUrl={activeProjectRepoUrl}
      hasGitRepo={state.chatDiffSnapshot?.status !== "no_repo"}
      gitStatus={state.chatDiffSnapshot?.status}
    />
  )
  const panesWithNavbar = (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {panes}
      {navbar}
    </div>
  )

  const chatWorkspace = projectId ? (
    <ChatWorkspace
      content={panesWithNavbar}
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
    panesWithNavbar
  )

  return (
    <ChatReferenceProvider value={chatReferenceActions}>
      <ChatSchedulesProvider value={chatSchedules}>
      <div ref={layoutRootRef} className="flex-1 flex flex-col min-w-0 relative">
        {chatWorkspace}
        {isMobileViewport ? (
          <MobileSidebarPane
            projectId={projectId}
            showRightSidebar={showRightSidebar}
            onClose={handleCloseRightSidebar}
            content={rightPanelContent}
          />
        ) : null}
      </div>
      </ChatSchedulesProvider>
    </ChatReferenceProvider>
  )
}

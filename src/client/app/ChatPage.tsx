import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react"
import { measureElement, useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { useOutletContext } from "react-router-dom"
import type {
  BranchActionFailure,
  BranchActionSuccess,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCheckoutBranchResult,
  ChatCreateBranchResult,
  ChatDiffSnapshot,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  ChatSyncResult,
  DiffCommitMode,
  DiffCommitResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
} from "../../shared/types"
import { ChatInput, type ChatInputHandle } from "../components/chat-ui/ChatInput"
import { ChatNavbar } from "../components/chat-ui/ChatNavbar"
import { RightSidebar } from "../components/chat-ui/RightSidebar"
import { TerminalWorkspace } from "../components/chat-ui/TerminalWorkspace"
import { DrainingIndicator } from "../components/messages/DrainingIndicator"
import { ProcessingMessage } from "../components/messages/ProcessingMessage"
import { OpenLocalLinkProvider } from "../components/messages/shared"
import { AnimatedShinyText } from "../components/ui/animated-shiny-text"
import { useAppDialog } from "../components/ui/app-dialog"
import { Card, CardContent } from "../components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable"
import { actionMatchesEvent, getResolvedKeybindings } from "../lib/keybindings"
import { cn } from "../lib/utils"
import { deriveLatestContextWindowSnapshot, type ContextWindowSnapshot } from "../lib/contextWindow"
import {
  DEFAULT_PROJECT_RIGHT_SIDEBAR_LAYOUT,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  RIGHT_SIDEBAR_MIN_SIZE_PERCENT,
  useRightSidebarStore,
} from "../stores/rightSidebarStore"
import { DEFAULT_PROJECT_TERMINAL_LAYOUT, useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { shouldCloseTerminalPane } from "./terminalLayoutResize"
import { TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "./terminalToggleAnimation"
import { useRightSidebarToggleAnimation } from "./useRightSidebarToggleAnimation"
import { useTerminalToggleAnimation } from "./useTerminalToggleAnimation"
import type { KannaState } from "./useKannaState"
import { buildResolvedTranscriptRows, KannaTranscriptRow, type ResolvedTranscriptRow } from "./KannaTranscript"
import { useStickyChatFocus } from "./useStickyChatFocus"

const EMPTY_STATE_TEXT = "What are we building?"
const EMPTY_STATE_TYPING_INTERVAL_MS = 19
const CHAT_NAVBAR_OFFSET_PX = 72
const SCROLL_BUTTON_BOTTOM_PX = 120
const DIFF_REFRESH_INTERVAL_MS = 5_000
const EMPTY_DIFF_SNAPSHOT: ChatDiffSnapshot = { status: "unknown", files: [] }
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 12

function serializeBranchSelection(branch: ChatBranchListEntry) {
  return branch.kind === "local"
    ? { kind: "local" as const, name: branch.name }
    : branch.kind === "remote"
      ? { kind: "remote" as const, name: branch.name, remoteRef: branch.remoteRef ?? branch.displayName }
      : {
          kind: "pull_request" as const,
          name: branch.name,
          prNumber: branch.prNumber ?? 0,
          headRefName: branch.headRefName ?? branch.name,
          headRepoCloneUrl: branch.headRepoCloneUrl,
          isCrossRepository: branch.isCrossRepository,
          remoteRef: branch.remoteRef,
        }
}

function isInteractiveTranscriptRow(row: ResolvedTranscriptRow) {
  return row.kind === "single"
    && row.message.kind === "tool"
    && (
      row.message.toolKind === "ask_user_question"
      || row.message.toolKind === "exit_plan_mode"
      || row.message.toolKind === "todo_write"
    )
}

function estimateTranscriptRowHeight(row: ResolvedTranscriptRow) {
  if (row.kind === "tool-group") {
    return 160
  }
  switch (row.message.kind) {
    case "compact_boundary":
    case "context_cleared":
    case "status":
      return 40
    default:
      return 96
  }
}

function getPinnedTailStartIndex(rows: ResolvedTranscriptRow[], isProcessing: boolean) {
  let tailStartIndex = Math.max(0, rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS)

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row) continue
    if (isInteractiveTranscriptRow(row)) {
      tailStartIndex = Math.min(tailStartIndex, index)
      continue
    }
    if (index < tailStartIndex) {
      break
    }
  }

  if (!isProcessing) {
    return tailStartIndex
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row || row.kind !== "single") continue
    if (row.message.kind === "user_prompt") {
      return Math.min(tailStartIndex, index)
    }
    if (row.message.kind === "assistant_text") {
      break
    }
  }

  return tailStartIndex
}

function sameContextWindowSnapshot(left: ContextWindowSnapshot | null, right: ContextWindowSnapshot | null) {
  if (left === right) return true
  if (!left || !right) return false
  return left.usedTokens === right.usedTokens
    && left.maxTokens === right.maxTokens
    && left.remainingTokens === right.remainingTokens
    && left.usedPercentage === right.usedPercentage
    && left.remainingPercentage === right.remainingPercentage
    && left.compactsAutomatically === right.compactsAutomatically
    && left.updatedAt === right.updatedAt
}

interface ChatTranscriptViewportProps {
  scrollRef: KannaState["scrollRef"]
  messages: KannaState["messages"]
  transcriptPaddingBottom: number
  localPath: string | null | undefined
  latestToolIds: KannaState["latestToolIds"]
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  isProcessing: boolean
  runtimeStatus: string | null
  isDraining: boolean
  commandError: string | null
  loadOlderHistory: () => Promise<void>
  onStopDraining: () => void
  onOpenLocalLink: KannaState["handleOpenLocalLink"]
  onAskUserQuestionSubmit: KannaState["handleAskUserQuestion"]
  onExitPlanModeConfirm: KannaState["handleExitPlanMode"]
  showScrollButton: boolean
  onScrollChange: () => void
  scrollToBottom: () => void
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  isPageFileDragActive: boolean
}

const ChatTranscriptViewport = memo(function ChatTranscriptViewport({
  scrollRef,
  messages,
  transcriptPaddingBottom,
  localPath,
  latestToolIds,
  isHistoryLoading,
  hasOlderHistory,
  isProcessing,
  runtimeStatus,
  isDraining,
  commandError,
  loadOlderHistory,
  onStopDraining,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  showScrollButton,
  onScrollChange,
  scrollToBottom,
  typedEmptyStateText,
  isEmptyStateTypingComplete,
  isPageFileDragActive,
}: ChatTranscriptViewportProps) {
  const contentRootRef = useRef<HTMLDivElement>(null)
  const previousRowCountRef = useRef(0)
  const pendingPrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const [transcriptContentWidth, setTranscriptContentWidth] = useState<number | null>(null)

  const resolvedRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
  }), [isProcessing, latestToolIds, localPath, messages])

  const pinnedTailStartIndex = useMemo(
    () => getPinnedTailStartIndex(resolvedRows, isProcessing),
    [isProcessing, resolvedRows]
  )
  const virtualizedHeadRows = useMemo(
    () => resolvedRows.slice(0, pinnedTailStartIndex),
    [pinnedTailStartIndex, resolvedRows]
  )
  const pinnedTailRows = useMemo(
    () => resolvedRows.slice(pinnedTailStartIndex),
    [pinnedTailStartIndex, resolvedRows]
  )
  const virtualMeasurementScopeKey = transcriptContentWidth === null
    ? "width:unknown"
    : `width:${Math.round(transcriptContentWidth)}`

  const rowVirtualizer = useVirtualizer({
    count: virtualizedHeadRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => `${virtualMeasurementScopeKey}:${virtualizedHeadRows[index]?.id ?? index}`,
    estimateSize: (index) => estimateTranscriptRowHeight(virtualizedHeadRows[index] ?? pinnedTailRows[0]!),
    measureElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  })

  useEffect(() => {
    const contentRoot = contentRootRef.current
    if (!contentRoot) return

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return

      const width = rect.width
      setTranscriptContentWidth((current) => {
        const nextWidth = typeof width === "number" ? width : null
        if (nextWidth === null && current === null) return current
        if (nextWidth !== null && current !== null && Math.round(nextWidth) === Math.round(current)) {
          return current
        }
        return nextWidth
      })

      if (!showScrollButton && !pendingPrependAnchorRef.current) {
        const scrollContainer = scrollRef.current
        if (scrollContainer) {
          scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" })
        }
      }
    })

    observer.observe(contentRoot)
    return () => observer.disconnect()
  }, [scrollRef, showScrollButton])

  useEffect(() => {
    if (transcriptContentWidth === null) return
    rowVirtualizer.measure()
  }, [rowVirtualizer, transcriptContentWidth])

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0
      const scrollOffset = instance.scrollOffset ?? 0
      const itemIntersectsViewport = item.end > scrollOffset && item.start < scrollOffset + viewportHeight
      if (itemIntersectsViewport) {
        return false
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight)
      return remainingDistance > 24
    }
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [rowVirtualizer])

  const requestOlderHistory = useCallback(() => {
    if (isHistoryLoading || !hasOlderHistory) return
    const scrollContainer = scrollRef.current
    if (scrollContainer) {
      pendingPrependAnchorRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
      }
    }
    void loadOlderHistory()
  }, [hasOlderHistory, isHistoryLoading, loadOlderHistory, scrollRef])

  useLayoutEffect(() => {
    const previousCount = previousRowCountRef.current
    const currentCount = resolvedRows.length

    if (pendingPrependAnchorRef.current && !isHistoryLoading) {
      const scrollContainer = scrollRef.current
      if (scrollContainer && currentCount > previousCount) {
        const heightDelta = scrollContainer.scrollHeight - pendingPrependAnchorRef.current.scrollHeight
        scrollContainer.scrollTop = pendingPrependAnchorRef.current.scrollTop + heightDelta
      }
      pendingPrependAnchorRef.current = null
    }

    previousRowCountRef.current = currentCount
  }, [isHistoryLoading, resolvedRows.length, scrollRef])

  useLayoutEffect(() => {
    if (showScrollButton) return
    if (pendingPrependAnchorRef.current) return

    const scrollContainer = scrollRef.current
    if (!scrollContainer) return

    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" })
  }, [isProcessing, resolvedRows.length, scrollRef, showScrollButton, transcriptContentWidth])

  const handleTranscriptScroll = useCallback(() => {
    onScrollChange()
    const scrollContainer = scrollRef.current
    if (!scrollContainer) return
    if (scrollContainer.scrollTop > 0) return
    requestOlderHistory()
  }, [onScrollChange, requestOlderHistory, scrollRef])

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleTranscriptScroll}
        className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 scroll-pt-[72px] [scrollbar-gutter:auto]"
      >
        <div ref={contentRootRef} className="mx-auto w-full max-w-[800px] animate-fade-in pt-[72px]">
          {isHistoryLoading ? (
            <div className="pb-4 flex justify-center">
              <span className="text-sm translate-y-[-0.5px]">
                <AnimatedShinyText
                  animate
                  shimmerWidth={Math.max(20, "Loading more messages...".length * 3)}
                >
                  Loading more messages...
                </AnimatedShinyText>
              </span>
            </div>
          ) : null}
          {messages.length > 0 ? (
            <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
              <>
                {virtualizedHeadRows.length > 0 ? (
                  <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const row = virtualizedHeadRows[virtualRow.index]
                      if (!row) return null

                      return (
                        <div
                          key={`virtual-row:${row.id}`}
                          data-index={virtualRow.index}
                          ref={rowVirtualizer.measureElement}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <div className="pb-5">
                            <KannaTranscriptRow
                              row={row}
                              onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                              onExitPlanModeConfirm={onExitPlanModeConfirm}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
                {pinnedTailRows.map((row) => (
                  <div key={`tail-row:${row.id}`} className="pb-5">
                    <KannaTranscriptRow
                      row={row}
                      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                      onExitPlanModeConfirm={onExitPlanModeConfirm}
                    />
                  </div>
                ))}
              </>
            </OpenLocalLinkProvider>
          ) : (
            <div style={{ height: transcriptPaddingBottom }} aria-hidden="true" />
          )}
          {isProcessing ? <ProcessingMessage status={runtimeStatus ?? undefined} /> : null}
          {!isProcessing && isDraining ? (
            <DrainingIndicator onStop={() => void onStopDraining()} />
          ) : null}
          {commandError ? (
            <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-xl px-4 py-3">
              {commandError}
            </div>
          ) : null}
          <div style={{ height: 250 }} aria-hidden="true" />
        </div>
      </div>

      {messages.length === 0 ? (
        <div
          className="pointer-events-none absolute inset-x-4 animate-fade-in"
          style={{
            top: CHAT_NAVBAR_OFFSET_PX,
            bottom: transcriptPaddingBottom,
          }}
        >
          <div className="mx-auto flex h-full max-w-[800px] items-center justify-center">
            <div className="flex flex-col items-center justify-center text-muted-foreground gap-4 opacity-70">
              <Flower strokeWidth={1.5} className="size-8 text-muted-foreground kanna-empty-state-flower" />
              <div
                className="text-base font-normal text-muted-foreground text-center max-w-xs flex items-center kanna-empty-state-text"
                aria-label={EMPTY_STATE_TEXT}
              >
                <span className="relative inline-grid place-items-start">
                  <span className="invisible col-start-1 row-start-1 whitespace-pre flex items-center">
                    <span>{EMPTY_STATE_TEXT}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true" />
                  </span>
                  <span className="col-start-1 row-start-1 whitespace-pre flex items-center">
                    <span>{typedEmptyStateText}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true">
                      <span
                        className="kanna-typewriter-cursor"
                        data-typing-complete={isEmptyStateTypingComplete ? "true" : "false"}
                      />
                    </span>
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isPageFileDragActive ? (
        <div className="absolute inset-0 z-30 pointer-events-none">
          <div className="absolute inset-0 backdrop-blur-sm" />
          <div className="absolute inset-6 ">
            <div className="flex h-full items-center justify-center">
              <div className="text-center flex flex-col items-center justify-center gap-3">
                <Upload className="mx-auto size-14 text-foreground" strokeWidth={1.75} />
                <div className="text-xl font-medium text-foreground">Drop up to 10 files</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{ bottom: SCROLL_BUTTON_BOTTOM_PX }}
        className={cn(
          "absolute left-1/2 -translate-x-1/2 z-10 transition-all",
          showScrollButton
            ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            : "scale-60 duration-300 ease-out pointer-events-none blur-sm opacity-0"
        )}
      >
        <button
          onClick={scrollToBottom}
          className="flex items-center transition-colors gap-1.5 px-2 bg-white hover:bg-muted border border-border rounded-full aspect-square cursor-pointer text-sm text-primary hover:text-foreground dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100 dark:border-slate-600"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>
    </>
  )
})

interface ChatInputDockProps {
  inputRef: RefObject<HTMLDivElement | null>
  chatInputRef: RefObject<ChatInputHandle | null>
  chatInputElementRef: RefObject<HTMLTextAreaElement | null>
  activeChatId: string | null
  hasSelectedProject: boolean
  runtimeStatus: string | null
  canCancel: boolean
  projectId: string | null
  activeProvider: "claude" | "codex" | null
  availableProviders: KannaState["availableProviders"]
  contextWindowSnapshot: ContextWindowSnapshot | null
  onSubmit: KannaState["handleSend"]
  onCancel: () => void
}

const ChatInputDock = memo(function ChatInputDock({
  inputRef,
  chatInputRef,
  chatInputElementRef,
  activeChatId,
  hasSelectedProject,
  runtimeStatus,
  canCancel,
  projectId,
  activeProvider,
  availableProviders,
  contextWindowSnapshot,
  onSubmit,
  onCancel,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={inputRef}>
        <ChatInput
          ref={chatInputRef}
          inputElementRef={chatInputElementRef}
          key={activeChatId ?? "new-chat"}
          onSubmit={onSubmit}
          onCancel={onCancel}
          disabled={!hasSelectedProject || runtimeStatus === "waiting_for_user"}
          canCancel={canCancel}
          chatId={activeChatId}
          projectId={projectId}
          activeProvider={activeProvider}
          availableProviders={availableProviders}
          contextWindowSnapshot={contextWindowSnapshot}
        />
      </div>
    </div>
  )
})

interface TerminalWorkspaceShellProps {
  projectId: string
  fixedTerminalHeight: number
  terminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["projects"][string]
  addTerminal: ReturnType<typeof useTerminalLayoutStore.getState>["addTerminal"]
  socket: KannaState["socket"]
  connectionStatus: KannaState["connectionStatus"]
  scrollback: number
  minColumnWidth: number
  splitTerminalShortcut?: string[]
  focusRequestVersion: number
  onTerminalCommandSent?: () => void
  onRemoveTerminal: (projectId: string, terminalId: string) => void
  onTerminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["setTerminalSizes"]
}

const TerminalWorkspaceShell = memo(function TerminalWorkspaceShell({
  projectId,
  fixedTerminalHeight,
  terminalLayout,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  focusRequestVersion,
  onTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
}: TerminalWorkspaceShellProps) {
  return (
    <div style={fixedTerminalHeight > 0 ? { height: `${fixedTerminalHeight}px` } : undefined}>
      <TerminalWorkspace
        projectId={projectId}
        layout={terminalLayout}
        onAddTerminal={addTerminal}
        socket={socket}
        connectionStatus={connectionStatus}
        scrollback={scrollback}
        minColumnWidth={minColumnWidth}
        splitTerminalShortcut={splitTerminalShortcut}
        focusRequestVersion={focusRequestVersion}
        onTerminalCommandSent={onTerminalCommandSent}
        onRemoveTerminal={onRemoveTerminal}
        onTerminalLayout={onTerminalLayout}
      />
    </div>
  )
})

export function hasFileDragTypes(types: Iterable<string>) {
  return Array.from(types).includes("Files")
}

function isAbsoluteLocalPath(value: string) {
  return value.startsWith("/")
    || value === "~"
    || value.startsWith("~/")
    || /^[A-Za-z]:[\\/]/u.test(value)
}

function joinProjectRelativePath(projectPath: string, filePath: string) {
  const separator = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/"
  const normalizedProjectPath = projectPath.replace(/[\\/]+$/u, "")
  const normalizedFilePath = filePath.replace(/^[\\/]+/u, "")
  return `${normalizedProjectPath}${separator}${normalizedFilePath}`
}

function resolveDiffFilePath(projectPath: string | null, filePath: string) {
  return !projectPath || isAbsoluteLocalPath(filePath)
    ? filePath
    : joinProjectRelativePath(projectPath, filePath)
}

export function ChatPage() {
  const state = useOutletContext<KannaState>()
  const dialog = useAppDialog()
  const layoutRootRef = useRef<HTMLDivElement>(null)
  const chatCardRef = useRef<HTMLDivElement>(null)
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("")
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] = useState(false)
  const [fixedTerminalHeight, setFixedTerminalHeight] = useState(0)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false)
  const [diffRenderMode, setDiffRenderMode] = useState<"unified" | "split">("unified")
  const [wrapDiffLines, setWrapDiffLines] = useState(false)
  const pageFileDragDepthRef = useRef(0)
  const terminalDiffRefreshTimeoutRef = useRef<number | null>(null)
  const wasProcessingRef = useRef(false)
  const lastProjectGitRefreshProjectIdRef = useRef<string | null>(null)
  const activeChatIdRef = useRef<string | null>(state.activeChatId)
  const projectPathRef = useRef<string | null>(state.runtime?.localPath ?? state.navbarLocalPath ?? null)
  const projectId = state.activeProjectId
  const projectTerminalLayout = useTerminalLayoutStore((store) => (projectId ? store.projects[projectId] : undefined))
  const terminalLayout = projectTerminalLayout ?? DEFAULT_PROJECT_TERMINAL_LAYOUT
  const projectRightSidebarLayout = useRightSidebarStore((store) => (projectId ? store.projects[projectId] : undefined))
  const rightSidebarLayout = projectRightSidebarLayout ?? DEFAULT_PROJECT_RIGHT_SIDEBAR_LAYOUT
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const toggleVisibility = useTerminalLayoutStore((store) => store.toggleVisibility)
  const resetMainSizes = useTerminalLayoutStore((store) => store.resetMainSizes)
  const setMainSizes = useTerminalLayoutStore((store) => store.setMainSizes)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)
  const toggleRightSidebar = useRightSidebarStore((store) => store.toggleVisibility)
  const setRightSidebarSize = useRightSidebarStore((store) => store.setSize)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const keybindings = state.keybindings
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const baseContextWindowSnapshotRef = useRef<ContextWindowSnapshot | null>(null)
  const contextWindowSnapshot = useMemo(() => {
    const derivedSnapshot = deriveLatestContextWindowSnapshot(state.chatSnapshot?.messages ?? [])
    const previousSnapshot = baseContextWindowSnapshotRef.current
    if (sameContextWindowSnapshot(previousSnapshot, derivedSnapshot)) {
      return previousSnapshot
    }
    baseContextWindowSnapshotRef.current = derivedSnapshot
    return derivedSnapshot
  }, [state.chatSnapshot?.messages])

  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && terminalLayout.isVisible && hasTerminals)
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals)
  const showRightSidebar = Boolean(projectId && rightSidebarLayout.isVisible)
  const shouldRenderRightSidebarLayout = Boolean(projectId)
  const clampRightSidebarSize = useCallback((size: number, widthOverride?: number) => {
    if (!Number.isFinite(size)) {
      return rightSidebarLayout.size
    }
    const nextLayoutWidth = widthOverride ?? layoutWidth
    const minPercentFromWidth = nextLayoutWidth > 0
      ? (RIGHT_SIDEBAR_MIN_WIDTH_PX / nextLayoutWidth) * 100
      : RIGHT_SIDEBAR_MIN_SIZE_PERCENT
    return Math.max(RIGHT_SIDEBAR_MIN_SIZE_PERCENT, minPercentFromWidth, size)
  }, [layoutWidth, rightSidebarLayout.size])
  const effectiveRightSidebarSize = clampRightSidebarSize(rightSidebarLayout.size)

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
    shouldRenderRightSidebarLayout,
    showRightSidebar,
    rightSidebarSize: effectiveRightSidebarSize,
  })

  useStickyChatFocus({
    rootRef: chatCardRef,
    fallbackRef: chatInputElementRef,
    enabled: state.hasSelectedProject && state.runtime?.status !== "waiting_for_user",
    canCancel: state.canCancel,
  })

  useEffect(() => {
    activeChatIdRef.current = state.activeChatId
  }, [state.activeChatId])

  useLayoutEffect(() => {
    const element = layoutRootRef.current
    if (!element) return

    const updateWidth = () => {
      const nextWidth = element.clientWidth
      setLayoutWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    updateWidth()

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    projectPathRef.current = state.runtime?.localPath ?? state.navbarLocalPath ?? null
  }, [state.navbarLocalPath, state.runtime?.localPath])

  const refreshProjectGitSnapshot = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }
    void state.socket.command({ type: "chat.refreshDiffs", chatId }).catch(() => {})
  }, [state.socket])

  const refreshDiffs = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId || !showRightSidebar) {
      return
    }
    void state.socket.command({ type: "chat.refreshDiffs", chatId }).catch(() => {})
  }, [showRightSidebar, state.socket])

  const scheduleTerminalDiffRefresh = useCallback(() => {
    if (!activeChatIdRef.current || !showRightSidebar) {
      return
    }
    if (terminalDiffRefreshTimeoutRef.current !== null) {
      window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
    }
    terminalDiffRefreshTimeoutRef.current = window.setTimeout(() => {
      terminalDiffRefreshTimeoutRef.current = null
      refreshDiffs()
    }, 1_000)
  }, [refreshDiffs, showRightSidebar])

  const handleOpenDiffFile = useCallback((filePath: string) => {
    const projectPath = projectPathRef.current
    const resolvedPath = resolveDiffFilePath(projectPath, filePath)
    void state.handleOpenLocalLink({ path: resolvedPath })
  }, [state.handleOpenLocalLink])

  const handleCopyDiffFilePath = useCallback((filePath: string) => {
    const projectPath = projectPathRef.current
    void state.handleCopyPath(resolveDiffFilePath(projectPath, filePath))
  }, [state.handleCopyPath])

  const handleCopyDiffRelativePath = useCallback((filePath: string) => {
    void state.handleCopyPath(filePath)
  }, [state.handleCopyPath])

  const handleLoadDiffPatch = useCallback(async (filePath: string) => {
    if (!projectId) {
      throw new Error("Project not found")
    }
    const result = await state.socket.command<{ patch: string }>({
      type: "project.readDiffPatch",
      projectId,
      path: filePath,
    })
    return result.patch
  }, [projectId, state.socket])

  const handleDiscardDiffFile = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    void (async () => {
      const confirmed = await dialog.confirm({
        title: "Discard Changes",
        description: `Discard changes for "${filePath}"? This cannot be undone.`,
        confirmLabel: "Discard",
        confirmVariant: "destructive",
      })
      if (!confirmed) return

      try {
        await state.socket.command({
          type: "chat.discardDiffFile",
          chatId,
          path: filePath,
        })
      } catch (error) {
        await dialog.alert({
          title: "Discard failed",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: "OK",
        })
      }
    })()
  }, [dialog, state.socket])

  const handleIgnoreDiffFile = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    void (async () => {
      const confirmed = await dialog.confirm({
        title: "Ignore File",
        description: `Add "${filePath}" to .gitignore?`,
        confirmLabel: "Ignore",
        confirmVariant: "destructive",
      })
      if (!confirmed) return

      try {
        await state.socket.command({
          type: "chat.ignoreDiffFile",
          chatId,
          path: filePath,
        })
      } catch (error) {
        await dialog.alert({
          title: "Ignore failed",
          description: error instanceof Error ? error.message : String(error),
          closeLabel: "OK",
        })
      }
    })()
  }, [dialog, state.socket])

  const handleCommitDiffs = useCallback(async (args: { paths: string[]; summary: string; description: string; mode: DiffCommitMode }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }
    const result = await state.socket.command<DiffCommitResult>({
      type: "chat.commitDiffs",
      chatId,
      paths: args.paths,
      summary: args.summary,
      description: args.description,
      mode: args.mode,
    })
    if (result.snapshotChanged) {
      refreshDiffs()
    }
    if (!result.ok) {
      await dialog.alert({
        title: result.title,
        description: result.localCommitCreated
          ? `${result.message}\n\nA local commit was created, but the push did not complete.${result.detail ? `\n\n${result.detail}` : ""}`
          : `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
        closeLabel: "OK",
      })
    }
    return result
  }, [dialog, refreshDiffs, state.socket])

  const handleSyncBranch = useCallback(async (action: "fetch" | "pull" | "push" | "publish") => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    const result = await state.socket.command<ChatSyncResult>({
      type: "chat.syncBranch",
      chatId,
      action,
    })
    if (result.snapshotChanged) {
      refreshDiffs()
    }
    if (!result.ok) {
      await dialog.alert({
        title: result.title,
        description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
        closeLabel: "OK",
      })
    }
    return result
  }, [dialog, refreshDiffs, state.socket])

  const handleGenerateCommitMessage = useCallback(async (args: { paths: string[] }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return { subject: "", body: "" }
    }

    const result = await state.socket.command<{ subject: string; body: string }>({
      type: "chat.generateCommitMessage",
      chatId,
      paths: args.paths,
    })

    return {
      subject: result.subject,
      body: result.body,
    }
  }, [state.socket])

  const handleInitializeGit = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.initGit",
        chatId,
      })
      if (result.snapshotChanged) {
        refreshProjectGitSnapshot()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Initialize git failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshProjectGitSnapshot, state.socket])

  const handleGetGitHubPublishInfo = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        ghInstalled: false,
        authenticated: false,
        owners: [],
        suggestedRepoName: "my-repo",
      } satisfies GitHubPublishInfo
    }

    return await state.socket.command<GitHubPublishInfo>({
      type: "chat.getGitHubPublishInfo",
      chatId,
    })
  }, [state.socket])

  const handleCheckGitHubRepoAvailability = useCallback(async (args: { owner: string; name: string }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        available: false,
        message: "No active chat.",
      } satisfies GitHubRepoAvailabilityResult
    }

    return await state.socket.command<GitHubRepoAvailabilityResult>({
      type: "chat.checkGitHubRepoAvailability",
      chatId,
      owner: args.owner,
      name: args.name,
    })
  }, [state.socket])

  const handleSetupGitHub = useCallback(async (args: {
    owner: string
    name: string
    visibility: "public" | "private"
    description: string
  }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.publishToGitHub",
        chatId,
        owner: args.owner,
        name: args.name,
        visibility: args.visibility,
        description: args.description.trim() || undefined,
      })
      if (result.snapshotChanged) {
        refreshProjectGitSnapshot()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Publish failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshProjectGitSnapshot, state.socket])

  const handleListBranches = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        recent: [],
        local: [],
        remote: [],
        pullRequests: [],
        pullRequestsStatus: "unavailable",
      } satisfies ChatBranchListResult
    }

    return await state.socket.command<ChatBranchListResult>({
      type: "chat.listBranches",
      chatId,
    })
  }, [state.socket])

  const handleCheckoutBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }

    let bringChanges = false
    if ((state.chatDiffSnapshot?.files.length ?? 0) > 0) {
      const confirmed = await dialog.confirm({
        title: "Bring Changes?",
        description: `You have uncommitted changes. Bring them to ${branch.name}?`,
        confirmLabel: "Bring Changes",
        cancelLabel: "Stay Here",
      })
      if (!confirmed) {
        return
      }
      bringChanges = true
    }

    try {
      const result = await state.socket.command<ChatCheckoutBranchResult>({
        type: "chat.checkoutBranch",
        chatId,
        branch: serializeBranchSelection(branch),
        bringChanges,
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok && !result.cancelled) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
    } catch (error) {
      await dialog.alert({
        title: "Checkout failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
    }
  }, [dialog, refreshDiffs, state.chatDiffSnapshot?.files.length, state.socket])

  const handlePreviewMergeBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        currentBranchName: undefined,
        targetBranchName: branch.name,
        targetDisplayName: branch.displayName,
        status: "error",
        commitCount: 0,
        hasConflicts: false,
        message: "Merge preview unavailable.",
      } satisfies ChatMergePreviewResult
    }

    return await state.socket.command<ChatMergePreviewResult>({
      type: "chat.previewMergeBranch",
      chatId,
      branch: serializeBranchSelection(branch),
    })
  }, [state.socket])

  const handleMergeBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<ChatMergeBranchResult>({
        type: "chat.mergeBranch",
        chatId,
        branch: serializeBranchSelection(branch),
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: "Merge failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket])

  const handleCreateBranch = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }

    const name = await dialog.prompt({
      title: "New Branch",
      description: "Enter a branch name.",
      placeholder: "feature/my-branch",
      confirmLabel: "Create",
    })
    if (!name) {
      return
    }

    const branchList = await handleListBranches()
    const currentBranchName = branchList.currentBranchName
    const defaultBranchName = branchList.defaultBranchName

    let baseBranchName = defaultBranchName
    if (defaultBranchName && currentBranchName && defaultBranchName !== currentBranchName) {
      const createFromCurrent = await dialog.confirm({
        title: "Branch Base",
        description: `Create "${name}" from ${currentBranchName} instead of ${defaultBranchName}?`,
        confirmLabel: `From ${currentBranchName}`,
        cancelLabel: `From ${defaultBranchName}`,
      })
      baseBranchName = createFromCurrent ? currentBranchName : defaultBranchName
    }

    try {
      const result = await state.socket.command<ChatCreateBranchResult>({
        type: "chat.createBranch",
        chatId,
        name,
        baseBranchName,
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: result.title,
          description: `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: "OK",
        })
      }
    } catch (error) {
      await dialog.alert({
        title: "Create branch failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "OK",
      })
    }
  }, [dialog, handleListBranches, refreshDiffs, state.socket])

  const handleCloseRightSidebar = useCallback(() => {
    if (!projectId) return
    toggleRightSidebar(projectId)
  }, [projectId, toggleRightSidebar])
  const handleToggleRightSidebar = useCallback(() => {
    if (!projectId) return

    if (showRightSidebar) {
      toggleRightSidebar(projectId)
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
        if (result?.ok && !showRightSidebar) {
          toggleRightSidebar(projectId)
        }
      })()
      return
    }

    toggleRightSidebar(projectId)
  }, [dialog, handleInitializeGit, projectId, showRightSidebar, state.chatDiffSnapshot?.status, toggleRightSidebar])
  const handleCancel = useCallback(() => {
    void state.handleCancel()
  }, [state.handleCancel])
  const handleOpenExternal = useCallback((action: "open_finder" | "open_editor" | "open_terminal") => {
    void state.handleOpenExternal(action)
  }, [state.handleOpenExternal])
  const handleRemoveTerminal = useCallback((currentProjectId: string, terminalId: string) => {
    void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
    removeTerminal(currentProjectId, terminalId)
  }, [removeTerminal, state.socket])

  function hasDraggedFiles(event: React.DragEvent) {
    return hasFileDragTypes(event.dataTransfer?.types ?? [])
  }

  function enqueueDroppedFiles(files: File[]) {
    if (!state.hasSelectedProject || files.length === 0) {
      return
    }
    chatInputRef.current?.enqueueFiles(files)
  }

  const handleToggleEmbeddedTerminal = () => {
    if (!projectId) return
    if (hasTerminals) {
      toggleVisibility(projectId)
      return
    }

    addTerminal(projectId)
  }

  const handleTerminalResize = (layout: Record<string, number>) => {
    if (!projectId || !showTerminalPane || isTerminalAnimating.current) {
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
  }

  useEffect(() => {
    if (state.messages.length !== 0) return

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
  }, [state.activeChatId, state.messages.length])

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
            if (result?.ok && !showRightSidebar) {
              toggleRightSidebar(projectId)
            }
          })()
          return
        }
        toggleRightSidebar(projectId)
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
  }, [addTerminal, dialog, handleInitializeGit, handleToggleEmbeddedTerminal, projectId, resolvedKeybindings, showRightSidebar, state.chatDiffSnapshot?.status, toggleRightSidebar, toggleVisibility])

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      state.updateScrollState()
    })
    const timeoutId = window.setTimeout(() => {
      state.updateScrollState()
    }, TERMINAL_TOGGLE_ANIMATION_DURATION_MS)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
    }
  }, [shouldRenderTerminalLayout, showTerminalPane, state.updateScrollState])

  useEffect(() => {
    function handleResize() {
      state.updateScrollState()
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [state.updateScrollState])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    const intervalId = window.setInterval(() => {
      refreshDiffs()
    }, DIFF_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    refreshDiffs()
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (!projectId || !state.activeChatId) {
      return
    }
    if (lastProjectGitRefreshProjectIdRef.current === projectId) {
      return
    }
    lastProjectGitRefreshProjectIdRef.current = projectId
    refreshProjectGitSnapshot()
  }, [projectId, refreshProjectGitSnapshot, state.activeChatId])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    function handleDiffRefresh() {
      if (document.visibilityState !== "visible") return
      refreshDiffs()
    }

    window.addEventListener("focus", handleDiffRefresh)
    document.addEventListener("visibilitychange", handleDiffRefresh)

    return () => {
      window.removeEventListener("focus", handleDiffRefresh)
      document.removeEventListener("visibilitychange", handleDiffRefresh)
    }
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (showRightSidebar && wasProcessingRef.current && !state.isProcessing) {
      refreshDiffs()
    }
    wasProcessingRef.current = state.isProcessing
  }, [projectId, refreshDiffs, showRightSidebar, state.isProcessing])

  useEffect(() => {
    return () => {
      if (terminalDiffRefreshTimeoutRef.current !== null) {
        window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (showRightSidebar) {
      return
    }
    if (terminalDiffRefreshTimeoutRef.current !== null) {
      window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
      terminalDiffRefreshTimeoutRef.current = null
    }
  }, [projectId, showRightSidebar])

  useEffect(() => {
    const element = layoutRootRef.current
    if (!element) return

    const updateHeight = () => {
      const containerHeight = element.getBoundingClientRect().height

      if (!shouldRenderTerminalLayout) {
        return
      }

      if (containerHeight <= 0) return
      const nextHeight = containerHeight * (terminalLayout.mainSizes[1] / 100)
      if (nextHeight <= 0) return
      setFixedTerminalHeight((current) => (Math.abs(current - nextHeight) < 1 ? current : nextHeight))
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()

    return () => observer.disconnect()
  }, [projectId, shouldRenderTerminalLayout, terminalLayout.mainSizes])

  useLayoutEffect(() => {
    if (!showRightSidebar || layoutWidth <= 0 || isRightSidebarAnimating.current) {
      return
    }

    const clampedRightSidebarSize = clampRightSidebarSize(rightSidebarLayout.size, layoutWidth)
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
    clampRightSidebarSize,
    isRightSidebarAnimating,
    layoutWidth,
    rightSidebarLayout.size,
    rightSidebarPanelGroupRef,
    showRightSidebar,
  ])

  const handleTranscriptDragEnter = useCallback((event: React.DragEvent) => {
    if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current += 1
    setIsPageFileDragActive(true)
  }, [state.hasSelectedProject])

  const handleTranscriptDragOver = useCallback((event: React.DragEvent) => {
    if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    if (!isPageFileDragActive) {
      setIsPageFileDragActive(true)
    }
  }, [isPageFileDragActive, state.hasSelectedProject])

  const handleTranscriptDragLeave = useCallback((event: React.DragEvent) => {
    if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = Math.max(0, pageFileDragDepthRef.current - 1)
    if (pageFileDragDepthRef.current === 0) {
      setIsPageFileDragActive(false)
    }
  }, [state.hasSelectedProject])

  const handleTranscriptDrop = useCallback((event: React.DragEvent) => {
    if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = 0
    setIsPageFileDragActive(false)
    enqueueDroppedFiles([...event.dataTransfer.files])
  }, [state.hasSelectedProject])

  const chatCard = (
    <Card
      ref={chatCardRef}
      className="bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative"
      onDragEnter={handleTranscriptDragEnter}
      onDragOver={handleTranscriptDragOver}
      onDragLeave={handleTranscriptDragLeave}
      onDrop={handleTranscriptDrop}
    >
      <CardContent className="flex flex-1 min-h-0 flex-col p-0 overflow-hidden relative">
        <ChatNavbar
          sidebarCollapsed={state.sidebarCollapsed}
          onOpenSidebar={state.openSidebar}
          onExpandSidebar={state.expandSidebar}
          onNewChat={state.handleCompose}
          localPath={state.navbarLocalPath}
          embeddedTerminalVisible={showTerminalPane}
          onToggleEmbeddedTerminal={projectId ? handleToggleEmbeddedTerminal : undefined}
          rightSidebarVisible={showRightSidebar}
          onToggleRightSidebar={projectId ? handleToggleRightSidebar : undefined}
          onOpenExternal={handleOpenExternal}
          editorLabel={state.editorLabel}
          finderShortcut={resolvedKeybindings.bindings.openInFinder}
          editorShortcut={resolvedKeybindings.bindings.openInEditor}
          terminalShortcut={resolvedKeybindings.bindings.toggleEmbeddedTerminal}
          rightSidebarShortcut={resolvedKeybindings.bindings.toggleRightSidebar}
          branchName={state.chatDiffSnapshot?.branchName}
          hasGitRepo={state.chatDiffSnapshot?.status !== "no_repo"}
          gitStatus={state.chatDiffSnapshot?.status}
        />
        <ChatTranscriptViewport
          scrollRef={state.scrollRef}
          messages={state.messages}
          transcriptPaddingBottom={state.transcriptPaddingBottom}
          localPath={state.runtime?.localPath}
          latestToolIds={state.latestToolIds}
          isHistoryLoading={state.isHistoryLoading}
          hasOlderHistory={state.hasOlderHistory}
          isProcessing={state.isProcessing}
          runtimeStatus={state.runtime?.status ?? null}
          isDraining={state.isDraining}
          commandError={state.commandError}
          loadOlderHistory={state.loadOlderHistory}
          onStopDraining={state.handleStopDraining}
          onOpenLocalLink={state.handleOpenLocalLink}
          onAskUserQuestionSubmit={state.handleAskUserQuestion}
          onExitPlanModeConfirm={state.handleExitPlanMode}
          showScrollButton={state.showScrollButton}
          onScrollChange={state.updateScrollState}
          scrollToBottom={state.scrollToBottom}
          typedEmptyStateText={typedEmptyStateText}
          isEmptyStateTypingComplete={isEmptyStateTypingComplete}
          isPageFileDragActive={isPageFileDragActive}
        />
      </CardContent>

      <ChatInputDock
        inputRef={state.inputRef}
        chatInputRef={chatInputRef}
        chatInputElementRef={chatInputElementRef}
        activeChatId={state.activeChatId}
        hasSelectedProject={state.hasSelectedProject}
        runtimeStatus={state.runtime?.status ?? null}
        canCancel={state.canCancel}
        projectId={projectId}
        activeProvider={state.runtime?.provider ?? null}
        availableProviders={state.availableProviders}
        contextWindowSnapshot={contextWindowSnapshot}
        onSubmit={state.handleSend}
        onCancel={handleCancel}
      />
    </Card>
  )

  return (
    <div ref={layoutRootRef} className="flex-1 flex flex-col min-w-0 relative">
      {shouldRenderRightSidebarLayout && projectId ? (
        <ResizablePanelGroup
          key={`${projectId}-right-sidebar`}
          groupRef={rightSidebarPanelGroupRef}
          orientation="horizontal"
          className="flex-1 min-h-0"
          onLayoutChange={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return
            }

            const clampedRightSidebarSize = clampRightSidebarSize(layout.rightSidebar)
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

            setRightSidebarSize(projectId, clampRightSidebarSize(layout.rightSidebar))
          }}
        >
          <ResizablePanel
            id="workspace"
            defaultSize={`${100 - effectiveRightSidebarSize}%`}
            minSize="20%"
            className="min-h-0 min-w-0"
          >
            {shouldRenderTerminalLayout ? (
              <ResizablePanelGroup
                key={projectId}
                groupRef={mainPanelGroupRef}
                orientation="vertical"
                className="flex-1 min-h-0"
                onLayoutChanged={handleTerminalResize}
              >
                <ResizablePanel id="chat" defaultSize={`${terminalLayout.mainSizes[0]}%`} minSize="25%" className="min-h-0">
                  {chatCard}
                </ResizablePanel>
                <ResizableHandle
                  withHandle
                  orientation="vertical"
                  disabled={!showTerminalPane}
                  className={cn(!showTerminalPane && "pointer-events-none opacity-0")}
                />
                <ResizablePanel
                  id="terminal"
                  defaultSize={`${terminalLayout.mainSizes[1]}%`}
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
                    <div style={fixedTerminalHeight > 0 ? { height: `${fixedTerminalHeight}px` } : undefined}>
                      <TerminalWorkspaceShell
                        projectId={projectId}
                        fixedTerminalHeight={fixedTerminalHeight}
                        terminalLayout={terminalLayout}
                        addTerminal={addTerminal}
                        socket={state.socket}
                        connectionStatus={state.connectionStatus}
                        scrollback={scrollback}
                        minColumnWidth={minColumnWidth}
                        splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
                        focusRequestVersion={terminalFocusRequestVersion}
                        onTerminalCommandSent={scheduleTerminalDiffRefresh}
                        onRemoveTerminal={handleRemoveTerminal}
                        onTerminalLayout={setTerminalSizes}
                      />
                    </div>
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              chatCard
            )}
          </ResizablePanel>
          <ResizableHandle
            withHandle={false}
            orientation="horizontal"
            disabled={!showRightSidebar}
            className={cn(!showRightSidebar && "pointer-events-none opacity-0")}
          />
          <ResizablePanel
            id="rightSidebar"
            defaultSize={`${effectiveRightSidebarSize}%`}
            className="min-h-0 min-w-0"
            elementRef={sidebarPanelRef}
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
              <RightSidebar
                projectId={projectId}
                diffs={state.chatDiffSnapshot ?? EMPTY_DIFF_SNAPSHOT}
                editorLabel={state.editorLabel}
                diffRenderMode={diffRenderMode}
                wrapLines={wrapDiffLines}
                onOpenFile={handleOpenDiffFile}
                onDiscardFile={handleDiscardDiffFile}
                onIgnoreFile={handleIgnoreDiffFile}
                onCopyFilePath={handleCopyDiffFilePath}
                onCopyRelativePath={handleCopyDiffRelativePath}
                onLoadPatch={handleLoadDiffPatch}
                onListBranches={handleListBranches}
                onPreviewMergeBranch={handlePreviewMergeBranch}
                onMergeBranch={handleMergeBranch}
                onCheckoutBranch={handleCheckoutBranch}
                onCreateBranch={handleCreateBranch}
                onGenerateCommitMessage={handleGenerateCommitMessage}
                onInitializeGit={handleInitializeGit}
                onGetGitHubPublishInfo={handleGetGitHubPublishInfo}
                onCheckGitHubRepoAvailability={handleCheckGitHubRepoAvailability}
                onSetupGitHub={handleSetupGitHub}
                onCommit={handleCommitDiffs}
                onSyncWithRemote={handleSyncBranch}
                onDiffRenderModeChange={setDiffRenderMode}
                onWrapLinesChange={setWrapDiffLines}
                onClose={handleCloseRightSidebar}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : shouldRenderTerminalLayout && projectId ? (
        <ResizablePanelGroup
          key={projectId}
          groupRef={mainPanelGroupRef}
          orientation="vertical"
          className="flex-1 min-h-0"
          onLayoutChanged={handleTerminalResize}
        >
          <ResizablePanel id="chat" defaultSize={`${terminalLayout.mainSizes[0]}%`} minSize="25%" className="min-h-0">
            {chatCard}
          </ResizablePanel>
          <ResizableHandle
            withHandle
            orientation="vertical"
            disabled={!showTerminalPane}
            className={cn(!showTerminalPane && "pointer-events-none opacity-0")}
          />
          <ResizablePanel
            id="terminal"
            defaultSize={`${terminalLayout.mainSizes[1]}%`}
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
                socket={state.socket}
                connectionStatus={state.connectionStatus}
                scrollback={scrollback}
                minColumnWidth={minColumnWidth}
                splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
                focusRequestVersion={terminalFocusRequestVersion}
                onTerminalCommandSent={scheduleTerminalDiffRefresh}
                onRemoveTerminal={handleRemoveTerminal}
                onTerminalLayout={setTerminalSizes}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        chatCard
      )}

    </div>
  )
}

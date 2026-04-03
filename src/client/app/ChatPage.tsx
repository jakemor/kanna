import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { useOutletContext } from "react-router-dom"
import type { HydratedTranscriptMessage } from "../../shared/types"
import { ChatInput, type ChatInputHandle } from "../components/chat-ui/ChatInput"
import { ChatNavbar } from "../components/chat-ui/ChatNavbar"
import { RightSidebar } from "../components/chat-ui/RightSidebar"
import { TerminalWorkspace } from "../components/chat-ui/TerminalWorkspace"
import { DrainingIndicator } from "../components/messages/DrainingIndicator"
import { ProcessingMessage } from "../components/messages/ProcessingMessage"
import { Card, CardContent } from "../components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable"
import { ScrollArea } from "../components/ui/scroll-area"
import { actionMatchesEvent, getResolvedKeybindings } from "../lib/keybindings"
import { cn } from "../lib/utils"
import {
  DEFAULT_PROJECT_RIGHT_SIDEBAR_LAYOUT,
  RIGHT_SIDEBAR_MAX_SIZE_PERCENT,
  RIGHT_SIDEBAR_MIN_SIZE_PERCENT,
  useRightSidebarStore,
} from "../stores/rightSidebarStore"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { DEFAULT_PROJECT_TERMINAL_LAYOUT, useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import { shouldCloseTerminalPane } from "./terminalLayoutResize"
import { TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "./terminalToggleAnimation"
import { useRightSidebarToggleAnimation } from "./useRightSidebarToggleAnimation"
import { useTerminalToggleAnimation } from "./useTerminalToggleAnimation"
import type { KannaState } from "./useKannaState"
import { KannaTranscript } from "./KannaTranscript"
import { useStickyChatFocus } from "./useStickyChatFocus"
import { useGitDiff } from "../hooks/useDiffExtractor"

const EMPTY_STATE_TEXT = "What are we building?"
const EMPTY_STATE_TYPING_INTERVAL_MS = 19
const CHAT_NAVBAR_OFFSET_PX = 72
const SCROLL_BUTTON_BOTTOM_PX = 120
const TRANSCRIPT_TOC_BREAKPOINT_PX = 1200

export interface TranscriptTocItem {
  id: string
  label: string
  order: number
}

export function getTranscriptTocLabel(content: string) {
  const firstLine = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstLine ?? "(attachment only)"
}

export function createTranscriptTocItems(messages: HydratedTranscriptMessage[]): TranscriptTocItem[] {
  let order = 0

  return messages.flatMap((message) => {
    if (message.kind !== "user_prompt" || message.hidden) {
      return []
    }

    order += 1
    return [{
      id: message.id,
      label: getTranscriptTocLabel(message.content),
      order,
    }]
  })
}

export function shouldShowTranscriptTocPanel(args: {
  enabled: boolean
  layoutWidth: number
  itemCount: number
}) {
  return args.enabled && args.layoutWidth > TRANSCRIPT_TOC_BREAKPOINT_PX && args.itemCount > 0
}

export function scrollTranscriptMessageIntoView(
  container: Pick<HTMLElement, "getBoundingClientRect" | "scrollTop" | "scrollTo">,
  target: Pick<HTMLElement, "getBoundingClientRect">
) {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const top = container.scrollTop + targetRect.top - containerRect.top - CHAT_NAVBAR_OFFSET_PX

  container.scrollTo({
    top: Math.max(0, top),
    behavior: "smooth",
  })
}

export function hasFileDragTypes(types: Iterable<string>) {
  return Array.from(types).includes("Files")
}

export function ChatPage() {
  const state = useOutletContext<KannaState>()
  const layoutRootRef = useRef<HTMLDivElement>(null)
  const chatCardRef = useRef<HTMLDivElement>(null)
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("")
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] = useState(false)
  const [fixedTerminalHeight, setFixedTerminalHeight] = useState(0)
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const pageFileDragDepthRef = useRef(0)
  const projectId = state.runtime?.projectId ?? null
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
  const showTranscriptToc = useChatPreferencesStore((store) => store.showTranscriptToc)
  const keybindings = state.keybindings
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const transcriptTocItems = useMemo(() => createTranscriptTocItems(state.messages), [state.messages])
  const shouldShowTranscriptToc = shouldShowTranscriptTocPanel({
    enabled: showTranscriptToc,
    layoutWidth,
    itemCount: transcriptTocItems.length,
  })

  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && terminalLayout.isVisible && hasTerminals)
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals)
  const showRightSidebar = Boolean(projectId && rightSidebarLayout.isVisible)
  const shouldRenderRightSidebarLayout = Boolean(projectId)
  const { refetch: refetchDiff } = useGitDiff(state.socket, projectId, showRightSidebar)
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
    rightSidebarSize: rightSidebarLayout.size,
  })

  useStickyChatFocus({
    rootRef: chatCardRef,
    fallbackRef: chatInputElementRef,
    enabled: state.hasSelectedProject && state.runtime?.status !== "waiting_for_user",
    canCancel: state.canCancel,
  })

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
  }, [addTerminal, handleToggleEmbeddedTerminal, projectId, resolvedKeybindings, toggleRightSidebar, toggleVisibility])

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
    const element = layoutRootRef.current
    if (!element) return

    const updateHeight = () => {
      const containerHeight = element.getBoundingClientRect().height
      const containerWidth = element.getBoundingClientRect().width
      setLayoutWidth((current) => (Math.abs(current - containerWidth) < 1 ? current : containerWidth))

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

  const clampRightSidebarSize = (size: number) => {
    if (!Number.isFinite(size)) {
      return rightSidebarLayout.size
    }

    return Math.min(RIGHT_SIDEBAR_MAX_SIZE_PERCENT, Math.max(RIGHT_SIDEBAR_MIN_SIZE_PERCENT, size))
  }

  const chatCard = (
    <Card
      ref={chatCardRef}
      className="bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative"
      onDragEnter={(event) => {
        if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
        event.preventDefault()
        pageFileDragDepthRef.current += 1
        setIsPageFileDragActive(true)
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
        if (!isPageFileDragActive) {
          setIsPageFileDragActive(true)
        }
      }}
      onDragLeave={(event) => {
        if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
        event.preventDefault()
        pageFileDragDepthRef.current = Math.max(0, pageFileDragDepthRef.current - 1)
        if (pageFileDragDepthRef.current === 0) {
          setIsPageFileDragActive(false)
        }
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event) || !state.hasSelectedProject) return
        event.preventDefault()
        pageFileDragDepthRef.current = 0
        setIsPageFileDragActive(false)
        enqueueDroppedFiles([...event.dataTransfer.files])
      }}
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
          onToggleRightSidebar={projectId ? () => toggleRightSidebar(projectId) : undefined}
          onOpenExternal={(action) => {
            void state.handleOpenExternal(action)
          }}
          editorLabel={state.editorLabel}
          finderShortcut={resolvedKeybindings.bindings.openInFinder}
          editorShortcut={resolvedKeybindings.bindings.openInEditor}
          terminalShortcut={resolvedKeybindings.bindings.toggleEmbeddedTerminal}
          rightSidebarShortcut={resolvedKeybindings.bindings.toggleRightSidebar}
        />

        <ScrollArea
          ref={state.scrollRef}
          onScroll={state.updateScrollState}
          className="flex-1 min-h-0 px-4 scroll-pt-[72px]"
        >
          {state.messages.length === 0 ? <div style={{ height: state.transcriptPaddingBottom }} aria-hidden="true" /> : null}
          {state.messages.length > 0 ? (
            <>
              <div className="animate-fade-in space-y-5 pt-[72px] max-w-[800px] mx-auto">
                <KannaTranscript
                  messages={state.messages}
                  isLoading={state.isProcessing}
                  localPath={state.runtime?.localPath}
                  latestToolIds={state.latestToolIds}
                  onOpenLocalLink={state.handleOpenLocalLink}
                  onAskUserQuestionSubmit={state.handleAskUserQuestion}
                  onExitPlanModeConfirm={state.handleExitPlanMode}
                />
                {state.isProcessing ? <ProcessingMessage status={state.runtime?.status} /> : null}
                {!state.isProcessing && state.isDraining ? (
                  <DrainingIndicator onStop={() => void state.handleStopDraining()} />
                ) : null}
                {state.commandError ? (
                  <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-xl px-4 py-3">
                    {state.commandError}
                  </div>
                ) : null}
              </div>
              <div style={{ height: 250 }} aria-hidden="true" />
            </>
          ) : null}
        </ScrollArea>

        {shouldShowTranscriptToc ? (
          <div
            className="absolute right-4 z-20"
            style={{ top: CHAT_NAVBAR_OFFSET_PX }}
          >
            <div
              className=" px-1 backdrop-blur-md"
              data-testid="transcript-toc"
            >
 
              <div className="flex flex-col items-end gap-[1px]">
                {transcriptTocItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex max-w-[175px] items-center justify-end gap-1 rounded-xl px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      const container = state.scrollRef.current
                      const target = document.getElementById(`msg-${item.id}`)
                      if (!container || !target) {
                        return
                      }

                      scrollTranscriptMessageIntoView(container, target)
                    }}
                    title={item.label}
                  >
                    {/* <span className="opacity-60 font-semibold translate-y-[0.5px]">{item.order}.</span> */}
                    <span className="min-w-0 truncate">{item.label}</span>
                    {/* <ArrowUpRight className="size-3"/> */}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {state.messages.length === 0 ? (
          <div
            key={state.activeChatId ?? "new-chat"}
            className="pointer-events-none absolute inset-x-4 animate-fade-in"
            style={{
              top: CHAT_NAVBAR_OFFSET_PX,
              bottom: state.transcriptPaddingBottom,
            }}
          >
            <div className="mx-auto flex h-full max-w-[800px] items-center justify-center">
              <div className="flex flex-col items-center justify-center text-muted-foreground gap-4 opacity-70">
                <Flower strokeWidth={1.5} className="size-8 text-muted-foreground kanna-empty-state-flower"></Flower>
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
            state.showScrollButton
              ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
              : "scale-60 duration-300 ease-out pointer-events-none blur-sm opacity-0"
          )}
        >
          <button
            onClick={state.scrollToBottom}
            className="flex items-center transition-colors gap-1.5 px-2 bg-white hover:bg-muted border border-border rounded-full aspect-square cursor-pointer text-sm text-primary hover:text-foreground dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100 dark:border-slate-600"
          >
            <ArrowDown className="h-5 w-5" />
          </button>
        </div>
      </CardContent>

      <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
        <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={state.inputRef}>
          <ChatInput
            ref={chatInputRef}
            inputElementRef={chatInputElementRef}
            key={state.activeChatId ?? "new-chat"}
            onSubmit={state.handleSend}
            onCancel={() => {
              void state.handleCancel()
            }}
            disabled={!state.hasSelectedProject || state.runtime?.status === "waiting_for_user"}
            canCancel={state.canCancel}
            chatId={state.activeChatId}
            projectId={projectId}
            activeProvider={state.runtime?.provider ?? null}
            availableProviders={state.availableProviders}
          />
        </div>
      </div>
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
            defaultSize={`${100 - rightSidebarLayout.size}%`}
            minSize="50%"
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
                      <TerminalWorkspace
                        projectId={projectId}
                        layout={terminalLayout}
                        onAddTerminal={addTerminal}
                        socket={state.socket}
                        connectionStatus={state.connectionStatus}
                        scrollback={scrollback}
                        minColumnWidth={minColumnWidth}
                        splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
                        focusRequestVersion={terminalFocusRequestVersion}
                        onRemoveTerminal={(currentProjectId, terminalId) => {
                          void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
                          removeTerminal(currentProjectId, terminalId)
                        }}
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
            withHandle
            orientation="horizontal"
            disabled={!showRightSidebar}
            className={cn(!showRightSidebar && "pointer-events-none opacity-0")}
          />
          <ResizablePanel
            id="rightSidebar"
            defaultSize={`${rightSidebarLayout.size}%`}
            maxSize={`${RIGHT_SIDEBAR_MAX_SIZE_PERCENT}%`}
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
                onClose={() => toggleRightSidebar(projectId)}
                onRefresh={refetchDiff}
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
              <div style={fixedTerminalHeight > 0 ? { height: `${fixedTerminalHeight}px` } : undefined}>
                <TerminalWorkspace
                  projectId={projectId}
                  layout={terminalLayout}
                  onAddTerminal={addTerminal}
                  socket={state.socket}
                  connectionStatus={state.connectionStatus}
                  scrollback={scrollback}
                  minColumnWidth={minColumnWidth}
                  splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
                  focusRequestVersion={terminalFocusRequestVersion}
                  onRemoveTerminal={(currentProjectId, terminalId) => {
                    void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
                    removeTerminal(currentProjectId, terminalId)
                  }}
                  onTerminalLayout={setTerminalSizes}
                />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        chatCard
      )}

    </div>
  )
}

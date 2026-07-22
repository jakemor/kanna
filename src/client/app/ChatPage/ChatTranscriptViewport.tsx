import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { AnimatedShinyText } from "../../components/ui/animated-shiny-text"
import { DrainingIndicator } from "../../components/messages/DrainingIndicator"
import { QueuedUserMessage } from "../../components/messages/QueuedUserMessage"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget } from "../../components/messages/shared"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { ContextMenu, ContextMenuTrigger } from "../../components/ui/context-menu"
import { OpenExternalContextMenuContent, openContextMenuFromButton } from "../../components/open-external-menu"
import { TRANSCRIPT_PADDING_BOTTOM_OFFSET } from "../kannaStateHelpers"
import { cn } from "../../lib/utils"
import { formatPathWithTilde, shouldOpenLocalFileLinkInEditor } from "../../lib/pathUtils"
import {
  buildResolvedTranscriptRows,
  KannaTranscriptRow,
  type ResolvedTranscriptRow,
  useStableResolvedRows,
} from "../KannaTranscript"
import type { KannaState } from "../useKannaState"
import type { KannaSocket } from "../socket"
import { EmptyStateUsageCards } from "./EmptyStateUsageCards"
import {
  CHAT_NAVBAR_OFFSET_PX,
  EMPTY_STATE_TEXT,
} from "./utils"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction } from "../../../shared/protocol"

/** Max auto-fetched history pages per chat when the list is too short to scroll. */
const MAX_HISTORY_AUTO_FILL_PAGES = 4

interface ChatTranscriptViewportProps {
  activeChatId: string | null
  listRef: React.RefObject<LegendListRef | null>
  messages: KannaState["messages"]
  queuedMessages: KannaState["queuedMessages"]
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
  onSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  onRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  onOpenLocalLink: KannaState["handleOpenLocalLink"]
  onAskUserQuestionSubmit: KannaState["handleAskUserQuestion"]
  onExitPlanModeConfirm: KannaState["handleExitPlanMode"]
  showScrollButton: boolean
  onIsAtEndChange: (isAtEnd: boolean) => void
  scrollToBottom: () => void
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  isPageFileDragActive: boolean
  showEmptyState: boolean
  /** When provided, the empty state shows live harness usage cards. */
  socket?: KannaSocket
  emptyStateProjectPath?: string | null
  onOpenProjectExternal?: (action: OpenExternalAction, editor?: EditorOpenSettings) => void
  editorPreset?: EditorPreset
  editorCommandTemplate?: string
  platform?: NodeJS.Platform
  headerOffsetPx?: number
}

export const ChatTranscriptViewport = memo(function ChatTranscriptViewport({
  activeChatId,
  listRef,
  messages,
  queuedMessages,
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
  onSteerQueuedMessage,
  onRemoveQueuedMessage,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  showScrollButton,
  onIsAtEndChange,
  scrollToBottom,
  typedEmptyStateText,
  isEmptyStateTypingComplete,
  isPageFileDragActive,
  showEmptyState,
  socket,
  emptyStateProjectPath,
  onOpenProjectExternal,
  editorPreset = "cursor",
  editorCommandTemplate,
  platform = "darwin",
  headerOffsetPx = CHAT_NAVBAR_OFFSET_PX,
}: ChatTranscriptViewportProps) {
  const previousRowCountRef = useRef(0)
  const localLinkMenuTriggerRef = useRef<HTMLSpanElement | null>(null)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})
  const [localLinkMenuTarget, setLocalLinkMenuTarget] = useState<OpenLocalLinkTarget | null>(null)
  const isMac = platform === "darwin"

  const rawRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
    hasOlderHistory,
  }), [hasOlderHistory, isProcessing, latestToolIds, localPath, messages])
  const resolvedRows = useStableResolvedRows(rawRows)

  useEffect(() => {
    setToolGroupExpanded({})
  }, [activeChatId])

  useEffect(() => {
    const previousRowCount = previousRowCountRef.current
    previousRowCountRef.current = resolvedRows.length

    if (previousRowCount > 0 || resolvedRows.length === 0) {
      return
    }

    onIsAtEndChange(true)
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [listRef, onIsAtEndChange, resolvedRows.length])

  const handleToolGroupExpandedChange = useCallback((groupId: string, next: boolean) => {
    setToolGroupExpanded((current) => (
      current[groupId] === next
        ? current
        : {
            ...current,
            [groupId]: next,
          }
    ))
  }, [])

  const handleScroll = useCallback((event?: unknown) => {
    const currentTarget = (
      typeof event === "object"
      && event !== null
      && "currentTarget" in event
      && event.currentTarget instanceof HTMLElement
    )
      ? event.currentTarget
      : listRef.current?.getScrollableNode?.()

    if (currentTarget instanceof HTMLElement) {
      const distanceFromEnd = currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop
      onIsAtEndChange(distanceFromEnd <= 4)
      return
    }

    const state = listRef.current?.getState?.()
    if (state) {
      onIsAtEndChange(state.isAtEnd)
    }
  }, [listRef, onIsAtEndChange])

  useEffect(() => {
    let cleanup: (() => void) | undefined
    const frameId = window.requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode?.()
      if (!(scrollNode instanceof HTMLElement)) {
        return
      }

      const handleNativeScroll = () => {
        handleScroll({ currentTarget: scrollNode })
      }

      scrollNode.addEventListener("scroll", handleNativeScroll, { passive: true })
      handleNativeScroll()
      cleanup = () => {
        scrollNode.removeEventListener("scroll", handleNativeScroll)
      }
    })

    return () => {
      window.cancelAnimationFrame(frameId)
      cleanup?.()
    }
  }, [activeChatId, handleScroll, listRef, resolvedRows.length])

  const handleStartReached = useCallback(() => {
    if (isHistoryLoading || !hasOlderHistory) {
      return
    }
    void loadOlderHistory()
  }, [hasOlderHistory, isHistoryLoading, loadOlderHistory])

  // A long tool-call run can collapse the entire loaded window into a single
  // tool-group row, leaving the list too short to scroll — so onStartReached
  // can never fire. Auto-fetch older pages until the viewport overflows
  // (capped); the header button below is the manual escape hatch beyond that.
  const autoFillPagesRef = useRef(0)

  useEffect(() => {
    autoFillPagesRef.current = 0
  }, [activeChatId])

  useEffect(() => {
    if (isHistoryLoading || !hasOlderHistory || resolvedRows.length === 0) {
      return
    }
    if (autoFillPagesRef.current >= MAX_HISTORY_AUTO_FILL_PAGES) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode?.()
      if (!(scrollNode instanceof HTMLElement)) {
        return
      }
      if (scrollNode.scrollHeight > scrollNode.clientHeight + 1) {
        return
      }
      autoFillPagesRef.current += 1
      void loadOlderHistory()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [activeChatId, hasOlderHistory, isHistoryLoading, listRef, loadOlderHistory, resolvedRows.length])

  const handleOpenLocalLinkClick = useCallback((target: OpenLocalLinkTarget) => {
    if (target.trigger !== "contextmenu") {
      const action = shouldOpenLocalFileLinkInEditor(target.path) ? "open_editor" : "open_default"
      void onOpenLocalLink(target, action)
      return
    }

    setLocalLinkMenuTarget(target)
    window.requestAnimationFrame(() => {
      const trigger = localLinkMenuTriggerRef.current
      if (!trigger) return
      const clientX = target.clientX ?? window.innerWidth / 2
      const clientY = target.clientY ?? window.innerHeight / 2
      trigger.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        view: window,
      }))
    })
  }, [onOpenLocalLink])

  const renderItem = useCallback(({ item }: { item: ResolvedTranscriptRow }) => (
    <div className="mx-auto w-full max-w-[800px] pb-5" data-transcript-row-id={item.id}>
      <KannaTranscriptRow
        row={item}
        toolGroupExpanded={item.kind === "tool-group" ? (toolGroupExpanded[item.id] ?? false) : undefined}
        onToolGroupExpandedChange={handleToolGroupExpandedChange}
        onAskUserQuestionSubmit={onAskUserQuestionSubmit}
        onExitPlanModeConfirm={onExitPlanModeConfirm}
      />
    </div>
  ), [handleToolGroupExpandedChange, onAskUserQuestionSubmit, onExitPlanModeConfirm, toolGroupExpanded])

  const listHeader = (
    <div className="mx-auto w-full max-w-[800px]" style={{ paddingTop: `${headerOffsetPx}px` }}>
      {isHistoryLoading ? (
        <div className="flex justify-center pb-4">
          <span className="text-sm translate-y-[-0.5px]">
            <AnimatedShinyText
              animate
              shimmerWidth={Math.max(20, "Loading more messages...".length * 3)}
            >
              Loading more messages...
            </AnimatedShinyText>
          </span>
        </div>
      ) : hasOlderHistory ? (
        <div className="flex justify-center pb-4">
          <button
            type="button"
            onClick={() => void loadOlderHistory()}
            className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Load older messages
          </button>
        </div>
      ) : null}
    </div>
  )

  const listFooter = (
    <div className="mx-auto w-full max-w-[800px]">
      {isProcessing ? <ProcessingMessage status={runtimeStatus ?? undefined} /> : null}
      {queuedMessages.map((message) => (
        <QueuedUserMessage
          key={message.id}
          message={message}
          onRemove={() => void onRemoveQueuedMessage(message.id)}
          onSendNow={() => void onSteerQueuedMessage(message.id)}
        />
      ))}
      {!isProcessing && isDraining ? (
        <DrainingIndicator onStop={() => void onStopDraining()} />
      ) : null}
      {commandError ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {commandError}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      <OpenLocalLinkProvider onOpenLocalLink={handleOpenLocalLinkClick}>
        <LegendList<ResolvedTranscriptRow>
          ref={listRef}
          data={resolvedRows}
          extraData={toolGroupExpanded}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={96}
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition
          onScroll={handleScroll}
          onStartReached={handleStartReached}
          onStartReachedThreshold={0.1}
          className="h-full flex-1 overflow-x-hidden overscroll-y-contain px-3 scroll-pt-[72px] [scrollbar-gutter:auto]"
          contentContainerStyle={{ paddingBottom: transcriptPaddingBottom + 10 }}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
      </OpenLocalLinkProvider>

      <ContextMenu onOpenChange={(open) => {
        if (!open) {
          setLocalLinkMenuTarget(null)
        }
      }}>
        <ContextMenuTrigger asChild>
          <span
            ref={localLinkMenuTriggerRef}
            aria-hidden="true"
            className="pointer-events-none fixed size-px opacity-0"
            style={{
              left: localLinkMenuTarget?.clientX ?? 0,
              top: localLinkMenuTarget?.clientY ?? 0,
            }}
          />
        </ContextMenuTrigger>
        {localLinkMenuTarget ? (
          <OpenExternalContextMenuContent
            isMac={isMac}
            editorPreset={editorPreset}
            editorCommandTemplate={editorCommandTemplate}
            includeFinder
            includePreview
            includeDefault
            onOpenExternal={(action, editor) => {
              void onOpenLocalLink(localLinkMenuTarget, action, editor)
            }}
          />
        ) : null}
      </ContextMenu>

      {showEmptyState ? (
        <div
          className="pointer-events-none absolute inset-x-4 animate-fade-in"
          style={{
            top: headerOffsetPx,
            // Align the scroll area's bottom to the top of the chat input.
            // transcriptPaddingBottom carries an extra clearance offset the
            // message list needs; the empty state shouldn't include it.
            bottom: Math.max(0, transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET),
          }}
        >
          <div className="pointer-events-auto mx-auto flex h-full max-w-[740px] flex-col items-center overflow-y-auto">
            {/* Flexbox-only center-or-scroll: my-auto centers the group when
                there's room, but its auto margins collapse once the content
                outgrows the container, so overflow-y-auto scrolls it from the
                top instead of clipping — no height measurement. */}
            <div className="my-auto flex w-full flex-col items-center gap-[6vh] py-6">
            <div className="flex flex-col items-center justify-center gap-4 text-muted-foreground opacity-70">
              <Flower strokeWidth={1.5} className="kanna-empty-state-flower size-8 text-muted-foreground" />
              <div
                className="kanna-empty-state-text flex max-w-xs items-center text-center text-base font-normal text-muted-foreground"
                aria-label={EMPTY_STATE_TEXT}
              >
                <span className="relative inline-grid place-items-start">
                  <span className="invisible col-start-1 row-start-1 flex items-center whitespace-pre">
                    <span>{EMPTY_STATE_TEXT}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true" />
                  </span>
                  <span className="col-start-1 row-start-1 flex items-center whitespace-pre">
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
              {emptyStateProjectPath && onOpenProjectExternal ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={openContextMenuFromButton}
                      title={emptyStateProjectPath}
                      className={cn(
                        "max-w-xs truncate rounded-md px-2 py-1 font-mono text-xs text-muted-foreground/80 transition-all duration-300 hover:bg-muted hover:text-foreground",
                        isEmptyStateTypingComplete
                          ? "pointer-events-auto opacity-100"
                          : "pointer-events-none opacity-0",
                      )}
                    >
                      {formatPathWithTilde(emptyStateProjectPath)}
                    </button>
                  </ContextMenuTrigger>
                  <OpenExternalContextMenuContent
                    isMac={isMac}
                    editorPreset={editorPreset}
                    editorCommandTemplate={editorCommandTemplate}
                    includeFinder
                    includeTerminal
                    onOpenExternal={onOpenProjectExternal}
                  />
                </ContextMenu>
              ) : null}
            </div>
            {socket ? (
              <div
                className={cn(
                  "mt-8 flex w-full justify-center transition-opacity duration-500",
                  isEmptyStateTypingComplete
                    ? "pointer-events-auto opacity-100"
                    : "pointer-events-none opacity-0",
                )}
              >
                <EmptyStateUsageCards socket={socket} activeChatId={activeChatId} />
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {isPageFileDragActive ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="absolute inset-0 backdrop-blur-sm" />
          <div className="absolute inset-6 ">
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center justify-center gap-3 text-center">
                <Upload className="mx-auto size-14 text-foreground" strokeWidth={1.75} />
                <div className="text-xl font-medium text-foreground">Drop up to 10 files</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{ bottom: transcriptPaddingBottom - 20 }}
        className={cn(
          "absolute left-1/2 z-10 -translate-x-1/2 transition-all",
          showScrollButton
            ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            : "pointer-events-none scale-60 opacity-0 blur-sm duration-300 ease-out",
        )}
      >
        <button
          onClick={scrollToBottom}
          className="flex aspect-square cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-2 text-sm text-primary transition-colors hover:bg-muted hover:text-foreground dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>
    </>
  )
})

function keyExtractor(item: ResolvedTranscriptRow) {
  return item.id
}

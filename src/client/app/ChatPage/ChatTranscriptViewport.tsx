import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { AnimatedShinyText } from "../../components/ui/animated-shiny-text"
import { DrainingIndicator } from "../../components/messages/DrainingIndicator"
import { QueuedUserMessage } from "../../components/messages/QueuedUserMessage"
import { OpenLocalLinkProvider } from "../../components/messages/shared"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { cn } from "../../lib/utils"
import {
  buildResolvedTranscriptRows,
  KannaTranscriptRow,
  type ResolvedTranscriptRow,
  useStableResolvedRows,
} from "../KannaTranscript"
import type { KannaState } from "../useKannaState"
import type { AutoContinueSchedule, CloudflareTunnelRecord } from "../../../shared/types"
import { CloudflareTunnelCard } from "../../components/chat-ui/CloudflareTunnelCard"
import {
  CHAT_NAVBAR_OFFSET_PX,
  EMPTY_STATE_TEXT,
} from "./utils"

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
  schedules: Record<string, AutoContinueSchedule>
  onAutoContinueAccept: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueReschedule: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueCancel: (scheduleId: string) => void
  tunnels?: Record<string, CloudflareTunnelRecord>
  liveTunnelId?: string | null
  onTunnelAccept?: (tunnelId: string) => void | Promise<void>
  onTunnelStop?: (tunnelId: string) => void | Promise<void>
  onTunnelRetry?: (tunnelId: string) => void | Promise<void>
  showScrollButton: boolean
  onIsAtEndChange: (isAtEnd: boolean) => void
  scrollToBottom: () => void
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  isPageFileDragActive: boolean
  showEmptyState: boolean
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
  schedules,
  onAutoContinueAccept,
  onAutoContinueReschedule,
  onAutoContinueCancel,
  tunnels,
  liveTunnelId,
  onTunnelAccept,
  onTunnelStop,
  onTunnelRetry,
  showScrollButton,
  onIsAtEndChange,
  scrollToBottom,
  typedEmptyStateText,
  isEmptyStateTypingComplete,
  isPageFileDragActive,
  showEmptyState,
}: ChatTranscriptViewportProps) {
  const previousRowCountRef = useRef(0)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})

  const rawRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
  }), [isProcessing, latestToolIds, localPath, messages])
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

  const renderItem = useCallback(({ item }: { item: ResolvedTranscriptRow }) => (
    <div className="mx-auto w-full max-w-[800px] pb-5" data-transcript-row-id={item.id}>
      <KannaTranscriptRow
        row={item}
        toolGroupExpanded={item.kind === "tool-group" ? (toolGroupExpanded[item.id] ?? false) : undefined}
        onToolGroupExpandedChange={handleToolGroupExpandedChange}
        onAskUserQuestionSubmit={onAskUserQuestionSubmit}
        onExitPlanModeConfirm={onExitPlanModeConfirm}
        schedules={schedules}
        onAutoContinueAccept={onAutoContinueAccept}
        onAutoContinueReschedule={onAutoContinueReschedule}
        onAutoContinueCancel={onAutoContinueCancel}
      />
    </div>
  ), [handleToolGroupExpandedChange, onAskUserQuestionSubmit, onExitPlanModeConfirm, schedules, onAutoContinueAccept, onAutoContinueReschedule, onAutoContinueCancel, toolGroupExpanded])

  const listHeader = (
    <div className="mx-auto w-full max-w-[800px] pt-[72px]">
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
      ) : null}
    </div>
  )

  const liveTunnelRecord = liveTunnelId && tunnels ? tunnels[liveTunnelId] : undefined

  const listFooter = (
    <div className="mx-auto w-full max-w-[800px]">
      {liveTunnelRecord && onTunnelAccept && onTunnelStop && onTunnelRetry && (
        <div className="pb-5">
          <CloudflareTunnelCard
            record={liveTunnelRecord}
            onAccept={onTunnelAccept}
            onStop={onTunnelStop}
            onRetry={onTunnelRetry}
            onDismiss={onTunnelStop}
          />
        </div>
      )}
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
      <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
        <LegendList<ResolvedTranscriptRow>
          ref={listRef}
          data={resolvedRows}
          extraData={{ toolGroupExpanded, schedules, tunnels, liveTunnelId }}
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

      {showEmptyState ? (
        <div
          className="pointer-events-none absolute inset-x-4 animate-fade-in"
          style={{
            top: CHAT_NAVBAR_OFFSET_PX,
            bottom: transcriptPaddingBottom,
          }}
        >
          <div className="mx-auto flex h-full max-w-[800px] items-center justify-center">
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
            </div>
          </div>
        </div>
      ) : null}

      {isPageFileDragActive ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="absolute inset-0 bg-background/70" />
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
            ? "scale-100 opacity-100 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            : "pointer-events-none scale-75 opacity-0 duration-200 ease-out",
        )}
      >
        <button
          onClick={scrollToBottom}
          className="flex aspect-square cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2 text-sm text-foreground transition-colors hover:bg-muted"
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

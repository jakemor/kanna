import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { ChatSnapshot, HydratedTranscriptMessage, ProviderCatalogEntry, TranscriptEntry, TranscriptOutlineEntry } from "../../shared/types"
import { DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES } from "../../shared/transcript-window"
import { useAppDialog } from "../components/ui/app-dialog"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { resolveForkBoundary } from "../lib/fork-boundary"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { findSidebarChat, useSidebarChatStatus } from "../stores/sidebarStore"
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
import { canCancelStatus, getLatestToolIds, hasNoTurnStatus, isProcessingStatus } from "./derived"
import {
  getPreviousPrompt,
  reconcileOptimisticUserPrompts,
  type OptimisticProcessingState,
  type OptimisticUserPrompt,
} from "./kannaStateHelpers"
import { visibleCommandError, type ConnectionHealth } from "./connectionHealth"
import { foldChatSnapshot } from "./snapshotEquality"
import type { KannaSocket } from "./socket"
import { useChatCommands } from "./useChatCommands"
import { useChatReadAnchor } from "./useChatReadAnchor"
import { useSendMessage } from "./useSendMessage"
import { useTakeUpNextRun } from "../hooks/useComposer"

const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = []
const EMPTY_OUTLINE: TranscriptOutlineEntry[] = []
const EMPTY_QUEUED_MESSAGES: ChatSnapshot["queuedMessages"] = []
/** As `useKannaState`: how long an open waits on the disk cache before subscribing without it. */
const DISK_CACHE_WAIT_MS = 30

function transcriptWindowSize() {
  return useAppSettingsStore.getState().settings?.transcript?.windowAssistantMessages
    ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES
}

const ignore = () => {}

/**
 * One chat, live, apart from the one the page is on: its transcript window,
 * its status and queue, and everything that drives it. What the previewer
 * shows a chat with.
 *
 * It is the chat half of `useKannaState`, for a second chat, put together
 * from the same parts: the `chat` topic with the span the cache holds, the
 * same fold, the same send pipeline (`useSendMessage`), the same commands
 * (`useChatCommands`) and read anchor. So a message sent here queues, steers
 * and reconciles exactly as one sent from the main composer does.
 *
 * The subscription is its own, with its own id: the server keeps a window and
 * a dedupe signature per subscription, so this one and the page's neither
 * share pushes nor disturb each other, and unsubscribing here leaves the
 * page's alone. `useBackgroundChatSubscriptions` stands down for this chat
 * while it is open, as it does for the page's.
 *
 * Mount it per chat (keyed by `chatId`): nothing here resets for a new id.
 */
export function useChatSession({ socket, chatId, fallbackProviders }: {
  socket: KannaSocket
  chatId: string
  /** The provider catalog until the chat's own snapshot brings one. */
  fallbackProviders: ProviderCatalogEntry[]
}) {
  const navigate = useNavigate()
  const dialog = useAppDialog()
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot | null>(null)
  // From memory in the first render, as `useKannaState` does on a switch, so
  // the chat mounts with its rows and at its reader's place.
  const [cachedTranscript, setCachedTranscript] = useState<CachedTranscriptWindow | null>(
    () => peekPaintableMemoryWindow(chatId, transcriptWindowSize()),
  )
  const [chatReady, setChatReady] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealth>("connecting")
  useEffect(() => socket.onHealth(setConnectionHealth), [socket])
  const [optimisticUserPrompts, setOptimisticUserPrompts] = useState<OptimisticUserPrompt[]>([])
  const [optimisticProcessing, setOptimisticProcessing] = useState<OptimisticProcessingState | null>(null)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const transcriptCacheWriter = useMemo(() => createTranscriptCacheWriter(), [])

  // The span held by now, for resubscribing after a reconnect with a tail
  // instead of the whole window. See the same ref in `useKannaState`.
  const heldSpanRef = useRef<{ start: number; end: number; endEntryId: string } | null>(null)
  useEffect(() => {
    const last = chatSnapshot?.messages[chatSnapshot.messages.length - 1]
    heldSpanRef.current = chatSnapshot && last
      ? { start: chatSnapshot.startIndex, end: chatSnapshot.startIndex + chatSnapshot.messages.length, endEntryId: last._id }
      : null
  }, [chatSnapshot])

  useEffect(() => {
    let cancelled = false
    let receivedSnapshot = false
    let subscribed = false
    let unsubscribe: (() => void) | null = null
    // Base for the first incremental push: the server resumes from the cached
    // span, so its first body starts where this window ends.
    let base: { messages: TranscriptEntry[]; startIndex: number } | null = null

    function handleSnapshot(snapshot: ChatSnapshot | null) {
      if (cancelled) return
      receivedSnapshot = true
      setCachedTranscript(null)
      // Bare call, nothing else: `foldChatSnapshot` must stay pure here.
      setChatSnapshot((current) => foldChatSnapshot(current, base, snapshot))
      setChatReady(true)
      setCommandError(null)
    }

    function subscribeToChat(cached: CachedTranscriptWindow | null) {
      if (cancelled || subscribed) return
      subscribed = true
      const trimmed = cached ? trimCachedWindow(cached, transcriptWindowSize()) : null
      const lastEntryId = trimmed?.entries[trimmed.entries.length - 1]?._id
      const span = trimmed && lastEntryId
        ? { start: trimmed.startIndex, end: trimmed.startIndex + trimmed.entries.length, endEntryId: lastEntryId }
        : null
      if (trimmed && span) {
        base = cachedWindowToMessages(trimmed)
        setCachedTranscript(canPaintCachedWindow(trimmed) ? trimmed : null)
      }
      unsubscribe = socket.subscribe<ChatSnapshot | null>(
        { type: "chat", chatId, ...(span ? { cachedSpan: span } : {}) },
        handleSnapshot,
        undefined,
        {
          topicOnReconnect: () => (
            heldSpanRef.current ? { type: "chat", chatId, cachedSpan: heldSpanRef.current } : { type: "chat", chatId }
          ),
        },
      )
    }

    // A running chat was being followed in the background until now, so
    // memory usually holds a current window and the server sends a tail.
    let diskWait: ReturnType<typeof setTimeout> | null = null
    const memory = readMemoryCachedWindow(chatId)
    if (memory) {
      subscribeToChat(memory)
    } else {
      diskWait = setTimeout(() => {
        diskWait = null
        subscribeToChat(null)
      }, DISK_CACHE_WAIT_MS)
      void readCachedWindow(chatId).then((cached) => {
        if (cancelled) return
        if (!subscribed) {
          if (diskWait !== null) clearTimeout(diskWait)
          diskWait = null
          subscribeToChat(cached)
          return
        }
        if (receivedSnapshot || !cached) return
        const trimmed = trimCachedWindow(cached, transcriptWindowSize())
        if (canPaintCachedWindow(trimmed)) setCachedTranscript(trimmed)
      })
    }

    return () => {
      cancelled = true
      if (diskWait !== null) clearTimeout(diskWait)
      unsubscribe?.()
      // The background follower picks the chat up from this window if it is
      // still running, and so does the main view if it opens there next.
      transcriptCacheWriter.flush()
    }
  }, [chatId, socket, transcriptCacheWriter])

  // Read like the main view's: the mark stays while the chat is on screen and
  // clears when you leave it, here by closing the previewer or moving it on.
  useEffect(() => () => {
    if (!findSidebarChat(chatId)?.unread) return
    void socket.command({ type: "chat.markRead", chatId }).catch(ignore)
  }, [chatId, socket])

  const snapshot = chatSnapshot?.runtime.chatId === chatId ? chatSnapshot : null
  const { anchorState: readAnchorState, reportReadAnchor } = useChatReadAnchor(socket, chatId, snapshot?.readAnchor, chatReady)

  const serverTranscriptEntries = snapshot?.messages
    ?? (cachedTranscript?.chatId === chatId ? cachedTranscript.entries : EMPTY_TRANSCRIPT_ENTRIES)
  const transcriptEntries = useMemo(
    () => (optimisticUserPrompts.length === 0
      ? serverTranscriptEntries
      : [...serverTranscriptEntries, ...optimisticUserPrompts.map((prompt) => prompt.entry)]),
    [optimisticUserPrompts, serverTranscriptEntries],
  )
  // The previous result goes back in, so a push that appended entries
  // hydrates only the new ones (see `processTranscriptMessages`).
  const previousMessagesRef = useRef<HydratedTranscriptMessage[] | null>(null)
  const messages = useMemo(() => {
    const next = processTranscriptMessages(transcriptEntries, previousMessagesRef.current)
    previousMessagesRef.current = next
    return next
  }, [transcriptEntries])
  const previousPrompt = useMemo(() => getPreviousPrompt(messages), [messages])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])

  const runtime = snapshot?.runtime ?? null
  useTakeUpNextRun(runtime)
  const forkBoundary = useMemo(
    () => (snapshot ? resolveForkBoundary(snapshot.runtime.forkedFrom, snapshot.messages, snapshot.startIndex, messages) : null),
    [snapshot, messages],
  )
  const optimisticRuntimeStatus = optimisticProcessing && (!runtime || hasNoTurnStatus(runtime.status)) ? "starting" : null
  // Until the chat's own snapshot lands, the sidebar's word for it.
  const sidebarStatus = useSidebarChatStatus(chatId)
  const runtimeStatus = optimisticRuntimeStatus ?? runtime?.status ?? (snapshot ? null : sidebarStatus) ?? null
  const isProcessing = isProcessingStatus(runtimeStatus ?? undefined)

  useEffect(() => {
    if (!chatSnapshot || chatSnapshot.runtime.chatId !== chatId) return
    transcriptCacheWriter.schedule(chatId, chatSnapshot, isProcessing)
  }, [chatId, chatSnapshot, isProcessing, transcriptCacheWriter])

  // The optimistic "starting" gives way to the server's word as in
  // `useKannaState`: at once when the turn shows as running, otherwise on the
  // first push after the send's ack that still says idle, or after 5 s.
  useEffect(() => {
    if (optimisticProcessing && runtime?.status && !hasNoTurnStatus(runtime.status)) setOptimisticProcessing(null)
  }, [optimisticProcessing, runtime?.status])
  const ackedSnapshotRef = useRef<{ ackedAt: number; snapshot: ChatSnapshot | null } | null>(null)
  useEffect(() => {
    if (!optimisticProcessing?.ackedAt) return
    if (runtime?.status && !hasNoTurnStatus(runtime.status)) return
    const { ackedAt } = optimisticProcessing
    if (ackedSnapshotRef.current?.ackedAt !== ackedAt) ackedSnapshotRef.current = { ackedAt, snapshot }
    const heardBack = snapshot !== null && snapshot !== ackedSnapshotRef.current.snapshot
    const timeoutId = window.setTimeout(() => {
      setOptimisticProcessing((current) => (current?.ackedAt === ackedAt ? null : current))
    }, heardBack ? 0 : 5_000)
    return () => window.clearTimeout(timeoutId)
  }, [optimisticProcessing, runtime?.status, snapshot])

  useEffect(() => {
    setOptimisticUserPrompts((current) => {
      const reconciled = reconcileOptimisticUserPrompts(current, chatId, serverTranscriptEntries)
      return reconciled.length === current.length && reconciled.every((prompt, index) => prompt === current[index])
        ? current
        : reconciled
    })
  }, [chatId, serverTranscriptEntries])

  const loadOlderMessages = useCallback(async (options?: { untilMessageId?: string; all?: boolean }) => {
    setIsLoadingOlderMessages(true)
    try {
      // The older slice arrives as a push on this chat's subscriptions on
      // this socket, which is this one alone: the page is on another chat.
      await socket.command<{ startIndex: number }>({
        type: "chat.loadOlder",
        chatId,
        ...(options?.untilMessageId !== undefined ? { untilMessageId: options.untilMessageId } : {}),
        ...(options?.all ? { all: true } : {}),
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [chatId, socket])

  // The main composer's send, pointed at this chat. With a chat id it never
  // creates a chat, so it never navigates or picks a project.
  const handleSend = useSendMessage({
    socket,
    navigate,
    activeChatId: chatId,
    setCommandError,
    setSelectedProjectId: ignore,
    setPendingChatId: ignore,
    setOptimisticProcessing,
    setOptimisticUserPrompts,
    sendContext: {
      isProcessing,
      optimisticUserPrompts,
      serverTranscriptEntries,
      selectedProjectId: runtime?.projectId ?? null,
      fallbackLocalProjectPath: null,
    },
  })

  const {
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleAskUserQuestion,
    handleExitPlanMode,
  } = useChatCommands({
    socket,
    dialog,
    activeChatId: chatId,
    setCommandError,
    defaultOpenLocalPath: runtime?.localPath,
  })

  return {
    chatSnapshot: snapshot,
    runtime,
    runtimeStatus,
    messages,
    queuedMessages: snapshot?.queuedMessages ?? EMPTY_QUEUED_MESSAGES,
    previousPrompt,
    latestToolIds,
    availableProviders: snapshot?.availableProviders ?? fallbackProviders,
    isProcessing,
    canCancel: canCancelStatus(runtimeStatus ?? undefined),
    isDraining: runtime?.isDraining ?? false,
    commandError: visibleCommandError(commandError, connectionHealth),
    readAnchorState,
    reportReadAnchor,
    hasOlderMessages: (snapshot?.startIndex ?? (cachedTranscript?.chatId === chatId ? cachedTranscript.startIndex : 0)) > 0,
    transcriptOutline: snapshot?.outline ?? EMPTY_OUTLINE,
    forkBoundary,
    loadOlderMessages,
    isLoadingOlderMessages,
    handleSend,
    handleSteerQueuedMessage,
    handleRemoveQueuedMessage,
    handleCancel,
    handleStopDraining,
    handleAskUserQuestion,
    handleExitPlanMode,
  }
}

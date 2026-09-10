import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "../../components/ui/message-scroller"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { DrainingIndicator } from "../../components/messages/DrainingIndicator"
import { QueuedUserMessage } from "../../components/messages/QueuedUserMessage"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget } from "../../components/messages/shared"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { ContextMenu, ContextMenuTrigger } from "../../components/ui/context-menu"
import { OpenExternalContextMenuContent, openContextMenuFromButton } from "../../components/open-external-menu"
import { TRANSCRIPT_PADDING_BOTTOM_OFFSET } from "../kannaStateHelpers"
import { useScrollbarGutterVar } from "../../hooks/useScrollbarGutterVar"
import { cn } from "../../lib/utils"
import type { ChatJumpRole } from "../../lib/chat-navigation"
import { formatPathWithTilde, shouldOpenLocalFileLinkInEditor } from "../../lib/pathUtils"
import {
  buildResolvedTranscriptRows,
  KannaTranscriptRow,
  useStableResolvedRows,
  type ResolvedTranscriptRow,
} from "../KannaTranscript"
import type { KannaState } from "../useKannaState"
import type { KannaSocket } from "../socket"
import type { ChatReadAnchorState, ReadAnchorLayout, ReadAnchorLayoutSource } from "../useChatReadAnchor"
import {
  buildRowIndexByMessageId,
  getLatestUserPrompt,
  getRowAnchorMessageId,
  isOptimisticMessageId,
  resolveJumpTarget,
  resolveRestoreTarget,
  shouldPinForNewPrompt,
  type LatestUserPrompt,
  type TranscriptJumpRequest,
  type TranscriptScrollTarget,
} from "./transcriptScrollAnchors"
import { TranscriptMinimap } from "./TranscriptMinimap"
import { buildTranscriptTurns, type TranscriptTurn } from "./transcriptTurns"
import { EmptyStateAuthCards } from "./EmptyStateAuthCards"
import { EmptyStateUsageCards } from "./EmptyStateUsageCards"
import {
  CHAT_NAVBAR_OFFSET_PX,
  EMPTY_STATE_TEXT,
} from "./utils"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction, TerminalPreset } from "../../../shared/protocol"
import type { TranscriptOutlineEntry } from "../../../shared/types"
/**
 * How close to the bottom counts as "at the end", as a fraction of viewport
 * height.
 *
 * Deliberately one number shared by two consumers: the list uses it to decide
 * whether to keep following new content, and the viewport uses it to decide
 * whether the reader is following. When those disagreed, scrolling up slightly
 * put them in opposite states — one pulling back to the bottom while the other
 * offered a scroll-to-bottom button. In pixels because that is what the
 * scroller measures in; a ratio silently read as 0.05px meant "at the end" was
 * never true and following never engaged.
 */
const AT_END_THRESHOLD_PX = 48

/**
 * How long a pin keeps correcting itself as the transcript settles.
 *
 * Content above the target can resize after the pin lands — images decode,
 * fonts swap, code blocks wrap. On a cold open of a long chat that goes on
 * for hundreds of milliseconds — far longer than a frame budget — so the
 * correction is driven by layout changes and bounded by the clock instead.
 */
const PIN_SETTLE_MS = 2000

/** Close enough to the intended offset to stop correcting. */
const PIN_TOLERANCE_PX = 2

/**
 * How far down the visible transcript a jumped-to message lands, as a fraction
 * of the height between the navbar and the composer.
 *
 * Flush under the chrome is right for *restoring* a read position — you were
 * reading down from there, and every pixel above it is spent. It's wrong for
 * arriving somewhere you asked for by name: a message pinned to the very top
 * reads as the start of the transcript, with nothing behind it to say what it
 * answers or follows. A fifth of a screen of lead-in is enough context to place
 * it without spending the screen you came to read.
 */
const JUMP_LEAD_IN_RATIO = 0.2

/**
 * That fraction in pixels, measured off the live viewport rather than assumed —
 * the composer grows with its draft, so the space actually being read is not a
 * constant.
 */
function measureJumpLeadIn(
  viewport: HTMLElement | null,
  insets: { top: number, bottom: number }
): number {
  if (!viewport) return 0
  const visible = viewport.clientHeight - insets.top - insets.bottom
  return visible <= 0 ? 0 : Math.round(visible * JUMP_LEAD_IN_RATIO)
}

/** Length of `.kanna-jump-flash`, which owns the actual timing. */
const JUMP_FLASH_DURATION_MS = 2236

/**
 * Grace before the class comes off, so the flash is never cut short.
 *
 * The animation starts a frame after the timer does, and a busy commit can
 * stretch that — ending the highlight early would clip the fade to a hard edge,
 * which is exactly what the slow release exists to avoid.
 */
const JUMP_FLASH_CLEANUP_SLACK_MS = 120

/**
 * Whether a row lights its own shape rather than the box around it.
 *
 * Only user prompts do. A prompt is a bubble hugging one side of the column, so
 * lighting the row box would wash the empty half of the line beside it and
 * point at a rectangle rather than at the message. Everything else — agent
 * text, tool groups, results — already fills the column, so the row box *is*
 * the message's shape and lighting it needs nothing from the row.
 */
function rowLightsItself(row: ResolvedTranscriptRow): boolean {
  return row.kind === "single" && row.message.kind === "user_prompt"
}




/**
 * Slack before the transcript counts as scrollable. Content and viewport rarely
 * land on equal subpixel values, and a hairline of scroll is not something
 * worth offering a map for.
 */
const OVERFLOW_EPSILON_PX = 8

/**
 * Where the reader sits *within* the top row, plus the column width that makes
 * that meaningful.
 *
 * Measured against the row rather than the scroll container: rows above it may
 * still be standing in at an estimated height, so an absolute scroll position
 * means something different on the next open. A distance into the row does not
 * move when the content above it re-measures.
 */
/** The rendered width of the transcript column, which is what wraps text. */
function measureTranscriptColumnWidth(viewport: HTMLElement | null): number | undefined {
  const column = viewport?.querySelector("[data-transcript-row-id]")
  return column ? Math.round(column.getBoundingClientRect().width) : undefined
}

function measureReadAnchorLayout(
  viewport: HTMLElement | null,
  rowId: string,
  headerOffsetPx: number
): ReadAnchorLayout | undefined {
  const row = viewport?.querySelector(`[data-message-id="${CSS.escape(rowId)}"]`)
  const column = row?.querySelector("[data-transcript-row-id]")
  if (!viewport || !row || !column) return undefined
  const offsetFromMessage = viewport.getBoundingClientRect().top + headerOffsetPx - row.getBoundingClientRect().top
  return {
    // The column, not the viewport: a wider window past the column's max width
    // rewraps nothing, so it must not invalidate the offset.
    transcriptWidth: Math.round(column.getBoundingClientRect().width),
    offsetFromMessage: Math.round(offsetFromMessage),
  }
}

/** No stored anchor — pin the latest user prompt. Used by the export viewer too. */
const DEFAULT_READ_ANCHOR_STATE: ChatReadAnchorState = { resolved: true, anchor: null }

/** What ChatPage drives the transcript with, in place of a list ref. */
export interface TranscriptScrollHandle {
  scrollToEnd: () => void
}

interface ChatTranscriptViewportProps {
  activeChatId: string | null
  listRef: React.RefObject<TranscriptScrollHandle | null>
  messages: KannaState["messages"]
  queuedMessages: KannaState["queuedMessages"]
  transcriptPaddingBottom: number
  localPath: string | null | undefined
  latestToolIds: KannaState["latestToolIds"]
  isProcessing: boolean
  runtimeStatus: string | null
  isDraining: boolean
  commandError: string | null
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
  onOpenProjectExternal?: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
  editorPreset?: EditorPreset
  editorCommandTemplate?: string
  platform?: NodeJS.Platform
  headerOffsetPx?: number
  /** Server-stored read position; restore waits for this to resolve. */
  readAnchorState?: ChatReadAnchorState
  /** Reports the message at the top of the viewport as the user scrolls. */
  onReportReadAnchor?: (messageId: string, atEnd: boolean, layout?: ReadAnchorLayoutSource) => void
  /**
   * A message to land on instead of the stored read position — set when the
   * chat was opened by clicking a specific message in the sidebar hover card.
   * Outranks the anchor on the open it arrives with, and moves an already-open
   * chat on its own.
   */
  jumpRequest?: TranscriptJumpRequest | null
  /** Fired once a jump request has been spent, so the sender can clear it. */
  onJumpRequestHandled?: (requestId: string) => void
  /**
   * The transcript window (see shared/transcript-window.ts). `messages` is
   * the loaded tail; the outline names every turn, loaded or not, so the
   * minimap covers the whole chat and a click on an unloaded turn can ask
   * for it.
   */
  hasOlderMessages?: boolean
  transcriptOutline?: TranscriptOutlineEntry[]
  onLoadOlderMessages?: (options?: { untilMessageId?: string; all?: boolean }) => Promise<void>
  isLoadingOlderMessages?: boolean
  /**
   * Where to publish `--transcript-scrollbar-w`. The chrome that overlays the
   * transcript — navbar wash, composer gradient — lives outside this component
   * but inside this element, and ends at the gutter so it stops dimming the
   * scrollbar. Unset (the export viewer) simply means nobody is asking.
   */
  scrollbarGutterHostRef?: React.RefObject<HTMLElement | null>
}

/**
 * The provider owns scroll anchoring and follow-the-end; the body below reads
 * them through hooks, which is why they are separate components.
 */
export const ChatTranscriptViewport = memo(function ChatTranscriptViewport(props: ChatTranscriptViewportProps) {
  return (
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={AT_END_THRESHOLD_PX}>
      <TranscriptScrollerBody {...props} />
    </MessageScrollerProvider>
  )
})

/** Which rows are on screen, as indices into the resolved row list. */
interface VisibleRowRange {
  start: number
  end: number
}

/**
 * The minimap, and the only thing subscribed to what is currently on screen.
 *
 * `useMessageScrollerVisibility` fires continuously while scrolling — that is
 * its job. Calling it at the top of the transcript body meant the body, its
 * whole row list, and every callback derived in it were rebuilt on every scroll
 * frame, so that a small overlay could highlight the turn you are looking at.
 * (It also made the scroll listener's own dependencies change per scroll event,
 * so the listener was detached and reattached continuously.)
 *
 * Subscribing here instead confines that to this component and the memoized
 * minimap below it. The read-anchor writer needs the same range but is throttled
 * to once a second and a half, so it reads it from a ref rather than re-render
 * anything to receive it.
 */
const TranscriptMinimapOverlay = memo(function TranscriptMinimapOverlay({
  viewportRef,
  rowCount,
  visibleRowRangeRef,
  ...minimapProps
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>
  /** Re-measures when rows are added or removed. */
  rowCount: number
  visibleRowRangeRef: React.RefObject<VisibleRowRange | null>
} & Omit<ComponentProps<typeof TranscriptMinimap>, "visibleStart" | "visibleEnd">) {
  const visibleRowRange = useVisibleRowRange(viewportRef, rowCount, minimapProps.topPx)

  visibleRowRangeRef.current = visibleRowRange

  return (
    <TranscriptMinimap
      {...minimapProps}
      visibleStart={visibleRowRange?.start ?? -1}
      visibleEnd={visibleRowRange?.end ?? -1}
    />
  )
})

/**
 * Which rows are on screen, from scroll geometry rather than an
 * IntersectionObserver.
 *
 * The scroller's observer watched every row at four thresholds, so Chromium
 * recomputed every row's intersection each frame and the callback rebuilt the
 * visible-id array on top. Here each row's top edge is read once per content
 * resize (an `offsetTop` chain, no forced layout once the resize has settled),
 * and a scroll is a binary search over those numbers. State changes only when
 * the range does, which is when a row boundary crosses the viewport edge, not
 * every frame.
 */
function useVisibleRowRange(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  rowCount: number,
  topInsetPx: number,
): VisibleRowRange | null {
  const [range, setRange] = useState<VisibleRowRange | null>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const content = viewport?.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    if (!viewport || !content) return

    let tops: number[] = []
    let frame: number | null = null

    const measure = () => {
      const items = content.querySelectorAll<HTMLElement>(':scope > [data-slot="message-scroller-item"]')
      // Against the viewport's own rect, in scroll coordinates. An `offsetTop`
      // walk never meets the viewport (it is not an offset parent) and summed
      // up to the page, which put every row off by the viewport's page offset
      // wherever the transcript does not start at the top of the window.
      const origin = viewport.getBoundingClientRect().top - viewport.scrollTop
      tops = Array.from(items, (item) => item.getBoundingClientRect().top - origin)
    }

    // The last row whose top edge is at or above `y`: the row that contains `y`.
    const rowAt = (y: number) => {
      let low = 0
      let high = tops.length - 1
      while (low < high) {
        const mid = (low + high + 1) >> 1
        if (tops[mid]! <= y) low = mid
        else high = mid - 1
      }
      return low
    }

    const compute = () => {
      frame = null
      if (tops.length === 0) {
        setRange(null)
        return
      }
      const start = rowAt(viewport.scrollTop + topInsetPx)
      const end = rowAt(viewport.scrollTop + viewport.clientHeight - 1)
      setRange((current) => (current && current.start === start && current.end === end ? current : { start, end }))
    }

    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(compute)
    }
    const remeasure = () => {
      measure()
      schedule()
    }

    remeasure()
    const observer = new ResizeObserver(remeasure)
    observer.observe(content)
    observer.observe(viewport)
    viewport.addEventListener("scroll", schedule, { passive: true })

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener("scroll", schedule)
    }
  }, [rowCount, topInsetPx, viewportRef])

  return range
}

const TranscriptScrollerBody = memo(function TranscriptScrollerBody({
  activeChatId,
  listRef,
  messages,
  queuedMessages,
  transcriptPaddingBottom,
  localPath,
  latestToolIds,
  isProcessing,
  runtimeStatus,
  isDraining,
  commandError,
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
  readAnchorState = DEFAULT_READ_ANCHOR_STATE,
  onReportReadAnchor,
  jumpRequest = null,
  onJumpRequestHandled,
  hasOlderMessages = false,
  transcriptOutline,
  onLoadOlderMessages,
  isLoadingOlderMessages = false,
  scrollbarGutterHostRef,
}: ChatTranscriptViewportProps) {
  const { scrollToEnd, scrollToMessage } = useMessageScroller()
  // Written by the minimap overlay, which owns the visibility subscription.
  // Read only by the throttled read-anchor writer, so a commit of lag costs
  // nothing and this component stays out of the scroll path entirely.
  const visibleRowRangeRef = useRef<VisibleRowRange | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  useScrollbarGutterVar(viewportRef, scrollbarGutterHostRef, "--transcript-scrollbar-w")
  const localLinkMenuTriggerRef = useRef<HTMLSpanElement | null>(null)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})
  const [localLinkMenuTarget, setLocalLinkMenuTarget] = useState<OpenLocalLinkTarget | null>(null)
  const isMac = platform === "darwin"

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
    listRef.current = { scrollToEnd: () => { scrollToEnd() } }
    return () => { listRef.current = null }
  }, [listRef, scrollToEnd])

  const rowIndexByMessageId = useMemo(() => buildRowIndexByMessageId(resolvedRows), [resolvedRows])
  const loadedTurns = useMemo(() => buildTranscriptTurns(resolvedRows), [resolvedRows])
  // Turns before the window come from the outline. They have no rows, so
  // they carry no reply or count; they exist so the map reaches the start
  // of the chat and a click can load them.
  const turns = useMemo(() => {
    if (!hasOlderMessages || !transcriptOutline || transcriptOutline.length === 0) return loadedTurns
    const loadedIds = new Set(loadedTurns.map((turn) => turn.id))
    const unloaded: TranscriptTurn[] = transcriptOutline
      .filter((entry) => !loadedIds.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        rowIndex: -1,
        endRowIndex: -1,
        replyRowId: null,
        prompt: entry.preview,
        response: null,
        agentMessageCount: 0,
        error: null,
        timestamp: new Date(entry.createdAt).toISOString(),
        durationMs: null,
        loaded: false,
      }))
    return unloaded.length === 0 ? loadedTurns : [...unloaded, ...loadedTurns]
  }, [hasOlderMessages, loadedTurns, transcriptOutline])

  /**
   * Rendered row window plus whether the list can scroll at all — together they
   * drive the minimap, which only earns its space once there is something to
   * navigate.
   */
  const [transcriptOverflows, setTranscriptOverflows] = useState(false)
  /** Scroll pane width, driving whether the minimap has a gutter to live in. */
  const [transcriptWidth, setTranscriptWidth] = useState(0)

  /**
   * Overlay insets, in a ref so the geometry sync stays referentially stable —
   * the bottom inset changes on every keystroke that grows the input, and
   * re-subscribing the list listeners that often would be wasteful.
   */
  const viewportInsetsRef = useRef({ top: 0, bottom: 0 })
  viewportInsetsRef.current = {
    top: headerOffsetPx,
    bottom: Math.max(0, transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET),
  }

  // Kept in a ref so the native scroll handler can read the current rows
  // without being re-created (and re-attached) on every transcript change.
  const resolvedRowsRef = useRef(resolvedRows)
  resolvedRowsRef.current = resolvedRows

  /** Chat we have already positioned, so restore runs exactly once per open. */
  const restoredChatIdRef = useRef<string | null>(null)
  /** Latest user prompt as of the last observation, for the pin-on-send rule. */
  const latestPromptRef = useRef<LatestUserPrompt | null>(null)
  /**
   * Whether the user has actually scrolled this chat themselves.
   *
   * Only their own scrolling may move the stored read position. Restores,
   * pins and auto-follow all scroll programmatically and settle over several
   * frames as rows measure — sampling during that drifts the anchor by a row
   * on every open. Real input events are the one signal those can't fake.
   */
  const hasUserScrolledRef = useRef(false)
  const pendingPinRef = useRef<{ rowId: string; offsetFromMessage: number; until: number } | null>(null)

  useEffect(() => {
    pendingPinRef.current = null
  }, [activeChatId])

  /**
   * Put a row at the top of the viewport, re-issuing until it stays there.
   *
   * One pass is not always enough on a cold open. Content above the target can
   * still resize after first layout — images decode, fonts swap, code blocks
   * wrap — and each shift moves the target under the pin.
   *
   * Each pass measures where the row actually ended up and corrects, stopping
   * as soon as it is within a pixel or two of the intended offset — so a
   * settled list costs one frame and nothing converges forever.
   */
  const pinRowToTop = useCallback((rowId: string, offsetFromMessage = 0) => {
    if (!scrollToMessage(rowId, { align: "start", scrollMargin: headerOffsetPx - offsetFromMessage })) {
      scrollToEnd()
      return
    }
    pendingPinRef.current = { rowId, offsetFromMessage, until: Date.now() + PIN_SETTLE_MS }
  }, [headerOffsetPx, scrollToEnd, scrollToMessage])

  /**
   * Nudge an in-flight pin back onto its row after the layout moves under it.
   *
   * Gives up on a deadline, once the row is where it should be, or the moment
   * the reader scrolls — a correction that fought a deliberate scroll would be
   * far worse than one that lands a little short.
   */
  const correctPendingPin = useCallback(() => {
    const pending = pendingPinRef.current
    if (!pending) return
    if (hasUserScrolledRef.current || Date.now() > pending.until) {
      pendingPinRef.current = null
      return
    }
    const viewport = viewportRef.current
    const row = viewport?.querySelector(`[data-message-id="${CSS.escape(pending.rowId)}"]`)
    if (!viewport || !row) return
    const intended = headerOffsetPx - pending.offsetFromMessage
    const offset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - intended
    if (Math.abs(offset) <= PIN_TOLERANCE_PX) return
    // Landed as close as the content allows. Without the scroller's trailing
    // spacer there is no invented room past the last message, so a row near
    // either end simply cannot reach the intended offset — and a correction
    // that cannot converge would re-issue on every layout change for the whole
    // settle window, chasing a position that does not exist.
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight
    const atLimit = offset > 0
      ? viewport.scrollTop >= maxScrollTop - PIN_TOLERANCE_PX
      : viewport.scrollTop <= PIN_TOLERANCE_PX
    if (atLimit) {
      pendingPinRef.current = null
      return
    }
    scrollToMessage(pending.rowId, { align: "start", scrollMargin: intended })
  }, [headerOffsetPx, scrollToMessage])

  const applyScrollTarget = useCallback((target: TranscriptScrollTarget) => {
    if (target.kind === "end") {
      onIsAtEndChange(true)
      scrollToEnd()
      return
    }

    // Written synchronously (it sets a ref in ChatPage) so the parent's
    // auto-follow effect bails on this same commit instead of yanking us to
    // the bottom — child effects flush before parent effects.
    onIsAtEndChange(false)
    pinRowToTop(target.rowId, target.offsetFromMessage)
  }, [onIsAtEndChange, pinRowToTop])

  /**
   * The row a jump last landed on, lit briefly so the eye finds it.
   *
   * Cleared on a timer rather than on animation end: the class has to come off
   * for the animation to be replayable at all, and an `animationend` that never
   * fires (the row scrolled out of the DOM mid-flash) would strand it.
   */
  const [flashRowId, setFlashRowId] = useState<string | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  const flashFrameRef = useRef<number | null>(null)

  const flashRow = useCallback((rowId: string) => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    if (flashFrameRef.current !== null) window.cancelAnimationFrame(flashFrameRef.current)
    // Dropped for a frame before being set, so jumping to the row you are
    // already lit on replays the flash. Re-applying a class that is already
    // there restarts nothing, and the second click would look ignored.
    setFlashRowId(null)
    flashFrameRef.current = window.requestAnimationFrame(() => {
      flashFrameRef.current = null
      setFlashRowId(rowId)
    })
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null
      setFlashRowId(null)
    }, JUMP_FLASH_DURATION_MS + JUMP_FLASH_CLEANUP_SLACK_MS)
  }, [])

  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    if (flashFrameRef.current !== null) window.cancelAnimationFrame(flashFrameRef.current)
  }, [])

  /**
   * Everything a jump does to a row: where it lands, and lighting it up.
   *
   * The one path every jump takes, wherever it was asked for — the sidebar's
   * hover card, and the minimap's ticks and card. They are the same act, so
   * they have to land the same way, and a jump that flashed from one surface
   * but not another (or landed a fifth of a screen off) reads as a bug.
   *
   * Deliberately not on the restore path: arriving back where you left off is
   * not somewhere you asked to go, and a flash on every chat open would be
   * noise rather than a cue.
   */
  const prepareJumpToRow = useCallback((rowId: string): TranscriptScrollTarget => {
    flashRow(rowId)
    return {
      kind: "pin",
      rowId,
      // Negative, because `offsetFromMessage` measures how far *into* the
      // message the landing point is: past its top for a restored read
      // position, above it for the breathing room a jump wants.
      offsetFromMessage: -measureJumpLeadIn(viewportRef.current, viewportInsetsRef.current),
    }
  }, [flashRow])

  /** Jump requests already spent, so each one lands exactly once. */
  const handledJumpRequestIdRef = useRef<string | null>(null)

  /**
   * Take the pending jump, if there is one and its message is loaded.
   *
   * Marks the request spent either way: a message id that isn't in the
   * transcript is not going to appear by being retried on the next render, and
   * an un-spent request would re-fire on every row change for the rest of the
   * chat's life. The caller falls back to its normal target.
   */
  const consumeJumpTarget = useCallback((): TranscriptScrollTarget | null => {
    if (!jumpRequest || handledJumpRequestIdRef.current === jumpRequest.requestId) return null
    handledJumpRequestIdRef.current = jumpRequest.requestId
    onJumpRequestHandled?.(jumpRequest.requestId)
    const target = resolveJumpTarget(resolvedRows, jumpRequest.role)
    return target?.kind === "pin" ? prepareJumpToRow(target.rowId) : target
  }, [jumpRequest, onJumpRequestHandled, prepareJumpToRow, resolvedRows])

  // Restore once per chat open: wait until rows exist *and* the stored anchor
  // has resolved, otherwise we'd land on the fallback and visibly jump when the
  // anchor arrives a moment later.
  useEffect(() => {
    if (!activeChatId) {
      // Leaving the chat surface arms the next open to restore again. Without
      // this the ref still names the chat just left, so returning to that same
      // chat short-circuits below — no restore, and no geometry sync to light
      // up the map. Navigating to a *different* chat happened to work, which
      // is why this only showed up on away-and-back.
      restoredChatIdRef.current = null
      return
    }
    if (restoredChatIdRef.current === activeChatId) return
    if (resolvedRows.length === 0 || !readAnchorState.resolved) return

    restoredChatIdRef.current = activeChatId
    hasUserScrolledRef.current = false
    latestPromptRef.current = getLatestUserPrompt(resolvedRows)
    // A jump outranks the stored position — you asked for this message by
    // name. Resolved here rather than in a second effect so the open scrolls
    // once: two pins in the same commit would land on the anchor first and
    // visibly slide off it. `hasUserScrolledRef` stays false so the pin's
    // settle loop still corrects as rows measure in; the read anchor catches
    // up from wherever the jump leaves us.
    applyScrollTarget(consumeJumpTarget() ?? resolveRestoreTarget(
      resolvedRows,
      readAnchorState.anchor,
      rowIndexByMessageId,
      measureTranscriptColumnWidth(viewportRef.current),
    ))
  }, [activeChatId, applyScrollTarget, consumeJumpTarget, readAnchorState, resolvedRows, rowIndexByMessageId])

  // A jump into the chat that is *already* open — the restore effect above has
  // already run for it, so nothing else would move the viewport. Deliberate in
  // the same sense as clicking a minimap tick, so it counts as the reader
  // choosing a position.
  useEffect(() => {
    if (!activeChatId || restoredChatIdRef.current !== activeChatId) return
    if (resolvedRows.length === 0) return
    const target = consumeJumpTarget()
    if (!target) return
    hasUserScrolledRef.current = true
    applyScrollTarget(target)
  }, [activeChatId, applyScrollTarget, consumeJumpTarget, resolvedRows])

  // Sending jumps to the bottom, where the new prompt and the reply that
  // follows it are. Streaming output never trips this because it leaves the
  // latest prompt untouched — only a genuinely new one does.
  useEffect(() => {
    if (!activeChatId || restoredChatIdRef.current !== activeChatId) return

    const nextPrompt = getLatestUserPrompt(resolvedRows)
    const previousPrompt = latestPromptRef.current
    latestPromptRef.current = nextPrompt

    if (!shouldPinForNewPrompt(previousPrompt, nextPrompt) || nextPrompt === null) return
    applyScrollTarget({ kind: "end" })
  }, [activeChatId, applyScrollTarget, resolvedRows])

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

  /**
   * Remember which message the user is looking at. `getState().start` is by
   * construction the first row whose bottom edge is below the viewport top, in
   * a coordinate space that already accounts for the sticky header — so it is
   * exactly "the message at the top of the screen".
   */
  /**
   * Which rows are on screen, as the scroller observes them.
   *
   * Real elements report their own visibility, so there is no geometry to
   * mirror and nothing to re-derive when something moves rows under a
   * stationary scroll position.
   */
  const reportTopVisibleMessage = useCallback((isAtEnd: boolean) => {
    if (!onReportReadAnchor) return
    // Never let a programmatic scroll move the stored position.
    if (!hasUserScrolledRef.current) return

    // The topmost row actually on screen — not the scroller's own anchor, which
    // marks turn starts and so is far coarser than a read position wants.
    const visibleRowRange = visibleRowRangeRef.current
    const row = visibleRowRange === null ? undefined : resolvedRowsRef.current[visibleRowRange.start]
    if (!row) return

    const messageId = getRowAnchorMessageId(row)
    // Optimistic ids are client-local and will not resolve on another device.
    if (!messageId || isOptimisticMessageId(messageId)) return

    // Deferred: the hook writes at most once per interval, and the measure is
    // a forced layout the scroll path does not need to pay on every event.
    onReportReadAnchor(messageId, isAtEnd, () => measureReadAnchorLayout(viewportRef.current, row.id, headerOffsetPx))
  }, [headerOffsetPx, onReportReadAnchor])

  const handleScroll = useCallback(() => {
    const scrollNode = viewportRef.current
    if (!scrollNode) return
    const distanceFromEnd = scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop
    const isAtEnd = distanceFromEnd <= AT_END_THRESHOLD_PX
    onIsAtEndChange(isAtEnd)
    reportTopVisibleMessage(isAtEnd)
    setTranscriptOverflows(scrollNode.scrollHeight - scrollNode.clientHeight > OVERFLOW_EPSILON_PX)
  }, [onIsAtEndChange, reportTopVisibleMessage])

  useEffect(() => {
    const scrollNode = viewportRef.current
    if (!scrollNode) return

    // Input events are the only reliable way to tell the user's own scrolling
    // apart from a restore or a pin, which also emit `scroll`.
    const markUserScrolled = () => {
      hasUserScrolledRef.current = true
    }
    const userIntentEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const

    // Resizing the pane changes both the minimap's gutter and whether the same
    // content still overflows, neither of which emits a scroll.
    const syncSize = () => {
      const nextWidth = scrollNode.clientWidth
      setTranscriptWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
      handleScroll()
    }
    const sizeObserver = new ResizeObserver(syncSize)
    sizeObserver.observe(scrollNode)
    syncSize()

    // The content grows as offscreen rows render for the first time, which is
    // what pulls a fresh pin off its target. Watching it is how the correction
    // knows to re-aim.
    const content = scrollNode.querySelector('[data-slot="message-scroller-content"]')
    const contentObserver = new ResizeObserver(() => {
      handleScroll()
      correctPendingPin()
    })
    if (content) contentObserver.observe(content)

    scrollNode.addEventListener("scroll", handleScroll, { passive: true })
    for (const eventName of userIntentEvents) {
      scrollNode.addEventListener(eventName, markUserScrolled, { passive: true })
    }

    return () => {
      sizeObserver.disconnect()
      contentObserver.disconnect()
      scrollNode.removeEventListener("scroll", handleScroll)
      for (const eventName of userIntentEvents) {
        scrollNode.removeEventListener(eventName, markUserScrolled)
      }
    }
  }, [activeChatId, correctPendingPin, handleScroll])

  // The button lives outside the scroll node, so it never trips the input
  // listeners — but jumping to the bottom is an explicit read-position choice.
  const handleScrollToBottomClick = useCallback(() => {
    hasUserScrolledRef.current = true
    scrollToBottom()
  }, [scrollToBottom])

  // Read through refs so the retry loop below sees state from the render that
  // each history page produced, not the one it started in.
  const rowIndexByMessageIdRef = useRef(rowIndexByMessageId)
  rowIndexByMessageIdRef.current = rowIndexByMessageId
  // Same reasoning as the scroll-to-bottom button: the minimap sits outside the
  // scroll node, so it never trips the input listeners, but jumping to a turn is
  // as deliberate a read-position choice as scrolling there by hand.
  /**
   * A jump whose row is not loaded yet. Set when a click names a turn before
   * the window; taken by the effect below once the rows include it.
   */
  const pendingUnloadedJumpRef = useRef<string | null>(null)

  const handleSelectTurn = useCallback((turn: TranscriptTurn, role: ChatJumpRole) => {
    hasUserScrolledRef.current = true
    if (turn.loaded === false) {
      // Load until that prompt is in the window; the jump lands when its
      // row appears. "reply" has no row to name on an unloaded turn, so the
      // prompt is the target either way.
      pendingUnloadedJumpRef.current = turn.id
      void onLoadOlderMessages?.({ untilMessageId: turn.id })
      return
    }
    // The same two ends the sidebar's card offers, resolved per turn rather
    // than per chat — and landing the same way: on the same message, with the
    // same lead-in above it.
    applyScrollTarget(prepareJumpToRow((role === "reply" ? turn.replyRowId : null) ?? turn.id))
  }, [applyScrollTarget, onLoadOlderMessages, prepareJumpToRow])

  useEffect(() => {
    const messageId = pendingUnloadedJumpRef.current
    if (!messageId) return
    const index = rowIndexByMessageId.get(messageId)
    const rowId = index === undefined ? undefined : resolvedRows[index]?.id
    if (rowId === undefined) return
    pendingUnloadedJumpRef.current = null
    applyScrollTarget(prepareJumpToRow(rowId))
  }, [applyScrollTarget, prepareJumpToRow, resolvedRows, rowIndexByMessageId])

  /**
   * The first loaded row and where it sat when "Load More" was clicked.
   *
   * The scroller keeps its position across prepends by watching its first
   * child, but the first child here is the list header (which holds the
   * button), so from its point of view nothing was prepended. The
   * correction is done here instead: once older rows land, the row that was
   * first is moved back to the same offset it had, in the same frame.
   */
  const prependAnchorRef = useRef<{ rowId: string; top: number } | null>(null)

  const captureFirstRow = useCallback(() => {
    const first = resolvedRows[0]
    const viewport = viewportRef.current
    const row = first && viewport?.querySelector(`[data-message-id="${CSS.escape(first.id)}"]`)
    if (!first || !viewport || !row) return
    prependAnchorRef.current = { rowId: first.id, top: row.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
  }, [resolvedRows])

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    if (!anchor) return
    const viewport = viewportRef.current
    const row = viewport?.querySelector(`[data-message-id="${CSS.escape(anchor.rowId)}"]`)
    if (!viewport || !row) return
    // Still the first row: nothing landed above it yet, keep waiting.
    if (resolvedRows[0]?.id === anchor.rowId) return
    prependAnchorRef.current = null
    const top = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    viewport.scrollTop += top - anchor.top
  }, [resolvedRows])

  const handleLoadOlderClick = useCallback(() => {
    captureFirstRow()
    void onLoadOlderMessages?.()
  }, [captureFirstRow, onLoadOlderMessages])

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

  // Stable identity: the viewport commits a render on every scroll event (the
  // visible row range changes constantly), and a fresh style object hands the
  // list a "content container changed" signal each time, which relays out the
  // header and footer and can itself re-trigger follow-the-bottom.
  const contentContainerStyle = useMemo(
    () => ({ paddingBottom: transcriptPaddingBottom + 10 }),
    [transcriptPaddingBottom]
  )

  const listHeader = (
    <div className="mx-auto w-full max-w-[800px]" style={{ paddingTop: `${headerOffsetPx}px` }}>
      {hasOlderMessages ? (
        // Same box as a transcript row so the button lines up with the
        // column below it. The scroller treats what lands above the first
        // row as a prepend and keeps the reader's position.
        <div className="flex justify-center px-2 pb-3 pt-1">
          <button
            type="button"
            onClick={handleLoadOlderClick}
            disabled={isLoadingOlderMessages}
            className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            {isLoadingOlderMessages ? "Loading…" : "Load More"}
          </button>
        </div>
      ) : null}
    </div>
  )

  // Same box geometry as a transcript row (816px wide, 8px of horizontal
  // padding around an 800px text column) rather than a bare 800px column.
  // The two only look alike above 816px; below it the row still insets its
  // content by the padding and a plain 800px box does not, so the spinner
  // would sit 8px left of every tool icon above it.
  const listFooter = (
    <div className="mx-auto w-full max-w-[816px] px-2">
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
        <MessageScroller className="h-full flex-1">
          <MessageScrollerViewport
            ref={viewportRef}
            className="h-full overflow-x-hidden overscroll-y-contain px-3"
            style={{ scrollPaddingTop: headerOffsetPx }}
          >
            <MessageScrollerContent style={contentContainerStyle}>
              {listHeader}
              {resolvedRows.map((row) => (
                <MessageScrollerItem
                  key={row.id}
                  messageId={row.id}
                  // Deliberately not a scroll anchor. Marking turn starts makes
                  // the scroller pull each new one to the top of the viewport —
                  // its "new turn begins here" behaviour. Sending should land
                  // at the bottom, where the reply arrives, and the read
                  // position is taken from the visible rows rather than from
                  // anchors.
                >
                  {/* The row's own padding is what gives the jump highlight its
                      breathing room, so it has to be uniform and inside the
                      box. The gap between messages used to be 20px of bottom
                      padding and is now 8 of padding either side plus 4 of
                      margin, so the rhythm is unchanged. `max-w` grew by the
                      padding to keep the text column itself at 800px. */}
                  <div
                    className={cn(
                      "mx-auto mb-1 w-full max-w-[816px] rounded-xl p-2",
                      flashRowId === row.id && !rowLightsItself(row) && "kanna-jump-flash",
                    )}
                    data-transcript-row-id={row.id}
                  >
                    <KannaTranscriptRow
                      row={row}
                      flash={flashRowId === row.id && rowLightsItself(row)}
                      toolGroupExpanded={row.kind === "tool-group" ? (toolGroupExpanded[row.id] ?? false) : undefined}
                      onToolGroupExpandedChange={handleToolGroupExpandedChange}
                      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                      onExitPlanModeConfirm={onExitPlanModeConfirm}
                    />
                  </div>
                </MessageScrollerItem>
              ))}
              {listFooter}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </OpenLocalLinkProvider>

      {showEmptyState ? null : (
        <TranscriptMinimapOverlay
          viewportRef={viewportRef}
          rowCount={resolvedRows.length}
          visibleRowRangeRef={visibleRowRangeRef}
          turns={turns}
          transcriptOverflows={transcriptOverflows}
          topPx={headerOffsetPx}
          // Match the empty state: transcriptPaddingBottom carries extra
          // clearance the message list needs but overlays should not.
          bottomPx={Math.max(0, transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET)}
          containerWidthPx={transcriptWidth}
          onSelectTurn={handleSelectTurn}
        />
      )}

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
                <div className="w-full space-y-3">
                  <EmptyStateAuthCards />
                  <EmptyStateUsageCards socket={socket} activeChatId={activeChatId} />
                </div>
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
          onClick={handleScrollToBottomClick}
          className="flex aspect-square cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-2 text-sm text-primary transition-colors hover:bg-muted hover:text-foreground dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>
    </>
  )
})

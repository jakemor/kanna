import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties } from "react"
import { ArrowLeft, ArrowRight, ChevronLeft, Flower, House, Loader2, PanelLeft, Search, Plus, Settings, Settings2, SquarePen, Terminal } from "lucide-react"
import { useLocation, useNavigate, useNavigationType } from "react-router-dom"
import { OPEN_LAYER_SELECTOR, useEdgePeek } from "./useEdgePeek"
import { APP_NAME } from "../../shared/branding"
import { Button } from "../components/ui/button"
import { StillTooltips } from "../components/ui/tooltip"
import { buildChatJumpLocationState, type ChatJumpRole } from "../lib/chat-navigation"
import { cn, normalizeChatId } from "../lib/utils"
import { ArchivedChatsDialog } from "../components/chat-ui/sidebar/ArchivedChatsDialog"
import { ArchivedSection } from "../components/chat-ui/sidebar/ArchivedSection"
import { LocalProjectsSection } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { FocusModePill } from "../components/chat-ui/sidebar/FocusModePill"
import { CHAT_INPUT_ATTRIBUTE } from "./chatFocusPolicy"
import { projectActivity } from "./kannaStateHelpers"
import { PANE_EASING, prefersReducedMotion } from "./paneAnimation"
import { SidebarChatHoverCard } from "../components/chat-ui/sidebar/ChatHoverCard"
import { ThreadRow, ThreadRowMenu } from "../components/chat-ui/sidebar/ThreadRow"
import { ThreadSections } from "../components/chat-ui/sidebar/ThreadSections"
import { Kbd } from "../components/ui/kbd"
import { SidebarViewSwitcher } from "../components/chat-ui/sidebar/SidebarViewSwitcher"
import { ChannelList, type ChannelActions, type RenderChatHoverCard, type RenderChatMenu } from "../components/channels/ChannelList"
import { useSidebarViewStore } from "../stores/sidebarViewStore"
import { useChatTabsStore } from "../stores/chatTabsStore"
import { isBackgroundOpenClick } from "../lib/background-open"
import { MachineSwitcher } from "./MachineSwitcher"
import { getResolvedKeybindings } from "../lib/keybindings"
import { useIsStandalone } from "../hooks/useIsStandalone"
import { useHasFinePointer } from "../lib/pointer"
import { isMacApp } from "../lib/macApp"
import type { ChatPreview, ChatTouchedFilesResult, KeybindingsSnapshot, SidebarChatRow, UpdateSnapshot } from "../../shared/types"
import { isNightlyVersion } from "../../shared/types"
import type { SocketStatus } from "./socket"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"
import { SIDEBAR_WIDTH_STORAGE_KEY } from "../lib/storageKeys"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { usePendingSendStore } from "../stores/pendingSendStore"
import { useSidebarData } from "../stores/sidebarStore"
import {
  focusSidebarData,
  isFocusModeEnabled,
  resolveFocusedProjectGroup,
  setFocusMode,
  toggleFocusMode,
  useFocusModeEnabled,
  useFocusModeStore,
} from "../stores/focusModeStore"
import { formatActionShortcut } from "../lib/keybindings"
import { SIDEBAR_MAX_WIDTH_PX } from "../lib/sidebarWidth"
import { useStableSidebarThreads } from "./useStableSidebarThreads"
import { listedThreads } from "../lib/thread-sections"
import { OPEN_COMMAND_PALETTE_EVENT, openCommandPalette } from "../components/command-palette/CommandPalette"

export const DEFAULT_SIDEBAR_WIDTH = 275
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = SIDEBAR_MAX_WIDTH_PX

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

function readStoredSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH
  const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  return stored ? clampSidebarWidth(Number(stored)) : DEFAULT_SIDEBAR_WIDTH
}

function persistSidebarWidth(width: number) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
}

interface KannaSidebarProps {
  activeChatId: string | null
  connectionStatus: SocketStatus
  ready: boolean
  collapsed: boolean
  /** Mobile only: a floating back-to-`/` button for pages with no header. */
  showMobileBackButton: boolean
  onCollapse: () => void
  onExpand: () => void
  onCreateChat: (projectId: string) => void
  /** The New Chat row: a chat in the current project, no picker. */
  onCompose: () => void
  onForkChat: (chat: SidebarChatRow) => void
  currentProjectId: string | null
  keybindings: KeybindingsSnapshot | null
  onMarkChatUnread?: (chat: SidebarChatRow) => void
  onRenameChat: (chat: SidebarChatRow) => void
  onShareChat: (chatId: string) => void
  onToggleChatPin: (chat: SidebarChatRow) => void
  onArchiveChat: (chat: SidebarChatRow) => void
  onOpenArchivedChat: (chatId: string) => void
  onRestoreChat: (chatId: string) => void
  onDeleteChat: (chat: SidebarChatRow) => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  /** Fetches what a chat changed, for the hover card's file list. */
  onLoadTouchedFiles?: (chatId: string) => Promise<ChatTouchedFilesResult>
  /** Fetches the hover card's prompt and reply text. */
  onLoadPreview?: (chatId: string) => Promise<ChatPreview>
  /** Prompts to `git init` a chat's project — the hover card's "Setup Git". */
  onSetupGit: (chatId: string) => void
  onRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject: (projectId: string) => void
  onReorderProjectGroups: (projectIds: string[]) => void
  /** Pins or unpins a project in the Channels view. */
  onSetProjectPinned: (projectId: string, pinned: boolean) => void
  editorLabel: string
  updateSnapshot: UpdateSnapshot | null
  onOpenChangelog: () => void
}

/**
 * The word in the header's DEV / NIGHTLY / UPDATE pills. Caps sit above the
 * middle of a line box, and tracking adds space after the last letter too, so
 * the box is trimmed to the cap height and the trailing tracking taken back:
 * centered both ways in the pill's fixed height.
 */
const PILL_WORD = "block leading-none -mr-[0.05em] [text-box:trim-both_cap_alphabetic]"

const VERSION_PILL_TONES = {
  dev: "border-border bg-muted text-muted-foreground",
  update: "bg-logo/20 border-logo/20 text-logo hover:bg-logo hover:text-foreground",
  nightly: "bg-blue-500/15 border-blue-500/25 text-blue-600 hover:bg-blue-500 hover:text-white hover:border-blue-500 dark:text-blue-400 dark:hover:text-white",
} as const

/** The DEV / UPDATE / NIGHTLY pill: one shape, the tone sets text and color. */
function VersionPill({ tone, label, busy, ...props }: {
  tone: keyof typeof VERSION_PILL_TONES
  label: string
  busy?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const className = cn(
    "inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-2 text-[11px] font-bold uppercase tracking-wider transition-colors",
    VERSION_PILL_TONES[tone]
  )
  const content = (
    <>
      {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
      <span className={PILL_WORD}>{label}</span>
    </>
  )
  // Without an action it is a label, not a button.
  if (!props.onClick) return <span className={className} title={props.title}>{content}</span>
  return (
    <button
      type="button"
      {...props}
      className={cn(className, "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none")}
    >
      {content}
    </button>
  )
}

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** iOS's push runs a little longer than a pane opening: a whole page travels its own width. */
const FOCUS_PUSH_MS = 350
/** How far the page underneath drifts while the one on top crosses it, as a share of its width. */
const FOCUS_PARALLAX = "-30%"
/** The sidebar card's own background, for the page on top, so it covers the one under it. */
const FOCUS_PAGE_SURFACE = ["bg-background", "dark:bg-card"]
const SIDEBAR_SCROLLER_SELECTOR = "[data-sidebar-scroller]"

/** The scroller itself, or the one inside. */
function findSidebarScroller(element: HTMLElement) {
  return element.matches(SIDEBAR_SCROLLER_SELECTOR) ? element : element.querySelector<HTMLElement>(SIDEBAR_SCROLLER_SELECTOR)
}

/**
 * What travels when focus mode pushes: the bar and the list under it.
 *
 * Except in the Mac app's desktop layout, where the bar holds nothing that
 * differs between the two pages: the logo it would swap for the back button
 * leads the list there instead (the traffic lights have its place), which
 * leaves the bar with add and search on both pages. Sliding those out and
 * identical ones in is motion for nothing, so the bar holds still and only
 * the list under it is the page.
 */
function getMovingPage(page: HTMLElement | null) {
  if (!page) return null
  const barIsShared = isMacApp() && window.matchMedia("(min-width: 768px)").matches
  return barIsShared ? findSidebarScroller(page) : page
}

/**
 * Focus mode is a page pushed onto the sidebar, the way an iOS navigation
 * controller pushes one: the whole page, bar and list, slides in from the
 * right, opaque, over the page that was there, which drifts a third of the
 * way left and fades beneath it. Leaving pops: the page slides back off to
 * the right and the one before it drifts back in from the left.
 *
 * React turns one page into the other in a single commit, so there is no
 * outgoing page left to animate. A copy of it is taken the moment the store
 * changes, before that commit, and stands in for it: inert, laid over the
 * frame the page sits in, scrolled to where the original was, and removed
 * when the motion ends.
 *
 * On the panes' curve (paneAnimation.ts), which is iOS's own for this, with
 * no overshoot: a click threw nothing. Only transform and opacity move.
 *
 * Not for the toggle shortcut (set `skipFocusMotionRef` before toggling):
 * that is pressed to get somewhere, over and over, and motion would only be
 * in the way. Escape does animate: it is the same step back as the back
 * button. Not for focus moving from one project to another either, which
 * follows the chat you opened. Under reduced motion the pages don't travel;
 * one fades out as the other fades in.
 */
function useFocusMotion(focused: boolean) {
  const pageMotionRef = useRef<HTMLDivElement>(null)
  const skipFocusMotionRef = useRef(false)
  const wasFocusedRef = useRef(focused)
  const outgoingRef = useRef<{ page: HTMLElement; scrollTop: number } | null>(null)
  const finishRef = useRef<(() => void) | null>(null)

  // The store changes before React renders the result, which is the one
  // moment the outgoing page is still in the document to be copied.
  const captureOutgoing = useCallback(() => {
    const page = getMovingPage(pageMotionRef.current)
    if (!page) return
    // A motion still running ends here, so its copy is not copied in turn.
    finishRef.current?.()
    const copy = {
      page: page.cloneNode(true) as HTMLElement,
      // A copy starts scrolled to the top; this puts it back.
      scrollTop: findSidebarScroller(page)?.scrollTop ?? 0,
    }
    outgoingRef.current = copy
    // Dropped if the change moved nothing on screen (no current project).
    window.requestAnimationFrame(() => {
      if (outgoingRef.current === copy) outgoingRef.current = null
    })
  }, [])
  useEffect(() => useFocusModeStore.subscribe((state, previous) => {
    if (state.enabled !== previous.enabled) captureOutgoing()
  }), [captureOutgoing])

  useLayoutEffect(() => {
    const wasFocused = wasFocusedRef.current
    wasFocusedRef.current = focused
    const skip = skipFocusMotionRef.current
    skipFocusMotionRef.current = false
    const outgoing = outgoingRef.current
    outgoingRef.current = null
    const page = getMovingPage(pageMotionRef.current)
    const frame = page?.parentElement
    if (wasFocused === focused || skip || !outgoing || !page || !frame) return

    // Over exactly where the page is: the whole frame, or under the bar.
    const copy = outgoing.page
    copy.inert = true
    copy.setAttribute("aria-hidden", "true")
    Object.assign(copy.style, {
      position: "absolute",
      top: `${page.offsetTop}px`,
      left: `${page.offsetLeft}px`,
      width: `${page.offsetWidth}px`,
      height: `${page.offsetHeight}px`,
      pointerEvents: "none",
    })
    frame.append(copy)
    const copyScroller = findSidebarScroller(copy)
    if (copyScroller) copyScroller.scrollTop = outgoing.scrollTop

    // Pushing, the new page is the one on top; popping, the copy is. The one
    // on top is opaque, so the page under it never shows through.
    const top = focused ? page : copy
    const under = focused ? copy : page
    top.classList.add(...FOCUS_PAGE_SURFACE)
    top.style.zIndex = "2"
    under.style.zIndex = "1"
    const previousPosition = page.style.position
    page.style.position = "relative"

    const reduced = prefersReducedMotion()
    const timing = reduced
      ? { duration: 150, easing: "ease" }
      : { duration: FOCUS_PUSH_MS, easing: PANE_EASING }
    const offRight = reduced ? { opacity: 0 } : { transform: "translateX(100%)" }
    const underneath = reduced ? { opacity: 0 } : { transform: `translateX(${FOCUS_PARALLAX})`, opacity: 0 }
    const atRest = { transform: "none", opacity: 1 }

    const animations = focused
      ? [page.animate([offRight, atRest], timing), copy.animate([atRest, underneath], { ...timing, fill: "forwards" })]
      : [copy.animate([atRest, offRight], { ...timing, fill: "forwards" }), page.animate([underneath, atRest], timing)]

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (finishRef.current === finish) finishRef.current = null
      for (const animation of animations) animation.cancel()
      copy.remove()
      page.classList.remove(...FOCUS_PAGE_SURFACE)
      page.style.zIndex = ""
      page.style.position = previousPosition
    }
    finishRef.current = finish
    animations[0]!.onfinish = finish
  }, [focused])

  useEffect(() => () => finishRef.current?.(), [])

  return { pageMotionRef, skipFocusMotionRef, captureOutgoing }
}

function KannaSidebarImpl({
  activeChatId,
  connectionStatus,
  ready,
  collapsed,
  showMobileBackButton,
  onCollapse,
  onExpand,
  onCreateChat,
  onCompose,
  onForkChat,
  currentProjectId,
  keybindings,
  onMarkChatUnread,
  onRenameChat,
  onShareChat,
  onToggleChatPin,
  onArchiveChat,
  onOpenArchivedChat,
  onRestoreChat,
  onDeleteChat,
  onCopyPath,
  onOpenExternalPath,
  onLoadTouchedFiles,
  onLoadPreview,
  onSetupGit,
  onRenameProject,
  onHideProject,
  onReorderProjectGroups,
  onSetProjectPinned,
  editorLabel,
  updateSnapshot,
  onOpenChangelog,
}: KannaSidebarProps) {
  // The one place that wants the whole snapshot. Selected here rather than
  // passed down so a sidebar push re-renders this component and nothing above
  // it — the chat page and the transcript are untouched by it.
  const allProjectsData = useSidebarData()
  const focusModeEnabled = useFocusModeEnabled()
  // Focus mode narrows the sidebar to one project. Resolved and applied once,
  // here, so the Chats view, the Projects view and the number-jump indices all
  // agree on what is on screen. The focused project is whichever one is current,
  // so opening a chat elsewhere re-points focus rather than leaving it.
  //
  // A project's own page (`/project/:id`) is that project focused whatever
  // the setting says: it is what opening a channel shows on a phone, where
  // the channel's chats are a page of their own between the channel list
  // and a chat, reached and left through the browser's history so the
  // system's swipe back works on it.
  const location = useLocation()
  const routeProjectId = useMemo(() => {
    const match = /^\/project\/([^/]+)/.exec(location.pathname)
    return match ? decodeURIComponent(match[1]!) : null
  }, [location.pathname])
  const focusedProjectGroup = useMemo(
    () => resolveFocusedProjectGroup(
      allProjectsData.projectGroups,
      focusModeEnabled || routeProjectId !== null,
      routeProjectId ?? currentProjectId
    ),
    [allProjectsData.projectGroups, currentProjectId, focusModeEnabled, routeProjectId]
  )
  const data = useMemo(
    () => focusSidebarData(allProjectsData, focusedProjectGroup),
    [allProjectsData, focusedProjectGroup]
  )
  const navigate = useNavigate()
  const isStandalone = useIsStandalone()
  const { pageMotionRef, skipFocusMotionRef, captureOutgoing } = useFocusMotion(focusedProjectGroup !== null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const initializedCollapsedGroupKeysRef = useRef<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [showNumberJumpHints, setShowNumberJumpHints] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  // Which project's archived chats the dialog is showing, if any. The
  // workspace-wide list is the sidebar's own Archived view, not this.
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const sidebarView = useSidebarViewStore((state) => state.view)
  const setSidebarView = useSidebarViewStore((state) => state.setView)
  /**
   * Leave the Archived view for the one you were in before it — a no-op from
   * anywhere else, so callers don't have to check where they are.
   *
   * The archive is where finished work goes, so anything that puts a chat back
   * into circulation has ended your visit: sending a prompt (which unarchives
   * the chat server-side, or was a new chat that was never in this list) and
   * restoring one. Staying put would leave you looking at a list the chat you
   * just acted on has dropped out of.
   */
  const leaveArchivedView = useSidebarViewStore((state) => state.leaveArchived)

  // Opening a channel where its chats can't hang off it as a menu (a phone,
  // or any touch screen): they are a page of their own, pushed onto the
  // history. Menu, then the channel's chats, then a chat, and back the same
  // way. The outgoing page is captured so the push animates, as focus mode's
  // does; the system's swipe back needs none of ours.
  const selectProject = useCallback((projectId: string) => {
    captureOutgoing()
    navigate(`/project/${encodeURIComponent(projectId)}`)
  }, [captureOutgoing, navigate])

  const handleRestoreChat = useCallback((chatId: string) => {
    leaveArchivedView()
    onRestoreChat(chatId)
  }, [leaveArchivedView, onRestoreChat])

  // Sends come from the composer, which is not in this tree — the pending-send
  // store is the one place both sides already meet. Subscribed only while the
  // Archived view is up, so every other view pays nothing for this.
  useEffect(() => {
    if (sidebarView !== "archived") return
    return usePendingSendStore.subscribe((state, previous) => {
      if (state.sentAt === previous.sentAt) return
      const started = Object.keys(state.sentAt)
        .some((chatId) => state.sentAt[chatId] !== previous.sentAt[chatId])
      if (started) leaveArchivedView()
    })
  }, [leaveArchivedView, sidebarView])
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const focusShortcutHint = formatActionShortcut(resolvedKeybindings, "toggleFocusMode") ?? undefined
  // Leaving the focused page. On a project's own page that is going back:
  // through the history where there is one to go back through, so the Back
  // button and the system's swipe land in the same place, and to the menu
  // for a page opened directly.
  const exitFocusMode = useCallback(() => {
    if (routeProjectId === null) {
      setFocusMode(false)
      return
    }
    captureOutgoing()
    if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) navigate(-1)
    else navigate("/", { replace: true })
  }, [captureOutgoing, navigate, routeProjectId])
  const visibleChats = useMemo(
    () => getVisibleSidebarChats(data.projectGroups, collapsedSections, expandedGroups),
    [collapsedSections, data.projectGroups, expandedGroups]
  )
  const visibleChatsRef = useRef(visibleChats)
  const visibleIndexByChatId = useMemo(
    () => new Map(visibleChats.map((entry) => [entry.chat.chatId, entry.visibleIndex])),
    [visibleChats]
  )

  const projectIdByPath = useMemo(
    () => new Map(data.projectGroups.map((group) => [group.localPath, group.groupKey])),
    [data.projectGroups]
  )

  // The Projects tab renders the same `ThreadRow` as the Chats tab, which wants
  // a SidebarThread. Flattened once here and shared with the Chats tab so
  // projectId/projectTitle/archived stay correct in one place — and so both tabs
  // hand their rows the same identity-stable thread objects.
  const everyThread = useStableSidebarThreads(data)
  const threads = useMemo(() => listedThreads(everyThread), [everyThread])
  const threadByChatId = useMemo(
    () => new Map(threads.map((thread) => [thread.chatId, thread])),
    [threads]
  )

  const activeVisibleCount = visibleChats.length
  const archivedProject = useMemo(
    () => allProjectsData.projectGroups.find((group) => group.groupKey === archivedProjectId) ?? null,
    [archivedProjectId, allProjectsData.projectGroups]
  )

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  // Tracked against every project, not the focused view — a collapsed project
  // that focus mode hides must come back collapsed, not reset.
  useEffect(() => {
    setCollapsedSections((previous) => {
      const next = new Set<string>()
      const projectKeys = new Set(allProjectsData.projectGroups.map((group) => group.groupKey))
      const initializedKeys = initializedCollapsedGroupKeysRef.current

      for (const key of previous) {
        if (projectKeys.has(key)) {
          next.add(key)
        }
      }

      initializedCollapsedGroupKeysRef.current = new Set(
        [...initializedKeys].filter((key) => projectKeys.has(key))
      )

      for (const group of allProjectsData.projectGroups) {
        if (initializedCollapsedGroupKeysRef.current.has(group.groupKey)) continue
        initializedCollapsedGroupKeysRef.current.add(group.groupKey)
        if (group.defaultCollapsed) {
          next.add(group.groupKey)
        }
      }

      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous
      }

      return next
    })
  }, [allProjectsData.projectGroups])

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const toggleExpandedGroup = useCallback((key: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const selectChat = useCallback((chatId: string) => {
    // With chat tabs on, Cmd+click: a tab for the chat, and you stay where
    // you are, as a browser opens a link in the background. Without them
    // there would be nothing to show for the click.
    if (useAppSettingsStore.getState().settings?.chatTabsEnabled === true && isBackgroundOpenClick()) {
      useChatTabsStore.getState().open(chatId, activeChatId)
      return
    }
    navigate(`/chat/${chatId}`)
  }, [activeChatId, navigate])

  // Same navigation with a landing spot attached. Always navigates, even to the
  // chat already open: the pathname wouldn't change, but the request id does,
  // which is what moves the viewport a second time.
  const selectChatMessage = useCallback((chatId: string, role: ChatJumpRole) => {
    navigate(`/chat/${chatId}`, { state: buildChatJumpLocationState(role) })
  }, [navigate])

  // The chat rows' own right-click menu, for the chats inside a channel's
  // card. The items that take you elsewhere or open a dialog close the card
  // first; the rest (pin, archive, copy, open in…) leave you where you were,
  // card included.
  const renderChannelChatMenu = useCallback<RenderChatMenu>((thread, row, closeCard) => (
    <ThreadRowMenu
      thread={thread}
      editorLabel={editorLabel}
      onCreateChat={(projectId) => { closeCard(); onCreateChat(projectId) }}
      onMarkChatUnread={(chat) => { closeCard(); onMarkChatUnread?.(chat) }}
      onRenameChat={(chat) => { closeCard(); onRenameChat(chat) }}
      onShareChat={(chatId) => { closeCard(); onShareChat(chatId) }}
      onForkChat={(chat) => { closeCard(); onForkChat(chat) }}
      onDeleteChat={(chat) => { closeCard(); onDeleteChat(chat) }}
      onCopyPath={onCopyPath}
      onOpenExternalPath={onOpenExternalPath}
      onToggleChatPin={onToggleChatPin}
      onArchiveChat={onArchiveChat}
      onRestoreChat={handleRestoreChat}
    >
      {row}
    </ThreadRowMenu>
  ), [editorLabel, handleRestoreChat, onArchiveChat, onCopyPath, onCreateChat, onDeleteChat, onForkChat, onOpenExternalPath, onMarkChatUnread, onRenameChat, onShareChat, onToggleChatPin])

  const channelActions = useMemo<ChannelActions>(() => ({
    editorLabel,
    onCreateChat,
    onRenameProject,
    onCopyPath,
    onOpenExternalPath,
    onShowArchivedProject: setArchivedProjectId,
    onHideProject,
    onSetProjectPinned,
  }), [editorLabel, onCopyPath, onCreateChat, onHideProject, onOpenExternalPath, onRenameProject, onSetProjectPinned])

  // The chat hover card again, for the chats inside a channel's card. Stable,
  // so the memoized channel rows are not re-rendered by it.
  const renderChannelChatHoverCard = useCallback<RenderChatHoverCard>((containerRef, cardThreads) => (
    <SidebarChatHoverCard
      containerRef={containerRef}
      threads={cardThreads}
      // 2px off the channel's card, as that card is off the sidebar: a row
      // ends 7px inside its card (padding and border).
      sideOffset={9}
      onSelectChat={selectChat}
      onSelectMessage={selectChatMessage}
      onOpenArchivedChat={onOpenArchivedChat}
      onSetupGit={onSetupGit}
      onLoadTouchedFiles={onLoadTouchedFiles}
      onLoadPreview={onLoadPreview}
      onOpenExternalPath={onOpenExternalPath}
    />
  ), [onLoadPreview, onLoadTouchedFiles, onOpenArchivedChat, onOpenExternalPath, onSetupGit, selectChat, selectChatMessage])

  const renderChatRow = useCallback((chat: SidebarChatRow) => {
    const thread = threadByChatId.get(chat.chatId)
    if (!thread) return null
    const visibleIndex = visibleIndexByChatId.get(chat.chatId)
    const shortcutHint = visibleIndex ? getSidebarNumberJumpHint(resolvedKeybindings, visibleIndex) : null

    return (
      <ThreadRow
        key={chat._id}
        thread={thread}
        isActive={activeChatId === normalizeChatId(chat.chatId)}
        editorLabel={editorLabel}
        // Project-scoped: rows already sit under their project header, so the
        // slot shows the chat's age — swapped for a keycap while the
        // number-jump modifier is held.
        detailScope="project-scoped"
        nowMs={nowMs}
        detailLabelOverride={showNumberJumpHints && shortcutHint ? (
          <Kbd className="h-4 min-w-4 rounded-sm border-border/50 bg-transparent px-1 text-[10px]">
            {shortcutHint}
          </Kbd>
        ) : undefined}
        onSelect={selectChat}
        onCreateChat={onCreateChat}
        onMarkChatUnread={onMarkChatUnread}
        onRenameChat={onRenameChat}
        onShareChat={onShareChat}
        onCopyPath={onCopyPath}
        onOpenExternalPath={onOpenExternalPath}
        onForkChat={onForkChat}
        onToggleChatPin={onToggleChatPin}
        onArchiveChat={onArchiveChat}
        onRestoreChat={handleRestoreChat}
        onDeleteChat={onDeleteChat}
      />
    )
  }, [activeChatId, editorLabel, nowMs, onToggleChatPin, onArchiveChat, onCopyPath, onCreateChat, onDeleteChat, onForkChat, onOpenExternalPath, onMarkChatUnread, onRenameChat, handleRestoreChat, onShareChat, resolvedKeybindings, selectChat, showNumberJumpHints, threadByChatId, visibleIndexByChatId])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 30_000)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      setShowNumberJumpHints(shouldShowSidebarNumberJumpHints(resolvedKeybindings, event))

      if (isSidebarModifierShortcut(resolvedKeybindings, "createChatInCurrentProject", event)) {
        if (!currentProjectId) {
          return
        }

        event.preventDefault()
        onCreateChat(currentProjectId)
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "openAddProject", event)) {
        event.preventDefault()
        openCommandPalette("add-project")
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "toggleFocusMode", event)) {
        // Turning focus on with no current project would hide every chat, so
        // the shortcut only turns it off in that state.
        if (!currentProjectId && !isFocusModeEnabled()) {
          return
        }

        event.preventDefault()
        // A shortcut's result lands at once; see `useFocusMotion`.
        skipFocusMotionRef.current = true
        toggleFocusMode()
        // Cleared a frame on in case the toggle changed nothing on screen, so
        // it can't swallow the motion of a later click.
        window.requestAnimationFrame(() => { skipFocusMotionRef.current = false })
        return
      }

      const targetIndex = getSidebarJumpTargetIndex(resolvedKeybindings, event)
      if (targetIndex === null) {
        return
      }

      const targetChat = visibleChatsRef.current[targetIndex - 1]?.chat
      if (!targetChat) {
        return
      }

      event.preventDefault()
      navigate(`/chat/${targetChat.chatId}`)
    }

    function handleKeyUp(event: KeyboardEvent) {
      setShowNumberJumpHints(shouldShowSidebarNumberJumpHints(resolvedKeybindings, event))
    }

    function clearHints() {
      setShowNumberJumpHints(false)
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    window.addEventListener("blur", clearHints)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", clearHints)
    }
  }, [currentProjectId, navigate, onCreateChat, resolvedKeybindings])

  // Escape leaves focus mode, but only when nothing nearer has a use for it.
  // It is last in line, heard as the event finishes bubbling, and it stands
  // down for:
  //   - anything that already answered it (`defaultPrevented`): the hold that
  //     stops a running turn, closing the composer's skill or project menu, the first
  //     Escape that returns focus to the composer, the phone's widget sheet;
  //   - anything that kept it for itself: the viewer and the branch picker
  //     stop it before it gets here;
  //   - an open menu, select or dialog (the command palette), which closes;
  //   - a text field other than the composer (a search box clearing its
  //     query, the plan's edit box, a terminal).
  // So in the composer of an idle chat, where Escape did nothing, it now does
  // this.
  const hasFocusedProject = focusedProjectGroup !== null
  useEffect(() => {
    if (!hasFocusedProject) return
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (document.querySelector(OPEN_LAYER_SELECTOR)) return
      const target = event.target
      if (target instanceof HTMLElement && !target.hasAttribute(CHAT_INPUT_ATTRIBUTE)
        && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return

      event.preventDefault()
      // Animated, unlike the toggle shortcut (`useFocusMotion`): Escape is
      // the step back out that the back button is, pressed once to leave.
      exitFocusMode()
    }
    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [exitFocusMode, hasFocusedProject])

  useEffect(() => {
    if (!activeChatId || !scrollContainerRef.current) return

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      const activeElement = container?.querySelector(`[data-chat-id="${activeChatId}"]`) as HTMLElement | null
      if (!activeElement || !container) return

      const elementRect = activeElement.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()

      if (elementRect.top < containerRect.top + 38) {
        const relativeTop = elementRect.top - containerRect.top + container.scrollTop
        container.scrollTo({ top: relativeTop - 38, behavior: "smooth" })
      } else if (elementRect.bottom > containerRect.bottom) {
        const elementCenter = elementRect.top + elementRect.height / 2 - containerRect.top + container.scrollTop
        const containerCenter = container.clientHeight / 2
        container.scrollTo({ top: elementCenter - containerCenter, behavior: "smooth" })
      }
    })
  }, [activeChatId])

  useEffect(() => {
    if (!isResizingSidebar) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    function handlePointerMove(event: PointerEvent) {
      const resizeStart = resizeStartRef.current
      if (!resizeStart) return
      setSidebarWidth(clampSidebarWidth(resizeStart.width + event.clientX - resizeStart.pointerX))
    }

    function handlePointerUp() {
      setIsResizingSidebar(false)
      resizeStartRef.current = null
      setSidebarWidth((current) => {
        const next = clampSidebarWidth(current)
        persistSidebarWidth(next)
        return next
      })
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp, { once: true })

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isResizingSidebar])

  // The peek (useEdgePeek): the collapsed card shown over the chat while the
  // mouse is at the window's left edge. Nothing is expanded: the chat keeps
  // its width under the card. 8px is both how near the edge opens it and the
  // card's left margin once it is there.
  const sidebarCardRef = useRef<HTMLDivElement>(null)
  const peeking = useEdgePeek({ side: "left", enabled: collapsed, panelRef: sidebarCardRef, edgePx: 8, insetPx: 8 })

  const hasVisibleChats = activeVisibleCount > 0
  // `/` is the sidebar itself on mobile; the projects page lives at `/home`
  // there. On desktop both paths show the projects page.
  // A project's page is the sidebar too, on a phone: the same list, focused.
  const isRootActive = location.pathname === "/" || routeProjectId !== null
  // Whether a channel's chats are a page or a menu. A menu needs a pointer
  // that can hover and a sidebar with room beside it, which the phone
  // layout, where the sidebar is the whole screen, has not.
  const hasFinePointer = useHasFinePointer()
  const isPhoneLayout = useMediaQuery("(max-width: 767px)")
  const channelsOpenAsPages = !hasFinePointer || isPhoneLayout
  const isLocalProjectsActive = isRootActive || location.pathname === "/home"
  const newSidebarEnabled = useAppSettingsStore((s) => s.settings?.newSidebarEnabled !== false)
  const devbox = useAppSettingsStore((s) => s.settings?.devbox === true)
  const projectIconsInChats = useAppSettingsStore((s) => s.settings?.projectIconsInChats !== false)
  const newSidebarProjectsView = newSidebarEnabled && sidebarView === "projects"

  // New Sidebar's Projects tab hides projects with no chats and sorts by
  // recent activity — but a project seen non-empty during the current tab
  // visit sticks around at its last position even after its last chat is
  // archived (activity would otherwise drop to 0 and yank it to the bottom).
  // The sticky memory resets when you leave the Projects tab.
  const stickyProjectActivityRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    if (!newSidebarProjectsView) stickyProjectActivityRef.current = new Map()
  }, [newSidebarProjectsView])
  const visibleProjectGroups = useMemo(() => {
    if (!newSidebarProjectsView) return data.projectGroups
    // Focus mode already picked the one project to show. Hiding it for being
    // empty would leave the view blank under a pill naming it.
    if (focusedProjectGroup) return data.projectGroups
    const sticky = stickyProjectActivityRef.current
    const visible = data.projectGroups.filter((group) => {
      if (group.chats.length > 0) {
        sticky.set(group.groupKey, projectActivity(group))
        return true
      }
      return sticky.has(group.groupKey)
    })
    // Sticky (just-emptied) groups sort by their remembered activity.
    return visible.sort((left, right) =>
      (sticky.get(right.groupKey) ?? projectActivity(right)) - (sticky.get(left.groupKey) ?? projectActivity(left)))
  }, [data.projectGroups, focusedProjectGroup, newSidebarProjectsView])

  const isSettingsActive = location.pathname.startsWith("/settings")
  const isUtilityPageActive = isLocalProjectsActive || isSettingsActive
  const isConnecting = connectionStatus === "connecting" || !ready
  const statusLabel = isConnecting ? "Connecting" : connectionStatus === "connected" ? "Connected" : "Disconnected"
  const statusDotClass = connectionStatus === "connected" ? "bg-emerald-500" : "bg-amber-500"
  const showNightlyUpdate = isNightlyVersion(updateSnapshot?.currentVersion ?? "")
    && updateSnapshot?.nightly?.status === "available"
  const showUpdateButton = showNightlyUpdate || updateSnapshot?.updateAvailable === true
  const showDevBadge = updateSnapshot
    ? updateSnapshot.latestVersion === `${updateSnapshot.currentVersion}-dev`
    : false
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const versionBadge = showDevBadge ? (
    <VersionPill tone="dev" label="Dev" title="Development build" />
  ) : showNightlyUpdate ? (
    <VersionPill
      tone="nightly"
      label="Nightly"
      busy={isUpdating}
      disabled={isUpdating}
      onClick={() => navigate("/settings/labs#nightlyBuilds")}
      title="New nightly available. Open Labs to build latest main."
    />
  ) : showUpdateButton ? (
    <VersionPill
      tone="update"
      label="Update"
      busy={isUpdating}
      disabled={isUpdating}
      onClick={onOpenChangelog}
      title={updateSnapshot?.latestVersion ? `Update to ${updateSnapshot.latestVersion}` : "Update Kanna"}
    />
  ) : null

  return (
    // Scanned by sweeping the pointer down the list; see StillTooltips.
    <StillTooltips>
      {showMobileBackButton && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-3 left-3 z-50 md:hidden"
          onClick={() => navigate("/")}
          title="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
      )}

      {collapsed && isUtilityPageActive && (
        <div className="hidden md:flex fixed left-0 top-0 h-full z-40 items-start pt-4 pl-5 border-l border-border/0 mac-app:!hidden transition-opacity duration-200 ease-out starting:opacity-0">
          <div className="flex items-center gap-1">
            <Flower className="size-6 text-logo" />
            <Button
              variant="ghost"
              size="icon"
              onClick={onExpand}
              title="Expand sidebar"
              className="hover:!border-border/0 hover:!bg-transparent"
            >
              <PanelLeft className="h-5 w-5" />
            </Button>
          </div>
        </div>
      )}

      <div
        ref={sidebarCardRef}
        data-sidebar="open"
        className={cn(
          "fixed inset-0 z-50 bg-background dark:bg-card flex flex-col h-[100dvh] select-none",
          "md:relative md:inset-auto md:w-[var(--sidebar-width)] md:mr-0 md:h-[calc(100dvh-16px)] md:my-2 md:ml-2 md:border md:border-border md:rounded-2xl",
          // Inset 8px from the window's edges, so concentric with its corners.
          "mac-app:md:rounded-[calc(var(--mac-window-radius)-8px)]",
          isRootActive ? "flex" : "hidden md:flex",
          // Collapsing slides the card out by its own margin: at -width it sits
          // just off the left edge and takes no room, so the chat widens in
          // the same frames it slides, and the card never changes width, so its
          // contents never reflow. The pane clock and curve every pane beside
          // the chat shares (paneAnimation.ts): 300ms in, 240ms out, glide.
          // visibility rides along: visible for the slide, hidden once gone.
          "md:transition-[margin-left,translate,box-shadow,visibility] md:duration-300 md:ease-glide motion-reduce:transition-none",
          collapsed && "md:!ml-[calc(var(--sidebar-width)*-1)]",
          collapsed && !peeking && "md:!duration-[240ms] md:invisible",
          // The peek slides the collapsed card back in by a transform, over
          // the chat rather than beside it: the margin stays where collapsing
          // left it, so nothing reflows. It lands where the open sidebar
          // sits, and on the same clock and curve as the margin. Expanding
          // from a peek therefore runs the two against each other and they
          // cancel: the card holds still while the chat makes room for it.
          peeking && "md:translate-x-[calc(var(--sidebar-width)+8px)] md:shadow-2xl"
        )}
        inert={collapsed && !peeking}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        {/* In the Mac app this row is the window's title bar: it drags the
            window, has no divider under it (a title bar runs into the
            content), and its content centers on the traffic lights. The card
            starts 9px down (8px margin, 1px border), so a center C needs a
            height of 2 × (C − 9). The traffic lights, the sidebar toggle and
            back/forward (below) take the left end. */}
        {/* The sidebar's page: the bar and everything that scrolls under it.
            Focus mode pushes a new one over it (`useFocusMotion`); the frame
            around it clips the page in transit and holds the outgoing copy.
            Settings and the machine switcher stay put below, as a tab bar
            does under a navigation stack.

            The frame takes the card's top corners, one pixel tighter for the
            card's border, which it sits inside. Without them the page in
            transit, opaque and square, paints over the card's rounded
            corners. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-t-[15px] mac-app:md:rounded-t-[calc(var(--mac-window-radius)-9px)]">
        <div ref={pageMotionRef} className="relative flex min-h-0 flex-1 flex-col">
        <div
          data-window-drag
          className="px-2.5 h-[64px] md:h-auto md:py-1 border-b grid grid-cols-[84px_minmax(0,1fr)_84px] items-center md:pl-3 md:pr-1 md:flex md:justify-between mac-app:md:h-[calc(var(--mac-traffic-lights-center)*2-18px)] mac-app:md:border-b-0 mac-app:md:py-0 mac-app:md:pl-[calc(var(--mac-traffic-lights-inset)+83px)]"
        >
          {/* A phone's bar is a navigation bar: what leads it is the way back
              when there is one, and the title sits in the middle as a title.
              So in focus mode Back takes Settings' place here, and the
              project's name below is text, not the button it is on desktop
              (where the bar has no middle and the two are one control). */}
          <div className="md:hidden flex">
            {focusedProjectGroup ? (
              <Button
                variant="ghost"
                size="icon"
                className="w-[42px] rounded-lg hover:!border-border/0 hover:!bg-transparent !border-0"
                onClick={exitFocusMode}
                title="Back"
                aria-label={`Back from ${focusedProjectGroup.title}`}
              >
                <ChevronLeft className="size-6" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "w-[42px] rounded-lg hover:!border-border/0 hover:!bg-transparent !border-0",
                  isSettingsActive ? "text-foreground" : "text-muted-foreground"
                )}
                onClick={() => navigate("/settings/general")}
                title="Settings"
              >
                <Settings className="h-5 w-5" />
              </Button>
            )}
          </div>
          {/* Focus mode's page is titled by its project, not by the app: the
              back button takes the logo and wordmark's place. */}
          {focusedProjectGroup ? (
            <>
              <span className="min-w-0 justify-self-center truncate text-base font-medium md:hidden">
                {focusedProjectGroup.title}
              </span>
              <FocusModePill
                // 2px in from the bar's 12px padding: the 20px chevron then
                // centers 24px from the card's edge, on the column the flower
                // and every row icon below share.
                className="hidden md:ml-[2px] md:flex mac-app:md:hidden"
                projectTitle={focusedProjectGroup.title}
                shortcutHint={focusShortcutHint}
                onExit={exitFocusMode}
              />
            </>
          ) : (
          <div className="flex items-center justify-self-center gap-2 md:justify-self-auto mac-app:md:hidden">
            <button
              type="button"
              // Reachable while collapsed only in a peek, where it keeps the
              // sidebar rather than sending it away.
              onClick={collapsed ? onExpand : onCollapse}
              title={collapsed ? "Keep sidebar open" : "Collapse sidebar"}
              className="hidden md:flex group/sidebar-collapse relative items-center justify-center h-5 w-5 sm:h-6 sm:w-6"
            >
              <Flower className="absolute inset-0.5 h-4 w-4 sm:h-5 sm:w-5 text-logo transition-all duration-200 ease-out opacity-100 scale-100 group-hover/sidebar-collapse:opacity-0 group-hover/sidebar-collapse:scale-0" />
              <PanelLeft className="absolute inset-0 h-4 w-4 sm:h-6 sm:w-6 text-slate-500 dark:text-slate-400 transition-all duration-200 ease-out opacity-0 scale-0 group-hover/sidebar-collapse:opacity-100 group-hover/sidebar-collapse:scale-80 hover:opacity-50" />
            </button>
            <Flower className="h-5 w-5 sm:h-6 sm:w-6 text-logo md:hidden" />
            {/* The flower collapses the sidebar, so the wordmark is what
                takes you home on desktop (the House button lives only in
                the mobile nav). */}
            <button
              type="button"
              onClick={() => navigate("/home")}
              title="Projects"
              className="font-logo text-base uppercase sm:text-md text-slate-600 dark:text-slate-100"
            >
              {APP_NAME}
            </button>
          </div>
          )}
          {/* In the app the flower group is hidden, which leaves this the
              row's only item; justify-between would put it at the start. */}
          <div className="flex items-center justify-self-end md:justify-self-auto mac-app:md:ml-auto">
            {!newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-10 rounded-lg hover:!border-border/0 hover:!bg-transparent md:hidden"
                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
                title="Search"
              >
                <Search className="h-5 w-5" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              onClick={newSidebarEnabled ? () => openCommandPalette() : () => navigate("/home")}
              className="size-10 rounded-lg hover:!border-border/0 hover:!bg-transparent md:hidden"
              title={newSidebarEnabled ? "Search" : "New project"}
            >
              {newSidebarEnabled ? <Search className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
            </Button>
            {newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate("/home")}
                className={cn(
                  "size-10 rounded-lg hover:!border-border/0 hover:!bg-transparent md:hidden",
                  isLocalProjectsActive ? "text-foreground" : "text-muted-foreground"
                )}
                title="Projects"
              >
                <House className="h-5 w-5" />
              </Button>
            ) : null}
            {/* The app shows it beside the logo instead (below). */}
            <div className="hidden md:flex mr-1 mac-app:md:hidden">{versionBadge}</div>
            {newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openCommandPalette("add-project")}
                className="hidden md:inline-flex h-10 w-auto rounded-lg px-1.5 pl-2 hover:!border-border/0 hover:!bg-transparent mac-app:md:h-8"
                title="Add project"
              >
                <Plus className="size-4" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              onClick={newSidebarEnabled ? () => openCommandPalette() : () => navigate("/home")}
              className={cn(
                "hidden md:inline-flex h-10 w-auto rounded-lg pl-1.5 pr-3 hover:!border-border/0 hover:!bg-transparent mac-app:md:h-8 mac-app:md:pr-1.5",
                !newSidebarEnabled && "pl-2 mac-app:md:pr-2"
              )}
              title={newSidebarEnabled ? "Search" : "New project"}
            >
              {newSidebarEnabled ? <Search className="size-4" /> : <Plus className="size-4" />}
            </Button>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          data-sidebar-scroller
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"
          style={{
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-y",
          }}
        >
          {/* The app's title bar has no divider, so the New Chat block sits
              tighter under it: 4px off the top, all 8px off the bottom. */}
          <div className="p-[7px] mac-app:md:pt-[3px]">
            {/* The app's header gives the flower and wordmark's place to the
                traffic lights, so the pair leads the sidebar here instead. It
                goes to Projects, as the header's wordmark does. 7px in centers
                the 20px flower on the 16px icons below (theirs start 9px in:
                1px border + px-2). The version badge ends at the header's
                search glyph: 1px border + pr-1 + the button's pr-1.5 + the
                glyph's ~1px inset, against this block's 1px border + 7px. */}
            <div className="hidden mac-app:md:flex items-center justify-between gap-2 pt-1 pb-2">
              {focusedProjectGroup ? (
                <FocusModePill
                  // 7px in, as the flower is: the same 20px box, so the same
                  // center as the 16px icons below.
                  className="pl-[7px] pr-[9px]"
                  projectTitle={focusedProjectGroup.title}
                  shortcutHint={focusShortcutHint}
                  onExit={exitFocusMode}
                />
              ) : (
              <button
                type="button"
                onClick={() => navigate("/home")}
                title="Projects"
                className="flex items-center gap-2 pl-[7px] pr-[9px]"
              >
                <Flower className="size-5 text-logo" />
                <span className="font-logo text-base uppercase text-slate-600 dark:text-slate-100">{APP_NAME}</span>
              </button>
              )}
              <div className="flex mr-1">{versionBadge}</div>
            </div>
            {newSidebarEnabled ? (
              <div className="flex flex-col gap-[1px] pb-2 mac-app:md:pb-0">
                {newSidebarEnabled ? (
                  <>
                    {/* The switcher overlays the New Chat row's right end rather
                        than sharing a flex row with it, so all three rows keep
                        the same full-width hover target. */}
                    <div className="relative">
                      <button
                        type="button"
                        // On a project's page, a chat in that project.
                        onClick={routeProjectId ? () => onCreateChat(routeProjectId) : onCompose}
                        // Hover only lifts the text, as the icon buttons' does.
                        // No box, so it never frames the filter button.
                        className="flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:text-accent-foreground"
                      >
                        <SquarePen className="h-4 w-4 shrink-0" />
                        <span>New Chat</span>
                      </button>
                      <div className="absolute inset-y-0 right-0 flex items-center">
                        <SidebarViewSwitcher view={sidebarView} onChange={setSidebarView} />
                      </div>
                    </div>
                  </>
                ) : null}
                {newSidebarEnabled && devbox ? (
                  <button
                    type="button"
                    onClick={() => navigate("/terminal")}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:border-border hover:bg-muted"
                  >
                    <Terminal className="h-4 w-4 shrink-0" />
                    <span>Terminal</span>
                  </button>
                ) : null}
              </div>
            ) : null}

            <div>
            {!hasVisibleChats && isConnecting ? (
              <div className="space-y-5 px-1 pt-3">
                {[0, 1, 2].map((section) => (
                  <div key={section} className="space-y-2 animate-pulse">
                    <div className="h-4 w-28 rounded bg-muted" />
                    <div className="space-y-1">
                      {[0, 1, 2].map((row) => (
                        <div key={row} className="flex items-center gap-2 rounded-md px-3 py-2">
                          <div className="h-3.5 w-3.5 rounded-full bg-muted" />
                          <div
                            className={cn(
                              "h-3.5 rounded bg-muted",
                              row === 0 ? "w-32" : row === 1 ? "w-40" : "w-28"
                            )}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Not in the Archived view: there, "no conversations yet" would sit
                above a list of the conversations you archived, and the view
                states its own emptiness anyway. Nor in the channel list, which
                shows projects whether or not they have conversations. */}
            {!isConnecting && sidebarView !== "archived" && !(sidebarView === "channels" && !focusedProjectGroup) && (
              (!hasVisibleChats && data.projectGroups.length === 0)
              // A focused project with no chats: say so, rather than leave the
              // list blank under a pill naming the project.
              || focusedProjectGroup?.chats.length === 0
            ) ? (
              <p className="text-sm text-slate-400 p-2 mt-6 text-center">No conversations yet</p>
            ) : null}

            {/* A channel that is open is its chats, as the Chats view shows them. */}
            {newSidebarEnabled && (sidebarView === "recents" || (sidebarView === "channels" && focusedProjectGroup)) ? (
              <ThreadSections
                // A channel's chats remember their sections per channel.
                expandScope={sidebarView === "channels" && focusedProjectGroup ? `channel:${focusedProjectGroup.groupKey}` : undefined}
                showProjectIcons={projectIconsInChats && sidebarView === "recents"}
                threads={threads}
                activeChatId={activeChatId}
                editorLabel={editorLabel}
                nowMs={nowMs}
                onSelectChat={selectChat}
                onOpenArchivedChat={onOpenArchivedChat}
                onRestoreChat={handleRestoreChat}
                onCreateChat={onCreateChat}
                onMarkChatUnread={onMarkChatUnread}
                onRenameChat={onRenameChat}
                onShareChat={onShareChat}
                onForkChat={onForkChat}
                onToggleChatPin={onToggleChatPin}
                onArchiveChat={onArchiveChat}
                onDeleteChat={onDeleteChat}
                onCopyPath={onCopyPath}
                onOpenExternalPath={onOpenExternalPath}
              />
            ) : null}

            {newSidebarEnabled && sidebarView === "archived" ? (
              <ArchivedSection
                threads={threads}
                activeChatId={activeChatId}
                editorLabel={editorLabel}
                nowMs={nowMs}
                onOpenArchivedChat={onOpenArchivedChat}
                onRestoreChat={handleRestoreChat}
                onCreateChat={onCreateChat}
                onMarkChatUnread={onMarkChatUnread}
                onRenameChat={onRenameChat}
                onShareChat={onShareChat}
                onForkChat={onForkChat}
                onArchiveChat={onArchiveChat}
                onDeleteChat={onDeleteChat}
                onCopyPath={onCopyPath}
                onOpenExternalPath={onOpenExternalPath}
              />
            ) : null}

            {newSidebarEnabled && sidebarView === "channels" && !focusedProjectGroup ? (
              <ChannelList
                projectGroups={allProjectsData.projectGroups}
                activeProjectId={currentProjectId}
                nowMs={nowMs}
                activeChatId={activeChatId}
                onSelect={selectProject}
                opensAsPage={channelsOpenAsPages}
                onSelectChat={selectChat}
                renderChatHoverCard={renderChannelChatHoverCard}
                actions={channelActions}
                renderChatMenu={renderChannelChatMenu}
              />
            ) : null}

            {!newSidebarEnabled || sidebarView === "projects" ? (
              <LocalProjectsSection
                projectGroups={visibleProjectGroups}
                editorLabel={editorLabel}
                onReorderGroups={onReorderProjectGroups}
                collapsedSections={collapsedSections}
                expandedGroups={expandedGroups}
                onToggleSection={toggleSection}
                onToggleExpandedGroup={toggleExpandedGroup}
                renderChatRow={renderChatRow}
                onShowArchivedProject={setArchivedProjectId}
                onNewLocalChat={(localPath) => {
                  const projectId = projectIdByPath.get(localPath)
                  if (projectId) {
                    onCreateChat(projectId)
                  }
                }}
                onCopyPath={onCopyPath}
                onOpenExternalPath={onOpenExternalPath}
                onRenameProject={onRenameProject}
                onHideProject={onHideProject}
                isConnected={connectionStatus === "connected"}
                newSidebar={newSidebarProjectsView}
              />
            ) : null}
            </div>
          </div>
        </div>

        </div>
        </div>

        {/* One card for every row above, anchored to whichever is under the
            pointer — see `SidebarChatHoverCard`. It renders a portal and no
            layout, so it sits here rather than inside the scrolling list. */}
        <SidebarChatHoverCard
          containerRef={scrollContainerRef}
          threads={threads}
          onSelectChat={selectChat}
          onSelectMessage={selectChatMessage}
          onOpenArchivedChat={onOpenArchivedChat}
          onSetupGit={onSetupGit}
          onLoadTouchedFiles={onLoadTouchedFiles}
          onLoadPreview={onLoadPreview}
          onOpenExternalPath={onOpenExternalPath}
        />

          <MachineSwitcher />
        <div className={cn("hidden md:block border-t border-border p-2", isStandalone && "pb-[55px]")}>
          <button
            type="button"
            onClick={() => navigate("/settings/general")}
            className={cn(
              "w-full rounded-xl rounded-t-md border px-3 py-2 text-left transition-colors",
              isSettingsActive
                ? "bg-muted border-border"
                : "border-border/0 hover:bg-muted hover:border-border active:bg-muted/80"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Settings</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{statusLabel}</span>
                {isConnecting ? (
                  <Loader2 className="h-2 w-2 animate-spin" />
                ) : (
                  <span className={cn("h-2 w-2 rounded-full", statusDotClass)} />
                )}
              </div>
            </div>
          </button>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          title="Resize sidebar"
          className={cn(
            "hidden md:block absolute -right-1 top-3 bottom-3 z-20 w-2 cursor-col-resize rounded-full",
            "focus-visible:outline-none"
          )}
          onPointerDown={(event) => {
            event.preventDefault()
            resizeStartRef.current = {
              pointerX: event.clientX,
              width: sidebarWidth,
            }
            setIsResizingSidebar(true)
          }}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
            persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
          }}
          onKeyDown={(event) => {
            let nextWidth: number | null = null
            if (event.key === "ArrowLeft") nextWidth = sidebarWidth - 16
            else if (event.key === "ArrowRight") nextWidth = sidebarWidth + 16
            else if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH
            else if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH
            else if (event.key === "Enter") nextWidth = DEFAULT_SIDEBAR_WIDTH
            if (nextWidth === null) return
            event.preventDefault()
            const clampedWidth = clampSidebarWidth(nextWidth)
            setSidebarWidth(clampedWidth)
            persistSidebarWidth(clampedWidth)
          }}
        />
      </div>

      {/* The Mac app's sidebar toggle and back/forward: pinned beside the
          traffic lights, so they are the same size in the same spot whether
          the sidebar is open (collapse) or closed (expand). The sidebar
          header and the chat navbar leave room for them (84px). After the
          card, so they stack above it; dialogs portal in later and stack
          above both. */}
      <div className="hidden mac-app:md:flex fixed z-50 items-center left-[var(--mac-traffic-lights-inset)] top-[calc(var(--mac-traffic-lights-center)-14px)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={collapsed ? onExpand : onCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="size-7 rounded-lg text-muted-foreground hover:!border-border/0 hover:!bg-transparent"
        >
          <PanelLeft className="size-4" />
        </Button>
        <MacHistoryButtons overSidebar={!collapsed || peeking} />
      </div>

      <ArchivedChatsDialog
        open={Boolean(archivedProject)}
        description={archivedProject?.localPath}
        chats={archivedProject?.archivedChats ?? []}
        nowMs={nowMs}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setArchivedProjectId(null)
        }}
        onOpenChat={onOpenArchivedChat}
        onRestoreChat={handleRestoreChat}
      />
    </StillTooltips>
  )
}

/**
 * The page can't ask the window whether it can go back or forward, so it
 * reads React Router's history index and remembers the furthest one this
 * load has seen: a push cuts off everything ahead of it, a pop keeps it.
 * History from before a reload counts as no forward until visited again.
 */
function MacHistoryButtons({ overSidebar }: { overSidebar: boolean }) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const index = (window.history.state as { idx?: number } | null)?.idx ?? 0
  const [lastIndex, setLastIndex] = useState(index)

  useEffect(() => {
    setLastIndex((last) => navigationType === "PUSH" ? index : Math.max(last, index))
  }, [location.key, navigationType, index])

  // Disabled, the ghost button's text is muted-foreground/50: translucent, so
  // wherever an arrow's shaft and head overlap, the stroke doubles up. The
  // same color made opaque instead, mixed over whatever the buttons sit on:
  // the sidebar card while it is open (bg-background, dark:bg-card), the
  // chat's bg-background once it slides away.
  const className = cn(
    "size-7 rounded-lg text-muted-foreground hover:!border-border/0 hover:!bg-transparent",
    "disabled:!text-[color-mix(in_srgb,hsl(var(--muted-foreground))_50%,var(--history-surface))]",
    "[--history-surface:hsl(var(--background))]",
    overSidebar && "dark:[--history-surface:hsl(var(--card))]"
  )
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        disabled={index <= 0}
        onClick={() => window.history.back()}
        title="Back"
        className={className}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={index >= lastIndex}
        onClick={() => window.history.forward()}
        title="Forward"
        className={className}
      >
        <ArrowRight className="size-4" />
      </Button>
    </>
  )
}

export const KannaSidebar = memo(KannaSidebarImpl)

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { ArrowLeft, Flower, House, Loader2, PanelLeft, Search, Plus, Settings, Settings2, SquarePen, Terminal } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { Button } from "../components/ui/button"
import { buildChatJumpLocationState, type ChatJumpRole } from "../lib/chat-navigation"
import { cn, normalizeChatId } from "../lib/utils"
import { ArchivedChatsDialog } from "../components/chat-ui/sidebar/ArchivedChatsDialog"
import { ArchivedSection } from "../components/chat-ui/sidebar/ArchivedSection"
import { LocalProjectsSection } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { FocusModePill } from "../components/chat-ui/sidebar/FocusModePill"
import { projectActivity } from "./kannaStateHelpers"
import { SidebarChatHoverCard } from "../components/chat-ui/sidebar/ChatHoverCard"
import { ThreadRow } from "../components/chat-ui/sidebar/ThreadRow"
import { ThreadSections } from "../components/chat-ui/sidebar/ThreadSections"
import { Kbd } from "../components/ui/kbd"
import { SidebarViewSwitcher, type SidebarView } from "../components/chat-ui/sidebar/SidebarViewSwitcher"
import { MachineSwitcher } from "./MachineSwitcher"
import { getResolvedKeybindings } from "../lib/keybindings"
import { useIsStandalone } from "../hooks/useIsStandalone"
import type { ChatPreview, ChatTouchedFilesResult, KeybindingsSnapshot, SidebarChatRow, UpdateSnapshot } from "../../shared/types"
import type { SocketStatus } from "./socket"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"
import { SIDEBAR_VIEW_STORAGE_KEY, SIDEBAR_WIDTH_STORAGE_KEY } from "../lib/storageKeys"
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
} from "../stores/focusModeStore"
import { formatActionShortcut } from "../lib/keybindings"
import { useStableSidebarThreads } from "./useStableSidebarThreads"
import { OPEN_COMMAND_PALETTE_EVENT, openCommandPalette } from "../components/command-palette/CommandPalette"

export const DEFAULT_SIDEBAR_WIDTH = 275
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 520

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

/**
 * The list view to start in. Only ever Chats or Projects: Archived is somewhere
 * you visit and get returned from (see `leaveArchivedView`), so it is never
 * persisted — and what's stored is exactly the view Archived hands you back to,
 * across reloads as well as within a session.
 */
function readStoredSidebarView(): Exclude<SidebarView, "archived"> {
  if (typeof window === "undefined") return "recents"
  return window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "projects" ? "projects" : "recents"
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
  onForkChat: (chat: SidebarChatRow) => void
  currentProjectId: string | null
  keybindings: KeybindingsSnapshot | null
  onRenameChat: (chat: SidebarChatRow) => void
  onShareChat: (chatId: string) => void
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
  editorLabel: string
  updateSnapshot: UpdateSnapshot | null
  onOpenChangelog: () => void
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
  onForkChat,
  currentProjectId,
  keybindings,
  onRenameChat,
  onShareChat,
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
  const focusedProjectGroup = useMemo(
    () => resolveFocusedProjectGroup(allProjectsData.projectGroups, focusModeEnabled, currentProjectId),
    [allProjectsData.projectGroups, currentProjectId, focusModeEnabled]
  )
  const data = useMemo(
    () => focusSidebarData(allProjectsData, focusedProjectGroup),
    [allProjectsData, focusedProjectGroup]
  )
  const location = useLocation()
  const navigate = useNavigate()
  const isStandalone = useIsStandalone()
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
  const [sidebarView, setSidebarView] = useState<SidebarView>(readStoredSidebarView)
  // Where Archived hands you back to. Held in a ref because nothing renders it
  // — it is read at the moment you leave, which can be from a store
  // subscription rather than a render.
  const returnViewRef = useRef<Exclude<SidebarView, "archived">>(readStoredSidebarView())

  const changeSidebarView = useCallback((view: SidebarView) => {
    setSidebarView(view)
    if (view === "archived") return
    returnViewRef.current = view
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view)
  }, [])

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
  const leaveArchivedView = useCallback(() => {
    setSidebarView((current) => (current === "archived" ? returnViewRef.current : current))
  }, [])

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
  const threads = useStableSidebarThreads(data)
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
    navigate(`/chat/${chatId}`)
  }, [navigate])

  // Same navigation with a landing spot attached. Always navigates, even to the
  // chat already open: the pathname wouldn't change, but the request id does,
  // which is what moves the viewport a second time.
  const selectChatMessage = useCallback((chatId: string, role: ChatJumpRole) => {
    navigate(`/chat/${chatId}`, { state: buildChatJumpLocationState(role) })
  }, [navigate])

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
        onRenameChat={onRenameChat}
        onShareChat={onShareChat}
        onCopyPath={onCopyPath}
        onOpenExternalPath={onOpenExternalPath}
        onForkChat={onForkChat}
        onArchiveChat={onArchiveChat}
        onRestoreChat={handleRestoreChat}
        onDeleteChat={onDeleteChat}
      />
    )
  }, [activeChatId, editorLabel, nowMs, onArchiveChat, onCopyPath, onCreateChat, onDeleteChat, onForkChat, onOpenExternalPath, onRenameChat, handleRestoreChat, onShareChat, resolvedKeybindings, selectChat, showNumberJumpHints, threadByChatId, visibleIndexByChatId])

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
        toggleFocusMode()
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

  const hasVisibleChats = activeVisibleCount > 0
  // `/` is the sidebar itself on mobile; the projects page lives at `/home`
  // there. On desktop both paths show the projects page.
  const isRootActive = location.pathname === "/"
  const isLocalProjectsActive = isRootActive || location.pathname === "/home"
  const newSidebarEnabled = useAppSettingsStore((s) => s.settings?.newSidebarEnabled !== false)
  const devbox = useAppSettingsStore((s) => s.settings?.devbox === true)
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
  const showUpdateButton = updateSnapshot?.updateAvailable === true
  const showDevBadge = updateSnapshot
    ? updateSnapshot.latestVersion === `${updateSnapshot.currentVersion}-dev`
    : false
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"

  return (
    <>
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
        <div className="hidden md:flex fixed left-0 top-0 h-full z-40 items-start pt-4 pl-5 border-l border-border/0">
          <div className="flex items-center gap-1">
            <Flower className="size-6 text-logo" />
            <Button
              variant="ghost"
              size="icon"
              onClick={onExpand}
              title="Expand sidebar"
            >
              <PanelLeft className="h-5 w-5" />
            </Button>
          </div>
        </div>
      )}

      <div
        data-sidebar="open"
        className={cn(
          "fixed inset-0 z-50 bg-background dark:bg-card flex flex-col h-[100dvh] select-none",
          "md:relative md:inset-auto md:w-[var(--sidebar-width)] md:mr-0 md:h-[calc(100dvh-16px)] md:my-2 md:ml-2 md:border md:border-border md:rounded-2xl",
          isRootActive ? "flex" : "hidden md:flex",
          collapsed && "md:hidden"
        )}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="px-2.5 h-[64px] md:h-auto md:py-1 border-b grid grid-cols-[84px_minmax(0,1fr)_84px] items-center md:pl-3 md:pr-1 md:flex md:justify-between">
          <div className="md:hidden flex">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "w-[42px] rounded-lg hover:!border-border/0 !border-0",
                isSettingsActive ? "text-foreground" : "text-muted-foreground"
              )}
              onClick={() => navigate("/settings/general")}
              title="Settings"
            >
              <Settings className="h-5 w-5" />
            </Button>
          </div>
          <div className="flex items-center justify-self-center gap-2 md:justify-self-auto">
            <button
              type="button"
              onClick={onCollapse}
              title="Collapse sidebar"
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
          <div className="flex items-center justify-self-end md:justify-self-auto">
            {!newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-10 rounded-lg hover:!border-border/0 md:hidden"
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
              className="size-10 rounded-lg hover:!border-border/0 md:hidden"
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
                  "size-10 rounded-lg hover:!border-border/0 md:hidden",
                  isLocalProjectsActive ? "text-foreground" : "text-muted-foreground"
                )}
                title="Projects"
              >
                <House className="h-5 w-5" />
              </Button>
            ) : null}
            {showDevBadge ? (
              <span
                className="mr-1 hidden md:inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-bold tracking-wider text-muted-foreground"
                title="Development build"
              >
                DEV
              </span>
            ) : showUpdateButton ? (
              <Button
                variant="outline"
                size="sm"
                className="hidden md:inline-flex rounded-full !h-auto mr-1 py-0.5 px-2 bg-logo/20 hover:bg-logo text-logo border-logo/20 hover:text-foreground hover:border-logo/20 text-[11px] font-bold tracking-wider"
                onClick={onOpenChangelog}
                disabled={isUpdating}
                title={updateSnapshot?.latestVersion ? `Update to ${updateSnapshot.latestVersion}` : "Update Kanna"}
              >
                {isUpdating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                UPDATE
              </Button>
            ) : null}
            {newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openCommandPalette("add-project")}
                className="hidden md:inline-flex h-10 w-auto rounded-lg px-1.5 pl-2 hover:!border-border/0"
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
                "hidden md:inline-flex h-10 w-auto rounded-lg pl-1.5 pr-3 hover:!border-border/0",
                !newSidebarEnabled && "pl-2"
              )}
              title={newSidebarEnabled ? "Search" : "New project"}
            >
              {newSidebarEnabled ? <Search className="size-4" /> : <Plus className="size-4" />}
            </Button>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"
          style={{
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-y",
          }}
        >
          <div className="p-[7px]">
            {/* The focus row joins this block rather than sitting below it, so
                it inherits the same width, padding and row rhythm as the
                buttons — which is the whole of its treatment. It leads the
                block, and the block leads both views, so focus mode is the
                first thing the sidebar says either way. */}
            {newSidebarEnabled || focusedProjectGroup ? (
              <div className="flex flex-col gap-[1px] pb-2">
                {focusedProjectGroup ? (
                  <FocusModePill
                    projectTitle={focusedProjectGroup.title}
                    shortcutHint={formatActionShortcut(resolvedKeybindings, "toggleFocusMode") ?? undefined}
                    onExit={() => setFocusMode(false)}
                  />
                ) : null}
                {newSidebarEnabled ? (
                  <>
                    {/* The switcher overlays the New Chat row's right end rather
                        than sharing a flex row with it, so all three rows keep
                        the same full-width hover target. */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => openCommandPalette("new-thread")}
                        className="flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:border-border hover:bg-muted"
                      >
                        <SquarePen className="h-4 w-4 shrink-0" />
                        <span>New Chat</span>
                      </button>
                      <div className="absolute inset-y-0 right-0 flex items-center">
                        <SidebarViewSwitcher view={sidebarView} onChange={changeSidebarView} />
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
                states its own emptiness anyway. */}
            {!isConnecting && sidebarView !== "archived" && (
              (!hasVisibleChats && data.projectGroups.length === 0)
              // A focused project with no chats: say so, rather than leave the
              // list blank under a pill naming the project.
              || focusedProjectGroup?.chats.length === 0
            ) ? (
              <p className="text-sm text-slate-400 p-2 mt-6 text-center">No conversations yet</p>
            ) : null}

            {newSidebarEnabled && sidebarView === "recents" ? (
              <ThreadSections
                threads={threads}
                activeChatId={activeChatId}
                editorLabel={editorLabel}
                nowMs={nowMs}
                onSelectChat={selectChat}
                onOpenArchivedChat={onOpenArchivedChat}
                onRestoreChat={handleRestoreChat}
                onCreateChat={onCreateChat}
                onRenameChat={onRenameChat}
                onShareChat={onShareChat}
                onForkChat={onForkChat}
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
                onRenameChat={onRenameChat}
                onShareChat={onShareChat}
                onForkChat={onForkChat}
                onArchiveChat={onArchiveChat}
                onDeleteChat={onDeleteChat}
                onCopyPath={onCopyPath}
                onOpenExternalPath={onOpenExternalPath}
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
    </>
  )
}

export const KannaSidebar = memo(KannaSidebarImpl)

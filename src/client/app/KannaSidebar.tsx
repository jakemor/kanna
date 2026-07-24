import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Flower, Folder, House, Loader2, PanelLeft, Search, X, Menu, Plus, Settings, SquarePen, SquareTerminal } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { Button } from "../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog"
import { formatSidebarAgeLabel } from "../lib/formatters"
import { getSidebarChatTimestamp } from "../lib/sidebarChats"
import { cn } from "../lib/utils"
import { ChatRow } from "../components/chat-ui/sidebar/ChatRow"
import { LocalProjectsSection, projectActivity } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { ThreadSections } from "../components/chat-ui/sidebar/ThreadSections"
import { SegmentedControl } from "../components/ui/segmented-control"
import { MachineSwitcher } from "./MachineSwitcher"
import { getResolvedKeybindings } from "../lib/keybindings"
import { useIsStandalone } from "../hooks/useIsStandalone"
import type { KeybindingsSnapshot, SidebarData, SidebarChatRow, UpdateSnapshot } from "../../shared/types"
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

/** Which view the sidebar shows when the recent-chats Labs mode is enabled. */
type SidebarView = "recents" | "projects"

function readStoredSidebarView(): SidebarView {
  if (typeof window === "undefined") return "recents"
  return window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "projects" ? "projects" : "recents"
}

interface KannaSidebarProps {
  data: SidebarData
  activeChatId: string | null
  connectionStatus: SocketStatus
  ready: boolean
  open: boolean
  collapsed: boolean
  showMobileOpenButton: boolean
  onOpen: () => void
  onClose: () => void
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
  onRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject: (projectId: string) => void
  onReorderProjectGroups: (projectIds: string[]) => void
  editorLabel: string
  updateSnapshot: UpdateSnapshot | null
  onOpenChangelog: () => void
}

function KannaSidebarImpl({
  data,
  activeChatId,
  connectionStatus,
  ready,
  open,
  collapsed,
  showMobileOpenButton,
  onOpen,
  onClose,
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
  onRenameProject,
  onHideProject,
  onReorderProjectGroups,
  editorLabel,
  updateSnapshot,
  onOpenChangelog,
}: KannaSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const isStandalone = useIsStandalone()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const initializedCollapsedGroupKeysRef = useRef<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())

  // The selected chat's project group, when it has chats to browse — gates the
  // "Chats in <project>" shortcut (mirrors the palette's own action gating).
  const currentProjectGroup = useMemo(() => {
    if (!currentProjectId) return null
    const group = data.projectGroups.find((candidate) => candidate.groupKey === currentProjectId)
    if (!group) return null
    return group.chats.length > 0 || (group.archivedChats?.length ?? 0) > 0 ? group : null
  }, [currentProjectId, data.projectGroups])
  const [showNumberJumpHints, setShowNumberJumpHints] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const [sidebarView, setSidebarView] = useState<SidebarView>(readStoredSidebarView)

  const changeSidebarView = useCallback((view: SidebarView) => {
    setSidebarView(view)
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view)
  }, [])
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

  const activeVisibleCount = visibleChats.length
  const archivedProject = useMemo(
    () => data.projectGroups.find((group) => group.groupKey === archivedProjectId) ?? null,
    [archivedProjectId, data.projectGroups]
  )

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  useEffect(() => {
    setCollapsedSections((previous) => {
      const next = new Set<string>()
      const projectKeys = new Set(data.projectGroups.map((group) => group.groupKey))
      const initializedKeys = initializedCollapsedGroupKeysRef.current

      for (const key of previous) {
        if (projectKeys.has(key)) {
          next.add(key)
        }
      }

      initializedCollapsedGroupKeysRef.current = new Set(
        [...initializedKeys].filter((key) => projectKeys.has(key))
      )

      for (const group of data.projectGroups) {
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
  }, [data.projectGroups])

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
    onClose()
  }, [navigate, onClose])

  const renderChatRow = useCallback((chat: SidebarChatRow) => {
    const visibleIndex = visibleIndexByChatId.get(chat.chatId)

    return (
      <ChatRow
        key={chat._id}
        chat={chat}
        activeChatId={activeChatId}
        nowMs={nowMs}
        shortcutHint={visibleIndex ? getSidebarNumberJumpHint(resolvedKeybindings, visibleIndex) : null}
        showShortcutHint={showNumberJumpHints}
        editorLabel={editorLabel}
        onSelectChat={selectChat}
        onNewChatInProject={(localPath) => {
          const projectId = projectIdByPath.get(localPath)
          if (projectId) onCreateChat(projectId)
        }}
        onRenameChat={() => onRenameChat(chat)}
        onShareChat={() => onShareChat(chat.chatId)}
        onCopyPath={() => onCopyPath(chat.localPath)}
        onOpenInFinder={() => onOpenExternalPath("open_finder", chat.localPath)}
        onOpenInEditor={() => onOpenExternalPath("open_editor", chat.localPath)}
        onForkChat={() => onForkChat(chat)}
        onArchiveChat={() => onArchiveChat(chat)}
        onDeleteChat={() => onDeleteChat(chat)}
      />
    )
  }, [activeChatId, editorLabel, nowMs, onArchiveChat, onCopyPath, onCreateChat, onDeleteChat, onForkChat, onOpenExternalPath, onRenameChat, onShareChat, projectIdByPath, resolvedKeybindings, selectChat, showNumberJumpHints, visibleIndexByChatId])

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
        onClose()
        openCommandPalette("add-project")
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
      onClose()
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
  }, [currentProjectId, navigate, onClose, onCreateChat, resolvedKeybindings])

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
  const isLocalProjectsActive = location.pathname === "/"
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
  }, [data.projectGroups, newSidebarProjectsView])

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
      {!open && showMobileOpenButton && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-3 left-3 z-50 md:hidden"
          onClick={onOpen}
        >
          <Menu className="h-5 w-5" />
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
          open ? "flex" : "hidden md:flex",
          collapsed && "md:hidden"
        )}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="px-2.5 h-[64px] md:h-auto md:py-1 border-b grid grid-cols-[84px_minmax(0,1fr)_84px] items-center md:pl-3 md:pr-1 md:flex md:justify-between">
          <div className="md:hidden grid grid-cols-2">
            <Button
              variant="ghost"
              size="icon"
              className="w-[42px] rounded-lg hover:!border-border/0 !border-0"
              onClick={onClose}
              title="Close sidebar"
            >
              <X className="h-5 w-5" />
            </Button>
            {!newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="w-[42px] rounded-lg hover:!border-border/0 !border-0 -translate-x-[1px]"
                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
                title="Search"
              >
                <Search className="h-5 w-5" />
              </Button>
            ) : null}
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
            <span className="font-logo text-base uppercase sm:text-md text-slate-600 dark:text-slate-100">{APP_NAME}</span>
          </div>
          <div className="flex items-center justify-self-end md:justify-self-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={newSidebarEnabled
                ? () => openCommandPalette()
                : () => {
                  navigate("/")
                  onClose()
                }}
              className="size-10 rounded-lg hover:!border-border/0 md:hidden"
              title={newSidebarEnabled ? "Search" : "New project"}
            >
              {newSidebarEnabled ? <Search className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
            </Button>
            {newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  navigate("/")
                  onClose()
                }}
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
            <Button
              variant="ghost"
              size="icon"
              onClick={newSidebarEnabled
                ? () => openCommandPalette()
                : () => {
                  navigate("/")
                  onClose()
                }}
              className="hidden md:inline-flex h-10 w-auto rounded-lg px-1.5 hover:!border-border/0"
              title={newSidebarEnabled ? "Search" : "New project"}
            >
              {newSidebarEnabled ? <Search className="size-4" /> : <Plus className="size-4" />}
            </Button>
            {newSidebarEnabled ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  navigate("/")
                  onClose()
                }}
                className={cn(
                  "hidden md:inline-flex h-10 w-auto rounded-lg pl-1.5 pr-3 hover:!border-border/0",
                  isLocalProjectsActive ? "text-foreground" : "text-muted-foreground"
                )}
                title="Projects"
              >
                <House className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>

        {newSidebarEnabled ? (
          <div className="flex flex-col gap-[1px] border-b border-border px-[7px] py-2">
            <SegmentedControl
              value={sidebarView}
              onValueChange={changeSidebarView}
              options={[
                { value: "recents", label: "Chats" },
                { value: "projects", label: "Projects" },
              ]}
              size="sm"
              className="grid w-full grid-cols-2 mb-2"
              optionClassName="w-full justify-center"
            />
            <button
              type="button"
              onClick={() => openCommandPalette("new-thread")}
              className="flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:border-border hover:bg-muted"
            >
              <SquarePen className="h-4 w-4 shrink-0" />
              <span>New Chat</span>
            </button>
            {devbox ? (
              <button
                type="button"
                onClick={() => {
                  navigate("/terminal")
                  onClose()
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:border-border hover:bg-muted"
              >
                <SquareTerminal className="h-4 w-4 shrink-0" />
                <span>Terminal</span>
              </button>
            ) : null}
            {currentProjectGroup ? (
              <button
                type="button"
                onClick={() => openCommandPalette("project-chats")}
                className="flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:border-border hover:bg-muted"
              >
                <Folder className="h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{currentProjectGroup.title}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"
          style={{
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-y",
          }}
        >
          <div className="p-[7px]">
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

            {!hasVisibleChats && !isConnecting && data.projectGroups.length === 0 ? (
              <p className="text-sm text-slate-400 p-2 mt-6 text-center">No conversations yet</p>
            ) : null}

            {newSidebarEnabled && sidebarView === "recents" ? (
              <ThreadSections
                data={data}
                activeChatId={activeChatId}
                editorLabel={editorLabel}
                nowMs={nowMs}
                onSelectChat={selectChat}
                onOpenArchivedChat={onOpenArchivedChat}
                onRestoreChat={onRestoreChat}
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

          <MachineSwitcher />
        <div className={cn("border-t border-border p-2", isStandalone && "pb-[55px]")}>
          <button
            type="button"
            onClick={() => {
              navigate("/settings/general")
              onClose()
            }}
            className={cn(
              "w-full rounded-xl rounded-t-md border px-3 py-2 text-left transition-colors",
              isSettingsActive
                ? "bg-muted border-border"
                : "border-border/0 hover:bg-muted hover:border-border active:bg-muted/80"
            )}
          >
            <div className="flex items- justify-between gap-2">
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-muted-foreground" />
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

      <Dialog
        open={Boolean(archivedProject)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setArchivedProjectId(null)
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Archived Chats</DialogTitle>
            <DialogDescription>
              {archivedProject?.localPath ?? ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1">
            {archivedProject?.archivedChats?.length ? (
              archivedProject.archivedChats.map((chat) => (
                <button
                  key={chat.chatId}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/0 px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted"
                  onClick={() => {
                    onOpenArchivedChat(chat.chatId)
                    setArchivedProjectId(null)
                    onClose()
                  }}
                >
                  <span className="min-w-0 truncate text-sm">{chat.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSidebarAgeLabel(getSidebarChatTimestamp(chat), nowMs)}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-1 py-3 text-sm text-muted-foreground">No archived chats</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {open ? <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={onClose} /> : null}
    </>
  )
}

export const KannaSidebar = memo(KannaSidebarImpl)

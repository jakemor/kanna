import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Download, Flower, PanelLeft, X, Menu, Plus, Settings } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { Button } from "../components/ui/button"
import { useAppDialog } from "../components/ui/app-dialog"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog"
import { formatSidebarAgeLabel, getPathBasename } from "../lib/formatters"
import { getSidebarChatTimestamp } from "../lib/sidebarChats"
import { cn } from "../lib/utils"
import { ChatRow } from "../components/chat-ui/sidebar/ChatRow"
import { LocalProjectsSection } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { StacksSection } from "../components/chat-ui/sidebar/StacksSection"
import { StackCreatePanel } from "../components/chat-ui/sidebar/StackCreatePanel"
import { StackChatCreateRow } from "../components/chat-ui/sidebar/StackChatCreateRow"
import { getResolvedKeybindings } from "../lib/keybindings"
import type { GitWorktree, KeybindingsSnapshot, SidebarData, SidebarChatRow, SidebarProjectGroup, StackBinding, UpdateSnapshot } from "../../shared/types"
import type { SocketStatus } from "./socket"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"

const SIDEBAR_WIDTH_STORAGE_KEY = "kanna:sidebar-width"
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

interface KannaSidebarProps {
  data: SidebarData
  activeChatId: string | null
  connectionStatus: SocketStatus
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
  onDeleteChat: (chat: SidebarChatRow) => void
  onEditChatPermissions?: (chatId: string) => void
  onOpenAddProjectModal: () => void
  onImportClaudeSessions?: () => Promise<void>
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onHideProject: (projectId: string) => void
  onToggleStar: (projectId: string, starred: boolean) => void
  onReorderProjectGroups: (projectIds: string[]) => void
  onCreateStack: (title: string, projectIds: string[]) => void
  onRenameStack: (stackId: string, title: string) => void
  onRemoveStack: (stackId: string) => void
  onCreateStackChat: (primaryProjectId: string, stackId: string, stackBindings: StackBinding[]) => void
  onListStackWorktrees: (projectId: string) => Promise<GitWorktree[]>
  editorLabel: string
  updateSnapshot: UpdateSnapshot | null
}

function KannaSidebarImpl({
  data,
  activeChatId,
  connectionStatus,
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
  onDeleteChat,
  onEditChatPermissions,
  onOpenAddProjectModal,
  onImportClaudeSessions,
  onCopyPath,
  onOpenExternalPath,
  onHideProject,
  onToggleStar,
  onReorderProjectGroups,
  onCreateStack,
  onRenameStack,
  onRemoveStack,
  onCreateStackChat,
  onListStackWorktrees,
  editorLabel,
  updateSnapshot,
}: KannaSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const initializedCollapsedGroupKeysRef = useRef<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [showNumberJumpHints, setShowNumberJumpHints] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const [expandedStackIds, setExpandedStackIds] = useState<Set<string>>(new Set())
  const [stackCreatePanelOpen, setStackCreatePanelOpen] = useState(false)
  const [stackEditId, setStackEditId] = useState<string | null>(null)
  const [stackDeleteConfirmId, setStackDeleteConfirmId] = useState<string | null>(null)
  const [stackChatCreateId, setStackChatCreateId] = useState<string | null>(null)
  const [stackChatWorktrees, setStackChatWorktrees] = useState<Map<string, GitWorktree[]>>(new Map())
  const [stackChatLoading, setStackChatLoading] = useState(false)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])

  const stackChats = useMemo(() => {
    const out: SidebarChatRow[] = []
    for (const group of data.projectGroups) {
      for (const chat of group.chats) {
        if (chat.stackId) out.push(chat)
      }
    }
    return out
  }, [data.projectGroups])

  const stripStackChats = useCallback((groups: SidebarProjectGroup[]) => {
    return groups.map((group) => {
      const chats = group.chats.filter((c) => !c.stackId)
      if (chats.length === group.chats.length) return group
      const previewChats = group.previewChats.filter((c) => !c.stackId)
      const olderChats = group.olderChats.filter((c) => !c.stackId)
      return { ...group, chats, previewChats, olderChats }
    })
  }, [])

  const starredProjectGroupsWithoutStackChats = useMemo(
    () => stripStackChats(data.starredProjectGroups),
    [data.starredProjectGroups, stripStackChats]
  )

  const projectGroupsWithoutStackChats = useMemo(
    () => stripStackChats(data.projectGroups),
    [data.projectGroups, stripStackChats]
  )

  const visibleChats = useMemo(
    () => getVisibleSidebarChats(
      [...starredProjectGroupsWithoutStackChats, ...projectGroupsWithoutStackChats],
      collapsedSections,
      expandedGroups
    ),
    [collapsedSections, starredProjectGroupsWithoutStackChats, projectGroupsWithoutStackChats, expandedGroups]
  )
  const visibleChatsRef = useRef(visibleChats)
  const visibleIndexByChatId = useMemo(
    () => new Map(visibleChats.map((entry) => [entry.chat.chatId, entry.visibleIndex])),
    [visibleChats]
  )

  const stackProjects = useMemo(
    () => data.projectGroups.map((group) => ({ id: group.groupKey, title: getPathBasename(group.localPath) })),
    [data.projectGroups]
  )

  const handleStartStackChat = useCallback(async (stackId: string) => {
    const stack = data.stacks.find((s) => s.id === stackId)
    if (!stack) return
    setStackChatCreateId(stackId)
    setStackChatLoading(true)
    try {
      const entries = await Promise.all(
        stack.projectIds.map(async (projectId) => [projectId, await onListStackWorktrees(projectId)] as const)
      )
      setStackChatWorktrees(new Map(entries))
    } finally {
      setStackChatLoading(false)
    }
  }, [data.stacks, onListStackWorktrees])

  const closeStackChatCreate = useCallback(() => {
    setStackChatCreateId(null)
    setStackChatWorktrees(new Map())
  }, [])

  const projectIdByPath = useMemo(
    () => new Map([...data.starredProjectGroups, ...data.projectGroups].map((group) => [group.localPath, group.groupKey])),
    [data.starredProjectGroups, data.projectGroups]
  )

  const activeVisibleCount = visibleChats.length
  const archivedProject = useMemo(
    () => [...data.starredProjectGroups, ...data.projectGroups].find((group) => group.groupKey === archivedProjectId) ?? null,
    [archivedProjectId, data.starredProjectGroups, data.projectGroups]
  )

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  useEffect(() => {
    setCollapsedSections((previous) => {
      const next = new Set<string>()
      const allGroups = [...data.starredProjectGroups, ...data.projectGroups]
      const projectKeys = new Set(allGroups.map((group) => group.groupKey))
      const initializedKeys = initializedCollapsedGroupKeysRef.current

      for (const key of previous) {
        if (projectKeys.has(key)) {
          next.add(key)
        }
      }

      initializedCollapsedGroupKeysRef.current = new Set(
        [...initializedKeys].filter((key) => projectKeys.has(key))
      )

      for (const group of allGroups) {
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
  }, [data.starredProjectGroups, data.projectGroups])

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
        onSelectChat={(chatId) => {
          navigate(`/chat/${chatId}`)
          onClose()
        }}
        onRenameChat={() => onRenameChat(chat)}
        onShareChat={() => onShareChat(chat.chatId)}
        onOpenInFinder={() => onOpenExternalPath("open_finder", chat.localPath)}
        onForkChat={() => onForkChat(chat)}
        onArchiveChat={() => onArchiveChat(chat)}
        onDeleteChat={() => onDeleteChat(chat)}
        onEditPermissions={onEditChatPermissions}
      />
    )
  }, [activeChatId, navigate, nowMs, onArchiveChat, onClose, onDeleteChat, onEditChatPermissions, onForkChat, onOpenExternalPath, onRenameChat, onShareChat, resolvedKeybindings, showNumberJumpHints, visibleIndexByChatId])

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
        navigate("/")
        onClose()
        onOpenAddProjectModal()
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "newStack", event)) {
        event.preventDefault()
        setStackCreatePanelOpen(true)
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "newStackChat", event)) {
        event.preventDefault()
        // TODO: open stack chat creation for the first stack if any
        // For now just ensure the binding is registered
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
  }, [currentProjectId, navigate, onClose, onCreateChat, onOpenAddProjectModal, resolvedKeybindings])

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

  const [isImporting, setIsImporting] = useState(false)
  const dialog = useAppDialog()

  const handleImport = useCallback(async () => {
    if (isImporting || !onImportClaudeSessions) return
    const confirmed = await dialog.confirm({
      title: "Import Claude sessions",
      description: "Scan ~/.claude/projects/ and import all sessions into Kanna? Already-imported sessions are skipped.",
      confirmLabel: "Import",
    })
    if (!confirmed) return
    setIsImporting(true)
    try {
      await onImportClaudeSessions()
    } catch (error) {
      console.error("[kanna/import] failed", error)
    } finally {
      setIsImporting(false)
    }
  }, [dialog, isImporting, onImportClaudeSessions])

  const hasVisibleChats = activeVisibleCount > 0
  const isLocalProjectsActive = location.pathname === "/"
  const isSettingsActive = location.pathname.startsWith("/settings")
  const isUtilityPageActive = isLocalProjectsActive || isSettingsActive
  const isConnecting = connectionStatus === "connecting"
  const statusLabel = isConnecting ? "Connecting" : connectionStatus === "connected" ? "Connected" : "Disconnected"
  const statusDotClass = connectionStatus === "connected" ? "bg-success" : "bg-warning"
  const showDevBadge = updateSnapshot
    ? updateSnapshot.latestVersion === `${updateSnapshot.currentVersion}-dev`
    : false

  return (
    <>
      {!open && showMobileOpenButton && (
        <Button
          variant="ghost"
          size="icon-mobile"
          aria-label="Open sidebar"
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
              aria-label="Expand sidebar"
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
          "md:relative md:inset-auto md:w-[var(--sidebar-width)] md:mr-0 md:h-[calc(100%-16px)] md:my-2 md:ml-2 md:border md:border-border md:rounded-2xl",
          open ? "flex" : "hidden md:flex",
          collapsed && "md:hidden"
        )}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="px-[5px] h-[64px] max-h-[64px] md:h-[55px] md:max-h-[55px] border-b grid grid-cols-[40px_minmax(0,1fr)_40px] items-center md:px-[7px] md:pl-3 md:flex md:justify-between">
          <div className="md:hidden">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 rounded-lg hover:!border-border/0"
              onClick={onClose}
              title="Close sidebar"
              aria-label="Close sidebar"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div className="flex items-center justify-self-center gap-2 md:justify-self-auto">
            <button
              type="button"
              onClick={onCollapse}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              className="hidden md:flex group/sidebar-collapse relative items-center justify-center h-5 w-5 sm:h-6 sm:w-6"
            >
              <Flower className="absolute inset-0.5 h-4 w-4 sm:h-5 sm:w-5 text-logo transition-all duration-200 ease-out opacity-100 scale-100 group-hover/sidebar-collapse:opacity-0 group-hover/sidebar-collapse:scale-0" />
              <PanelLeft className="absolute inset-0 h-4 w-4 sm:h-6 sm:w-6 text-muted-foreground transition-all duration-200 ease-out opacity-0 scale-0 group-hover/sidebar-collapse:opacity-100 group-hover/sidebar-collapse:scale-80 hover:opacity-50" />
            </button>
            <Flower className="h-5 w-5 sm:h-6 sm:w-6 text-logo md:hidden" />
            <span className="font-logo text-base sm:text-md text-foreground">{APP_NAME}</span>
          </div>
          <div className="flex items-center justify-self-end md:justify-self-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                navigate("/")
                onClose()
              }}
              className="size-10 rounded-lg hover:!border-border/0 md:hidden"
              title="New project"
              aria-label="New project"
            >
              <Plus className="h-5 w-5" />
            </Button>
            {showDevBadge ? (
              <span
                className="mr-1 hidden md:inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-bold tracking-wider text-muted-foreground"
                title="Development build"
              >
                DEV
              </span>
            ) : null}
            {onImportClaudeSessions ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleImport()}
                disabled={isImporting}
                className="inline-flex size-10 rounded-lg hover:!border-border/0"
                title="Import Claude Code sessions"
                aria-label="Import Claude Code sessions"
              >
                <Download className="size-4" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                navigate("/")
                onClose()
              }}
              className="hidden md:inline-flex size-10 rounded-lg hover:!border-border/0"
              title="New project"
              aria-label="New project"
            >
              <Plus className="size-4" />
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
            {!hasVisibleChats && data.projectGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground p-2 mt-6 text-center">No conversations yet</p>
            ) : null}

            <StacksSection
              stacks={data.stacks}
              projects={stackProjects}
              expandedStackIds={expandedStackIds}
              onToggleExpanded={(stackId) => setExpandedStackIds((prev) => {
                const next = new Set(prev)
                if (next.has(stackId)) next.delete(stackId)
                else next.add(stackId)
                return next
              })}
              onOpenCreatePanel={() => setStackCreatePanelOpen(true)}
              onOpenStackMenu={(stackId) => {
                setStackEditId(stackId)
                setStackCreatePanelOpen(true)
              }}
              onDeleteStack={(stackId) => setStackDeleteConfirmId(stackId)}
              onStartChat={(stackId) => { void handleStartStackChat(stackId) }}
              renderChatCreate={(stack) => {
                if (stack.id !== stackChatCreateId) return null
                if (stackChatLoading) return <p className="text-xs text-muted-foreground">Loading worktrees…</p>
                const rowProjects = stack.projectIds.map((pid) => ({
                  id: pid,
                  title: stackProjects.find((p) => p.id === pid)?.title ?? pid,
                  worktrees: stackChatWorktrees.get(pid) ?? [],
                }))
                return (
                  <StackChatCreateRow
                    stack={stack}
                    projects={rowProjects}
                    onCreate={async ({ primaryProjectId, stackBindings }) => {
                      onCreateStackChat(primaryProjectId, stack.id, stackBindings)
                      closeStackChatCreate()
                    }}
                    onCancel={closeStackChatCreate}
                  />
                )
              }}
              renderChatRow={renderChatRow}
              chats={stackChats}
            />

            {stackCreatePanelOpen && (
              <StackCreatePanel
                mode={stackEditId ? "edit" : "create"}
                projects={stackProjects}
                initialProjectIds={stackEditId ? (data.stacks.find(s => s.id === stackEditId)?.projectIds ?? []) : []}
                initialTitle={stackEditId ? (data.stacks.find(s => s.id === stackEditId)?.title ?? "") : ""}
                onSubmit={async (title, projectIds) => {
                  if (stackEditId) {
                    onRenameStack(stackEditId, title)
                  } else {
                    onCreateStack(title, projectIds)
                  }
                  setStackCreatePanelOpen(false)
                  setStackEditId(null)
                }}
                onCancel={() => {
                  setStackCreatePanelOpen(false)
                  setStackEditId(null)
                }}
              />
            )}

            {stackDeleteConfirmId && (() => {
              const stack = data.stacks.find(s => s.id === stackDeleteConfirmId)
              if (!stack) return null
              return (
                <div className="px-2.5 py-2 border border-destructive/50 rounded-lg bg-background mx-2 my-1">
                  <p className="text-xs text-destructive mb-2">Delete "{stack.title}"?</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => { onRemoveStack(stackDeleteConfirmId); setStackDeleteConfirmId(null) }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
                      onClick={() => setStackDeleteConfirmId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )
            })()}

            {starredProjectGroupsWithoutStackChats.length > 0 && (
              <>
                <LocalProjectsSection
                  projectGroups={starredProjectGroupsWithoutStackChats}
                  editorLabel={editorLabel}
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
                  onHideProject={onHideProject}
                  onToggleStar={onToggleStar}
                  isConnected={connectionStatus === "connected"}
                />
                {data.projectGroups.length > 0 && (
                  <div className="mx-3 my-1 border-t border-border/50" />
                )}
              </>
            )}

            <LocalProjectsSection
              projectGroups={projectGroupsWithoutStackChats}
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
              onHideProject={onHideProject}
              onToggleStar={onToggleStar}
              isConnected={connectionStatus === "connected"}
            />
          </div>
        </div>

        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => {
              navigate("/settings/general")
              onClose()
            }}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors duration-150 rounded-none",
              isSettingsActive
                ? "bg-muted"
                : "hover:bg-muted/50"
            )}
          >
            <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm flex-1">Settings</span>
          </button>
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
            <span
              className={cn("h-1.5 w-1.5 rounded-full shrink-0", statusDotClass)}
              aria-hidden
            />
            <span className="text-[11px] text-muted-foreground tabular-nums">{statusLabel}</span>
          </div>
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

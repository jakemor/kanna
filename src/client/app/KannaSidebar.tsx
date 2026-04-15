import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Flower, Loader2, PanelLeft, X, Menu, Plus, Settings } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { Button } from "../components/ui/button"
import { shouldDefaultCollapseSidebarProject } from "../lib/sidebarChats"
import { cn } from "../lib/utils"
import { ChatRow } from "../components/chat-ui/sidebar/ChatRow"
import { LocalProjectsSection } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { getResolvedKeybindings } from "../lib/keybindings"
import type { KeybindingsSnapshot, SidebarData, SidebarChatRow, UpdateSnapshot } from "../../shared/types"
import type { SocketStatus } from "./socket"
import { useProjectGroupOrderStore } from "../stores/projectGroupOrderStore"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"

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
  currentProjectId: string | null
  keybindings: KeybindingsSnapshot | null
  onDeleteChat: (chat: SidebarChatRow) => void
  onOpenAddProjectModal: () => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onRemoveProject: (projectId: string) => void
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
  currentProjectId,
  keybindings,
  onDeleteChat,
  onOpenAddProjectModal,
  onCopyPath,
  onOpenExternalPath,
  onRemoveProject,
  editorLabel,
  updateSnapshot,
  onOpenChangelog,
}: KannaSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const initializedCollapsedGroupKeysRef = useRef<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [showNumberJumpHints, setShowNumberJumpHints] = useState(false)
  const chatsPerProject = 10
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])

  const savedOrder = useProjectGroupOrderStore((s) => s.order)
  const setGroupOrder = useProjectGroupOrderStore((s) => s.setOrder)

  const orderedProjectGroups = useMemo(() => {
    if (savedOrder.length === 0) return data.projectGroups

    const groupMap = new Map(data.projectGroups.map((g) => [g.groupKey, g]))
    const ordered = savedOrder
      .filter((key) => groupMap.has(key))
      .map((key) => groupMap.get(key)!)

    const orderedKeys = new Set(savedOrder)
    for (const group of data.projectGroups) {
      if (!orderedKeys.has(group.groupKey)) ordered.push(group)
    }

    return ordered
  }, [data.projectGroups, savedOrder])
  const handleReorderGroups = useCallback(
    (newOrder: string[]) => setGroupOrder(newOrder),
    [setGroupOrder]
  )
  const visibleChats = useMemo(
    () => getVisibleSidebarChats(orderedProjectGroups, collapsedSections, expandedGroups, chatsPerProject, nowMs),
    [chatsPerProject, collapsedSections, expandedGroups, nowMs, orderedProjectGroups]
  )
  const visibleIndexByChatId = useMemo(
    () => new Map(visibleChats.map((entry) => [entry.chat.chatId, entry.visibleIndex])),
    [visibleChats]
  )

  const projectIdByPath = useMemo(
    () => new Map(data.projectGroups.map((group) => [group.localPath, group.groupKey])),
    [data.projectGroups]
  )

  const activeVisibleCount = visibleChats.length

  useEffect(() => {
    setCollapsedSections((previous) => {
      const next = new Set<string>()
      const projectKeys = new Set(orderedProjectGroups.map((group) => group.groupKey))
      const initializedKeys = initializedCollapsedGroupKeysRef.current

      for (const key of previous) {
        if (projectKeys.has(key)) {
          next.add(key)
        }
      }

      initializedCollapsedGroupKeysRef.current = new Set(
        [...initializedKeys].filter((key) => projectKeys.has(key))
      )

      for (const group of orderedProjectGroups) {
        if (initializedCollapsedGroupKeysRef.current.has(group.groupKey)) continue
        initializedCollapsedGroupKeysRef.current.add(group.groupKey)
        if (shouldDefaultCollapseSidebarProject(group.chats, nowMs)) {
          next.add(group.groupKey)
        }
      }

      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous
      }

      return next
    })
  }, [nowMs, orderedProjectGroups])

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
        onDeleteChat={() => onDeleteChat(chat)}
      />
    )
  }, [activeChatId, navigate, nowMs, onClose, onDeleteChat, resolvedKeybindings, showNumberJumpHints, visibleIndexByChatId])

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

      const targetIndex = getSidebarJumpTargetIndex(resolvedKeybindings, event)
      if (targetIndex === null) {
        return
      }

      const targetChat = visibleChats[targetIndex - 1]?.chat
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
  }, [currentProjectId, navigate, onClose, onCreateChat, onOpenAddProjectModal, resolvedKeybindings, visibleChats])

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
  }, [activeChatId, activeVisibleCount])

  const hasVisibleChats = activeVisibleCount > 0
  const isLocalProjectsActive = location.pathname === "/"
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
          "md:relative md:inset-auto md:w-[275px] md:mr-0 md:h-[calc(100dvh-16px)] md:my-2 md:ml-2 md:border md:border-border md:rounded-2xl",
          open ? "flex" : "hidden md:flex",
          collapsed && "md:hidden"
        )}
      >
        <div className=" pl-3 pr-[7px] h-[64px] max-h-[64px] md:h-[55px] md:max-h-[55px] border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
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
          <div className="flex items-center">
            {showDevBadge ? (
              <span
                className="mr-1 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-bold tracking-wider text-muted-foreground"
                title="Development build"
              >
                DEV
              </span>
            ) : showUpdateButton ? (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full !h-auto mr-1 py-0.5 px-2 bg-logo/20 hover:bg-logo text-logo border-logo/20 hover:text-foreground hover:border-logo/20  text-[11px] font-bold tracking-wider"
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
              onClick={() => {
                navigate("/")
                onClose()
              }}
              className="size-10 rounded-lg hover:!border-border/0"
              title="New project"
            >
              <Plus className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={onClose}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto scrollbar-hide"
          style={{ WebkitOverflowScrolling: "touch" }}
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

            <LocalProjectsSection
              projectGroups={orderedProjectGroups}
              editorLabel={editorLabel}
              onReorderGroups={handleReorderGroups}
              collapsedSections={collapsedSections}
              expandedGroups={expandedGroups}
              onToggleSection={toggleSection}
              onToggleExpandedGroup={toggleExpandedGroup}
              renderChatRow={renderChatRow}
              chatsPerProject={chatsPerProject}
              nowMs={nowMs}
              onNewLocalChat={(localPath) => {
                const projectId = projectIdByPath.get(localPath)
                if (projectId) {
                  onCreateChat(projectId)
                }
              }}
              onCopyPath={onCopyPath}
              onOpenExternalPath={onOpenExternalPath}
              onRemoveProject={onRemoveProject}
              isConnected={connectionStatus === "connected"}
            />
          </div>
        </div>

        <div className="border-t border-border p-2">
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
      </div>

      {open ? <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={onClose} /> : null}
    </>
  )
}

export const KannaSidebar = memo(KannaSidebarImpl)

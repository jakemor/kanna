import { CornerDownLeft, Ellipsis, ExternalLink, Globe, Home, Minus, Play, Plus, RefreshCw, SquareArrowOutUpRight, Trash2, Zap } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState, type FocusEvent, type FormEvent, type ReactNode } from "react"
import type { LocalHttpServerInfo, ProjectQuickAction } from "../../../shared/protocol"
import type { KannaSocket } from "../../app/socket"
import {
  getCachedLocalHttpServers,
  getCachedProjectQuickActions,
  refreshCachedLocalHttpServers,
  refreshCachedProjectQuickActions,
  removeCachedLocalHttpServer,
  writeCachedProjectQuickActions,
} from "../../lib/browserPanelCache"
import { formatPathWithTilde } from "../../lib/pathUtils"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import { openContextMenuFromButton } from "../open-external-menu"
import { Button } from "../ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"
import { Input } from "../ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

interface BrowserPanelProps {
  projectId: string
  socket: KannaSocket
  onClose: () => void
  onRunQuickAction: (command: string) => void
}

function BrowserToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="none"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-8 w-8 shrink-0 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground disabled:opacity-40"
    >
      {children}
    </Button>
  )
}

function BrowserPanelImpl({ projectId, socket, onRunQuickAction }: BrowserPanelProps) {
  const browserState = useRightSidebarStore((store) => store.projectBrowser[projectId])
  const navigateBrowser = useRightSidebarStore((store) => store.navigateBrowser)
  const setBrowserZoom = useRightSidebarStore((store) => store.setBrowserZoom)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const address = browserState?.address ?? ""
  const zoom = browserState?.zoom ?? 1
  const [addressDraft, setAddressDraft] = useState(address)
  const [iframeVersion, setIframeVersion] = useState(0)
  const [localServers, setLocalServers] = useState<LocalHttpServerInfo[]>(() => getCachedLocalHttpServers() ?? [])
  const [isLoadingServers, setIsLoadingServers] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [quickActions, setQuickActions] = useState<ProjectQuickAction[]>(() => getCachedProjectQuickActions(projectId) ?? [])
  const [quickActionsError, setQuickActionsError] = useState<string | null>(null)
  const [newQuickActionCommand, setNewQuickActionCommand] = useState("")
  const [isAddingQuickAction, setIsAddingQuickAction] = useState(false)
  const [isZoomTooltipOpen, setIsZoomTooltipOpen] = useState(false)
  const [showOtherServers, setShowOtherServers] = useState(false)
  const postRunRefreshTimeoutsRef = useRef<number[]>([])
  const projectServers = localServers.filter((server) => server.sameProject)
  const otherServers = localServers.filter((server) => !server.sameProject)
  const shouldAutoShowOtherServers = projectServers.length === 0
  const shouldShowOtherServers = showOtherServers || shouldAutoShowOtherServers
  const visibleServers = shouldShowOtherServers ? localServers : projectServers

  const refreshLocalServers = useCallback((options: { silent?: boolean } = {}) => {
    const hasCachedServers = getCachedLocalHttpServers() !== null
    if (!options.silent) {
      setIsLoadingServers(true)
    }
    setServerError(null)
    void refreshCachedLocalHttpServers(socket, projectId)
      .then(setLocalServers)
      .catch((error) => setServerError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        if (!options.silent || !hasCachedServers) {
          setIsLoadingServers(false)
        }
      })
  }, [projectId, socket])

  const killServer = useCallback((server: LocalHttpServerInfo) => {
    setLocalServers(removeCachedLocalHttpServer(server.port))
    void socket.command({ type: "browser.killLocalHttpServer", port: server.port })
      .then(() => refreshLocalServers({ silent: true }))
      .catch((error) => setServerError(error instanceof Error ? error.message : String(error)))
  }, [refreshLocalServers, socket])

  const writeQuickActions = useCallback((actions: ProjectQuickAction[]) => {
    setQuickActions(actions)
    setQuickActionsError(null)
    void writeCachedProjectQuickActions(socket, projectId, actions)
      .then(setQuickActions)
      .catch((error) => setQuickActionsError(error instanceof Error ? error.message : String(error)))
  }, [projectId, socket])

  const addQuickAction = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const command = newQuickActionCommand.trim()
    if (!command) return
    writeQuickActions([
      ...quickActions,
      {
        id: globalThis.crypto?.randomUUID?.() ?? `quick-action-${Date.now()}`,
        label: command,
        command,
      },
    ])
    setNewQuickActionCommand("")
    setIsAddingQuickAction(false)
  }, [newQuickActionCommand, quickActions, writeQuickActions])

  const deleteQuickAction = useCallback((actionId: string) => {
    writeQuickActions(quickActions.filter((action) => action.id !== actionId))
  }, [quickActions, writeQuickActions])

  const handleQuickActionComposerBlur = useCallback((event: FocusEvent<HTMLFormElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setIsAddingQuickAction(false)
  }, [])

  const runQuickAction = useCallback((command: string) => {
    onRunQuickAction(command)
    postRunRefreshTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
    postRunRefreshTimeoutsRef.current = [1_000, 2_000].map((delay) => window.setTimeout(() => {
      refreshLocalServers({ silent: true })
    }, delay))
  }, [onRunQuickAction, refreshLocalServers])

  useEffect(() => {
    setAddressDraft(address)
  }, [address])

  useEffect(() => {
    if (address) return
    const cachedServers = getCachedLocalHttpServers()
    if (cachedServers) {
      setLocalServers(cachedServers)
    } else {
      setLocalServers([])
    }
    refreshLocalServers({ silent: Boolean(cachedServers) })
  }, [address, refreshLocalServers])

  useEffect(() => {
    const cachedQuickActions = getCachedProjectQuickActions(projectId)
    if (cachedQuickActions) {
      setQuickActions(cachedQuickActions)
    } else {
      setQuickActions([])
    }
    setQuickActionsError(null)
    void refreshCachedProjectQuickActions(socket, projectId)
      .then(setQuickActions)
      .catch((error) => setQuickActionsError(error instanceof Error ? error.message : String(error)))
  }, [projectId, socket])

  useEffect(() => {
    if (address) return

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      refreshLocalServers({ silent: true })
    }, 7_000)

    return () => window.clearInterval(intervalId)
  }, [address, refreshLocalServers])

  useEffect(() => {
    return () => {
      postRunRefreshTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
      postRunRefreshTimeoutsRef.current = []
    }
  }, [])

  const quickActionsSection = (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 pl-1 text-sm font-medium mb-3">
        <Zap className="h-4 w-4 text-muted-foreground" />
        <span>Quick Actions</span>
        <Button
          type="button"
          variant="ghost"
          size="none"
          aria-label="Add quick action"
          title="Add quick action"
          onClick={() => setIsAddingQuickAction((current) => !current)}
          className="ml-auto h-6 w-6 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {isAddingQuickAction ? (
        <form
          onSubmit={addQuickAction}
          onBlur={handleQuickActionComposerBlur}
          className="relative flex h-[42px] min-w-0 items-center rounded-xl border border-border/70 px-3"
        >
          <Input
            value={newQuickActionCommand}
            onChange={(event) => setNewQuickActionCommand(event.target.value)}
            placeholder="bun run dev"
            className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 pr-10 text-sm font-medium shadow-none outline-none  focus-visible:ring-0 focus-visible:ring-offset-0"
            autoFocus
          />
          <Button
            type="submit"
            variant="ghost"
            size="none"
            disabled={!newQuickActionCommand.trim()}
            className="absolute right-1.5 top-1/2 h-6 -translate-y-1/2 rounded-md px-2 text-xs text-muted-foreground hover:!bg-muted/40 hover:text-foreground"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </Button>
        </form>
      ) : null}
      {quickActionsError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {quickActionsError}
        </div>
      ) : null}
      {quickActions.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
          No quick actions.
        </div>
      ) : (
        quickActions.map((action) => (
          <ContextMenu key={action.id}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                onClick={() => runQuickAction(action.command)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  runQuickAction(action.command)
                }}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-border/70 px-3 pr-[10px] py-2 outline-none hover:bg-muted/40 focus-visible:outline-none active:outline-none"
                title={action.command}
              >
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">
                  {action.label}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="none"
                  aria-label="Run quick action"
                  title="Run quick action"
                  onClick={(event) => {
                    event.stopPropagation()
                    runQuickAction(action.command)
                  }}
                  className="h-6 w-6 shrink-0 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground"
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  deleteQuickAction(action.id)
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))
      )}
    </div>
  )

  function handleAddressSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    navigateBrowser(projectId, addressDraft)
  }

  function handleRefresh() {
    if (!address) {
      refreshLocalServers()
      return
    }
    setIframeVersion((current) => current + 1)
  }

  return (
    <div className="h-full min-h-0 border-l border-border bg-background md:min-w-[370px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
          <BrowserToolbarButton label="Home" onClick={() => navigateBrowser(projectId, "")}>
            <Home className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton label="Refresh" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4" />
          </BrowserToolbarButton>
          <form onSubmit={handleAddressSubmit} className="group relative min-w-0 flex-1">
            <Input
              value={addressDraft}
              onChange={(event) => setAddressDraft(event.target.value)}
              placeholder="Enter a URL"
              className="h-7 rounded-[9px] px-[28px] text-xs text-muted-foreground focus:text-foreground hover:text-foreground  text-center border-border/0 bg-background hover:bg-card focus:bg-card hover:border-border/50 focus:border-border/50 transition-all"
            />
            {address ? (
              <Button
                type="button"
                variant="ghost"
                size="none"
                title="Open external"
                aria-label="Open external"
                onClick={() => window.open(address, "_blank", "noopener,noreferrer")}
                className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 border-border/0 text-muted-foreground opacity-0 hover:!border-border/0 hover:!bg-transparent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </form>
          <Tooltip open={isZoomTooltipOpen}>
            <TooltipTrigger asChild>
              <div
                className="flex shrink-0 items-center gap-0"
                onMouseEnter={() => setIsZoomTooltipOpen(true)}
                onMouseLeave={() => setIsZoomTooltipOpen(false)}
                onFocus={() => setIsZoomTooltipOpen(true)}
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget)) return
                  setIsZoomTooltipOpen(false)
                }}
              >
                <BrowserToolbarButton label="Zoom out" onClick={() => setBrowserZoom(projectId, zoom - 0.1)}>
                  <Minus className="h-4 w-4" />
                </BrowserToolbarButton>
                <BrowserToolbarButton label="Zoom in" onClick={() => setBrowserZoom(projectId, zoom + 0.1)}>
                  <Plus className="h-4 w-4" />
                </BrowserToolbarButton>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {Math.round(zoom * 100)}%
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {!address ? (
            <div className="h-full overflow-y-auto p-3 ">
              <div className="h-full mx-auto max-w-[450px] flex flex-col" style={{justifyContent: "safe center"}}>
              <div className="pl-1 mb-3 flex items-center gap-2 text-sm font-medium">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span>Local Servers</span>
              </div>
              <div className="space-y-4">
                {serverError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {serverError}
                  </div>
                ) : isLoadingServers ? (
                  <div className="space-y-1.5 animate-pulse">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className="flex w-full min-w-0 flex-col rounded-md border border-border/70 px-3 py-2">
                        <div className="flex w-full min-w-0 items-center gap-2">
                          <div className={row === 1 ? "h-4 w-36 rounded bg-muted" : "h-4 w-28 rounded bg-muted"} />
                          <div className="h-1.5 w-1.5 rounded-full bg-muted" />
                          <div className="ml-auto h-6 w-6 rounded bg-muted" />
                        </div>
                        <div className="mt-1.5 flex w-full min-w-0 items-center gap-3">
                          <div className={row === 2 ? "h-3 w-32 rounded bg-muted" : "h-3 w-40 rounded bg-muted"} />
                          <div className="ml-auto h-3 w-[42%] rounded bg-muted" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : localServers.length === 0 ? (
                  <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    No local HTTP servers found.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {visibleServers.map((server) => (
                      <ContextMenu key={server.address}>
                        <ContextMenuTrigger asChild>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => navigateBrowser(projectId, server.address)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return
                              event.preventDefault()
                              navigateBrowser(projectId, server.address)
                            }}
                            className="flex w-full min-w-0 cursor-pointer flex-col rounded-xl border border-border/70 px-3 py-1.5 pb-2.5 text-left outline-none hover:border-border hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            <span className="flex w-full min-w-0 items-center gap-2">
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span className="min-w-0 truncate text-sm font-medium text-foreground">{server.title}</span>
                                {server.sameProject ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" /> : null}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="none"
                                aria-label="Server actions"
                                title="Server actions"
                                onClick={openContextMenuFromButton}
                                className="!h-auto !w-auto shrink-0 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground"
                              >
                                <Ellipsis className="w-4" />
                              </Button>
                            </span>
                            <span className="flex w-full min-w-0 items-center gap-3">
                              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{server.address}</span>
                              {server.ownerPath ? (
                                <span className="max-w-[45%] shrink-0 truncate text-right text-[11px] text-muted-foreground/70">{formatPathWithTilde(server.ownerPath)}</span>
                              ) : null}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onSelect={(event) => {
                              event.preventDefault()
                              window.open(server.address, "_blank", "noopener,noreferrer")
                            }}
                          >
                            <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                            <span>Open in New Tab</span>
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={(event) => {
                              event.preventDefault()
                              killServer(server)
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Kill Process</span>
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                    {otherServers.length > 0 && !shouldAutoShowOtherServers ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="none"
                        onClick={() => setShowOtherServers((current) => !current)}
                        className="h-8 w-fit rounded-md px-2 text-xs text-muted-foreground hover:!bg-muted/40"
                      >
                        {showOtherServers ? "Hide other projects" : `Other projects (${otherServers.length})`}
                      </Button>
                    ) : null}
                  </div>
                )}
                {quickActionsSection}
                <div className="h-3"/>
              </div>
              </div>
            </div>
          ) : (
            <div className="h-full w-full overflow-auto bg-muted/20">
              <iframe
                ref={iframeRef}
                key={`${address}-${iframeVersion}`}
                src={address}
                title="Browser panel"
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                className="h-full w-full origin-top-left border-0 bg-background"
                style={{
                  width: `${100 / zoom}%`,
                  height: `${100 / zoom}%`,
                  transform: `scale(${zoom})`,
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const BrowserPanel = memo(BrowserPanelImpl)

import { Copy, Folder, Globe, GlobeLock, Layers, ListFilter, Loader2, RadioTower, SquareArrowOutUpRight, Trash2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { LocalHttpServerInfo } from "../../../../shared/protocol"
import type { KannaSocket } from "../../../app/socket"
import {
  getCachedLocalHttpServers,
  refreshCachedLocalHttpServers,
  removeCachedLocalHttpServer,
  setCachedLocalHttpServerPublicUrl,
} from "../../../lib/localServersCache"
import { formatPathWithTilde } from "../../../lib/pathUtils"
import { cn } from "../../../lib/utils"
import { useConnectionStore } from "../../../stores/connectionStore"
import { ContextMenuItem } from "../../ui/context-menu"
import { InputPopover, PopoverMenuItem } from "../ChatPreferenceControls"
import { WidgetError, WidgetList, WidgetRow } from "./parts"
import { useWidgetExpanded, WidgetCard, WidgetPresence } from "./WidgetCard"

const POLL_INTERVAL_MS = 7_000

/**
 * Local HTTP servers, opened in a new tab. Hidden while nothing is listening
 * anywhere; it stays mounted meanwhile, because it is what polls.
 *
 * Open by default with a few servers: with one dev server, its URL is the
 * whole point of the card, and a closed header would cost a click every time.
 */
export function PortsWidget({
  projectId,
  socket,
  active,
  refreshRequest,
}: {
  projectId: string
  socket: KannaSocket
  /** Polls only while the widget column is open. */
  active: boolean
  /**
   * Bumped when a quick action runs. A server it starts takes a moment to
   * bind its port, so this re-checks shortly after rather than waiting out
   * the poll.
   */
  refreshRequest: number
}) {
  const [servers, setServers] = useState<LocalHttpServerInfo[]>(() => getCachedLocalHttpServers() ?? [])
  const [loaded, setLoaded] = useState(() => getCachedLocalHttpServers() !== null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<"project" | "all">("project")
  const [exposingPorts, setExposingPorts] = useState<ReadonlySet<number>>(() => new Set())
  // In cloud mode the viewer's browser cannot reach localhost on the machine,
  // so a row opens through its cloudflared URL and exposes the port on demand.
  const connectionMode = useConnectionStore((store) => store.mode)
  const loadConnectionMode = useConnectionStore((store) => store.load)
  const isCloud = connectionMode === "cloud"
  const postRunRefreshTimeoutsRef = useRef<number[]>([])

  const projectServers = servers.filter((server) => server.sameProject)
  // This project's servers unless the filter says all: other projects'
  // belong to other work, and mixing them in unasked reads as if they were
  // this project's. With "all", they keep their grey dot and owner path.
  const visibleServers = scope === "all" ? servers : projectServers
  // An error holds the list open so it cannot hide behind a closed header.
  const [expanded, setExpanded] = useWidgetExpanded(projectId, "ports", visibleServers.length)

  const refreshServers = useCallback(() => {
    void refreshCachedLocalHttpServers(socket, projectId)
      .then((next) => {
        setServers(next)
        setError(null)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoaded(true))
  }, [projectId, socket])

  useEffect(() => {
    if (connectionMode === "unknown") void loadConnectionMode()
  }, [connectionMode, loadConnectionMode])

  useEffect(() => {
    if (!active) return
    refreshServers()
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshServers()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [active, refreshServers])

  useEffect(() => {
    if (refreshRequest === 0) return
    postRunRefreshTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
    postRunRefreshTimeoutsRef.current = [1_000, 2_000].map((delay) => window.setTimeout(refreshServers, delay))
  }, [refreshRequest, refreshServers])

  useEffect(() => () => {
    postRunRefreshTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
  }, [])

  const exposeServer = useCallback(async (server: LocalHttpServerInfo) => {
    if (server.publicUrl) return server.publicUrl
    setExposingPorts((current) => new Set(current).add(server.port))
    try {
      const result = await socket.command<{ port: number; publicUrl: string }>({
        type: "browser.exposeLocalHttpServer",
        port: server.port,
      })
      setServers(setCachedLocalHttpServerPublicUrl(server.port, result.publicUrl))
      return result.publicUrl
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return null
    } finally {
      setExposingPorts((current) => {
        const next = new Set(current)
        next.delete(server.port)
        return next
      })
    }
  }, [socket])

  const openServer = useCallback((server: LocalHttpServerInfo) => {
    if (!isCloud || server.publicUrl) {
      window.open(isCloud ? server.publicUrl : server.address, "_blank", "noopener,noreferrer")
      return
    }
    // Exposing takes a round trip, and a window opened after an await is no
    // longer a user gesture, so popup blockers eat it. Open the tab now and
    // point it at the tunnel once it exists.
    const tab = window.open("about:blank", "_blank")
    void exposeServer(server).then((publicUrl) => {
      if (!tab || tab.closed) return
      if (!publicUrl) {
        tab.close()
        return
      }
      tab.location.replace(publicUrl)
      // Cut the tunnelled page off from this one only now, in the same task
      // as the navigation, while the tab still holds our about:blank. Cut
      // first, and the browser no longer counts this page as the tab's
      // opener, refuses to navigate it, and leaves it blank.
      tab.opener = null
    })
  }, [exposeServer, isCloud])

  const killServer = useCallback((server: LocalHttpServerInfo) => {
    setServers(removeCachedLocalHttpServer(server.port))
    void socket.command({ type: "browser.killLocalHttpServer", port: server.port })
      .then(refreshServers)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [refreshServers, socket])

  const unexposeServer = useCallback((server: LocalHttpServerInfo) => {
    setServers(setCachedLocalHttpServerPublicUrl(server.port, undefined))
    void socket.command({ type: "browser.unexposeLocalHttpServer", port: server.port })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [socket])

  const otherServerCount = servers.length - projectServers.length

  return (
    <WidgetPresence show={error !== null || (loaded && servers.length > 0)}>
      {/* Nothing visible under the filter means just the header (and its
          filter), so no chevron. The count then says where the servers are,
          or the header would look broken. */}
      <WidgetCard
        icon={<RadioTower />}
        title="Ports"
        count={visibleServers.length > 0
          ? visibleServers.length
          : scope === "project" && otherServerCount > 0 ? `${otherServerCount} elsewhere` : undefined}
        expanded={(visibleServers.length > 0 && expanded) || error !== null}
        // With nothing here but servers elsewhere, the header is the way to
        // them: it widens the filter to all projects and opens the list,
        // rather than a count you'd have to find the filter to act on.
        onToggle={visibleServers.length > 0
          ? () => setExpanded(!expanded)
          : otherServerCount > 0
            ? () => {
              setScope("all")
              setExpanded(true)
            }
            : undefined}
        actions={(
          // The same filter popover as the left sidebar's New Chat row.
          <InputPopover
            align="end"
            triggerClassName={cn(
              "size-6 justify-center rounded-md p-0 hover:text-foreground",
              scope === "all" && "text-foreground",
            )}
            trigger={<ListFilter className="size-4 shrink-0" aria-label="Filter ports" />}
          >
            {(close) => (
              <>
                <PopoverMenuItem
                  onClick={() => {
                    close()
                    setScope("project")
                  }}
                  selected={scope === "project"}
                  icon={<Folder className="h-4 w-4" />}
                  label="This project"
                  description={`${projectServers.length} running`}
                />
                <PopoverMenuItem
                  onClick={() => {
                    close()
                    setScope("all")
                  }}
                  selected={scope === "all"}
                  icon={<Layers className="h-4 w-4" />}
                  label="All projects"
                  description={`${servers.length} running`}
                />
              </>
            )}
          </InputPopover>
        )}
      >
        {visibleServers.length > 0 || error ? (
          <WidgetList>
            {error ? <WidgetError>{error}</WidgetError> : null}
            {visibleServers.map(renderServer)}
          </WidgetList>
        ) : null}
      </WidgetCard>
    </WidgetPresence>
  )

  function renderServer(server: LocalHttpServerInfo) {
    const isExposing = exposingPorts.has(server.port)
    return (
      <WidgetRow
        key={server.address}
        icon={<span className={cn("size-1.5 rounded-full", server.sameProject ? "bg-success" : "bg-muted-foreground/40")} />}
        title={(
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{server.title}</span>
            {isExposing
              ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Exposing" />
              : server.publicUrl ? <Globe className="size-3 shrink-0 text-info" aria-label="Exposed to the internet" /> : null}
          </span>
        )}
        subtitle={(
          <>
            {isExposing ? "Exposing…" : server.publicUrl ?? server.address}
            {!server.sameProject && server.ownerPath ? ` · ${formatPathWithTilde(server.ownerPath)}` : ""}
          </>
        )}
        onActivate={() => openServer(server)}
        aria-busy={isExposing}
        menuLabel="Port actions"
        menu={(
          <>
            {/* The row's own open, so in cloud mode it exposes first rather
                than opening a localhost this browser can't reach. */}
            <ContextMenuItem onSelect={() => openServer(server)}>
              <SquareArrowOutUpRight className="size-3.5" />
              <span>Open in New Tab</span>
            </ContextMenuItem>
            {server.publicUrl ? (
              <>
                <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(server.publicUrl ?? "")}>
                  <Copy className="size-3.5" />
                  <span>Copy Public URL</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => unexposeServer(server)}>
                  <GlobeLock className="size-3.5" />
                  <span>Stop Exposing</span>
                </ContextMenuItem>
              </>
            ) : (
              <ContextMenuItem disabled={isExposing} onSelect={() => void exposeServer(server)}>
                <Globe className="size-3.5" />
                <span>Expose to Internet</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => killServer(server)} className="text-destructive focus:text-destructive">
              <Trash2 className="size-3.5" />
              <span>Kill Process</span>
            </ContextMenuItem>
          </>
        )}
      />
    )
  }
}

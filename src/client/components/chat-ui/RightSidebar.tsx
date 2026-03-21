import {
  startTransition,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  X,
  File as FileIcon,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react"
import type { FileTreeReadDirectoryResult } from "../../../shared/protocol"
import type { FileTreeEntry, FileTreeSnapshot } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"
import { Button } from "../ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"
import { ScrollArea } from "../ui/scroll-area"

const ROW_HEIGHT = 29
const ROW_OVERSCAN = 8
const INDENT_PX = 14
const DEFAULT_PAGE_SIZE = 200

interface RightSidebarProps {
  projectId: string | null
  isVisible: boolean
  socket: KannaSocket
  onOpenFile: (target: { path: string }) => Promise<void>
  onOpenInFinder: (path: string) => Promise<void>
  onClose: () => void
}

interface DirectoryState {
  entries: FileTreeEntry[]
  nextCursor: string | null
  hasMore: boolean
  error: string | null
  isLoading: boolean
  stale: boolean
}

type VisibleRow =
  | { key: string; type: "entry"; entry: FileTreeEntry; depth: number; isExpanded: boolean; isLoading: boolean }
  | { key: string; type: "load-more"; directoryPath: string; depth: number; isLoading: boolean }
  | { key: string; type: "error"; directoryPath: string; depth: number; message: string }

const EMPTY_DIRECTORY_STATE: DirectoryState = {
  entries: [],
  nextCursor: null,
  hasMore: false,
  error: null,
  isLoading: false,
  stale: false,
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "rst", "log", "env"])
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "php",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "sh",
  "zsh",
  "bash",
  "html",
  "css",
  "scss",
  "sql",
  "vue",
  "svelte",
])
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"])
const CONFIG_EXTENSIONS = new Set(["toml", "yaml", "yml", "ini", "conf"])
const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "xlsx"])
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z"])

type RightSidebarContentMode = "empty-project" | "empty-error" | "tree"

export function getRightSidebarContentMode(args: {
  projectId: string | null
  rootError: string | null
  rootEntryCount: number
}) : RightSidebarContentMode {
  if (!args.projectId) {
    return "empty-project"
  }

  if (args.rootError && args.rootEntryCount === 0) {
    return "empty-error"
  }

  return "tree"
}

export function RightSidebar({ projectId, isVisible, socket, onOpenFile, onOpenInFinder, onClose }: RightSidebarProps) {
  const [snapshot, setSnapshot] = useState<FileTreeSnapshot | null>(null)
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<Record<string, true>>({})
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requestVersionRef = useRef(new Map<string, number>())
  const expandedRef = useRef<Record<string, true>>({})
  const initializedProjectIdRef = useRef<string | null>(null)

  useEffect(() => {
    setSnapshot(null)
    setDirectories({})
    setExpanded({})
    expandedRef.current = {}
    initializedProjectIdRef.current = null
    setScrollTop(0)
  }, [projectId])

  const markStale = useEffectEvent((directoryPaths: string[]) => {
    setDirectories((current) => {
      let changed = false
      const next = { ...current }
      for (const directoryPath of directoryPaths) {
        const existing = next[directoryPath]
        if (!existing || existing.stale) continue
        next[directoryPath] = { ...existing, stale: true }
        changed = true
      }
      return changed ? next : current
    })
  })

  const loadDirectory = useEffectEvent(async (args: {
    directoryPath: string
    append?: boolean
    forceRefresh?: boolean
    preserveLoadedCount?: boolean
  }) => {
    if (!projectId) return

    const currentDirectory = directories[args.directoryPath] ?? EMPTY_DIRECTORY_STATE
    if (!args.forceRefresh && currentDirectory.isLoading) {
      return
    }

    const targetLimit = args.append
      ? snapshot?.pageSize ?? DEFAULT_PAGE_SIZE
      : args.preserveLoadedCount
        ? Math.max(snapshot?.pageSize ?? DEFAULT_PAGE_SIZE, currentDirectory.entries.length || 0)
        : snapshot?.pageSize ?? DEFAULT_PAGE_SIZE

    const nextVersion = (requestVersionRef.current.get(args.directoryPath) ?? 0) + 1
    requestVersionRef.current.set(args.directoryPath, nextVersion)

    startTransition(() => {
      setDirectories((current) => ({
        ...current,
        [args.directoryPath]: {
          ...(current[args.directoryPath] ?? EMPTY_DIRECTORY_STATE),
          isLoading: true,
          error: args.append ? current[args.directoryPath]?.error ?? null : null,
        },
      }))
    })

    try {
      const result = await socket.command<FileTreeReadDirectoryResult>({
        type: "file-tree.readDirectory",
        projectId,
        directoryPath: args.directoryPath,
        cursor: args.append ? currentDirectory.nextCursor ?? undefined : undefined,
        limit: targetLimit,
      })

      if (requestVersionRef.current.get(args.directoryPath) !== nextVersion) {
        return
      }

      startTransition(() => {
        setDirectories((current) => {
          const existing = current[args.directoryPath] ?? EMPTY_DIRECTORY_STATE
          const entries = args.append ? [...existing.entries, ...result.entries] : result.entries
          return {
            ...current,
            [args.directoryPath]: {
              entries,
              nextCursor: result.nextCursor,
              hasMore: result.hasMore,
              error: result.error ?? null,
              isLoading: false,
              stale: false,
            },
          }
        })
      })
    } catch (error) {
      if (requestVersionRef.current.get(args.directoryPath) !== nextVersion) {
        return
      }

      startTransition(() => {
        setDirectories((current) => ({
          ...current,
          [args.directoryPath]: {
            ...(current[args.directoryPath] ?? EMPTY_DIRECTORY_STATE),
            isLoading: false,
            error: error instanceof Error ? error.message : String(error),
            stale: true,
          },
        }))
      })
    }
  })

  useEffect(() => {
    if (!projectId || !isVisible) return

    const unsubscribe = socket.subscribeFileTree(projectId, {
      onSnapshot: (nextSnapshot) => {
        startTransition(() => setSnapshot(nextSnapshot))
        if (initializedProjectIdRef.current === projectId) {
          return
        }
        initializedProjectIdRef.current = projectId
        void loadDirectory({
          directoryPath: "",
          forceRefresh: true,
          preserveLoadedCount: true,
        })
      },
      onEvent: (event) => {
        markStale(event.directoryPaths)
        for (const directoryPath of event.directoryPaths) {
          if (!expandedRef.current[directoryPath]) continue
          void loadDirectory({
            directoryPath,
            forceRefresh: true,
            preserveLoadedCount: true,
          })
        }
      },
    })

    return unsubscribe
  }, [isVisible, loadDirectory, markStale, projectId, socket])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const resizeObserver = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight)
    })
    resizeObserver.observe(element)
    setViewportHeight(element.clientHeight)
    return () => resizeObserver.disconnect()
  }, [])

  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = []
    appendVisibleRows(rows, {
      directoryPath: "",
      depth: 0,
      directories,
      expanded,
    })
    return rows
  }, [directories, expanded])

  const totalHeight = visibleRows.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_OVERSCAN)
  const endIndex = Math.min(
    visibleRows.length,
    Math.ceil((scrollTop + Math.max(viewportHeight, ROW_HEIGHT)) / ROW_HEIGHT) + ROW_OVERSCAN
  )
  const windowedRows = visibleRows.slice(startIndex, endIndex)
  const rootState = directories[""] ?? EMPTY_DIRECTORY_STATE
  const contentMode = getRightSidebarContentMode({
    projectId,
    rootError: rootState.error,
    rootEntryCount: rootState.entries.length,
  })

  async function handleEntryActivate(entry: FileTreeEntry) {
    if (entry.kind === "directory") {
      toggleDirectory(entry.relativePath)
      return
    }
    if (!snapshot) return
    await onOpenFile({ path: joinAbsolutePath(snapshot.rootPath, entry.relativePath) })
  }

  async function handleCopyPath(path: string) {
    await navigator.clipboard.writeText(path)
  }

  function toggleDirectory(directoryPath: string) {
    const isExpanded = Boolean(expanded[directoryPath])
    if (isExpanded) {
      setExpanded((current) => {
        const next = { ...current }
        delete next[directoryPath]
        expandedRef.current = next
        return next
      })
      return
    }

    setExpanded((current) => {
      const next: Record<string, true> = { ...current, [directoryPath]: true }
      expandedRef.current = next
      return next
    })
    const directoryState = directories[directoryPath]
    if (!directoryState || directoryState.stale || (directoryState.entries.length === 0 && !directoryState.error)) {
      void loadDirectory({ directoryPath, forceRefresh: true, preserveLoadedCount: true })
    }
  }

  return (
    <div className="h-full min-h-0 border-l border-border bg-background md:min-w-[300px]">
        <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {snapshot?.rootPath ?? "Loading project tree..."}
          </div>
          <button
            type="button"
            aria-label="Close file browser"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {contentMode === "empty-project" ? (
          <EmptyState message="Open a project to browse files." />
        ) : contentMode === "empty-error" ? (
          <EmptyState message={rootState.error ?? "Could not load the project tree."} />
        ) : (
          <ScrollArea
            ref={scrollRef}
            className="flex-1 min-h-0"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: totalHeight || ROW_HEIGHT, position: "relative" }}>
              {windowedRows.map((row, index) => {
                const rowIndex = startIndex + index
                const top = rowIndex * ROW_HEIGHT
                if (row.type === "load-more") {
                  return (
                    <div
                      key={row.key}
                      className="absolute inset-x-0 py-px"
                      style={{ top, height: ROW_HEIGHT }}
                    >
                      <button
                        type="button"
                        onClick={() => void loadDirectory({ directoryPath: row.directoryPath, append: true })}
                        className="mx-2 flex h-[28px] w-[calc(100%-16px)] cursor-pointer items-center rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                        style={{ paddingLeft: 10 + row.depth * INDENT_PX }}
                      >
                        {row.isLoading ? "Loading more..." : "Load more"}
                      </button>
                    </div>
                  )
                }

                if (row.type === "error") {
                  return (
                    <div
                      key={row.key}
                      className="absolute inset-x-0 py-px"
                      style={{ top, height: ROW_HEIGHT }}
                    >
                      <div
                        className="mx-2 flex h-[28px] w-[calc(100%-16px)] items-center text-xs text-destructive"
                        style={{ paddingLeft: 10 + row.depth * INDENT_PX }}
                      >
                        {row.message}
                      </div>
                    </div>
                  )
                }

                const icon = getEntryIcon(row.entry, row.isExpanded)
                const absolutePath = snapshot ? joinAbsolutePath(snapshot.rootPath, row.entry.relativePath) : row.entry.relativePath
                return (
                  <div
                    key={row.key}
                    className="absolute inset-x-0 py-px"
                    style={{ top, height: ROW_HEIGHT }}
                  >
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            void handleEntryActivate(row.entry)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              void handleEntryActivate(row.entry)
                            }
                            if (event.key === "ArrowRight" && row.entry.kind === "directory" && !row.isExpanded) {
                              event.preventDefault()
                              toggleDirectory(row.entry.relativePath)
                            }
                            if (event.key === "ArrowLeft" && row.entry.kind === "directory" && row.isExpanded) {
                              event.preventDefault()
                              toggleDirectory(row.entry.relativePath)
                            }
                          }}
                          className="group mx-2 flex h-[28px] w-[calc(100%-16px)] cursor-pointer items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/70 hover:text-foreground"
                          style={{ paddingLeft: 6 + row.depth * INDENT_PX }}
                        >
                          {row.entry.kind === "directory" ? (
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground">
                              {row.isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </span>
                          ) : (
                            <span className="block h-5 w-5 shrink-0" aria-hidden="true" />
                          )}
                          <span className="shrink-0 text-muted-foreground">{icon}</span>
                          <span className="truncate text-sm">{row.entry.name}</span>
                          {row.entry.kind !== "directory" ? (
                            <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                          ) : null}
                          {row.isLoading ? <span className="ml-auto text-[11px] text-muted-foreground">Updating...</span> : null}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onSelect={() => {
                            void onOpenInFinder(absolutePath)
                          }}
                        >
                          Open in Finder
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() => {
                            void handleCopyPath(absolutePath)
                          }}
                        >
                          Copy Path
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}

        {isVisible && snapshot ? (
          <div className="border-t border-border px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start rounded-md px-2 text-xs"
              onClick={() => {
                void loadDirectory({
                  directoryPath: "",
                  forceRefresh: true,
                  preserveLoadedCount: true,
                })
              }}
            >
              Refresh tree
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function appendVisibleRows(
  rows: VisibleRow[],
  args: {
    directoryPath: string
    depth: number
    directories: Record<string, DirectoryState>
    expanded: Record<string, true>
  }
) {
  const directory = args.directories[args.directoryPath] ?? EMPTY_DIRECTORY_STATE
  for (const entry of directory.entries) {
    const isExpanded = Boolean(args.expanded[entry.relativePath])
    const childDirectory = args.directories[entry.relativePath]
    rows.push({
      key: `entry:${entry.relativePath}`,
      type: "entry",
      entry,
      depth: args.depth,
      isExpanded,
      isLoading: Boolean(childDirectory?.isLoading && entry.kind === "directory"),
    })

    if (entry.kind === "directory" && isExpanded) {
      if (childDirectory?.error) {
        rows.push({
          key: `error:${entry.relativePath}`,
          type: "error",
          directoryPath: entry.relativePath,
          depth: args.depth + 1,
          message: childDirectory.error,
        })
      }

      appendVisibleRows(rows, {
        directoryPath: entry.relativePath,
        depth: args.depth + 1,
        directories: args.directories,
        expanded: args.expanded,
      })

      if (childDirectory?.hasMore) {
        rows.push({
          key: `load-more:${entry.relativePath}:${childDirectory.nextCursor ?? "end"}`,
          type: "load-more",
          directoryPath: entry.relativePath,
          depth: args.depth + 1,
          isLoading: childDirectory.isLoading,
        })
      }
    }
  }

  if (args.directoryPath === "" && directory.hasMore) {
    rows.push({
      key: `load-more:root:${directory.nextCursor ?? "end"}`,
      type: "load-more",
      directoryPath: "",
      depth: 0,
      isLoading: directory.isLoading,
    })
  }
}

function getEntryIcon(entry: FileTreeEntry, isExpanded: boolean) {
  if (entry.kind === "directory") {
    return isExpanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />
  }

  const extension = entry.extension ?? ""
  if (extension === "json") return <FileJson2 className="h-4 w-4" />
  if (SPREADSHEET_EXTENSIONS.has(extension)) return <FileSpreadsheet className="h-4 w-4" />
  if (IMAGE_EXTENSIONS.has(extension)) return <FileImage className="h-4 w-4" />
  if (ARCHIVE_EXTENSIONS.has(extension)) return <Archive className="h-4 w-4" />
  if (CONFIG_EXTENSIONS.has(extension)) return <FileCog className="h-4 w-4" />
  if (TEXT_EXTENSIONS.has(extension)) return <FileText className="h-4 w-4" />
  if (CODE_EXTENSIONS.has(extension)) return <FileCode2 className="h-4 w-4" />
  return <FileIcon className="h-4 w-4" />
}

function joinAbsolutePath(rootPath: string, relativePath: string) {
  return relativePath ? `${rootPath.replace(/\/$/, "")}/${relativePath}` : rootPath
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-[260px] text-center text-sm leading-6 text-muted-foreground">{message}</div>
    </div>
  )
}

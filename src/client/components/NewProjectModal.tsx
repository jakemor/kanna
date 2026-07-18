import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { ArrowLeft, Check, File, Folder, GitBranch, Loader2 } from "lucide-react"
import { DEFAULT_NEW_PROJECT_ROOT } from "../../shared/branding"
import { parseGitRepoUrl, toCloneUrl } from "../../shared/git-url"
import type { FsDirEntry, FsListResult } from "../../shared/types"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog"
import { Input } from "./ui/input"
import { SegmentedControl } from "./ui/segmented-control"

export type ProjectMode = "new" | "existing" | "clone"

export interface NewProjectResult {
  mode: ProjectMode
  localPath: string
  fallbackPath?: string
  title: string
  cloneUrl?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (project: NewProjectResult) => Promise<void>
  listDirectory: (path?: string) => Promise<FsListResult>
}

type Tab = "new" | "existing"
type CloneStatus = "idle" | "cloning" | "success" | "error"

function toKebab(str: string): string {
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export type ExistingInputMode = "filter" | "path" | "git"

/** Decide what the single browser input means: git URL, absolute path jump, or entry filter. */
export function classifyExistingInput(value: string): ExistingInputMode {
  const trimmed = value.trim()
  if (parseGitRepoUrl(trimmed)) return "git"
  if (trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return "path"
  }
  return "filter"
}

/** Dotfiles stay hidden unless the filter itself starts with a dot, which prefix-matches hidden entries. */
export function filterDirEntries(entries: FsDirEntry[], filter: string): FsDirEntry[] {
  const query = filter.trim().toLocaleLowerCase()
  if (query.startsWith(".")) {
    return entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(query))
  }
  return entries.filter((entry) => {
    if (entry.name.startsWith(".")) return false
    return query ? entry.name.toLocaleLowerCase().includes(query) : true
  })
}

export function abbreviateHomePath(fullPath: string, homePath: string): string {
  if (!homePath) return fullPath
  if (fullPath === homePath) return "~"
  if (fullPath.startsWith(homePath + "/") || fullPath.startsWith(homePath + "\\")) {
    return "~" + fullPath.slice(homePath.length)
  }
  return fullPath
}

export function joinDirPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return parent.endsWith(sep) ? parent + name : parent + sep + name
}

/** Remembered across modal opens so browsing picks up where the user left off. */
let lastBrowsedPath: string | undefined

export function NewProjectModal({ open, onOpenChange, onConfirm, listDirectory }: Props) {
  const [tab, setTab] = useState<Tab>("new")
  const [name, setName] = useState("")
  const [cloneStatus, setCloneStatus] = useState<CloneStatus>("idle")
  const [cloneError, setCloneError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Browser (existing tab) state
  const [dir, setDir] = useState<FsListResult | null>(null)
  const [dirLoading, setDirLoading] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [highlight, setHighlight] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const filterInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dirCacheRef = useRef(new Map<string, FsListResult>())
  const requestSeqRef = useRef(0)
  const currentPathRef = useRef<string | null>(null)

  const isBusy = cloneStatus === "cloning" || cloneStatus === "success"

  const navigate = useCallback(async (target?: string, fromBack = false) => {
    const seq = ++requestSeqRef.current
    setDirError(null)
    setFilter("")
    setHighlight(0)
    // Keep the finder keyboard-driven even after mouse navigation
    filterInputRef.current?.focus()

    const arriveAt = (result: FsListResult) => {
      const previous = currentPathRef.current
      if (!fromBack && previous && previous !== result.path) {
        setHistory((stack) => [...stack, previous])
      }
      currentPathRef.current = result.path
      lastBrowsedPath = result.path
      setDir(result)
    }

    const cached = target !== undefined ? dirCacheRef.current.get(target) : undefined
    if (cached) {
      arriveAt(cached)
      return
    }
    setDirLoading(true)
    try {
      const result = await listDirectory(target)
      dirCacheRef.current.set(result.path, result)
      if (seq !== requestSeqRef.current) return
      arriveAt(result)
    } catch (error) {
      if (seq !== requestSeqRef.current) return
      setDirError(error instanceof Error ? error.message : String(error))
    } finally {
      if (seq === requestSeqRef.current) setDirLoading(false)
    }
  }, [listDirectory])

  const goBack = useCallback(() => {
    const previous = history[history.length - 1]
    if (previous === undefined) return
    setHistory(history.slice(0, -1))
    void navigate(previous, true)
  }, [history, navigate])

  useEffect(() => {
    if (open) {
      setTab("new")
      setName("")
      setCloneStatus("idle")
      setCloneError(null)
      setDir(null)
      setDirError(null)
      setFilter("")
      setHighlight(0)
      setHistory([])
      dirCacheRef.current.clear()
      currentPathRef.current = null
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (open && !isBusy) {
      setTimeout(() => {
        if (tab === "new") inputRef.current?.focus()
        else filterInputRef.current?.focus()
      }, 0)
    }
  }, [tab, open, isBusy])

  // Lazy-load the browser the first time the existing tab is shown
  useEffect(() => {
    if (open && tab === "existing" && !dir && !dirLoading && !dirError) {
      void navigate(lastBrowsedPath)
    }
  }, [open, tab, dir, dirLoading, dirError, navigate])

  // Detect git URLs in either input
  const activeValue = tab === "new" ? name : filter
  const parsedGitUrl = useMemo(() => parseGitRepoUrl(activeValue.trim()), [activeValue])
  const isCloneMode = parsedGitUrl !== null

  const inputMode: ExistingInputMode = useMemo(() => classifyExistingInput(filter), [filter])

  const kebab = toKebab(name)
  const newPath = kebab ? `${DEFAULT_NEW_PROJECT_ROOT}/${kebab}` : ""

  // For clone mode: derive path from the repo name, with owner-repo fallback
  const clonePath = parsedGitUrl ? `${DEFAULT_NEW_PROJECT_ROOT}/${parsedGitUrl.repo}` : ""
  const cloneFallbackPath = parsedGitUrl ? `${DEFAULT_NEW_PROJECT_ROOT}/${parsedGitUrl.owner}-${parsedGitUrl.repo}` : ""

  const visibleEntries = useMemo(
    () => (dir ? filterDirEntries(dir.entries, inputMode === "filter" ? filter : "") : []),
    [dir, filter, inputMode]
  )
  // Server sorts dirs first, so navigable rows are a prefix of visibleEntries
  const visibleDirCount = useMemo(
    () => visibleEntries.filter((entry) => entry.kind === "dir").length,
    [visibleEntries]
  )
  const clampedHighlight = Math.min(highlight, Math.max(0, visibleDirCount - 1))

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [clampedHighlight, visibleEntries])

  const dirBasename = dir ? (abbreviateHomePath(dir.path, dir.homePath).split(/[\\/]/).pop() || dir.path) : ""

  const canSubmit = !isBusy && (isCloneMode
    ? !!parsedGitUrl
    : tab === "new"
      ? !!kebab
      : !!dir && !dirLoading)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return

    if (isCloneMode && parsedGitUrl) {
      // Keep modal open with progress for clones
      setCloneStatus("cloning")
      setCloneError(null)
      try {
        await onConfirm({
          mode: "clone",
          localPath: clonePath,
          fallbackPath: cloneFallbackPath,
          title: parsedGitUrl.repo,
          cloneUrl: toCloneUrl(activeValue.trim()),
        })
        setCloneStatus("success")
        // Brief success flash then close
        setTimeout(() => onOpenChange(false), 600)
      } catch (error) {
        setCloneStatus("error")
        setCloneError(error instanceof Error ? error.message : String(error))
      }
    } else if (tab === "new") {
      onConfirm({ mode: "new", localPath: newPath, title: name.trim() })
      onOpenChange(false)
    } else if (dir) {
      const folderName = dir.path.split(/[\\/]/).pop() || dir.path
      onConfirm({ mode: "existing", localPath: dir.path, title: folderName })
      onOpenChange(false)
    }
  }, [canSubmit, isCloneMode, parsedGitUrl, clonePath, cloneFallbackPath, activeValue, tab, newPath, name, dir, onConfirm, onOpenChange])

  const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      onOpenChange(false)
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      if (isCloneMode) {
        void handleSubmit()
      } else if (inputMode === "path") {
        void navigate(filter.trim())
      } else if (e.metaKey || e.ctrlKey) {
        void handleSubmit()
      } else if (visibleDirCount > 0 && dir) {
        const target = visibleEntries[clampedHighlight]
        if (target) void navigate(joinDirPath(dir.path, target.name))
      }
      return
    }
    if (e.key === "Backspace" && filter === "" && history.length > 0) {
      e.preventDefault()
      goBack()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlight(Math.min(clampedHighlight + 1, Math.max(0, visibleDirCount - 1)))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlight(Math.max(0, clampedHighlight - 1))
    }
  }, [onOpenChange, isCloneMode, inputMode, filter, dir, visibleDirCount, visibleEntries, clampedHighlight, history.length, goBack, handleSubmit, navigate])

  const cloneIndicator = parsedGitUrl && (
    <div className="flex items-center gap-1.5 text-xs text-primary">
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0" />
      <span>
        Clone <span className="font-medium">{parsedGitUrl.owner}/{parsedGitUrl.repo}</span> into {clonePath}
      </span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={isBusy ? undefined : onOpenChange}>
      <DialogContent
        size={!isBusy && tab === "existing" ? "lg" : "sm"}
        onInteractOutside={isBusy ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={isBusy ? (e) => e.preventDefault() : undefined}
      >
        <DialogBody className="space-y-4">
          <DialogTitle>Add Project</DialogTitle>

          {!isBusy && (
            <SegmentedControl
              value={tab}
              onValueChange={setTab}
              options={[
                { value: "new" as Tab, label: "New Folder" },
                { value: "existing" as Tab, label: "Browse Existing" },
              ]}
              className="w-full mb-2"
              optionClassName="flex-1 justify-center"
            />
          )}

          {isBusy ? (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2.5">
                {cloneStatus === "cloning" ? (
                  <Loader2 className="h-4 w-4 text-primary animate-spin flex-shrink-0" />
                ) : (
                  <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                )}
                <span className="text-sm text-foreground">
                  {cloneStatus === "cloning"
                    ? <>Cloning <span className="font-medium">{parsedGitUrl?.owner}/{parsedGitUrl?.repo}</span>&hellip;</>
                    : <>Cloned <span className="font-medium">{parsedGitUrl?.owner}/{parsedGitUrl?.repo}</span></>}
                </span>
              </div>
              <p className="text-xs text-muted-foreground font-mono pl-6.5">
                {clonePath}
              </p>
            </div>
          ) : tab === "new" ? (
            <div className="space-y-2">
              <Input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setCloneError(null) }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSubmit()
                  if (e.key === "Escape") onOpenChange(false)
                }}
                placeholder="Project name or GitHub/GitLab URL"
              />
              {isCloneMode ? cloneIndicator : newPath ? (
                <p className="text-xs text-muted-foreground font-mono">
                  {newPath}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                ref={filterInputRef}
                type="text"
                value={filter}
                onChange={(e) => { setFilter(e.target.value); setHighlight(0); setCloneError(null) }}
                onKeyDown={handleBrowserKeyDown}
                placeholder="Filter folders, jump to a path, or paste a git URL"
                spellCheck={false}
                autoComplete="off"
              />

              {isCloneMode ? cloneIndicator : inputMode === "path" ? (
                <p className="text-xs text-muted-foreground">
                  Press <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono text-[10px]">Enter</kbd> to go to <span className="font-mono">{filter.trim()}</span>
                </p>
              ) : null}

              <div className="border border-border rounded-lg overflow-hidden">
                {/* Location bar */}
                {/* pl-2 + the 4px centering inset inside the h-6 button lines the arrow up with the row icons (p-1 + px-2) */}
                <div className="flex items-center gap-1 border-b border-border bg-muted/40 pl-2 pr-1.5 py-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    disabled={history.length === 0 || dirLoading}
                    onClick={goBack}
                    aria-label="Back"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  {/* The mono font renders its glyphs ~1px above the geometric center; nudge to optically align with the back arrow */}
                  <span className="flex-1 min-w-0 truncate px-1 font-mono text-xs text-muted-foreground translate-y-[0.5px]" title={dir?.path}>
                    {dir ? abbreviateHomePath(dir.path, dir.homePath) : " "}
                  </span>
                  {dir?.isGitRepo ? (
                    <span className="flex items-center gap-1 flex-shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <GitBranch className="h-3 w-3" />
                      git
                    </span>
                  ) : null}
                  {dirLoading ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" /> : null}
                </div>

                {/* Entries */}
                <div ref={listRef} className="h-64 overflow-y-auto overscroll-contain p-1">
                  {dirError ? (
                    <div className="px-2 py-3 text-sm text-destructive">{dirError}</div>
                  ) : !dir && dirLoading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading&hellip;
                    </div>
                  ) : visibleEntries.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      {filter && inputMode === "filter" ? "No matches" : "Empty folder"}
                    </div>
                  ) : (
                    <>
                      {visibleEntries.map((entry, index) => entry.kind === "dir" ? (
                        <button
                          key={entry.name}
                          type="button"
                          data-highlighted={index === clampedHighlight || undefined}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground",
                            index === clampedHighlight ? "bg-muted" : "hover:bg-muted/60"
                          )}
                          onMouseMove={() => { if (highlight !== index) setHighlight(index) }}
                          onClick={() => void navigate(joinDirPath(dir!.path, entry.name))}
                        >
                          <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate">{entry.name}</span>
                        </button>
                      ) : (
                        <div
                          key={entry.name}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground/60"
                        >
                          <File className="h-4 w-4 flex-shrink-0" />
                          <span className="truncate">{entry.name}</span>
                        </div>
                      ))}
                      {dir?.truncated ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          Showing the first {dir.entries.length.toLocaleString()} entries
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Open a folder, then add it as a project. <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono text-[10px]">&#8984;&#9166;</kbd> adds the current folder.
              </p>
            </div>
          )}

          {cloneError && (
            <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-lg px-3 py-2">
              {cloneError}
            </div>
          )}
        </DialogBody>
        {!isBusy && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {isCloneMode ? "Clone" : tab === "new" ? "Create" : dir ? `Add "${dirBasename}"` : "Add"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

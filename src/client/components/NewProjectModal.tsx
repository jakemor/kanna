import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { ArrowLeft, Check, Circle, File, Folder, GitBranch, Loader2, Plus, Star } from "lucide-react"
import { parseGitRepoUrl } from "../../shared/git-url"
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
  listDirectory: (path?: string, nearest?: boolean) => Promise<FsListResult>
  makeDirectory: (path: string) => Promise<FsListResult>
}

type CloneStatus = "idle" | "cloning" | "success" | "error"

export type BrowserInputMode = "filter" | "path" | "repo"

/** Decide what the single input means: path jump, git repo to clone, or entry filter. */
export function classifyBrowserInput(value: string): BrowserInputMode {
  const trimmed = value.trim()
  if (trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return "path"
  }
  if (parseRepoRef(trimmed)) return "repo"
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

export function pathBasename(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "")
  const base = trimmed.split(/[\\/]/).pop() ?? ""
  return base === "~" ? "" : base
}

export interface RepoRef {
  host: string
  owner: string
  repo: string
  cloneUrl: string
}

/** Parse a full GitHub/GitLab URL or an `owner/repo` shorthand (assumed GitHub). */
export function parseRepoRef(value: string): RepoRef | null {
  const trimmed = value.trim()
  const parsed = parseGitRepoUrl(trimmed)
  if (parsed) {
    return {
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      cloneUrl: `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`,
    }
  }
  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (shorthand) {
    return {
      host: "github.com",
      owner: shorthand[1]!,
      repo: shorthand[2]!,
      cloneUrl: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
    }
  }
  return null
}

export interface CloneDestination {
  localPath: string
  fallbackPath: string
  title: string
  /** True when the repo clones straight into the (empty) current folder. */
  direct: boolean
}

/**
 * An empty current folder receives the repo contents directly (the
 * create-a-folder-then-clone-into-it flow); otherwise the clone lands
 * in a new subfolder named after the repo.
 */
export function resolveCloneDestination(
  dir: Pick<FsListResult, "path" | "entries">,
  repo: RepoRef
): CloneDestination {
  if (dir.entries.length === 0) {
    return {
      localPath: dir.path,
      fallbackPath: joinDirPath(dir.path, repo.repo),
      title: pathBasename(dir.path) || repo.repo,
      direct: true,
    }
  }
  return {
    localPath: joinDirPath(dir.path, repo.repo),
    fallbackPath: joinDirPath(dir.path, `${repo.owner}-${repo.repo}`),
    title: repo.repo,
    direct: false,
  }
}

interface RepoMeta {
  fullName: string
  description: string | null
  stars: number
  language: string | null
  pushedAt: string | null
}

/** Remembered across modal opens so browsing picks up where the user left off. */
let lastBrowsedPath: string | undefined

export function NewProjectModal({ open, onOpenChange, onConfirm, listDirectory, makeDirectory }: Props) {
  const [cloneStatus, setCloneStatus] = useState<CloneStatus>("idle")
  const [cloneError, setCloneError] = useState<string | null>(null)

  // Browser state
  const [dir, setDir] = useState<FsListResult | null>(null)
  const [dirLoading, setDirLoading] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [highlight, setHighlight] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dirCacheRef = useRef(new Map<string, FsListResult>())
  const requestSeqRef = useRef(0)
  const currentPathRef = useRef<string | null>(null)

  // Inline new-folder state
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState("")
  const folderInputRef = useRef<HTMLInputElement>(null)

  // Repo metadata state
  const [repoMeta, setRepoMeta] = useState<RepoMeta | null>(null)
  const [repoMetaLoading, setRepoMetaLoading] = useState(false)
  const [repoMetaError, setRepoMetaError] = useState<string | null>(null)
  const repoMetaCacheRef = useRef(new Map<string, RepoMeta>())
  const repoKeyRef = useRef<string | null>(null)

  const isBusy = cloneStatus === "cloning" || cloneStatus === "success"

  const inputMode: BrowserInputMode = useMemo(() => classifyBrowserInput(input), [input])
  const parsedRepo = useMemo(
    () => (inputMode === "repo" ? parseRepoRef(input) : null),
    [inputMode, input]
  )

  const arriveAt = useCallback((result: FsListResult, fromBack = false) => {
    const previous = currentPathRef.current
    if (!fromBack && previous && previous !== result.path) {
      setHistory((stack) => [...stack, previous])
    }
    currentPathRef.current = result.path
    lastBrowsedPath = result.path
    setDir(result)
    setDirError(null)
    setInput("")
    setHighlight(0)
  }, [])

  const navigate = useCallback(async (target?: string, opts?: { fromBack?: boolean; nearest?: boolean }) => {
    const seq = ++requestSeqRef.current
    setDirError(null)
    // Keep the finder keyboard-driven even after mouse navigation
    inputRef.current?.focus()

    const cached = target !== undefined ? dirCacheRef.current.get(target) : undefined
    if (cached) {
      arriveAt(cached, opts?.fromBack)
      return
    }
    setDirLoading(true)
    try {
      const result = await listDirectory(target, opts?.nearest)
      // A nearest fallback is view state, not a fact about the ancestor — cache it clean
      dirCacheRef.current.set(result.path, { ...result, missingSuffix: undefined })
      if (seq !== requestSeqRef.current) return
      arriveAt(result, opts?.fromBack)
    } catch (error) {
      if (seq !== requestSeqRef.current) return
      setDirError(error instanceof Error ? error.message : String(error))
    } finally {
      if (seq === requestSeqRef.current) setDirLoading(false)
    }
  }, [listDirectory, arriveAt])

  const goBack = useCallback(() => {
    const previous = history[history.length - 1]
    if (previous === undefined) return
    setHistory(history.slice(0, -1))
    void navigate(previous, { fromBack: true })
  }, [history, navigate])

  /** Create a folder (inline row or a missing typed path) and step into it. */
  const createFolder = useCallback(async (target: string) => {
    setDirLoading(true)
    setDirError(null)
    try {
      const result = await makeDirectory(target)
      if (result.parentPath) dirCacheRef.current.delete(result.parentPath)
      dirCacheRef.current.set(result.path, result)
      arriveAt(result)
      setCreatingFolder(false)
      setFolderName("")
      inputRef.current?.focus()
    } catch (error) {
      setDirError(error instanceof Error ? error.message : String(error))
    } finally {
      setDirLoading(false)
    }
  }, [makeDirectory, arriveAt])

  const trimmedFolderName = folderName.trim()
  const canCreateFolder = !!trimmedFolderName && !/[\\/]/.test(trimmedFolderName) && !!dir && !dirLoading

  useEffect(() => {
    if (open) {
      setCloneStatus("idle")
      setCloneError(null)
      setDir(null)
      setDirError(null)
      setInput("")
      setHighlight(0)
      setHistory([])
      setCreatingFolder(false)
      setFolderName("")
      setRepoMeta(null)
      setRepoMetaError(null)
      dirCacheRef.current.clear()
      currentPathRef.current = null
      setTimeout(() => inputRef.current?.focus(), 0)
      void navigate(lastBrowsedPath)
    }
    // Deliberately keyed on `open` alone: `navigate` picks up new prop identities anyway
  }, [open])

  useEffect(() => {
    if (creatingFolder) {
      setTimeout(() => folderInputRef.current?.focus(), 0)
    }
  }, [creatingFolder])

  // Debounced repo metadata lookup so the user can confirm they picked the right repo
  useEffect(() => {
    if (!open) return
    if (!parsedRepo || parsedRepo.host !== "github.com") {
      repoKeyRef.current = null
      setRepoMeta(null)
      setRepoMetaError(null)
      setRepoMetaLoading(false)
      return
    }
    const key = `${parsedRepo.owner}/${parsedRepo.repo}`
    repoKeyRef.current = key
    const cached = repoMetaCacheRef.current.get(key)
    if (cached) {
      setRepoMeta(cached)
      setRepoMetaError(null)
      setRepoMetaLoading(false)
      return
    }
    setRepoMeta(null)
    setRepoMetaError(null)
    setRepoMetaLoading(true)
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${key}`)
        if (!response.ok) {
          throw new Error(response.status === 404
            ? "Repository not found — it may be private. Cloning can still work if you have access."
            : `Couldn't load repository details (${response.status}).`)
        }
        const data = await response.json() as {
          full_name: string
          description: string | null
          stargazers_count: number
          language: string | null
          pushed_at: string | null
        }
        const meta: RepoMeta = {
          fullName: data.full_name,
          description: data.description,
          stars: data.stargazers_count,
          language: data.language,
          pushedAt: data.pushed_at,
        }
        repoMetaCacheRef.current.set(key, meta)
        if (repoKeyRef.current !== key) return
        setRepoMeta(meta)
      } catch (error) {
        if (repoKeyRef.current !== key) return
        setRepoMetaError(error instanceof Error ? error.message : String(error))
      } finally {
        if (repoKeyRef.current === key) setRepoMetaLoading(false)
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [open, parsedRepo])

  const cloneDestination = useMemo(
    () => (dir && parsedRepo ? resolveCloneDestination(dir, parsedRepo) : null),
    [dir, parsedRepo]
  )

  const visibleEntries = useMemo(
    () => (dir ? filterDirEntries(dir.entries, inputMode === "filter" ? input : "") : []),
    [dir, input, inputMode]
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

  const canSubmit = !isBusy && !!dir && !dirLoading && (inputMode !== "repo" || !!cloneDestination)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !dir) return

    if (parsedRepo && cloneDestination) {
      // Keep modal open with progress for clones
      setCloneStatus("cloning")
      setCloneError(null)
      try {
        await onConfirm({
          mode: "clone",
          localPath: cloneDestination.localPath,
          fallbackPath: cloneDestination.fallbackPath,
          title: cloneDestination.title,
          cloneUrl: parsedRepo.cloneUrl,
        })
        setCloneStatus("success")
        // Brief success flash then close
        setTimeout(() => onOpenChange(false), 600)
      } catch (error) {
        setCloneStatus("error")
        setCloneError(error instanceof Error ? error.message : String(error))
      }
    } else {
      const folderName = dir.path.split(/[\\/]/).pop() || dir.path
      onConfirm({ mode: "existing", localPath: dir.path, title: folderName })
      onOpenChange(false)
    }
  }, [canSubmit, dir, parsedRepo, cloneDestination, onConfirm, onOpenChange])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      onOpenChange(false)
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      if (inputMode === "repo") {
        void handleSubmit()
      } else if (inputMode === "path") {
        void navigate(input.trim(), { nearest: true })
      } else if (e.metaKey || e.ctrlKey) {
        void handleSubmit()
      } else if (visibleDirCount > 0 && dir) {
        const target = visibleEntries[clampedHighlight]
        if (target) void navigate(joinDirPath(dir.path, target.name))
      }
      return
    }
    if (e.key === "Backspace" && input === "" && history.length > 0) {
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
  }, [onOpenChange, inputMode, input, dir, visibleDirCount, visibleEntries, clampedHighlight, history.length, goBack, handleSubmit, navigate])

  const repoCard = parsedRepo ? (
    <div className="border border-border rounded-lg px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <GitBranch className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground truncate">
          {repoMeta?.fullName ?? `${parsedRepo.owner}/${parsedRepo.repo}`}
        </span>
        {repoMetaLoading ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
      {repoMeta?.description ? (
        <p className="text-xs text-muted-foreground line-clamp-2">{repoMeta.description}</p>
      ) : null}
      {repoMeta ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3" />
            {repoMeta.stars.toLocaleString()}
          </span>
          {repoMeta.language ? (
            <span className="flex items-center gap-1">
              <Circle className="h-2 w-2 fill-current" />
              {repoMeta.language}
            </span>
          ) : null}
          {repoMeta.pushedAt ? (
            <span>Updated {new Date(repoMeta.pushedAt).toLocaleDateString()}</span>
          ) : null}
        </div>
      ) : repoMetaError ? (
        <p className="text-xs text-muted-foreground">{repoMetaError}</p>
      ) : parsedRepo.host !== "github.com" ? (
        <p className="text-xs text-muted-foreground">Repository on {parsedRepo.host}</p>
      ) : null}
      {cloneDestination && dir ? (
        <p className="text-xs text-muted-foreground font-mono pt-0.5">
          Clone {cloneDestination.direct ? "into" : "to"} {abbreviateHomePath(cloneDestination.localPath, dir.homePath)}
        </p>
      ) : null}
    </div>
  ) : null

  return (
    <Dialog open={open} onOpenChange={isBusy ? undefined : onOpenChange}>
      <DialogContent
        size="lg"
        onInteractOutside={isBusy ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={isBusy ? (e) => e.preventDefault() : undefined}
      >
        <DialogBody className="space-y-4">
          <DialogTitle>Add Project</DialogTitle>

          {isBusy ? (
            <div className="space-y-3 py-1">
              {repoCard}
              <div className="flex items-center gap-2.5 pt-1">
                {cloneStatus === "cloning" ? (
                  <Loader2 className="h-4 w-4 text-primary animate-spin flex-shrink-0" />
                ) : (
                  <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                )}
                <span className="text-sm text-foreground">
                  {cloneStatus === "cloning"
                    ? <>Cloning <span className="font-medium">{parsedRepo?.owner}/{parsedRepo?.repo}</span>&hellip;</>
                    : <>Cloned <span className="font-medium">{parsedRepo?.owner}/{parsedRepo?.repo}</span></>}
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => { setInput(e.target.value); setHighlight(0); setCloneError(null) }}
                onKeyDown={handleInputKeyDown}
                placeholder="Filter folders, jump to a path, or paste a git repo"
                spellCheck={false}
                autoComplete="off"
              />

              {inputMode === "path" ? (
                <p className="text-xs text-muted-foreground">
                  Press <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono text-[10px]">Enter</kbd> to go to <span className="font-mono">{input.trim()}</span>
                </p>
              ) : null}

              {repoCard}

              <div className="border border-border rounded-lg overflow-hidden">
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
                  <span
                    className={cn(
                      "flex-1 min-w-0 truncate px-1 font-mono text-xs translate-y-[0.5px]",
                      dirError ? "text-destructive" : "text-muted-foreground"
                    )}
                    title={dirError ?? dir?.path}
                  >
                    {dirError ?? (dir ? abbreviateHomePath(dir.path, dir.homePath) : " ")}
                  </span>
                  {!dirError && dir?.isGitRepo ? (
                    <span className="flex items-center gap-1 flex-shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <GitBranch className="h-3 w-3" />
                      git
                    </span>
                  ) : null}
                  {dirLoading ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" /> : null}
                </div>

                {/* Entries */}
                <div ref={listRef} className="h-56 overflow-y-auto overscroll-contain p-1">
                  {/* One create affordance at the top: a typed-but-missing path wins, otherwise plain New Folder */}
                  {dir && !dirError ? (
                    creatingFolder ? (
                      <div className="flex items-center gap-2 px-2 py-1">
                        <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <Input
                          ref={folderInputRef}
                          type="text"
                          value={folderName}
                          onChange={(e) => setFolderName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && canCreateFolder) {
                              void createFolder(joinDirPath(dir.path, trimmedFolderName))
                            }
                            if (e.key === "Escape") {
                              e.stopPropagation()
                              setCreatingFolder(false)
                              setFolderName("")
                              inputRef.current?.focus()
                            }
                          }}
                          placeholder="Folder name"
                          spellCheck={false}
                          autoComplete="off"
                          className="h-7 text-sm"
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground hover:bg-muted/60"
                        onClick={() => {
                          if (dir.missingSuffix) {
                            void createFolder(joinDirPath(dir.path, dir.missingSuffix))
                          } else {
                            setCreatingFolder(true)
                          }
                        }}
                      >
                        <Plus className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          {dir.missingSuffix ? <>Create "{dir.missingSuffix}"</> : "New Folder"}
                        </span>
                      </button>
                    )
                  ) : null}
                  {dirError ? null : !dir && dirLoading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading&hellip;
                    </div>
                  ) : visibleEntries.length === 0 ? (
                    input && inputMode === "filter" ? (
                      <div className="px-2 py-3 text-sm text-muted-foreground">No matches</div>
                    ) : null
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
                Open a folder and add it as a project, or paste a git repo to clone it there. <kbd className="px-1 py-0.5 rounded border border-border bg-muted font-mono text-[10px]">&#8984;&#9166;</kbd> adds the current folder.
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
              {inputMode === "repo" ? "Clone" : dir ? `Add "${dirBasename}"` : "Add"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

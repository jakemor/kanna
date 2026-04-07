import { PatchDiff } from "@pierre/diffs/react"
import { Ban, Check, ChevronDown, ChevronUp, Code, Columns2, Copy, Download, Ellipsis, GitBranch, GitPullRequest, LoaderCircle, Minus, RefreshCw, Rows3, Search, Trash2, Upload, WrapText } from "lucide-react"
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react"
import type {
  ChatAttachment,
  ChatBranchHistoryEntry,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatDiffSnapshot,
  DiffCommitMode,
  DiffCommitResult,
} from "../../../shared/types"
import { useStickyState } from "../../hooks/useStickyState"
import { cn } from "../../lib/utils"
import { useDiffCommitStore } from "../../stores/diffCommitStore"
import { AttachmentFileCard, AttachmentImageCard } from "../messages/AttachmentCard"
import { AttachmentPreviewModal } from "../messages/AttachmentPreviewModal"
import { classifyAttachmentPreview } from "../messages/attachmentPreview"
import { Button } from "../ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu"
import { Input } from "../ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { SegmentedControl } from "../ui/segmented-control"
import { Textarea } from "../ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

type DiffRenderMode = "unified" | "split"
type DiffFile = ChatDiffSnapshot["files"][number]
type SidebarViewMode = "changes" | "history"
const EMPTY_CHECKED_PATHS: Record<string, boolean> = {}

function getDiffPreviewAttachment(projectId: string | null, file: DiffFile): ChatAttachment | null {
  if (!projectId || !file.mimeType || typeof file.size !== "number" || file.changeType === "deleted") {
    return null
  }

  if (!file.mimeType.startsWith("image/") && file.mimeType !== "application/pdf") {
    return null
  }

  return {
    id: `diff:${file.path}`,
    kind: file.mimeType.startsWith("image/") ? "image" : "file",
    displayName: file.path.split("/").pop() ?? file.path,
    absolutePath: file.path,
    relativePath: file.path,
    contentUrl: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content`,
    mimeType: file.mimeType,
    size: file.size,
  }
}

interface RightSidebarProps {
  projectId: string | null
  diffs: ChatDiffSnapshot
  editorLabel: string
  diffRenderMode: DiffRenderMode
  wrapLines: boolean
  onOpenFile: (path: string) => void
  onDiscardFile: (path: string) => void
  onIgnoreFile: (path: string) => void
  onCopyFilePath: (path: string) => void
  onCopyRelativePath: (path: string) => void
  onListBranches: () => Promise<ChatBranchListResult>
  onCheckoutBranch: (branch: ChatBranchListEntry) => Promise<void>
  onCreateBranch: () => Promise<void>
  onGenerateCommitMessage: (args: { paths: string[] }) => Promise<{ subject: string; body: string }>
  onCommit: (args: { paths: string[]; summary: string; description: string; mode: DiffCommitMode }) => Promise<DiffCommitResult | null>
  onSyncWithRemote: (action: "fetch" | "pull" | "publish") => Promise<unknown>
  onDiffRenderModeChange: (mode: DiffRenderMode) => void
  onWrapLinesChange: (wrap: boolean) => void
  onClose: () => void
}

export function canIgnoreDiffFile(file: DiffFile) {
  return file.isUntracked
}

function getPatchCounts(patch: string) {
  let additions = 0
  let deletions = 0

  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
      continue
    }
    if (line.startsWith("+")) {
      additions += 1
      continue
    }
    if (line.startsWith("-")) {
      deletions += 1
    }
  }

  return { additions, deletions }
}

function IconButton(props: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={props.label}
          title={props.label}
          onClick={props.onClick}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            props.active && "bg-accent text-foreground"
          )}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  )
}

function StageCheckbox({
  checked,
  mixed = false,
  label,
  className,
  onClick,
}: {
  checked: boolean
  mixed?: boolean
  label?: string
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label ?? (checked ? "Exclude file from commit" : "Include file in commit")}
      aria-checked={mixed ? "mixed" : checked}
      aria-pressed={mixed ? "mixed" : checked}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex size-4.5 shrink-0 items-center justify-center rounded border transition-colors",
        checked || mixed
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-transparent",
        className
      )}
    >
      {mixed
        ? <Minus className="h-3 w-3" strokeWidth={3} />
        : checked
          ? <Check className="h-3 w-3" strokeWidth={3} />
          : null}
    </button>
  )
}

function formatRelativeTime(isoTimestamp: string) {
  const timestamp = Date.parse(isoTimestamp)
  if (!Number.isFinite(timestamp)) {
    return ""
  }

  const diffMs = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day

  if (diffMs < minute) {
    return "just now"
  }
  if (diffMs < hour) {
    return `${Math.round(diffMs / minute)}m ago`
  }
  if (diffMs < day) {
    return `${Math.round(diffMs / hour)}hr ago`
  }
  if (diffMs < week) {
    return `${Math.round(diffMs / day)}d ago`
  }
  if (diffMs < month) {
    return `${Math.round(diffMs / week)}wk ago`
  }
  if (diffMs < year) {
    return `${Math.round(diffMs / month)}mo ago`
  }
  return `${Math.round(diffMs / year)}yr ago`
}

function formatFetchTooltip(isoTimestamp?: string) {
  if (!isoTimestamp) {
    return "No local fetch recorded"
  }
  return `Last fetched ${formatRelativeTime(isoTimestamp)}`
}

function CommitHistoryRow({ entry }: { entry: ChatBranchHistoryEntry }) {
  const relativeTime = formatRelativeTime(entry.authoredAt)
  const isClickable = Boolean(entry.githubUrl)
  return (
    <button
      type="button"
      disabled={!isClickable}
      onClick={() => {
        if (!entry.githubUrl || typeof window === "undefined") return
        window.open(entry.githubUrl, "_blank", "noopener,noreferrer")
      }}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors",
        isClickable ? "hover:bg-accent" : "cursor-default opacity-60"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{entry.summary}</div>
        {entry.description ? (
          <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
            {entry.description}
          </div>
        ) : null}
        <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {entry.authorName ? <span className="truncate">{entry.authorName}</span> : null}
          {entry.authorName && relativeTime ? <span aria-hidden="true">•</span> : null}
          {relativeTime ? <span>{relativeTime}</span> : null}
        </div>
      </div>
      {entry.tags.length > 0 ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {entry.tags.map((tag) => (
            <span key={tag} className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  )
}

function BranchSwitcher({
  currentBranchName,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
}: {
  currentBranchName?: string
  onListBranches: () => Promise<ChatBranchListResult>
  onCheckoutBranch: (branch: ChatBranchListEntry) => Promise<void>
  onCreateBranch: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [query, setQuery] = useState("")
  const [branchList, setBranchList] = useState<ChatBranchListResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setIsLoading(true)
    setError(null)
    void onListBranches()
      .then((result) => setBranchList(result))
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [onListBranches, open])

  const normalizedQuery = query.trim().toLowerCase()
  const filterEntries = (entries: ChatBranchListEntry[]) => entries.filter((entry) => {
    if (!normalizedQuery) return true
    return [
      entry.displayName,
      entry.name,
      entry.description,
      entry.prTitle,
      entry.headLabel,
    ].some((value) => value?.toLowerCase().includes(normalizedQuery))
  })

  const currentName = branchList?.currentBranchName ?? currentBranchName
  const pullRequestHeadNames = new Set((branchList?.pullRequests ?? []).map((entry) => entry.headRefName ?? entry.name))
  const recent = filterEntries(branchList?.recent ?? []).filter((entry) => entry.name !== currentName)
  const local = filterEntries(branchList?.local ?? []).filter((entry) => entry.name !== currentName)
  const remote = filterEntries(branchList?.remote ?? []).filter((entry) => entry.name !== currentName && !pullRequestHeadNames.has(entry.name))
  const pullRequests = filterEntries(branchList?.pullRequests ?? []).filter((entry) => entry.name !== currentName)

  async function handleCheckout(entry: ChatBranchListEntry) {
    setIsMutating(true)
    try {
      await onCheckoutBranch(entry)
      setOpen(false)
      setQuery("")
    } finally {
      setIsMutating(false)
    }
  }

  async function handleCreate() {
    setIsMutating(true)
    try {
      await onCreateBranch()
      setOpen(false)
      setQuery("")
    } finally {
      setIsMutating(false)
    }
  }

  function BranchSection({
    title,
    entries,
    emptyLabel,
  }: {
    title: string
    entries: ChatBranchListEntry[]
    emptyLabel?: string
  }) {
    if (entries.length === 0 && !emptyLabel) {
      return null
    }

    return (
      <div className="space-y-1">
        <div className="sticky top-0 z-10 bg-background px-1 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </div>
        {entries.length === 0 ? (
          <div className="px-1 py-1 text-xs text-muted-foreground">{emptyLabel}</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              disabled={isMutating}
              onClick={() => {
                void handleCheckout(entry)
              }}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent disabled:opacity-60"
            >
              {entry.kind === "pull_request"
                ? <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="flex w-full items-center gap-3">
                  <div className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm text-foreground">{entry.displayName}</div>
                  {entry.updatedAt ? (
                    <div className="ml-auto shrink-0 text-right text-[11px] text-muted-foreground">
                      {formatRelativeTime(entry.updatedAt)}
                    </div>
                  ) : null}
                </div>
                {entry.kind === "pull_request" && entry.description ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {entry.description}
                  </div>
                ) : null}
              </div>
            </button>
          ))
        )}
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Open branch switcher"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{currentBranchName ?? "Detached HEAD"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-2">
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search branches"
                className="h-8 pl-7 text-sm"
                disabled={isLoading || isMutating}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => void handleCreate()} disabled={isLoading || isMutating} className="h-8 px-2 text-xs hover:!bg-transparent hover:!border-border/0">
              + New
            </Button>
          </div>
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              <span>Loading branches…</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">{error}</div>
          ) : (
            <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1.5 -mr-[8px]">
              <BranchSection title="Recent" entries={recent} emptyLabel="No recent branches." />
              <BranchSection title="Local" entries={local} emptyLabel="No local branches." />
              <BranchSection title="Remote" entries={remote} emptyLabel="No remote branches." />
              <BranchSection
                title="Pull Requests"
                entries={pullRequests}
                emptyLabel={
                  branchList?.pullRequestsStatus === "error"
                    ? branchList.pullRequestsError ?? "Could not load pull requests."
                    : branchList?.pullRequestsStatus === "unavailable"
                      ? "Pull requests unavailable for this repository."
                      : "No open pull requests."
                }
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DiffFileCard({
  file,
  rootRef,
  projectId,
  isCollapsed,
  isChecked,
  editorLabel,
  diffRenderMode,
  wrapLines,
  onToggleCollapsed,
  onToggleChecked,
  onOpenFile,
  onDiscardFile,
  onIgnoreFile,
  onCopyFilePath,
  onCopyRelativePath,
}: {
  file: DiffFile
  rootRef: RefObject<HTMLDivElement | null>
  projectId: string | null
  isCollapsed: boolean
  isChecked: boolean
  editorLabel: string
  diffRenderMode: DiffRenderMode
  wrapLines: boolean
  onToggleCollapsed: () => void
  onToggleChecked: () => void
  onOpenFile: (path: string) => void
  onDiscardFile: (path: string) => void
  onIgnoreFile: (path: string) => void
  onCopyFilePath: (path: string) => void
  onCopyRelativePath: (path: string) => void
}) {
  const counts = getPatchCounts(file.patch)
  const canIgnore = canIgnoreDiffFile(file)
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const { sentinelRef, isStuck } = useStickyState<HTMLDivElement>({
    rootRef,
    disabled: isCollapsed,
  })
  const previewAttachment = useMemo(() => getDiffPreviewAttachment(projectId, file), [file, projectId])

  function handleAttachmentClick(attachment: ChatAttachment) {
    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }
    setSelectedAttachmentId(attachment.id)
  }

  function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    cardRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
      view: window,
    }))
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={cardRef} key={file.path} className="relative rounded-lg border border-border bg-background">
          {!isCollapsed ? <div ref={sentinelRef} className="pointer-events-none absolute inset-x-0 top-0 h-px" aria-hidden="true" /> : null}
          <div
            role="button"
            tabIndex={0}
            onClick={onToggleCollapsed}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              onToggleCollapsed()
            }}
            className={cn(
              "group/header sticky top-0 z-20 flex cursor-pointer items-center justify-between gap-3 bg-background pl-[7px] pr-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              !isCollapsed && !isStuck && "rounded-t-[calc(theme(borderRadius.lg)-1px)]",
              isCollapsed && "rounded-[calc(theme(borderRadius.lg)-1px)]",
              !isCollapsed && "border-b border-border/50"
            )}
          >
            <div className="flex min-w-0 items-center">
              <StageCheckbox
                checked={isChecked}
                onClick={onToggleChecked}
              />
              <div className="min-w-0 truncate select-none ml-2 mr-1">{file.path}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2 select-none">
              <span className="whitespace-nowrap text-xs font-mono">
                {counts.additions > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{counts.additions}</span> : null}
                {counts.deletions > 0 ? (
                  <span className={counts.additions > 0 ? "ml-2 text-red-600 dark:text-red-400" : "text-red-600 dark:text-red-400"}>
                    -{counts.deletions}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                aria-label={`Open actions for ${file.path}`}
                onClick={openContextMenuFromButton}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Ellipsis className="h-3.5 w-3.5 shrink-0" />
              </button>
              {isCollapsed ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronUp className="h-3.5 w-3.5 shrink-0" />}
            </div>
          </div>
          {!isCollapsed ? (
            <div className="kanna-diff-patch overflow-hidden rounded-b-[calc(theme(borderRadius.lg)-1px)] pb-[1px]">
              {previewAttachment ? (
                <div className="flex justify-center p-3">
                  {previewAttachment.kind === "image" ? (
                    <AttachmentImageCard
                      attachment={previewAttachment}
                      onClick={() => handleAttachmentClick(previewAttachment)}
                    />
                  ) : (
                    <AttachmentFileCard
                      attachment={previewAttachment}
                      onClick={() => handleAttachmentClick(previewAttachment)}
                    />
                  )}
                </div>
              ) : (
                <PatchDiff
                  patch={file.patch}
                  options={{
                    diffStyle: diffRenderMode,
                    disableFileHeader: true,
                    disableBackground: false,
                    overflow: wrapLines ? "wrap" : "scroll",
                    lineDiffType: "word",
                    diffIndicators: "classic",
                  }}
                />
              )}
            </div>
          ) : null}
          <AttachmentPreviewModal
            attachment={previewAttachment && selectedAttachmentId === previewAttachment.id ? previewAttachment : null}
            onOpenChange={(open) => !open && setSelectedAttachmentId(null)}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenFile(file.path)
          }}
        >
          <Code className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in {editorLabel}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onDiscardFile(file.path)
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Discard Changes</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canIgnore}
          onSelect={(event) => {
            event.stopPropagation()
            if (!canIgnore) return
            onIgnoreFile(file.path)
          }}
        >
          <Ban className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Ignore File</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyFilePath(file.path)
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy File Path</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyRelativePath(file.path)
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy Relative Path</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function RightSidebarImpl({
  projectId,
  diffs,
  editorLabel,
  diffRenderMode,
  wrapLines,
  onOpenFile,
  onDiscardFile,
  onIgnoreFile,
  onCopyFilePath,
  onCopyRelativePath,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  onGenerateCommitMessage,
  onCommit,
  onSyncWithRemote,
  onDiffRenderModeChange,
  onWrapLinesChange,
  onClose,
}: RightSidebarProps) {
  const hasChanges = diffs.files.length > 0
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(diffs.files.map((file) => [file.path, true]))
  )
  const [viewMode, setViewMode] = useState<SidebarViewMode>(() => (hasChanges ? "changes" : "history"))
  const [summary, setSummary] = useState("")
  const [description, setDescription] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [commitModeInFlight, setCommitModeInFlight] = useState<DiffCommitMode | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const filePaths = useMemo(() => diffs.files.map((file) => file.path), [diffs.files])
  const filePathsKey = useMemo(() => filePaths.join("\u0000"), [filePaths])
  const checkedPaths = useDiffCommitStore((store) => (projectId ? (store.checkedPathsByProjectId[projectId] ?? EMPTY_CHECKED_PATHS) : EMPTY_CHECKED_PATHS))
  const reconcileCheckedPaths = useDiffCommitStore((store) => store.reconcileProject)
  const setCheckedPath = useDiffCommitStore((store) => store.setChecked)
  const setAllCheckedPaths = useDiffCommitStore((store) => store.setAllChecked)
  const previousHasChangesRef = useRef(hasChanges)

  useEffect(() => {
    setCollapsedPaths((current) => {
      const next: Record<string, boolean> = {}
      for (const filePath of filePaths) {
        next[filePath] = current[filePath] ?? true
      }
      if (
        Object.keys(current).length === Object.keys(next).length
        && Object.entries(next).every(([path, value]) => current[path] === value)
      ) {
        return current
      }
      return next
    })
  }, [filePaths, filePathsKey])

  useEffect(() => {
    if (!projectId) return
    reconcileCheckedPaths(projectId, filePaths)
  }, [filePaths, filePathsKey, projectId, reconcileCheckedPaths])

  useEffect(() => {
    const previousHasChanges = previousHasChangesRef.current
    if (previousHasChanges !== hasChanges) {
      setViewMode(hasChanges ? "changes" : "history")
      previousHasChangesRef.current = hasChanges
      return
    }
    previousHasChangesRef.current = hasChanges
  }, [hasChanges])

  const selectedPaths = useMemo(
    () => diffs.files.filter((file) => checkedPaths[file.path] ?? true).map((file) => file.path),
    [checkedPaths, diffs.files]
  )
  const selectedCount = selectedPaths.length
  const allSelected = diffs.files.length > 0 && selectedCount === diffs.files.length
  const someSelected = selectedCount > 0 && selectedCount < diffs.files.length
  const trimmedSummary = summary.trim()
  const hasSummary = trimmedSummary.length > 0
  const isCommitting = commitModeInFlight !== null
  const isBusy = isGenerating || isCommitting
  const branchHistory = diffs.branchHistory?.entries ?? []
  const behindCount = diffs.behindCount ?? 0
  const isPublishedBranch = diffs.hasUpstream === true
  const isPublishableBranch = diffs.hasUpstream === false && Boolean(diffs.branchName)
  const encodedBranchName = diffs.branchName
    ? diffs.branchName.split("/").map((segment) => encodeURIComponent(segment)).join("/")
    : null
  const syncAction: "fetch" | "pull" | "publish" = isPublishableBranch
    ? "publish"
    : behindCount > 0
      ? "pull"
      : "fetch"
  const compareUrl = diffs.originRepoSlug && encodedBranchName
    ? `https://github.com/${diffs.originRepoSlug}/compare/${encodedBranchName}?expand=1`
    : null
  const canOpenPullRequest = Boolean(
    isPublishedBranch
    && compareUrl
    && diffs.branchName
    && diffs.branchName !== diffs.defaultBranchName
  )
  const canGenerate = diffs.status === "ready"
    && selectedCount > 0
    && !isBusy
  const canCommit = diffs.status === "ready"
    && selectedCount > 0
    && hasSummary
    && !isBusy
  const primaryCommitMode: DiffCommitMode = diffs.hasUpstream ? "commit_and_push" : "commit_only"

  async function handleCommit(mode: DiffCommitMode) {
    if (!canCommit) return
    setCommitModeInFlight(mode)
    try {
      const result = await onCommit({
        paths: selectedPaths,
        summary: trimmedSummary,
        description: description.trim(),
        mode,
      })
      if (result?.ok || result?.localCommitCreated) {
        setSummary("")
        setDescription("")
      }
    } finally {
      setCommitModeInFlight(null)
    }
  }

  async function handleGenerate() {
    if (!canGenerate) return
    setIsGenerating(true)
    try {
      const result = await onGenerateCommitMessage({ paths: selectedPaths })
      setSummary(result.subject)
      setDescription(result.body)
    } finally {
      setIsGenerating(false)
    }
  }

  function handleCommitKeyDown(event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") {
      return
    }
    event.preventDefault()
    if (hasSummary) {
      void handleCommit(primaryCommitMode)
      return
    }
    void handleGenerate()
  }

  async function handleSync() {
    if (diffs.status !== "ready" || isSyncing) return
    setIsSyncing(true)
    try {
      await onSyncWithRemote(syncAction)
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className="h-full min-h-0 border-l border-border bg-background md:min-w-[370px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border pl-2.5 pr-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BranchSwitcher
              currentBranchName={diffs.branchName}
              onListBranches={onListBranches}
              onCheckoutBranch={onCheckoutBranch}
              onCreateBranch={onCreateBranch}
            />
          </div>
          {diffs.status === "ready" ? (
            syncAction === "publish" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleSync()}
                disabled={isSyncing}
                className="h-7 gap-1.5 px-2 text-xs hover:!bg-transparent hover:!border-border/0"
              >
                {isSyncing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                <span>Publish Branch</span>
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                {syncAction === "fetch" ? (
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleSync()}
                        disabled={isSyncing}
                        className="h-7 gap-1.5 px-2 text-xs hover:!bg-transparent hover:!border-border/0"
                      >
                        {isSyncing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        <span>Fetch</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{formatFetchTooltip(diffs.lastFetchedAt)}</TooltipContent>
                  </Tooltip>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleSync()}
                    disabled={isSyncing}
                    className="h-7 gap-1.5 px-2 text-xs hover:!bg-transparent hover:!border-border/0"
                  >
                    {isSyncing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    <span>Pull</span>
                    <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] text-muted-foreground">
                      {behindCount}
                    </span>
                  </Button>
                )}
                {canOpenPullRequest && compareUrl ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (typeof window === "undefined") return
                      window.open(compareUrl, "_blank", "noopener,noreferrer")
                    }}
                    className="h-7 gap-1.5 px-2 text-xs hover:!bg-transparent hover:!border-border/0"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />
                    <span>PR</span>
                  </Button>
                ) : null}
              </div>
            )
          ) : null}
        </div>
        <div className="relative min-h-0 flex-1">
          <div className="sticky top-0 z-30 pl-[14px] pr-[12px] pt-[6px] bg-gradient-to-b from-background to-transparent">
            <div className="relative h-[40px]  flex min-w-0 items-center justify-center gap-[13px]">
              <div className="flex min-w-0 flex-1 items-center justify-between gap-[13px] relative">
                {viewMode === "changes" ? (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
                    <StageCheckbox
                      checked={allSelected}
                      mixed={someSelected}
                      label={
                        someSelected
                          ? "Select all files for commit"
                          : allSelected
                            ? "Unselect all files from commit"
                            : "Select all files for commit"
                      }
                      onClick={() => {
                        if (!projectId || diffs.files.length === 0) return
                        setAllCheckedPaths(projectId, filePaths, someSelected ? true : !allSelected)
                      }}
                    />
                    <span>{selectedCount} files</span>
                  </div>
                ) : <div />}
                <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
                  <div className="pointer-events-auto">
                    <SegmentedControl
                      value={viewMode}
                      onValueChange={(value) => setViewMode(value)}
                      size="sm"
                      optionClassName="flex-1 justify-center"
                      options={[
                        { value: "changes", label: "Changes"},
                        { value: "history", label: "History" },
                      ]}
                    />
                  </div>
                </div>
                {viewMode === "changes" ? (
                  <div className="flex items-center gap-1">
                    <IconButton
                      label="Unified diff"
                      active={diffRenderMode === "unified"}
                      onClick={() => onDiffRenderModeChange("unified")}
                    >
                      <Rows3 className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Side-by-side diff"
                      active={diffRenderMode === "split"}
                      onClick={() => onDiffRenderModeChange("split")}
                    >
                      <Columns2 className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={wrapLines ? "Disable word wrap" : "Enable word wrap"}
                      active={wrapLines}
                      onClick={() => onWrapLinesChange(!wrapLines)}
                    >
                      <WrapText className="h-4 w-4" />
                    </IconButton>
                  </div>
                ) : <div />}
              </div>
            </div>
          </div>
          <div ref={scrollContainerRef} className="h-full overflow-y-auto [scrollbar-gutter:stable]">
            {diffs.status === "no_repo" ? (
              <div className="flex h-full items-center justify-center px-6 py-3 text-center">
                <p className="text-sm text-muted-foreground">Open a git repo to view current file diffs.</p>
              </div>
            ) : viewMode === "history" ? (
              branchHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 py-3 text-center">
                  <p className="text-sm text-muted-foreground">No recent commits on {diffs.branchName ?? "this branch"}.</p>
                </div>
              ) : (
                <div className="space-y-1.5 p-1.5">
                  {branchHistory.map((entry) => <CommitHistoryRow key={entry.sha} entry={entry} />)}
                </div>
              )
            ) : diffs.files.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 py-3 text-center">
                <p className="text-sm text-muted-foreground">No file changes.</p>
              </div>
            ) : (
              <div className="space-y-1.5 p-1.5 pb-44">
                {diffs.files.map((file) => {
                  const isCollapsed = collapsedPaths[file.path] ?? true
                  const isChecked = checkedPaths[file.path] ?? true

                  return (
                    <DiffFileCard
                      key={file.path}
                      file={file}
                      rootRef={scrollContainerRef}
                      projectId={projectId}
                      isCollapsed={isCollapsed}
                      isChecked={isChecked}
                      editorLabel={editorLabel}
                      diffRenderMode={diffRenderMode}
                      wrapLines={wrapLines}
                      onToggleCollapsed={() => setCollapsedPaths((current) => ({ ...current, [file.path]: !isCollapsed }))}
                      onToggleChecked={() => {
                        if (!projectId) return
                        setCheckedPath(projectId, file.path, !isChecked)
                      }}
                      onOpenFile={onOpenFile}
                      onDiscardFile={onDiscardFile}
                      onIgnoreFile={onIgnoreFile}
                      onCopyFilePath={onCopyFilePath}
                      onCopyRelativePath={onCopyRelativePath}
                    />
                  )
                })}
              </div>
            )}
          </div>
          
          {viewMode === "changes" ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-3 pt-14 overflow-y-auto [scrollbar-gutter:stable]">
            <div className="absolute inset-x-0 bottom-0 top-0 bg-gradient-to-t from-background to-transparent" />
            <div className="pointer-events-auto relative mx-auto max-w-[550px]">
              <div className="space-y-0 rounded-xl bg-background">
                <Input
                  value={summary}
                  onChange={(event) => {
                    setSummary(event.target.value)
                  }}
                  onKeyDown={handleCommitKeyDown}
                  placeholder="Commit message (override)"
                  className="rounded-t-xl rounded-b-none px-3"
                  disabled={isBusy || diffs.status !== "ready"}
                />
                <Textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onKeyDown={handleCommitKeyDown}
                  placeholder="Description"
                  rows={3}
                  className="-mt-px rounded-t-none rounded-b-xl px-3 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:border-border mb-2"
                  disabled={isBusy || diffs.status !== "ready"}
                />
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <Button
                      type="button"
                      className="-mt-px w-full rounded-xl "
                      disabled={hasSummary ? !canCommit : !canGenerate}
                      onClick={() => {
                        if (hasSummary) {
                          void handleCommit(primaryCommitMode)
                          return
                        }
                        void handleGenerate()
                      }}
                    >
                      {hasSummary
                        ? (isCommitting
                          ? (commitModeInFlight === "commit_only" ? "Committing..." : "Committing & Pushing...")
                          : diffs.hasUpstream
                            ? `Commit & Push ${selectedCount} ${selectedCount === 1 ? "file" : "files"} to ${diffs.branchName ?? "current branch"}`
                            : `Commit ${selectedCount} ${selectedCount === 1 ? "file" : "files"} to ${diffs.branchName ?? "current branch"}`)
                        : (isGenerating
                          ? "Generating..."
                          : `Generate message for ${selectedCount} ${selectedCount === 1 ? "file" : "files"} on ${diffs.branchName ?? "current branch"}`)}
                    </Button>
                  </ContextMenuTrigger>
                  {diffs.hasUpstream ? (
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={!hasSummary || !canCommit}
                        onSelect={(event) => {
                          event.stopPropagation()
                          void handleCommit("commit_only")
                        }}
                      >
                        Commit Only
                      </ContextMenuItem>
                    </ContextMenuContent>
                  ) : null}
                </ContextMenu>
              </div>
            </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export const RightSidebar = memo(RightSidebarImpl)

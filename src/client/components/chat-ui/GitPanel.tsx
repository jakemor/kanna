import { Check, Columns2, Download, GitBranch, GitBranchPlus, Github, GitPullRequest, LoaderCircle, PenLine, RefreshCw, Rows3, Sparkles, Upload, WrapText } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatDiffSnapshot,
  DiffCommitMode,
  DiffCommitResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
} from "../../../shared/types"
import { formatRelativeTime } from "../../lib/formatters"
import { isDiffPathChecked, useDiffCommitStore } from "../../stores/diffCommitStore"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import { Button } from "../ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"
import { Input } from "../ui/input"
import { SegmentedControl } from "../ui/segmented-control"
import { Textarea } from "../ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { BranchSwitcher } from "./git/BranchSwitcher"
import { CommitHistoryRow } from "./git/CommitHistoryRow"
import { DiffFileCard, type DiffFileActions } from "./git/DiffFileCard"
import { GitHubPublishModal } from "./git/GitHubPublishModal"
import { IconButton, StageCheckbox, type DiffRenderMode } from "./git/shared"

export { canIgnoreDiffFile, canIgnoreDiffFolder, shouldLoadDiffPatchNow } from "./git/DiffFileCard"
export type { DiffFileActions } from "./git/DiffFileCard"

type SidebarViewMode = "changes" | "history"
const EMPTY_CHECKED_PATHS: Record<string, boolean> = {}

// Rendering thousands of file cards at once makes the whole app sluggish, so
// the changes list is paginated and expanded on demand.
export const INITIAL_VISIBLE_DIFF_FILE_COUNT = 200
export const VISIBLE_DIFF_FILE_INCREMENT = 300

interface GitPanelProps extends DiffFileActions {
  projectId: string | null
  diffs: ChatDiffSnapshot
  editorLabel: string
  diffRenderMode: DiffRenderMode
  wrapLines: boolean
  onLoadPatch: (path: string) => Promise<string>
  onListBranches: () => Promise<ChatBranchListResult>
  onPreviewMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergePreviewResult>
  onMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergeBranchResult | null>
  onCheckoutBranch: (branch: ChatBranchListEntry) => Promise<void>
  onCreateBranch: () => Promise<void>
  onGenerateCommitMessage: (args: { paths: string[] }) => Promise<{ subject: string; body: string }>
  onInitializeGit: () => Promise<unknown>
  onGetGitHubPublishInfo: () => Promise<GitHubPublishInfo>
  onCheckGitHubRepoAvailability: (args: { owner: string; name: string }) => Promise<GitHubRepoAvailabilityResult>
  onSetupGitHub: (args: { owner: string; name: string; visibility: "public" | "private"; description: string }) => Promise<unknown>
  onCommit: (args: { paths: string[]; summary: string; description: string; mode: DiffCommitMode }) => Promise<DiffCommitResult | null>
  onSyncWithRemote: (action: "fetch" | "pull" | "push" | "publish") => Promise<unknown>
  onDiffRenderModeChange: (mode: DiffRenderMode) => void
  onWrapLinesChange: (wrap: boolean) => void
  onClose: () => void
}

export function getPrimaryCommitActionPrefix(args: {
  hasSummary: boolean
  isGenerating: boolean
  isCommitting: boolean
  isGeneratedCommitInFlight: boolean
  commitModeInFlight: DiffCommitMode | null
  primaryCommitMode: DiffCommitMode
}) {
  if (args.hasSummary) {
    if (args.isCommitting) {
      if (args.isGeneratedCommitInFlight) {
        return args.commitModeInFlight === "commit_only" ? "Committing..." : "Pushing..."
      }
      return args.commitModeInFlight === "commit_only" ? "Committing..." : "Committing & Pushing..."
    }
    return args.primaryCommitMode === "commit_only" ? "Commit to" : "Commit & push to"
  }

  if (args.isGenerating) {
    return "Generating..."
  }
  return args.primaryCommitMode === "commit_only" ? "Generate & commit to" : "Generate & push to"
}

function formatFetchTooltip(isoTimestamp?: string) {
  if (!isoTimestamp) {
    return "No local fetch recorded"
  }
  return `Last fetched ${formatRelativeTime(isoTimestamp)}`
}

function GitPanelImpl({
  projectId,
  diffs,
  editorLabel,
  diffRenderMode,
  wrapLines,
  onOpenFile,
  onOpenInFinder,
  onDiscardFile,
  onIgnoreFile,
  onIgnoreFolder,
  onCopyFilePath,
  onCopyRelativePath,
  onListBranches,
  onPreviewMergeBranch,
  onMergeBranch,
  onCheckoutBranch,
  onCreateBranch,
  onGenerateCommitMessage,
  onInitializeGit,
  onGetGitHubPublishInfo,
  onCheckGitHubRepoAvailability,
  onSetupGitHub,
  onCommit,
  onSyncWithRemote,
  onLoadPatch,
  onDiffRenderModeChange,
  onWrapLinesChange,
  onClose,
}: GitPanelProps) {
  const fileActions: DiffFileActions = useMemo(() => ({
    onOpenFile,
    onOpenInFinder,
    onDiscardFile,
    onIgnoreFile,
    onIgnoreFolder,
    onCopyFilePath,
    onCopyRelativePath,
  }), [onOpenFile, onOpenInFinder, onDiscardFile, onIgnoreFile, onIgnoreFolder, onCopyFilePath, onCopyRelativePath])
  const hasChanges = diffs.files.length > 0
  const [isGenerating, setIsGenerating] = useState(false)
  const [commitModeInFlight, setCommitModeInFlight] = useState<DiffCommitMode | null>(null)
  const [isGeneratedCommitInFlight, setIsGeneratedCommitInFlight] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isGitHubPublishModalOpen, setIsGitHubPublishModalOpen] = useState(false)
  const [patchesByPath, setPatchesByPath] = useState<Record<string, string>>({})
  const [patchErrorsByPath, setPatchErrorsByPath] = useState<Record<string, string>>({})
  const [loadingPatchPaths, setLoadingPatchPaths] = useState<Record<string, boolean>>({})
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const patchDigestsByPathRef = useRef<Record<string, string>>({})
  const [visibleFileCount, setVisibleFileCount] = useState(INITIAL_VISIBLE_DIFF_FILE_COUNT)
  const filePaths = useMemo(() => diffs.files.map((file) => file.path), [diffs.files])
  const filePathsKey = useMemo(() => filePaths.join("\u0000"), [filePaths])
  const viewMode = useRightSidebarStore((store) => (projectId ? (store.projectUi[projectId]?.viewMode ?? (hasChanges ? "changes" : "history")) : (hasChanges ? "changes" : "history")))
  const collapsedPaths = useRightSidebarStore((store) => (projectId ? (store.projectUi[projectId]?.collapsedPaths ?? EMPTY_CHECKED_PATHS) : EMPTY_CHECKED_PATHS))
  const summary = useRightSidebarStore((store) => (projectId ? (store.projectUi[projectId]?.summary ?? "") : ""))
  const description = useRightSidebarStore((store) => (projectId ? (store.projectUi[projectId]?.description ?? "") : ""))
  const reconcileCollapsedPaths = useRightSidebarStore((store) => store.reconcileCollapsedPaths)
  const toggleCollapsedPath = useRightSidebarStore((store) => store.toggleCollapsedPath)
  const setViewMode = useRightSidebarStore((store) => store.setViewMode)
  const setCommitDraft = useRightSidebarStore((store) => store.setCommitDraft)
  const clearCommitDraft = useRightSidebarStore((store) => store.clearCommitDraft)
  const diffCommitSelection = useDiffCommitStore((store) => (projectId ? store.selectionsByProjectId[projectId] : undefined))
  const reconcileCheckedPaths = useDiffCommitStore((store) => store.reconcileProject)
  const setCheckedPath = useDiffCommitStore((store) => store.setChecked)
  const setAllCheckedPaths = useDiffCommitStore((store) => store.setAllChecked)
  const previousHasChangesRef = useRef(hasChanges)

  useEffect(() => {
    setVisibleFileCount(INITIAL_VISIBLE_DIFF_FILE_COUNT)
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    reconcileCollapsedPaths(projectId, filePaths)
  }, [filePaths, filePathsKey, projectId, reconcileCollapsedPaths])

  useEffect(() => {
    const nextDigestsByPath = Object.fromEntries(diffs.files.map((file) => [file.path, file.patchDigest]))
    const filePathSet = new Set(filePaths)
    const isCurrentDigest = (path: string) => patchDigestsByPathRef.current[path] === nextDigestsByPath[path]
    setPatchesByPath((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => filePathSet.has(path) && isCurrentDigest(path))
    ))
    setPatchErrorsByPath((current) => Object.fromEntries(Object.entries(current).filter(([path]) => filePathSet.has(path) && isCurrentDigest(path))))
    setLoadingPatchPaths((current) => Object.fromEntries(Object.entries(current).filter(([path]) => filePathSet.has(path) && isCurrentDigest(path))))
    patchDigestsByPathRef.current = nextDigestsByPath
  }, [diffs.files, filePaths, filePathsKey])

  useEffect(() => {
    if (!projectId) return
    reconcileCheckedPaths(projectId, filePaths)
  }, [filePaths, filePathsKey, projectId, reconcileCheckedPaths])

  useEffect(() => {
    if (!projectId) return
    const previousHasChanges = previousHasChangesRef.current
    if (previousHasChanges !== hasChanges) {
      setViewMode(projectId, hasChanges ? "changes" : "history")
      previousHasChangesRef.current = hasChanges
      return
    }
    previousHasChangesRef.current = hasChanges
  }, [hasChanges, projectId, setViewMode])

  const selectedPaths = useMemo(
    () => diffs.files.filter((file) => isDiffPathChecked(diffCommitSelection, file.path)).map((file) => file.path),
    [diffCommitSelection, diffs.files]
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
  const aheadCount = diffs.aheadCount ?? 0
  const isPublishedBranch = diffs.hasUpstream === true
  const isPublishableBranch = diffs.hasUpstream === false && Boolean(diffs.branchName)
  const hasRemoteOrigin = diffs.hasOriginRemote === true
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
  const primaryCommitMode: DiffCommitMode = hasRemoteOrigin ? "commit_and_push" : "commit_only"
  const resolvedBranchName = diffs.branchName ?? "current branch"
  const primaryCommitActionPrefix = getPrimaryCommitActionPrefix({
    hasSummary,
    isGenerating,
    isCommitting,
    isGeneratedCommitInFlight,
    commitModeInFlight,
    primaryCommitMode,
  })

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
        if (projectId) {
          clearCommitDraft(projectId)
        }
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
      if (projectId) {
        setCommitDraft(projectId, {
          summary: result.subject,
          description: result.body,
        })
      }
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleGenerateAndCommit(mode: DiffCommitMode) {
    if (!canGenerate) return
    setIsGenerating(true)
    try {
      const result = await onGenerateCommitMessage({ paths: selectedPaths })
      const generatedSummary = result.subject.trim()
      const generatedDescription = result.body.trim()
      if (projectId) {
        setCommitDraft(projectId, {
          summary: result.subject,
          description: result.body,
        })
      }
      if (!generatedSummary) {
        return
      }

      setIsGenerating(false)
      setIsGeneratedCommitInFlight(true)
      setCommitModeInFlight(mode)
      const commitResult = await onCommit({
        paths: selectedPaths,
        summary: generatedSummary,
        description: generatedDescription,
        mode,
      })
      if (commitResult?.ok || commitResult?.localCommitCreated) {
        if (projectId) {
          clearCommitDraft(projectId)
        }
      }
    } finally {
      setIsGenerating(false)
      setIsGeneratedCommitInFlight(false)
      setCommitModeInFlight(null)
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
    void handleGenerateAndCommit(primaryCommitMode)
  }

  async function handleSync(action: "fetch" | "pull" | "push" | "publish" = syncAction) {
    if (diffs.status !== "ready" || isSyncing) return
    setIsSyncing(true)
    try {
      await onSyncWithRemote(action)
    } finally {
      setIsSyncing(false)
    }
  }

  const handleLoadPatch = useCallback(async (path: string) => {
    if (patchesByPath[path] !== undefined || loadingPatchPaths[path]) {
      return patchesByPath[path] ?? ""
    }

    setLoadingPatchPaths((current) => ({ ...current, [path]: true }))
    setPatchErrorsByPath((current) => {
      if (!(path in current)) return current
      const { [path]: _removed, ...rest } = current
      return rest
    })

    try {
      const patch = await onLoadPatch(path)
      setPatchesByPath((current) => ({ ...current, [path]: patch }))
      const digest = diffs.files.find((file) => file.path === path)?.patchDigest
      if (digest) {
        patchDigestsByPathRef.current = {
          ...patchDigestsByPathRef.current,
          [path]: digest,
        }
      }
      return patch
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPatchErrorsByPath((current) => ({ ...current, [path]: message }))
      throw error
    } finally {
      setLoadingPatchPaths((current) => {
        const { [path]: _removed, ...rest } = current
        return rest
      })
    }
  }, [diffs.files, loadingPatchPaths, onLoadPatch, patchesByPath])

  return (
    <div className="h-full min-h-0 border-l border-border bg-background md:min-w-[370px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border pl-2.5 pr-2 h-[49px]">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BranchSwitcher
              currentBranchName={diffs.branchName}
              onListBranches={onListBranches}
              onPreviewMergeBranch={onPreviewMergeBranch}
              onMergeBranch={onMergeBranch}
              onCheckoutBranch={onCheckoutBranch}
              onCreateBranch={onCreateBranch}
            />
          </div>
          {diffs.status === "ready" ? (
            !hasRemoteOrigin ? (
              <Button
                variant="default"
                size="sm"
                onClick={() => setIsGitHubPublishModalOpen(true)}
                className="h-7 gap-1.5 px-3 text-xs"
              >
                <Github className="h-3.5 w-3.5" />
                <span>Push to GitHub</span>
              </Button>
            ) : syncAction === "publish" ? (
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
                {isPublishedBranch && aheadCount > 0 ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void handleSync("push")}
                    disabled={isSyncing}
                    className="h-7 gap-1.5 px-2 text-xs"
                  >
                    {isSyncing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    <span>Push</span>
                    <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary-foreground/15 px-1 text-[10px] text-primary-foreground">
                      {aheadCount}
                    </span>
                  </Button>
                ) : null}
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
                      onValueChange={(value) => {
                        if (!projectId) return
                        setViewMode(projectId, value as SidebarViewMode)
                      }}
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
                <div className="flex max-w-[280px] flex-col items-center gap-3">
                  <p className="text-sm text-muted-foreground">Initialize git here to start tracking branches, diffs, and history.</p>
                  <Button size="sm" onClick={() => void onInitializeGit()}>
                    Init Git
                  </Button>
                </div>
              </div>
            ) : viewMode === "history" ? (
              branchHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6 py-3 text-center">
                  <p className="text-sm text-muted-foreground">No recent commits on {diffs.branchName ?? "this branch"}.</p>
                </div>
              ) : (
                <div className="space-y-1.5 p-1.5">
                  {branchHistory.map((entry, index) => <CommitHistoryRow key={entry.sha} entry={entry} isPendingPush={index < aheadCount} />)}
                </div>
              )
            ) : diffs.files.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 py-3 text-center">
                <p className="text-sm text-muted-foreground">No file changes.</p>
              </div>
            ) : (
              <div className="space-y-1.5 p-1.5 pb-10">
                {(visibleFileCount < diffs.files.length ? diffs.files.slice(0, visibleFileCount) : diffs.files).map((file) => {
                  const isCollapsed = collapsedPaths[file.path] ?? true
                  const isChecked = isDiffPathChecked(diffCommitSelection, file.path)

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
                      onToggleCollapsed={() => {
                        if (!projectId) return
                        toggleCollapsedPath(projectId, file.path)
                      }}
                      onToggleChecked={() => {
                        if (!projectId) return
                        setCheckedPath(projectId, file.path, !isChecked)
                      }}
                      fileActions={fileActions}
                      patch={patchesByPath[file.path]}
                      patchError={patchErrorsByPath[file.path]}
                      isPatchLoading={Boolean(loadingPatchPaths[file.path])}
                      onLoadPatch={handleLoadPatch}
                    />
                  )
                })}
                {visibleFileCount < diffs.files.length ? (
                  <button
                    type="button"
                    onClick={() => setVisibleFileCount((count) => count + VISIBLE_DIFF_FILE_INCREMENT)}
                    className="flex w-full items-center justify-center rounded-lg border border-dashed border-border px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    Show {Math.min(VISIBLE_DIFF_FILE_INCREMENT, diffs.files.length - visibleFileCount)} more of {(diffs.files.length - visibleFileCount).toLocaleString()} remaining files
                  </button>
                ) : null}

                {viewMode === "changes" ? (
                  <div className="pointer-events-none sticky inset-x-0 bottom-11 py-1 pb-6 z-30 overflow-y-auto">
                  <div className="absolute inset-x-0 bottom-0 top-0 bg-gradient-to-t from-background to-transparent" />
                  <div className="pointer-events-auto relative">
                    <div className="space-y-0 rounded-xl  backdrop-blur-md mx-auto max-w-[700px]">
                      <div className="relative">
                        <Input
                          value={summary}
                          onChange={(event) => {
                            if (!projectId) return
                            setCommitDraft(projectId, {
                              summary: event.target.value,
                              description,
                            })
                          }}
                          onKeyDown={handleCommitKeyDown}
                          placeholder="Commit message"
                          className="rounded-t-xl rounded-b-none px-3 pr-10"
                          disabled={isBusy || diffs.status !== "ready"}
                        />
                        <Tooltip delayDuration={0}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Generate commit message"
                              className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                              disabled={!canGenerate}
                              onClick={() => void handleGenerate()}
                            >
                              {isGenerating ? (
                                <LoaderCircle strokeWidth={2.5} className="size-3.5 animate-spin" />
                              ) : (
                                <Sparkles strokeWidth={2.5} className="size-3.5" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Generate commit message</TooltipContent>
                        </Tooltip>
                      </div>
                      <Textarea
                        value={description}
                        onChange={(event) => {
                          if (!projectId) return
                          setCommitDraft(projectId, {
                            summary,
                            description: event.target.value,
                          })
                        }}
                        onKeyDown={handleCommitKeyDown}
                        placeholder="Description"
                        rows={5}
                        className="-mt-px rounded-t-none rounded-b-xl px-3 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:border-border mb-2"
                        disabled={isBusy || diffs.status !== "ready"}
                      />
                      <div className="w-full flex flex-row">
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <Button
                            type="button"
                            className="-mt-px w-full rounded-xl"
                            disabled={hasSummary ? !canCommit : !canGenerate}
                            onClick={() => {
                              if (hasSummary) {
                                void handleCommit(primaryCommitMode)
                                return
                              }
                              void handleGenerateAndCommit(primaryCommitMode)
                            }}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              {hasSummary ? (
                                isCommitting ? (
                                  <LoaderCircle strokeWidth={2.5} className="size-3 shrink-0 animate-spin" />
                                ) : primaryCommitMode === "commit_and_push" ? diffs.hasUpstream ? (
                                  <Upload strokeWidth={2.5} className="size-3 shrink-0" />
                                ) : (
                                  <GitBranchPlus strokeWidth={2.5} className="size-3 shrink-0" />
                                ) : (
                                  <Check strokeWidth={2.5} className="size-3 shrink-0" />
                                )
                              ) : isGenerating ? (
                                <LoaderCircle strokeWidth={2.5} className="size-3 shrink-0 animate-spin" />
                              ) : (
                                <PenLine strokeWidth={2.5} className="size-3 shrink-0" />
                              )}
                              <span className="min-w-0 truncate text-left">
                                {isGenerating || isCommitting
                                  ? primaryCommitActionPrefix
                                  : <>{primaryCommitActionPrefix} <GitBranch strokeWidth={2.5} className="mr-[4.5px] ml-0.5 inline size-3 " />{resolvedBranchName}</>}
                              </span>
                            </span>
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
                  </div>
                ) : null}
              </div>
            )}
          </div>


        </div>
        <GitHubPublishModal
          open={isGitHubPublishModalOpen}
          onOpenChange={setIsGitHubPublishModalOpen}
          onGetGitHubPublishInfo={onGetGitHubPublishInfo}
          onCheckGitHubRepoAvailability={onCheckGitHubRepoAvailability}
          onPublish={onSetupGitHub}
        />
      </div>
    </div>
  )
}

export const GitPanel = memo(GitPanelImpl)

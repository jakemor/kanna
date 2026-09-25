import { ArrowDown, ArrowUp, Check, FileDiff, GitBranch, GitBranchPlus, GitMerge, Github, GitPullRequest, History, LoaderCircle, Pencil, PenLine, RefreshCw, Sparkles, Upload } from "lucide-react"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type {
  ChatBranchDetails,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCommitDetails,
  ChatDiffSnapshot,
  DiffCommitMode,
  DiffCommitResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
} from "../../../../shared/types"
import { formatRelativeTime } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { isDiffPathChecked, useDiffCommitStore } from "../../../stores/diffCommitStore"
import { openViewer, useReviewedPath } from "../../../stores/viewerStore"
import { useRightSidebarStore } from "../../../stores/rightSidebarStore"
import { Button } from "../../ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../ui/context-menu"
import { Input } from "../../ui/input"
import { Textarea } from "../../ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { BranchPicker } from "../git/BranchPicker"
import { CommitHistoryRow } from "../git/CommitHistoryRow"
import { CommitHoverCard } from "../git/CommitHoverCard"
import { DiffFileHoverCard } from "../git/DiffFileHoverCard"
import { DiffFileRow, type DiffFileActions } from "../git/DiffFileRow"
import { GitHubPublishModal } from "../git/GitHubPublishModal"
import { MergeBranchModal } from "../git/MergeBranchModal"
import { DiffFileStat, sortByPath, StageCheckbox } from "../git/shared"
import {
  WIDGET_FOOTER_BUTTON_CLASS,
  WIDGET_FOOTER_ICON_BUTTON_CLASS,
  WIDGET_ROW_REVEAL_CLASS,
  WIDGET_STRIP_INPUT_CLASS,
  WidgetFooter,
  WidgetList,
  WidgetMoreRow,
  WidgetStatic,
  WidgetStrip,
} from "./parts"
import { SwapIn, useWidgetExpanded, WidgetCard, WidgetPresence } from "./WidgetCard"

export { canIgnoreDiffFile, canIgnoreDiffFolder } from "../git/DiffFileRow"
export type { DiffFileActions } from "../git/DiffFileRow"

// The Changes list opens on a screenful and pages on from there: the card is
// an index, and thousands of rows at once make the whole app sluggish.
/**
 * The Changes search: every word of the query in the file's path, in any
 * order, ignoring case ("widget card" finds widgets/WidgetCard.tsx). Keeps
 * the list's order.
 */
export function filterFilesByQuery<T extends { path: string }>(files: readonly T[], query: string): readonly T[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return files
  return files.filter((file) => {
    const path = file.path.toLowerCase()
    return words.every((word) => path.includes(word))
  })
}

export const INITIAL_VISIBLE_DIFF_FILE_COUNT = 5
export const VISIBLE_DIFF_FILE_INCREMENT = 200
// History opens on the latest few commits; "Show more" reveals the rest of
// what the server sends, which is 25 (diff-store's BRANCH_HISTORY_LIMIT).
export const INITIAL_VISIBLE_HISTORY_COUNT = 5

/**
 * The Changes header: what the commit button will commit. With every file
 * checked (the default) that is simply the change set; once some are
 * unchecked it says "3 of 5" and the totals count only the checked files,
 * because the commit row stays in view while the list is collapsed and the
 * header is then the only place the selection shows.
 */
export function summarizeChanges(
  files: ReadonlyArray<{ path: string; additions?: number; deletions?: number }>,
  selectedPaths: ReadonlySet<string>,
) {
  const partial = files.some((file) => !selectedPaths.has(file.path))
  const counted = partial ? files.filter((file) => selectedPaths.has(file.path)) : files
  const noun = files.length === 1 ? "file" : "files"
  return {
    title: partial ? `${counted.length} of ${files.length} ${noun} changed` : `${files.length} ${noun} changed`,
    additions: counted.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }
}

/** The commits History lists, and how many a "Show more" would add. */
export function visibleHistoryEntries<T>(entries: T[], showAll: boolean) {
  const shown = showAll ? entries : entries.slice(0, INITIAL_VISIBLE_HISTORY_COUNT)
  return { shown, hiddenCount: entries.length - shown.length }
}

interface GitWidgetsProps extends DiffFileActions {
  projectId: string | null
  diffs: ChatDiffSnapshot
  editorLabel: string
  onListBranches: () => Promise<ChatBranchListResult>
  onPreviewMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergePreviewResult>
  onMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergeBranchResult | null>
  onCheckoutBranch: (branch: ChatBranchListEntry) => Promise<void>
  onCreateBranch: (args: { name: string; baseBranchName?: string }) => Promise<void>
  onGenerateCommitMessage: (args: { paths: string[] }) => Promise<{ subject: string; body: string }>
  onInitializeGit: () => Promise<unknown>
  onGetGitHubPublishInfo: () => Promise<GitHubPublishInfo>
  onCheckGitHubRepoAvailability: (args: { owner: string; name: string }) => Promise<GitHubRepoAvailabilityResult>
  onSetupGitHub: (args: { owner: string; name: string; visibility: "public" | "private"; description: string }) => Promise<unknown>
  onCommit: (args: { paths: string[]; summary: string; description: string; mode: DiffCommitMode }) => Promise<DiffCommitResult | null>
  onSyncWithRemote: (action: "fetch" | "pull" | "push" | "publish") => Promise<unknown>
  /** A commit's files and committer, for History's hover card. */
  onReadCommit?: (sha: string) => Promise<ChatCommitDetails>
  /** A branch's or PR's details, for the branch picker's hover card. */
  onReadBranch?: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>
  /** A changed file's patch, for the Changes rows' hover card peek. */
  onLoadPatch?: (path: string) => Promise<string>
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
        return args.commitModeInFlight === "commit_only" ? "Committing…" : "Pushing…"
      }
      return args.commitModeInFlight === "commit_only" ? "Committing…" : "Committing & Pushing…"
    }
    return args.primaryCommitMode === "commit_only" ? "Commit to" : "Commit & push to"
  }

  if (args.isGenerating) {
    return "Generating…"
  }
  return args.primaryCommitMode === "commit_only" ? "Generate & commit to" : "Generate & push to"
}

/** The icon-only Fetch button's tooltip: when it last ran. */
function formatFetchTooltip(isoTimestamp?: string) {
  if (!isoTimestamp) {
    return "No local fetch recorded"
  }
  return `Fetched ${formatRelativeTime(isoTimestamp)}`
}

/**
 * The git part of the widget column, three cards.
 *
 * Branch names the current branch and carries the sync controls (fetch, and
 * ↓/↑ counts to pull and push). It expands into the branch picker (find,
 * switch or create a branch), with Merge and PR in its footer. Changes is an
 * "N files changed" disclosure over the file list, an index: each row opens
 * its diff in the viewer over the chat, and the commit box stays in
 * view below. History lists recent commits.
 */
function GitWidgetsImpl({
  projectId,
  diffs,
  editorLabel,
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
  onReadCommit,
  onReadBranch,
  onLoadPatch,
}: GitWidgetsProps) {
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
  // The merge dialog belongs to the footer, which shows without the picker,
  // so it loads its own branch list when opened.
  const [mergeModalOpen, setMergeModalOpen] = useState(false)
  const [mergeBranchList, setMergeBranchList] = useState<ChatBranchListResult | null>(null)
  const [isGitHubPublishModalOpen, setIsGitHubPublishModalOpen] = useState(false)
  const [visibleFileCount, setVisibleFileCount] = useState(INITIAL_VISIBLE_DIFF_FILE_COUNT)
  const [fileQuery, setFileQuery] = useState("")
  const filePaths = useMemo(() => diffs.files.map((file) => file.path), [diffs.files])
  const filePathsKey = useMemo(() => filePaths.join("\u0000"), [filePaths])
  // Local, not persisted: the picker is a place you visit, not a view to keep open.
  const [branchesExpanded, setBranchesExpanded] = useState(false)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const historyListRef = useRef<HTMLDivElement | null>(null)
  const changesListRef = useRef<HTMLDivElement | null>(null)
  const [changesExpanded, setChangesExpanded] = useWidgetExpanded(projectId, "changes", diffs.files.length, true)
  // Tree order, here and in the viewer, as GitHub and VS Code list changes:
  // related files sit together and the order doesn't move as edits grow.
  const filesInOrder = useMemo(() => sortByPath(diffs.files), [diffs.files])
  const [historyExpanded, setHistoryExpanded] = useWidgetExpanded(projectId, "history", diffs.branchHistory?.entries.length ?? 0)
  const summary = useRightSidebarStore((store) => (projectId ? (store.projectUi[projectId]?.summary ?? "") : ""))
  const description = useRightSidebarStore((store) => (projectId ? (store.projectUi[projectId]?.description ?? "") : ""))
  // The message and description fields stay hidden behind the pencil: the
  // commit button generates a message by itself, so most commits never need
  // them. A draft already written starts them open, so you can see what the
  // button is about to commit.
  const [commitEditorOpen, setCommitEditorOpen] = useState(() => summary.trim().length > 0 || description.trim().length > 0)
  const commitMessageInputRef = useRef<HTMLInputElement | null>(null)
  const reviewedPath = useReviewedPath(projectId)

  // The row the viewer is on stays in sight: scrolling the diff list moves
  // the highlight here, so the list shows that row, past the first five if
  // it must be, and scrolls just far enough to show it.
  useEffect(() => {
    if (!reviewedPath) return
    const index = filterFilesByQuery(filesInOrder, fileQuery).findIndex((file) => file.path === reviewedPath)
    if (index === -1) return
    setVisibleFileCount((count) => Math.max(count, index + 1))
    requestAnimationFrame(() => {
      changesListRef.current
        ?.querySelector(`[data-row-key="${CSS.escape(reviewedPath)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  }, [fileQuery, filesInOrder, reviewedPath])
  const setCommitDraft = useRightSidebarStore((store) => store.setCommitDraft)
  const clearCommitDraft = useRightSidebarStore((store) => store.clearCommitDraft)
  const diffCommitSelection = useDiffCommitStore((store) => (projectId ? store.selectionsByProjectId[projectId] : undefined))
  const reconcileCheckedPaths = useDiffCommitStore((store) => store.reconcileProject)
  const setCheckedPath = useDiffCommitStore((store) => store.setChecked)
  const setAllCheckedPaths = useDiffCommitStore((store) => store.setAllChecked)

  useEffect(() => {
    setVisibleFileCount(INITIAL_VISIBLE_DIFF_FILE_COUNT)
    setFileQuery("")
    setShowAllHistory(false)
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    reconcileCheckedPaths(projectId, filePaths)
  }, [filePaths, filePathsKey, projectId, reconcileCheckedPaths])

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
  const visibleHistory = visibleHistoryEntries(branchHistory, showAllHistory)
  const changesSummary = useMemo(
    () => summarizeChanges(diffs.files, new Set(selectedPaths)),
    [diffs.files, selectedPaths],
  )
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
  const commitButtonState = hasSummary
    ? (isCommitting ? `committing:${commitModeInFlight}:${isGeneratedCommitInFlight}` : "commit")
    : (isGenerating ? "generating" : "generate")
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

  function openMergeModal() {
    setMergeModalOpen(true)
    setMergeBranchList(null)
    void onListBranches()
      .then(setMergeBranchList)
      // An empty list, not null: null is the dialog's loading skeleton, and
      // a failed load would otherwise pulse forever. The picker surfaces
      // load errors.
      .catch(() => setMergeBranchList({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "error" }))
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


  const syncButtonClass = "h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground hover:!bg-transparent hover:!border-border/0"
  const remoteSyncActions = !hasRemoteOrigin ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setIsGitHubPublishModalOpen(true)}
      className={syncButtonClass}
    >
      <Github className="size-3.5" />
      <span>Push to GitHub</span>
    </Button>
  ) : syncAction === "publish" ? (
    <Button variant="ghost" size="sm" onClick={() => void handleSync()} disabled={isSyncing} className={syncButtonClass}>
      {isSyncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
      <span>Publish</span>
    </Button>
  ) : (
    <>
      {syncAction === "fetch" ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            {/* Icon only: the refresh glyph says fetch; the tooltip says when it last ran. */}
            <Button variant="ghost" size="sm" aria-label="Fetch" onClick={() => void handleSync()} disabled={isSyncing} className={syncButtonClass}>
              {isSyncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{formatFetchTooltip(diffs.lastFetchedAt)}</TooltipContent>
        </Tooltip>
      ) : (
        // Counts, not words: at the column's width "Pull 3 · Push 2 · PR"
        // truncated the branch name, the one thing this header is for.
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`Pull ${behindCount}`} onClick={() => void handleSync()} disabled={isSyncing} className={syncButtonClass}>
              {isSyncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowDown className="size-3.5" />}
              <span className="tabular-nums">{behindCount}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pull {behindCount} {behindCount === 1 ? "commit" : "commits"}</TooltipContent>
        </Tooltip>
      )}
      {isPublishedBranch && aheadCount > 0 ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button variant="default" size="sm" aria-label={`Push ${aheadCount}`} onClick={() => void handleSync("push")} disabled={isSyncing} className="h-6 gap-1 px-1.5 text-xs">
              {isSyncing ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
              <span className="tabular-nums">{aheadCount}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Push {aheadCount} {aheadCount === 1 ? "commit" : "commits"}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )

  // Only while the card is open: merging and opening a PR are rare next to
  // reading the branch name, and an always-visible footer for them cost the
  // column 56px. New branch is not here: the picker's search creates one from
  // what you typed. A detached HEAD has nothing to merge into.
  const branchActions = diffs.status === "ready" && (diffs.branchName || canOpenPullRequest) ? (
    <WidgetFooter>
      {diffs.branchName ? (
        <Button type="button" variant="outline" className={WIDGET_FOOTER_BUTTON_CLASS} onClick={openMergeModal}>
          <span className="flex min-w-0 items-center gap-1.5">
            <GitMerge strokeWidth={2.5} className="size-3 shrink-0" />
            <span className="min-w-0 truncate text-left">
              {/* The ellipsis says it opens a dialog (pick the branch to merge), not a merge. */}
              Merge into <GitBranch strokeWidth={2.5} className="mr-[4.5px] ml-0.5 inline size-3" />{diffs.branchName}…
            </span>
          </span>
        </Button>
      ) : null}
      {canOpenPullRequest && compareUrl ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label="Open pull request"
              onClick={() => window.open(compareUrl, "_blank", "noopener,noreferrer")}
              className={WIDGET_FOOTER_ICON_BUTTON_CLASS}
            >
              <GitPullRequest strokeWidth={2.5} className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open pull request</TooltipContent>
        </Tooltip>
      ) : null}
    </WidgetFooter>
  ) : null

  // The message fields, over the commit buttons while the pencil is on.
  const commitFields = (
    <div>
      <div className="relative">
        <Input
          ref={commitMessageInputRef}
          value={summary}
          onChange={(event) => {
            if (!projectId) return
            setCommitDraft(projectId, { summary: event.target.value, description })
          }}
          onKeyDown={handleCommitKeyDown}
          placeholder="Commit message"
          className="rounded-t-xl rounded-b-none px-3 pr-10"
          disabled={isBusy}
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
              {isGenerating
                ? <LoaderCircle strokeWidth={2.5} className="size-3.5 animate-spin" />
                : <Sparkles strokeWidth={2.5} className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>Generate commit message</TooltipContent>
        </Tooltip>
      </div>
      <Textarea
        value={description}
        onChange={(event) => {
          if (!projectId) return
          setCommitDraft(projectId, { summary, description: event.target.value })
        }}
        onKeyDown={handleCommitKeyDown}
        placeholder="Description"
        rows={3}
        // No ring (it would clash with the input's edge above), but the
        // border still says which of the two fields has focus.
        className="-mt-px rounded-t-none rounded-b-xl px-3 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:border-ring"
        disabled={isBusy}
      />
    </div>
  )

  const commitBox = hasChanges && diffs.status === "ready" ? (
    <WidgetFooter above={commitEditorOpen ? commitFields : undefined}>
      {/* A split button, as the footer itself: the commit taking the width
          and the pencil an accessory at its end, like a split button's
          dropdown half. Each half lights on its own under the pointer, and
          the rule between them runs the full height, so each half's hover
          fill meets it edge to edge. */}
      <div className="flex h-full min-w-0 flex-1 items-stretch">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              disabled={hasSummary ? !canCommit : !canGenerate}
              onClick={() => {
                if (hasSummary) {
                  void handleCommit(primaryCommitMode)
                  return
                }
                void handleGenerateAndCommit(primaryCommitMode)
              }}
              className="flex h-full min-w-0 flex-1 items-center justify-center px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:text-foreground/50"
            >
              {/* Cross-fades per state: the label changes width and wording
                  while you watch it, and a hard swap reads as a flicker. */}
              <SwapIn swapKey={commitButtonState} className="min-w-0 gap-1.5">
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
              </SwapIn>
            </button>
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
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={commitEditorOpen ? "Hide commit message" : "Write commit message"}
              aria-pressed={commitEditorOpen}
              onClick={() => {
                const opening = !commitEditorOpen
                setCommitEditorOpen(opening)
                // Focus only on a click, never on mount: a draft that starts
                // the fields open must not pull focus out of the chat input.
                if (opening) requestAnimationFrame(() => commitMessageInputRef.current?.focus())
              }}
              className={cn(
                "flex h-full w-10 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                commitEditorOpen && "bg-muted text-foreground",
              )}
            >
              <Pencil strokeWidth={2.5} className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{commitEditorOpen ? "Hide commit message" : "Write commit message"}</TooltipContent>
        </Tooltip>
      </div>
    </WidgetFooter>
  ) : null

  const openFileReview = (path: string) => {
    if (projectId) openViewer({ kind: "diff", projectId, path })
  }
  const firstCheckedPath = filesInOrder.find((file) => isDiffPathChecked(diffCommitSelection, file.path))?.path ?? null
  // A search shows what it finds, a page at once rather than five: you typed
  // to get to a file, not to page through for it.
  const matchingFiles = filterFilesByQuery(filesInOrder, fileQuery)
  const searching = fileQuery.trim().length > 0
  const pageSize = searching ? Math.max(visibleFileCount, VISIBLE_DIFF_FILE_INCREMENT) : visibleFileCount
  const visibleFiles = pageSize < matchingFiles.length ? matchingFiles.slice(0, pageSize) : matchingFiles
  const hiddenFileCount = matchingFiles.length - visibleFiles.length
  // A page at a time (the count says what this click shows, and "left" what
  // remains), then "Show less" back to the first screenful.
  const filesMore = hiddenFileCount > 0 ? (
    <WidgetMoreRow
      count={Math.min(VISIBLE_DIFF_FILE_INCREMENT, hiddenFileCount)}
      detail={hiddenFileCount > VISIBLE_DIFF_FILE_INCREMENT ? `${hiddenFileCount.toLocaleString()} left` : undefined}
      onShow={() => setVisibleFileCount((count) => count + VISIBLE_DIFF_FILE_INCREMENT)}
    />
  ) : !searching && diffs.files.length > INITIAL_VISIBLE_DIFF_FILE_COUNT ? (
    <WidgetMoreRow count={0} shown onHide={() => setVisibleFileCount(INITIAL_VISIBLE_DIFF_FILE_COUNT)} />
  ) : null

  // A Strip for what acts on the whole list (include every file, find one,
  // review the checked ones), then the files. The list is an index: a row opens its diff in
  // the viewer over the chat, never inside this card.
  const fileList = hasChanges ? (
    <>
      <WidgetStrip
        leading={(
          <StageCheckbox
            checked={allSelected}
            mixed={someSelected}
            label={allSelected ? "Unselect all files from commit" : "Select all files for commit"}
            className="size-4"
            onClick={() => {
              if (!projectId) return
              setAllCheckedPaths(projectId, filePaths, someSelected ? true : !allSelected)
            }}
          />
        )}
        trailing={(
          <Button
            variant="ghost"
            size="sm"
            disabled={!firstCheckedPath}
            onClick={() => {
              // Opens on a checked file, so the review is the checked files
              // and nothing else (the viewer adds an unchecked file only when
              // you open that file itself).
              const reviewedIsChecked = reviewedPath !== null && isDiffPathChecked(diffCommitSelection, reviewedPath)
              const target = reviewedIsChecked ? reviewedPath : firstCheckedPath
              if (target) openFileReview(target)
            }}
            className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground hover:!bg-transparent hover:!border-border/0"
          >
            {/* Words, not an eye: it opens the checked files in one scroll,
                and says how many, which a glyph can't. */}
            <span>{allSelected ? "Review all" : someSelected ? `Review ${selectedCount}` : "Review"}</span>
          </Button>
        )}
      >
        {/* What's in the commit is already said: the header counts it ("2 of
            3 files changed") and Review names it. This line finds a file. */}
        <input
          value={fileQuery}
          onChange={(event) => setFileQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && fileQuery) {
              event.preventDefault()
              event.stopPropagation()
              setFileQuery("")
            }
          }}
          placeholder="Search files"
          aria-label="Search changed files"
          type="search"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          className={cn(WIDGET_STRIP_INPUT_CLASS, "[&::-webkit-search-cancel-button]:hidden")}
        />
      </WidgetStrip>
      <WidgetList listRef={changesListRef}>
        {visibleFiles.map((file, index) => {
          const isChecked = isDiffPathChecked(diffCommitSelection, file.path)
          return (
            <DiffFileRow
              key={file.path}
              file={file}
              isChecked={isChecked}
              isReviewing={reviewedPath === file.path}
              editorLabel={editorLabel}
              fileActions={fileActions}
              onToggleChecked={() => {
                if (!projectId) return
                setCheckedPath(projectId, file.path, !isChecked)
              }}
              onReview={() => openFileReview(file.path)}
              className={!searching && index >= INITIAL_VISIBLE_DIFF_FILE_COUNT ? WIDGET_ROW_REVEAL_CLASS : undefined}
            />
          )
        })}
        {searching && matchingFiles.length === 0 ? (
          <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">No files match “{fileQuery.trim()}”</div>
        ) : null}
        {filesMore}
      </WidgetList>
      <DiffFileHoverCard
        containerRef={changesListRef}
        files={new Map(visibleFiles.map((file) => [file.path, file]))}
        projectId={projectId}
        onLoadPatch={onLoadPatch}
      />
    </>
  ) : null

  return (
    <>
      <WidgetPresence show={diffs.status === "no_repo"}>
        <WidgetCard
          icon={<GitBranch />}
          title="Git"
          footer={(
            <WidgetFooter>
              <Button type="button" variant="outline" className={WIDGET_FOOTER_BUTTON_CLASS} onClick={() => void onInitializeGit()}>
                Init Git
              </Button>
            </WidgetFooter>
          )}
        >
          <WidgetStatic>
            <p className="text-sm text-muted-foreground">Not a git repository.</p>
          </WidgetStatic>
        </WidgetCard>
      </WidgetPresence>
      <WidgetPresence show={diffs.status === "ready"}>
        <WidgetCard
          icon={<GitBranch />}
          title={(
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0">Branch</span>
              <span className="min-w-0 truncate text-muted-foreground">{diffs.branchName ?? "Detached HEAD"}</span>
            </span>
          )}
          expanded={branchesExpanded}
          onToggle={() => setBranchesExpanded((current) => !current)}
          actions={remoteSyncActions}
          footer={branchesExpanded ? branchActions : undefined}
        >
          <BranchPicker
            currentBranchName={diffs.branchName}
            onListBranches={onListBranches}
            onCheckoutBranch={onCheckoutBranch}
            onCreateBranch={onCreateBranch}
            onDone={() => setBranchesExpanded(false)}
            repoSlug={diffs.originRepoSlug}
            onReadBranch={onReadBranch}
          />
        </WidgetCard>
      </WidgetPresence>
      {/* A clean working tree drops the card rather than saying so. */}
      <WidgetPresence show={diffs.status === "ready" && hasChanges}>
        <WidgetCard
          icon={<FileDiff />}
          title={changesSummary.title}
          expanded={changesExpanded}
          onToggle={() => setChangesExpanded(!changesExpanded)}
          // Totals of what will be committed, in the same +/- typography as each file row.
          actions={<DiffFileStat additions={changesSummary.additions} deletions={changesSummary.deletions} className="pr-1" />}
          footer={commitBox}
        >
          {fileList}
        </WidgetCard>
      </WidgetPresence>
      <WidgetPresence show={diffs.status === "ready" && branchHistory.length > 0}>
        <WidgetCard
          icon={<History />}
          title="History"
          // Not the length: that is the server's cap (25) on any real repo.
          // What is worth a glance is what hasn't reached the remote yet.
          count={isPublishedBranch && aheadCount > 0 ? `${aheadCount} unpushed` : undefined}
          expanded={historyExpanded}
          onToggle={() => setHistoryExpanded(!historyExpanded)}
        >
          <WidgetList listRef={historyListRef}>
            {visibleHistory.shown.map((entry, index) => (
              <CommitHistoryRow
                key={entry.sha}
                entry={entry}
                isPendingPush={index < aheadCount}
                className={index >= INITIAL_VISIBLE_HISTORY_COUNT ? WIDGET_ROW_REVEAL_CLASS : undefined}
              />
            ))}
            {branchHistory.length > INITIAL_VISIBLE_HISTORY_COUNT ? (
              <WidgetMoreRow
                count={visibleHistory.hiddenCount}
                shown={showAllHistory}
                onShow={() => setShowAllHistory(true)}
                onHide={() => setShowAllHistory(false)}
              />
            ) : null}
          </WidgetList>
          <CommitHoverCard
            containerRef={historyListRef}
            entries={visibleHistory.shown}
            onReadCommit={onReadCommit}
          />
        </WidgetCard>
      </WidgetPresence>

      <MergeBranchModal
        open={mergeModalOpen}
        onOpenChange={setMergeModalOpen}
        branchList={mergeBranchList}
        currentBranchName={diffs.branchName}
        onPreviewMergeBranch={onPreviewMergeBranch}
        onMergeBranch={onMergeBranch}
      />
      <GitHubPublishModal
        open={isGitHubPublishModalOpen}
        onOpenChange={setIsGitHubPublishModalOpen}
        onGetGitHubPublishInfo={onGetGitHubPublishInfo}
        onCheckGitHubRepoAvailability={onCheckGitHubRepoAvailability}
        onPublish={onSetupGitHub}
      />
    </>
  )
}

export const GitWidgets = memo(GitWidgetsImpl)

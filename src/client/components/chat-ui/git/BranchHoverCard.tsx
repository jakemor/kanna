import { useEffect, useReducer, type RefObject } from "react"
import { ArrowDown, ArrowUp, FileDiff, GitBranch, GitCommitHorizontal, Laptop, MessageSquare, Unlink } from "lucide-react"
import type { ChatBranchDetails, ChatBranchListEntry, ChatPullRequestDetails } from "../../../../shared/types"
import { formatCompactAge } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { TURN_CARD_ROW_INSET, TurnCardMessage, TurnCardMetaRow } from "../../ui/turn-card"
import { useCardDetails, WidgetHoverCard } from "../widgets/WidgetHoverCard"
import { CheckRunsSection } from "./CheckRunsSection"
import { CARD_PILL_CLASS, CardPerson, DiffFileStat } from "./shared"

/*
 * These cards leave out what the row already shows: a PR's number, author,
 * age, checks count and merge state; a branch's kind (its section says it)
 * and age. They carry what the row cuts short or has no room for.
 */

// Keyed by the row and its tip time, so a branch that moved reads again.
const detailsCache = new Map<string, ChatBranchDetails>()
// Reads in progress, shared by the rows' prefetch and the cards, so hovering
// a row whose read hasn't landed waits on it instead of starting another.
const pendingReads = new Map<string, Promise<ChatBranchDetails>>()

// Everything showing cached details, redrawn when a read lands. A
// subscription rather than each caller tracking whether it's still mounted:
// that flag goes stale when dev's Fast Refresh re-runs effects on the same
// instance, and then a read that lands never reaches the rows.
const cacheListeners = new Set<() => void>()

function readDetails(entry: ChatBranchListEntry, onReadBranch: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>) {
  const key = detailsKey(entry)
  const pending = pendingReads.get(key)
  if (pending) return pending
  const read = onReadBranch(entry)
    .then((details) => {
      detailsCache.set(key, details)
      for (const listener of cacheListeners) listener()
      return details
    })
    .finally(() => pendingReads.delete(key))
  pendingReads.set(key, read)
  return read
}

function detailsKey(entry: ChatBranchListEntry) {
  return `${entry.id}\u0000${entry.updatedAt ?? ""}`
}

/**
 * Reads the given rows' details ahead of any hover, for state the rows show
 * themselves (a PR's checks and merge state). Shares the cards' cache, so a
 * card on one of these rows opens with everything already there. Capped by
 * the caller: each PR is a network read.
 */
export function useBranchDetails(
  entries: readonly ChatBranchListEntry[],
  onReadBranch?: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>,
): ReadonlyMap<string, ChatBranchDetails> {
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    cacheListeners.add(rerender)
    return () => {
      cacheListeners.delete(rerender)
    }
  }, [])
  const keys = entries.map(detailsKey).join("\u0001")
  useEffect(() => {
    if (!onReadBranch) return
    for (const entry of entries) {
      const key = detailsKey(entry)
      if (detailsCache.has(key) || pendingReads.has(key)) continue
      readDetails(entry, onReadBranch).catch(() => {})
    }
    // `keys` stands for `entries`: a new array with the same rows is no change.
  }, [keys, onReadBranch])
  return new Map(entries.flatMap((entry) => {
    const details = detailsCache.get(detailsKey(entry))
    return details ? [[entry.id, details] as const] : []
  }))
}

/**
 * A PR body as a preview: without the template's scaffolding (HTML comments,
 * markdown headings like "### What does this change?"), which reads as noise
 * in three lines of muted text, and with runs of blank lines collapsed.
 */
export function previewPullRequestBody(body: string) {
  return body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split("\n")
    .filter((line) => !/^\s{0,3}#{1,6}\s/u.test(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

/** "↑3 ↓1 main", "even with main": where a branch stands against another. */
function Divergence({ ahead, behind, name }: { ahead: number; behind: number; name: string }) {
  if (ahead === 0 && behind === 0) return <span className="truncate">Even with {name}</span>
  return (
    <span className="flex min-w-0 items-center gap-1" title={`${ahead} ahead, ${behind} behind ${name}`}>
      {ahead ? <span className="flex items-center text-foreground"><ArrowUp className="size-2.5" strokeWidth={2.5} />{ahead}</span> : null}
      {behind ? <span className="flex items-center"><ArrowDown className="size-2.5" strokeWidth={2.5} />{behind}</span> : null}
      <span className="truncate">{name}</span>
    </span>
  )
}

/**
 * A local or remote branch: who last committed to it, its whole name, that
 * commit, and where it stands against its upstream and the default branch.
 */
function BranchCardContent({ entry, details }: { entry: ChatBranchListEntry; details: ChatBranchDetails | null }) {
  const commit = details?.lastCommit
  const upstream = details?.upstream
  return (
    <>
      {commit?.authorName ? (
        <TurnCardMetaRow>
          <CardPerson name={commit.authorName} title={formatPromptTimestamp(commit.authoredAt)} />
        </TurnCardMetaRow>
      ) : null}
      <div className="mt-1 space-y-1">
        <div className={cn("break-all text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET)}>{entry.displayName}</div>
        {commit ? (
          <div className={cn("line-clamp-2 text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>{commit.summary}</div>
        ) : null}
      </div>
      {/* Where it stands: its other copy on the left, the default branch on
          the right. Neither is on the row. */}
      {upstream || details?.localBranchName || details?.base || (entry.kind === "local" && details) ? (
        <TurnCardMetaRow className="mt-1">
          {upstream ? (
            upstream.gone ? (
              <span className="flex items-center gap-1 text-destructive"><Unlink className="size-2.5" strokeWidth={2.5} />Upstream deleted</span>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
                <Divergence ahead={upstream.ahead} behind={upstream.behind} name={upstream.name} />
              </span>
            )
          ) : details?.localBranchName ? (
            <span className="flex items-center gap-1"><Laptop className="size-2.5" strokeWidth={2.5} />Checked out locally</span>
          ) : entry.kind === "local" ? (
            <span>Not pushed</span>
          ) : null}
          {details?.base ? (
            <span className="ml-auto flex min-w-0 items-center pl-2">
              <Divergence ahead={details.base.ahead} behind={details.base.behind} name={details.base.name} />
            </span>
          ) : null}
        </TurnCardMetaRow>
      ) : null}
    </>
  )
}

/**
 * A pull request: where it merges and when it was opened, the whole title
 * (the row cuts it to a line), a cleaned-up description, and how big it is.
 */
export function PullRequestCardContent({
  entry,
  pr,
  onOpen,
  onOpenCheck,
}: {
  entry: ChatBranchListEntry
  /** Absent until the read lands: the row's title and head show meanwhile. */
  pr: ChatPullRequestDetails | undefined
  onOpen?: () => void
  /** Opens one check's page on GitHub. */
  onOpenCheck?: (url: string) => void
}) {
  const body = pr?.body ? previewPullRequestBody(pr.body) : ""
  const hasStats = pr && (pr.changedFiles !== undefined || pr.commits !== undefined || pr.comments || pr.additions !== undefined)
  return (
    <>
      {/* Where it merges from and to, and when it was opened: neither is on
          the row, which shows when it last changed. */}
      <TurnCardMetaRow>
        <GitBranch className="size-2.5 shrink-0" strokeWidth={2.5} />
        <span className="min-w-0 truncate">
          {entry.headLabel ?? entry.headRefName}
          {pr?.baseRefName ? <span className="opacity-60"> → </span> : null}
          {pr?.baseRefName ?? ""}
        </span>
        {pr?.createdAt ? (
          <span className="ml-auto shrink-0 pl-2" title={`Opened ${formatPromptTimestamp(pr.createdAt)}`}>
            opened {formatCompactAge(pr.createdAt)}
          </span>
        ) : null}
      </TurnCardMetaRow>
      <div className="mt-1 space-y-1">
        <TurnCardMessage
          className="line-clamp-3 text-sm font-medium text-popover-foreground"
          label="Open this pull request on GitHub"
          onSelect={onOpen}
        >
          {pr?.title ?? entry.prTitle ?? entry.displayName}
        </TurnCardMessage>
        {body ? (
          <div className={cn("line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>{body}</div>
        ) : null}
      </div>
      {/* Size, as glyphs and numbers: files, commits, comments, then +/- on
          the right edge, where every card keeps its line counts. */}
      {hasStats ? (
        <TurnCardMetaRow className="mt-1">
          {pr.changedFiles !== undefined ? (
            <span className="flex items-center gap-1" title={`${pr.changedFiles} files changed`}><FileDiff className="size-2.5" strokeWidth={2.5} />{pr.changedFiles}</span>
          ) : null}
          {pr.commits !== undefined ? (
            <span className="ml-1.5 flex items-center gap-1" title={`${pr.commits} commits`}><GitCommitHorizontal className="size-2.5" strokeWidth={2.5} />{pr.commits}</span>
          ) : null}
          {pr.comments ? (
            <span className="ml-1.5 flex items-center gap-1" title={`${pr.comments} comments`}><MessageSquare className="size-2.5" strokeWidth={2.5} />{pr.comments}</span>
          ) : null}
          <DiffFileStat additions={pr.additions} deletions={pr.deletions} className="ml-auto pl-2" />
        </TurnCardMetaRow>
      ) : null}
      {pr?.labels.length ? (
        // Wraps, with the same 4px between lines as between pills.
        <TurnCardMetaRow className="mt-1 flex-wrap gap-y-1">
          {pr.labels.map((label) => (
            <span key={label} className={CARD_PILL_CLASS}>{label}</span>
          ))}
        </TurnCardMetaRow>
      ) : null}
      {/* The head commit's checks one by one; the row can only count them. */}
      {pr?.checkRuns ? <CheckRunsSection runs={pr.checkRuns} checks={pr.checks} onOpen={onOpenCheck} /> : null}
    </>
  )
}

function BranchHoverCardBody({
  entry,
  onReadBranch,
  repoSlug,
  dismiss,
}: {
  entry: ChatBranchListEntry
  onReadBranch?: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>
  repoSlug?: string
  dismiss: () => void
}) {
  const details = useCardDetails(detailsCache, detailsKey(entry), onReadBranch ? () => readDetails(entry, onReadBranch) : null)
  if (entry.kind === "pull_request") {
    const url = details?.pullRequest?.url ?? (repoSlug && entry.prNumber ? `https://github.com/${repoSlug}/pull/${entry.prNumber}` : undefined)
    const openInNewTab = (target: string) => {
      dismiss()
      window.open(target, "_blank", "noopener,noreferrer")
    }
    return (
      <PullRequestCardContent
        entry={entry}
        pr={details?.pullRequest}
        onOpen={url ? () => openInNewTab(url) : undefined}
        onOpenCheck={openInNewTab}
      />
    )
  }
  return <BranchCardContent entry={entry} details={details} />
}

/** The branch picker's hover card: a branch's or a PR's card on the row under the pointer. */
export function BranchHoverCard({
  containerRef,
  entries,
  onReadBranch,
  repoSlug,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  /** Every row the picker is showing, by `id` (which is also the row's key). */
  entries: ReadonlyMap<string, ChatBranchListEntry>
  onReadBranch?: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>
  repoSlug?: string
}) {
  return (
    <WidgetHoverCard containerRef={containerRef}>
      {(id, dismiss) => {
        const entry = entries.get(id)
        if (!entry) return null
        return <BranchHoverCardBody key={id} entry={entry} onReadBranch={onReadBranch} repoSlug={repoSlug} dismiss={dismiss} />
      }}
    </WidgetHoverCard>
  )
}

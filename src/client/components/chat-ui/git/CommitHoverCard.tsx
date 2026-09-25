import { type RefObject, useState } from "react"
import { Check, Copy, FileDiff, GitCommitHorizontal, GitMerge } from "lucide-react"
import type { ChatBranchHistoryEntry, ChatCommitDetails } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { TURN_CARD_ROW_INSET, TurnCardMessage, TurnCardMetaRow, TurnCardMetaSeparator } from "../../ui/turn-card"
import { useCardDetails, WidgetHoverCard } from "../widgets/WidgetHoverCard"
import { CheckRunsSection } from "./CheckRunsSection"
import { DiffFileStat } from "./shared"

// A commit never changes but its checks do, so the key carries the row's
// rollup: when the snapshot moves it (a job finished), the card reads again.
const detailsCache = new Map<string, ChatCommitDetails>()

function detailsKey(entry: ChatBranchHistoryEntry) {
  const checks = entry.checks
  return checks ? `${entry.sha}\u0000${checks.state}:${checks.passed}/${checks.total}` : entry.sha
}

/**
 * A commit's card: the full message, who and when, how big it is, and each
 * of its checks. Everything the History row has to truncate or leave out.
 */
export function CommitHoverCardContent({
  entry,
  details,
  onOpenCommit,
  onOpenCheck,
}: {
  entry: ChatBranchHistoryEntry
  /** What the server adds; absent until the read lands (or if it fails). */
  details: ChatCommitDetails | null
  onOpenCommit?: () => void
  /** Opens one check's page on GitHub. */
  onOpenCheck?: (url: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const shortSha = entry.sha.slice(0, 7)
  const isMerge = (details?.parentCount ?? 0) > 1

  // Author, age, the checks' count, tags and "not pushed" are on the History
  // row; the card carries what the row can't: the hash, a merge, a committer
  // who isn't the author, the exact time, the whole message, the size, and
  // which checks passed and which didn't.
  return (
    <>
      <TurnCardMetaRow>
        <button
          type="button"
          aria-label={`Copy ${entry.sha}`}
          onClick={() => {
            void navigator.clipboard?.writeText(entry.sha)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1_200)
          }}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm font-mono transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {isMerge ? <GitMerge className="size-2.5 shrink-0" strokeWidth={2.5} /> : <GitCommitHorizontal className="size-2.5 shrink-0" strokeWidth={2.5} />}
          {shortSha}
          {copied ? <Check className="size-2.5 shrink-0 text-success" strokeWidth={2.5} /> : <Copy className="size-2.5 shrink-0 opacity-60" strokeWidth={2.5} />}
        </button>
        {isMerge ? (
          <>
            <TurnCardMetaSeparator />
            <span className="shrink-0">Merge</span>
          </>
        ) : null}
        {details?.committerName ? (
          <>
            <TurnCardMetaSeparator />
            <span className="truncate">committed by {details.committerName}</span>
          </>
        ) : null}
        <span className="ml-auto shrink-0 pl-2" title={details?.authorEmail}>{formatPromptTimestamp(entry.authoredAt)}</span>
      </TurnCardMetaRow>
      {/* The whole message, which the row cuts to one line: the subject in the
          prompt's weight, the body under it like a reply. Opens the commit on
          GitHub when the repo is there, as the row does. */}
      <div className="mt-1 space-y-1">
        <TurnCardMessage
          className="line-clamp-3 text-sm font-medium text-popover-foreground"
          label="Open this commit on GitHub"
          onSelect={onOpenCommit}
        >
          {entry.summary}
        </TurnCardMessage>
        {entry.description ? (
          <div className={cn("line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>
            {entry.description.trim()}
          </div>
        ) : null}
      </div>
      {/* Only once read, as on the chat card: nothing appears until it lands,
          so the card doesn't resize under a reader already on it. CI is the
          appendix you drop to when the message didn't settle it. */}
      {details?.checkRuns ? (
        <CheckRunsSection runs={details.checkRuns} checks={entry.checks} onOpen={onOpenCheck} />
      ) : null}
      {/* The size as the card's footer, a fact about the whole commit rather
          than a section to read. Not the files: the viewer lists those. */}
      {details && details.totalFileCount > 0 ? (
        <TurnCardMetaRow className="-mx-1.5 -mb-2 mt-2 rounded-b-lg border-t border-border/60 bg-muted/40 px-3 py-1.5">
          <FileDiff className="size-2.5 shrink-0" strokeWidth={2.5} />
          <span>{details.totalFileCount} file{details.totalFileCount === 1 ? "" : "s"} changed</span>
          <DiffFileStat additions={details.additions} deletions={details.deletions} className="ml-auto pl-2" />
        </TurnCardMetaRow>
      ) : null}
    </>
  )
}

/** Reads the commit's details while its card is open, then renders it. */
function CommitHoverCardBody({
  entry,
  onReadCommit,
  dismiss,
}: {
  entry: ChatBranchHistoryEntry
  onReadCommit?: (sha: string) => Promise<ChatCommitDetails>
  dismiss: () => void
}) {
  const details = useCardDetails(detailsCache, detailsKey(entry), onReadCommit ? () => onReadCommit(entry.sha) : null)
  const openInNewTab = (url: string) => {
    dismiss()
    window.open(url, "_blank", "noopener,noreferrer")
  }
  return (
    <CommitHoverCardContent
      entry={entry}
      details={details}
      onOpenCommit={entry.githubUrl ? () => openInNewTab(entry.githubUrl!) : undefined}
      onOpenCheck={openInNewTab}
    />
  )
}

/** History's hover card: one for the list, a commit's card on the row under the pointer. */
export function CommitHoverCard({
  containerRef,
  entries,
  onReadCommit,
}: {
  /** The History list; every commit row is somewhere beneath it. */
  containerRef: RefObject<HTMLDivElement | null>
  entries: ChatBranchHistoryEntry[]
  onReadCommit?: (sha: string) => Promise<ChatCommitDetails>
}) {
  return (
    <WidgetHoverCard containerRef={containerRef}>
      {(sha, dismiss) => {
        const entry = entries.find((candidate) => candidate.sha === sha)
        if (!entry) return null
        return <CommitHoverCardBody key={sha} entry={entry} onReadCommit={onReadCommit} dismiss={dismiss} />
      }}
    </WidgetHoverCard>
  )
}

import { GitPullRequestDraft } from "lucide-react"
import type { ChatBranchDetails, ChatBranchListEntry, ChatBranchPullRequest } from "../../../../shared/types"
import { WidgetRow } from "../widgets/parts"
import { useBranchDetails } from "./BranchHoverCard"
import { ChecksIcon, pullRequestStateIcon } from "./PullRequestState"

/**
 * The branch's PR as a branch picker entry, so it reads its details (checks,
 * merge state) and opens its hover card through the picker's own paths.
 * Keyed by its last update, so a push or an edit reads it again.
 */
export function branchPullRequestEntry(branchName: string, pr: ChatBranchPullRequest): ChatBranchListEntry {
  return {
    id: `pr:${pr.number}`,
    kind: "pull_request",
    name: branchName,
    displayName: pr.title,
    prNumber: pr.number,
    prTitle: pr.title,
    headRefName: branchName,
    updatedAt: pr.updatedAt,
  }
}

/**
 * The Branch card's first row when the branch has an open PR: where its
 * commits are going, so it sits right above them. Laid out as a PR row in the
 * picker (merge state as the icon, checks under the right edge) and opens the
 * PR on GitHub.
 */
export function BranchPullRequestRow({
  entry,
  pr,
  onReadBranch,
}: {
  entry: ChatBranchListEntry
  pr: ChatBranchPullRequest
  onReadBranch?: (entry: ChatBranchListEntry) => Promise<ChatBranchDetails>
}) {
  const details = useBranchDetails([entry], onReadBranch).get(entry.id)?.pullRequest
  // A draft says so before the read lands; anything else waits for it.
  const state = details
    ? pullRequestStateIcon(details)
    : pr.isDraft
      ? { icon: <GitPullRequestDraft className="text-muted-foreground" />, label: "Draft" }
      : pullRequestStateIcon(undefined)
  return (
    <WidgetRow
      icon={<span title={state.label} aria-label={state.label} className="flex">{state.icon}</span>}
      title={pr.title}
      subtitle={`#${pr.number}${pr.isDraft ? " · Draft" : ""}`}
      subMeta={details?.checks ? <ChecksIcon checks={details.checks} /> : undefined}
      // No native tooltip: the card's BranchHoverCard shows the whole PR.
      rowKey={entry.id}
      onActivate={() => window.open(pr.url, "_blank", "noopener,noreferrer")}
      aria-label={`Open pull request #${pr.number} on GitHub`}
    />
  )
}

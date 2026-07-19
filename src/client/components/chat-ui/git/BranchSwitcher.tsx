import { ChevronDown, GitBranch, GitMerge, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import type {
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
} from "../../../../shared/types"
import { Button } from "../../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover"
import { SegmentedControl } from "../../ui/segmented-control"
import { BranchListSection, BranchSearchInput } from "./BranchList"
import { MergeBranchModal } from "./MergeBranchModal"

export function BranchSwitcher({
  currentBranchName,
  onListBranches,
  onPreviewMergeBranch,
  onMergeBranch,
  onCheckoutBranch,
  onCreateBranch,
}: {
  currentBranchName?: string
  onListBranches: () => Promise<ChatBranchListResult>
  onPreviewMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergePreviewResult>
  onMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergeBranchResult | null>
  onCheckoutBranch: (branch: ChatBranchListEntry) => Promise<void>
  onCreateBranch: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [mergeModalOpen, setMergeModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [query, setQuery] = useState("")
  const [entryView, setEntryView] = useState<"branches" | "pull_requests">("branches")
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
  const totalPullRequestCount = branchList?.pullRequests.length ?? 0

  async function handleCheckout(entry: ChatBranchListEntry) {
    setIsMutating(true)
    try {
      await onCheckoutBranch(entry)
      setOpen(false)
      setQuery("")
      setEntryView("branches")
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
      setEntryView("branches")
    } finally {
      setIsMutating(false)
    }
  }

  function openMergeModal() {
    setOpen(false)
    setMergeModalOpen(true)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Open branch switcher"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{currentBranchName ?? "Detached HEAD"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-2">
        <div className="space-y-2">
          <BranchSearchInput
            value={query}
            onChange={setQuery}
            placeholder={entryView === "pull_requests" ? "Search pull requests" : "Search branches"}
            disabled={isLoading || isMutating}
            trailingAction={(
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={isLoading || isMutating}
                className="h-7 px-2 text-xs hover:!bg-transparent hover:!border-border/0"
              >
                + New
              </Button>
            )}
          />
          <SegmentedControl
            value={entryView}
            onValueChange={(value) => setEntryView(value as "branches" | "pull_requests")}
            size="sm"
            className="w-full"
            optionClassName="flex-1 justify-center"
            options={[
              { value: "branches", label: "Branches" },
              { value: "pull_requests", label: `Open PRs ${totalPullRequestCount}` },
            ]}
          />
          <div className="max-h-[420px] overflow-y-auto pr-1.5 -mr-[8px]">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                <span>Loading branches…</span>
              </div>
            ) : error ? (
              <div className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">{error}</div>
            ) : entryView === "pull_requests" ? (
              <BranchListSection
                title="Open PRs"
                entries={pullRequests}
                emptyLabel={
                  branchList?.pullRequestsStatus === "error"
                    ? branchList.pullRequestsError ?? "Could not load pull requests."
                    : branchList?.pullRequestsStatus === "unavailable"
                      ? "Pull requests unavailable for this repository."
                      : "No open pull requests."
                }
                disabled={isMutating}
                stickyTitle
                onSelect={(entry) => {
                  void handleCheckout(entry)
                }}
              />
            ) : (
              <div className="space-y-3">
                <BranchListSection
                  title="Recent"
                  entries={recent}
                  emptyLabel="No recent branches."
                  disabled={isMutating}
                  stickyTitle
                  onSelect={(entry) => {
                    void handleCheckout(entry)
                  }}
                />
                <BranchListSection
                  title="Local"
                  entries={local}
                  emptyLabel="No local branches."
                  disabled={isMutating}
                  stickyTitle
                  onSelect={(entry) => {
                    void handleCheckout(entry)
                  }}
                />
                <BranchListSection
                  title="Remote"
                  entries={remote}
                  emptyLabel="No remote branches."
                  disabled={isMutating}
                  stickyTitle
                  onSelect={(entry) => {
                    void handleCheckout(entry)
                  }}
                />
              </div>
            )}
          </div>
          {currentName ? (
            <Button
              variant="default"
              size="sm"
              disabled={isLoading || isMutating || Boolean(error)}
              onClick={openMergeModal}
              className="h-9 w-full justify-center rounded-lg px-3 text-sm"
            >
              <span className="block max-w-full truncate">
                <GitMerge className="mr-1.5 inline h-3.5 w-3.5 shrink-0" />
                Merge branch into {currentName}...
              </span>
            </Button>
          ) : null}
        </div>
      </PopoverContent>
      <MergeBranchModal
        open={mergeModalOpen}
        onOpenChange={setMergeModalOpen}
        branchList={branchList}
        currentBranchName={currentName}
        onPreviewMergeBranch={onPreviewMergeBranch}
        onMergeBranch={onMergeBranch}
      />
    </Popover>
  )
}

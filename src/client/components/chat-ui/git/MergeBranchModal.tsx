import { AlertTriangle, Check, GitBranchPlus, LoaderCircle } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
} from "../../../../shared/types"
import { Button } from "../../ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../ui/dialog"
import { BranchListSection, BranchSearchInput } from "./BranchList"

function getBranchCandidatePriority(entry: ChatBranchListEntry) {
  switch (entry.kind) {
    case "local":
      return 0
    case "pull_request":
      return 1
    case "remote":
    default:
      return 2
  }
}

function dedupeBranchEntries(entries: ChatBranchListEntry[]) {
  const selectedByName = new Map<string, ChatBranchListEntry>()
  for (const entry of entries) {
    const existing = selectedByName.get(entry.name)
    if (!existing || getBranchCandidatePriority(entry) < getBranchCandidatePriority(existing)) {
      selectedByName.set(entry.name, entry)
    }
  }
  return selectedByName
}

function getMergeBranchGroups(branchList: ChatBranchListResult, currentBranchName?: string) {
  const uniqueEntriesByName = dedupeBranchEntries([
    ...branchList.local,
    ...branchList.pullRequests,
    ...branchList.remote,
  ])
  if (currentBranchName) {
    uniqueEntriesByName.delete(currentBranchName)
  }

  const usedNames = new Set<string>()
  const defaultBranch = branchList.defaultBranchName
    ? uniqueEntriesByName.get(branchList.defaultBranchName)
    : undefined

  if (defaultBranch) {
    usedNames.add(defaultBranch.name)
  }

  const recent = branchList.recent
    .map((entry) => uniqueEntriesByName.get(entry.name) ?? entry)
    .filter((entry): entry is ChatBranchListEntry => Boolean(entry) && !usedNames.has(entry.name))

  for (const entry of recent) {
    usedNames.add(entry.name)
  }

  const other = [...uniqueEntriesByName.values()]
    .filter((entry) => !usedNames.has(entry.name))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))

  return {
    defaultBranch,
    recent,
    other,
  }
}

export function MergeBranchModal({
  open,
  onOpenChange,
  branchList,
  currentBranchName,
  onPreviewMergeBranch,
  onMergeBranch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  branchList: ChatBranchListResult | null
  currentBranchName?: string
  onPreviewMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergePreviewResult>
  onMergeBranch: (branch: ChatBranchListEntry) => Promise<ChatMergeBranchResult | null>
}) {
  const [query, setQuery] = useState("")
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [preview, setPreview] = useState<ChatMergePreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isMerging, setIsMerging] = useState(false)

  const groupedEntries = useMemo(() => {
    if (!branchList) {
      return { defaultBranch: undefined, recent: [], other: [] }
    }
    return getMergeBranchGroups(branchList, currentBranchName)
  }, [branchList, currentBranchName])

  const normalizedQuery = query.trim().toLowerCase()
  const matchesQuery = useCallback((entry: ChatBranchListEntry) => {
    if (!normalizedQuery) return true
    return [
      entry.displayName,
      entry.name,
      entry.description,
      entry.prTitle,
      entry.headLabel,
    ].some((value) => value?.toLowerCase().includes(normalizedQuery))
  }, [normalizedQuery])

  const visibleDefaultBranch = groupedEntries.defaultBranch && matchesQuery(groupedEntries.defaultBranch)
    ? groupedEntries.defaultBranch
    : undefined
  const visibleRecent = groupedEntries.recent.filter(matchesQuery)
  const visibleOther = groupedEntries.other.filter(matchesQuery)

  const selectedEntry = useMemo(() => {
    if (!selectedName) return null
    return [groupedEntries.defaultBranch, ...groupedEntries.recent, ...groupedEntries.other]
      .find((entry): entry is ChatBranchListEntry => entry !== undefined && entry.name === selectedName) ?? null
  }, [groupedEntries.defaultBranch, groupedEntries.other, groupedEntries.recent, selectedName])

  useEffect(() => {
    if (!open) {
      setQuery("")
      setSelectedName(null)
      setPreview(null)
      setPreviewError(null)
      setIsPreviewLoading(false)
      setIsMerging(false)
    }
  }, [open])

  useEffect(() => {
    if (!open || !selectedEntry) {
      setPreview(null)
      setPreviewError(null)
      setIsPreviewLoading(false)
      return
    }

    let cancelled = false
    setPreview(null)
    setPreviewError(null)
    setIsPreviewLoading(true)

    void onPreviewMergeBranch(selectedEntry)
      .then((result) => {
        if (cancelled) return
        setPreview(result)
      })
      .catch((error) => {
        if (cancelled) return
        setPreviewError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (cancelled) return
        setIsPreviewLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [onPreviewMergeBranch, open, selectedEntry])

  const mergeDisabled = !selectedEntry || !preview || isPreviewLoading || isMerging || preview.status !== "mergeable"

  async function handleMerge() {
    if (!selectedEntry || mergeDisabled) return
    setIsMerging(true)
    try {
      const result = await onMergeBranch(selectedEntry)
      if (result?.ok) {
        onOpenChange(false)
      }
    } finally {
      setIsMerging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="max-w-[min(92vw,475px)]">
        <DialogBody className="flex min-h-0 flex-col gap-3 px-4 pb-4 pt-4">
          <div className="space-y-1">
            <DialogTitle>Merge into {currentBranchName ?? "current branch"}</DialogTitle>
            <DialogDescription>
              Choose a branch to continue.
            </DialogDescription>
          </div>
          <BranchSearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search branches"
          />
          <div className="max-h-[375px] space-y-3 overflow-y-auto pr-1">
            <BranchListSection
              title="Default Branch"
              entries={visibleDefaultBranch ? [visibleDefaultBranch] : []}
              emptyLabel="No default branch available."
              selectedName={selectedName}
              onSelect={(entry) => setSelectedName(entry.name)}
            />
            <BranchListSection
              title="Recent Branches"
              entries={visibleRecent}
              emptyLabel="No recent branches."
              selectedName={selectedName}
              onSelect={(entry) => setSelectedName(entry.name)}
            />
            <BranchListSection
              title="Other Branches"
              entries={visibleOther}
              emptyLabel="No other branches match this search."
              selectedName={selectedName}
              onSelect={(entry) => setSelectedName(entry.name)}
            />
          </div>
          <div className="px-2">
            {!selectedEntry ? (
              <div className="text-sm text-muted-foreground">
                Select a branch to preview the merge.
              </div>
            ) : isPreviewLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                <span>Checking merge preview…</span>
              </div>
            ) : previewError ? (
              <div className="text-sm text-destructive">
                {previewError}
              </div>
            ) : preview ? (
              <div className="flex items-start gap-2">
                {preview.status === "up_to_date" ? (
                  <Check className="mt-1 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : preview.status === "conflicts" ? (
                  <AlertTriangle className="mt-1 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                ) : preview.status === "mergeable" ? (
                  <GitBranchPlus className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <AlertTriangle className="mt-1 size-3.5 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-foreground">{preview.message}</div>
                  {preview.detail ? (
                    <div className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{preview.detail}</div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Preview unavailable.
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <div className="flex min-w-0 w-full items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="max-w-full min-w-0" size="sm" disabled={mergeDisabled} onClick={() => void handleMerge()}>
              {isMerging ? (
                <>
                  <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Merging…
                </>
              ) : (
                <span className="block max-w-full truncate">Merge</span>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

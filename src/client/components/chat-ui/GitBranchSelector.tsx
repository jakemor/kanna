import { useCallback, useDeferredValue, useEffect, useRef, useState, useTransition } from "react"
import { GitBranch, Loader2, Plus, Check } from "lucide-react"
import type { GitBranchesResult, GitCreateBranchResult, GitSwitchBranchResult } from "../../../shared/protocol"
import type { KannaSocket } from "../../app/socket"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { cn } from "../../lib/utils"

interface Props {
  projectId: string
  socket: KannaSocket
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; currentBranch: string | null; branches: string[] }
  | { phase: "error"; message: string }
  | { phase: "not-a-repo" }

function BranchItem({
  label,
  isCurrent,
  icon,
  onClick,
  className,
}: {
  label: string
  isCurrent?: boolean
  icon?: React.ReactNode
  onClick: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors hover:bg-muted",
        className
      )}
    >
      <span className="flex-shrink-0 w-4 flex items-center justify-center">
        {icon ?? (isCurrent ? <Check className="h-3.5 w-3.5 text-muted-foreground" /> : null)}
      </span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {isCurrent && (
        <span className="flex-shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
          current
        </span>
      )}
    </button>
  )
}

export function GitBranchSelector({ projectId, socket }: Props) {
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [isPending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchBranches = useCallback(async () => {
    try {
      const result = await socket.command<GitBranchesResult>({ type: "git.getBranches", projectId })
      if (!result.isRepo) {
        setLoadState({ phase: "not-a-repo" })
        return
      }
      setLoadState({ phase: "ready", currentBranch: result.currentBranch, branches: result.branches })
    } catch (err: unknown) {
      setLoadState({ phase: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [projectId, socket])

  // Fetch on mount and whenever projectId/socket changes
  useEffect(() => {
    void fetchBranches()
  }, [fetchBranches])

  // Re-fetch and reset query when popover opens
  useEffect(() => {
    if (!open) return
    setQuery("")
    void fetchBranches()
  }, [open, fetchBranches])

  // Auto-focus the search input when the popover opens and branches are loaded
  useEffect(() => {
    if (open && loadState.phase === "ready") {
      const id = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(id)
    }
  }, [open, loadState.phase])

  function handleSwitchBranch(branchName: string) {
    if (loadState.phase !== "ready" || branchName === loadState.currentBranch) return
    setOpen(false)
    startTransition(async () => {
      try {
        await socket.command<GitSwitchBranchResult>({ type: "git.switchBranch", projectId, branchName })
        await fetchBranches()
      } catch (err: unknown) {
        setLoadState({ phase: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  function handleCreateBranch(branchName: string) {
    if (!branchName.trim()) return
    setOpen(false)
    startTransition(async () => {
      try {
        await socket.command<GitCreateBranchResult>({
          type: "git.createBranch",
          projectId,
          branchName: branchName.trim(),
          checkout: true,
        })
        await fetchBranches()
      } catch (err: unknown) {
        setLoadState({ phase: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  // Don't render anything once we know it's not a git repo
  if (loadState.phase === "not-a-repo") return null

  // Filter branches based on the deferred query
  const filteredBranches =
    loadState.phase === "ready"
      ? loadState.branches.filter((b) => b.toLowerCase().includes(deferredQuery.toLowerCase()))
      : []

  const queryMatchesExisting =
    loadState.phase === "ready" && loadState.branches.some((b) => b === deferredQuery.trim())

  const showCreateOption = deferredQuery.trim().length > 0 && !queryMatchesExisting

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-10 w-auto max-w-[180px] gap-1.5 rounded-lg border border-border/0 px-3 text-sm text-muted-foreground",
            loadState.phase === "error" && "text-destructive"
          )}
        >
          {isPending ? (
            <Loader2 className="h-4.5 w-4.5 flex-shrink-0 animate-spin" />
          ) : (
            <GitBranch className="h-4.5 w-4.5 flex-shrink-0" />
          )}
          {/* Only show text once we know the branch — no "..." placeholder */}
          {loadState.phase === "ready" && (
            <span className="truncate">{loadState.currentBranch ?? "HEAD detached"}</span>
          )}
          {loadState.phase === "error" && (
            <span className="truncate">git error</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-0 overflow-hidden">
        {/* Search input */}
        <div className="border-b border-border">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or create branch..."
            className="w-full px-3 py-2 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === "Enter" && showCreateOption) {
                handleCreateBranch(query)
              }
            }}
          />
        </div>

        {/* Branch list */}
        <div className="max-h-[220px] overflow-y-auto p-1">
          {loadState.phase === "loading" && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}

          {loadState.phase === "error" && (
            <p className="px-2 py-3 text-xs text-muted-foreground">{loadState.message}</p>
          )}

          {loadState.phase === "ready" && (
            <>
              {filteredBranches.length === 0 && !showCreateOption && (
                <p className="px-2 py-3 text-xs text-muted-foreground">No branches match</p>
              )}

              {filteredBranches.map((branch) => (
                <BranchItem
                  key={branch}
                  label={branch}
                  isCurrent={branch === loadState.currentBranch}
                  onClick={() => handleSwitchBranch(branch)}
                />
              ))}

              {showCreateOption && (
                <BranchItem
                  label={`Create branch "${deferredQuery.trim()}"`}
                  icon={<Plus className="h-3.5 w-3.5 text-muted-foreground" />}
                  onClick={() => handleCreateBranch(query)}
                  className="text-muted-foreground border-t border-border/50 mt-1 pt-2 rounded-none"
                />
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

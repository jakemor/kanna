import { AlertTriangle, Building2, Check, FileText, Globe, LoaderCircle, Lock, PencilLine, UserRound } from "lucide-react"
import { useEffect, useState } from "react"
import type { GitHubPublishInfo, GitHubRepoAvailabilityResult } from "../../../../shared/types"
import { cn } from "../../../lib/utils"
import { Button } from "../../ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../ui/dialog"
import { Input } from "../../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select"
import { Textarea } from "../../ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"

export function GitHubPublishModal({
  open,
  onOpenChange,
  onGetGitHubPublishInfo,
  onCheckGitHubRepoAvailability,
  onPublish,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGetGitHubPublishInfo: () => Promise<GitHubPublishInfo>
  onCheckGitHubRepoAvailability: (args: { owner: string; name: string }) => Promise<GitHubRepoAvailabilityResult>
  onPublish: (args: { owner: string; name: string; visibility: "public" | "private"; description: string }) => Promise<unknown>
}) {
  const [info, setInfo] = useState<GitHubPublishInfo | null>(null)
  const [isLoadingInfo, setIsLoadingInfo] = useState(false)
  const [owner, setOwner] = useState("")
  const [name, setName] = useState("")
  const [visibility, setVisibility] = useState<"public" | "private">("private")
  const [description, setDescription] = useState("")
  const [availability, setAvailability] = useState<GitHubRepoAvailabilityResult | null>(null)
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoadingInfo(true)
    setAvailability(null)
    void onGetGitHubPublishInfo()
      .then((result) => {
        if (cancelled) return
        setInfo(result)
        setOwner(result.owners[0] ?? result.activeAccountLogin ?? "")
        setName(result.suggestedRepoName)
        setVisibility("private")
        setDescription("")
      })
      .finally(() => {
        if (cancelled) return
        setIsLoadingInfo(false)
      })
    return () => {
      cancelled = true
    }
  }, [onGetGitHubPublishInfo, open])

  useEffect(() => {
    if (!open || !info?.ghInstalled || !info.authenticated) {
      return
    }
    const trimmedOwner = owner.trim()
    const trimmedName = name.trim()
    if (!trimmedOwner || !trimmedName) {
      setAvailability(null)
      return
    }

    let cancelled = false
    setIsCheckingAvailability(true)
    const timeoutId = window.setTimeout(() => {
      void onCheckGitHubRepoAvailability({ owner: trimmedOwner, name: trimmedName })
        .then((result) => {
          if (cancelled) return
          setAvailability(result)
        })
        .finally(() => {
          if (cancelled) return
          setIsCheckingAvailability(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [info?.authenticated, info?.ghInstalled, name, onCheckGitHubRepoAvailability, open, owner])

  async function handlePublish() {
    if (!owner.trim() || !name.trim()) return
    setIsPublishing(true)
    try {
      const result = await onPublish({
        owner: owner.trim(),
        name: name.trim(),
        visibility,
        description,
      })
      if ((result as { ok?: boolean } | null)?.ok) {
        onOpenChange(false)
      }
    } finally {
      setIsPublishing(false)
    }
  }

  const canPublish = Boolean(
    info?.ghInstalled
    && info.authenticated
    && owner.trim()
    && name.trim()
    && availability?.available
    && !isCheckingAvailability
    && !isPublishing
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="max-w-[min(92vw,475px)]">
        <DialogBody className="space-y-2 px-4 pb-4 pt-4">
          <div className="space-y-1">
            <DialogTitle>Push to GitHub</DialogTitle>
            <DialogDescription>Create a GitHub repository from this local project using GitHub CLI.</DialogDescription>
          </div>
          {isLoadingInfo ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              <span>Checking GitHub CLI…</span>
            </div>
          ) : info && !info.ghInstalled ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>GitHub CLI is not installed.</p>
              <div className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-foreground">
                brew install gh
              </div>
              <p>Then run:</p>
              <div className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-foreground">
                gh auth login
              </div>
            </div>
          ) : info && !info.authenticated ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>GitHub CLI is installed but not signed in.</p>
              <div className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-foreground">
                gh auth login
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger className="pl-[11px] [&>span]:flex [&>span]:items-center [&>span]:gap-2">
                    <SelectValue placeholder="Select owner" />
                  </SelectTrigger>
                  <SelectContent>
                    {(info?.owners ?? []).map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        <span className="flex items-center gap-2">
                          {candidate === info?.activeAccountLogin ? (
                            <UserRound className="size-4 text-muted-foreground" />
                          ) : (
                            <Building2 className="size-4 text-muted-foreground" />
                          )}
                          <span className="pl-[1px]">{candidate}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="my-repo"
                    className="pl-9 pr-10"
                  />
                  <PencilLine className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground" />
                  {isCheckingAvailability ? (
                    <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" />
                    </div>
                  ) : availability ? (
                    <div className="absolute inset-y-0 right-2 flex items-center">
                      <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={availability.message}
                            className={cn(
                              "flex size-6 items-center justify-center rounded-md",
                              availability.available
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-destructive"
                            )}
                          >
                            {availability.available ? <Check className="size-4" /> : <AlertTriangle className="size-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{availability.message}</TooltipContent>
                      </Tooltip>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <div className="relative">
                  <FileText className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
                  <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                    placeholder="Optional description"
                    className="pl-9 outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Select value={visibility} onValueChange={(value) => setVisibility(value as "public" | "private")}>
                  <SelectTrigger className="pl-[11px] [&>span]:flex [&>span]:items-center [&>span]:gap-2">
                    <SelectValue placeholder="Select visibility" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">
                      <span className="flex items-center gap-2">
                        <Lock className="size-4 text-muted-foreground" />
                        <span className="pl-[1px]">Private</span>
                      </span>
                    </SelectItem>
                    <SelectItem value="public">
                      <span className="flex items-center gap-2">
                        <Globe className="size-4 text-muted-foreground" />
                        <span className="pl-[1px]">Public</span>
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canPublish} onClick={() => void handlePublish()}>
            {isPublishing ? (
              <>
                <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
                Publishing…
              </>
            ) : (
              "Push to GitHub"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

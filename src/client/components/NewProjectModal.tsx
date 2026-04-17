import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { Check, GitBranch, Loader2 } from "lucide-react"
import { DEFAULT_NEW_PROJECT_ROOT } from "../../shared/branding"
import { parseGitRepoUrl, toCloneUrl } from "../../shared/git-url"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog"
import { Input } from "./ui/input"
import { SegmentedControl } from "./ui/segmented-control"

export type ProjectMode = "new" | "existing" | "clone"

export interface NewProjectResult {
  mode: ProjectMode
  localPath: string
  fallbackPath?: string
  title: string
  cloneUrl?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (project: NewProjectResult) => Promise<void>
}

type Tab = "new" | "existing"
type CloneStatus = "idle" | "cloning" | "success" | "error"

function toKebab(str: string): string {
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function NewProjectModal({ open, onOpenChange, onConfirm }: Props) {
  const [tab, setTab] = useState<Tab>("new")
  const [name, setName] = useState("")
  const [existingPath, setExistingPath] = useState("")
  const [cloneStatus, setCloneStatus] = useState<CloneStatus>("idle")
  const [cloneError, setCloneError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const existingInputRef = useRef<HTMLInputElement>(null)

  const isBusy = cloneStatus === "cloning" || cloneStatus === "success"

  useEffect(() => {
    if (open) {
      setTab("new")
      setName("")
      setExistingPath("")
      setCloneStatus("idle")
      setCloneError(null)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (open && !isBusy) {
      setTimeout(() => {
        if (tab === "new") inputRef.current?.focus()
        else existingInputRef.current?.focus()
      }, 0)
    }
  }, [tab, open, isBusy])

  // Detect git URLs in either input
  const activeValue = tab === "new" ? name : existingPath
  const parsedGitUrl = useMemo(() => parseGitRepoUrl(activeValue), [activeValue])
  const isCloneMode = parsedGitUrl !== null

  const kebab = toKebab(name)
  const newPath = kebab ? `${DEFAULT_NEW_PROJECT_ROOT}/${kebab}` : ""
  const trimmedExisting = existingPath.trim()

  // For clone mode: derive path from the repo name, with owner-repo fallback
  const clonePath = parsedGitUrl ? `${DEFAULT_NEW_PROJECT_ROOT}/${parsedGitUrl.repo}` : ""
  const cloneFallbackPath = parsedGitUrl ? `${DEFAULT_NEW_PROJECT_ROOT}/${parsedGitUrl.owner}-${parsedGitUrl.repo}` : ""

  const canSubmit = !isBusy && (isCloneMode
    ? !!parsedGitUrl
    : tab === "new"
      ? !!kebab
      : !!trimmedExisting)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return

    if (isCloneMode && parsedGitUrl) {
      // Keep modal open with progress for clones
      setCloneStatus("cloning")
      setCloneError(null)
      try {
        await onConfirm({
          mode: "clone",
          localPath: clonePath,
          fallbackPath: cloneFallbackPath,
          title: parsedGitUrl.repo,
          cloneUrl: toCloneUrl(activeValue),
        })
        setCloneStatus("success")
        // Brief success flash then close
        setTimeout(() => onOpenChange(false), 600)
      } catch (error) {
        setCloneStatus("error")
        setCloneError(error instanceof Error ? error.message : String(error))
      }
    } else if (tab === "new") {
      onConfirm({ mode: "new", localPath: newPath, title: name.trim() })
      onOpenChange(false)
    } else {
      const folderName = trimmedExisting.split("/").pop() || trimmedExisting
      onConfirm({ mode: "existing", localPath: trimmedExisting, title: folderName })
      onOpenChange(false)
    }
  }, [canSubmit, isCloneMode, parsedGitUrl, clonePath, activeValue, tab, newPath, name, trimmedExisting, onConfirm, onOpenChange])

  const cloneIndicator = parsedGitUrl && (
    <div className="flex items-center gap-1.5 text-xs text-primary">
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0" />
      <span>
        Clone <span className="font-medium">{parsedGitUrl.owner}/{parsedGitUrl.repo}</span> into {clonePath}
      </span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={isBusy ? undefined : onOpenChange}>
      <DialogContent
        size="sm"
        onInteractOutside={isBusy ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={isBusy ? (e) => e.preventDefault() : undefined}
      >
        <DialogBody className="space-y-4">
          <DialogTitle>Add Project</DialogTitle>

          {!isBusy && (
            <SegmentedControl
              value={tab}
              onValueChange={setTab}
              options={[
                { value: "new" as Tab, label: "New Folder" },
                { value: "existing" as Tab, label: "Existing Path" },
              ]}
              className="w-full mb-2"
              optionClassName="flex-1 justify-center"
            />
          )}

          {isBusy ? (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2.5">
                {cloneStatus === "cloning" ? (
                  <Loader2 className="h-4 w-4 text-primary animate-spin flex-shrink-0" />
                ) : (
                  <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                )}
                <span className="text-sm text-foreground">
                  {cloneStatus === "cloning"
                    ? <>Cloning <span className="font-medium">{parsedGitUrl?.owner}/{parsedGitUrl?.repo}</span>&hellip;</>
                    : <>Cloned <span className="font-medium">{parsedGitUrl?.owner}/{parsedGitUrl?.repo}</span></>}
                </span>
              </div>
              <p className="text-xs text-muted-foreground font-mono pl-6.5">
                {clonePath}
              </p>
            </div>
          ) : tab === "new" ? (
            <div className="space-y-2">
              <Input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setCloneError(null) }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSubmit()
                  if (e.key === "Escape") onOpenChange(false)
                }}
                placeholder="Project name or GitHub/GitLab URL"
              />
              {isCloneMode ? cloneIndicator : newPath ? (
                <p className="text-xs text-muted-foreground font-mono">
                  {newPath}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                ref={existingInputRef}
                type="text"
                value={existingPath}
                onChange={(e) => { setExistingPath(e.target.value); setCloneError(null) }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSubmit()
                  if (e.key === "Escape") onOpenChange(false)
                }}
                placeholder="~/Projects/my-app or GitHub/GitLab URL"
              />
              {isCloneMode ? cloneIndicator : (
                <p className="text-xs text-muted-foreground">
                  The folder will be created if it doesn't exist.
                </p>
              )}
            </div>
          )}

          {cloneError && (
            <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-lg px-3 py-2">
              {cloneError}
            </div>
          )}
        </DialogBody>
        {!isBusy && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {isCloneMode ? "Clone" : "Create"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

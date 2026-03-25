import { useState, useEffect, useRef } from "react"
import { ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react"
import { DEFAULT_NEW_PROJECT_ROOT } from "../../shared/branding"
import type { DirectoryBrowserSnapshot } from "../../shared/types"
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
import { ScrollArea } from "./ui/scroll-area"
import { cn } from "../lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialDirectory: DirectoryBrowserSnapshot | null
  onListDirectories: (localPath?: string) => Promise<DirectoryBrowserSnapshot>
  onConfirm: (project: { mode: Tab; localPath: string; title: string }) => void
}

type Tab = "new" | "existing"

function toKebab(str: string): string {
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function getPathLabel(localPath: string) {
  const parts = localPath.split("/").filter(Boolean)
  return parts[parts.length - 1] || localPath
}

export function NewProjectModal({ open, onOpenChange, initialDirectory, onListDirectories, onConfirm }: Props) {
  const [tab, setTab] = useState<Tab>("new")
  const [name, setName] = useState("")
  const [roots, setRoots] = useState<DirectoryBrowserSnapshot["roots"]>([])
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, DirectoryBrowserSnapshot["entries"]>>({})
  const [expandedPaths, setExpandedPaths] = useState<string[]>([])
  const [homePath, setHomePath] = useState<string | null>(null)
  const [selectedExistingPath, setSelectedExistingPath] = useState("")
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setTab("new")
      setName("")
      setRoots(initialDirectory ? initialDirectory.roots : [])
      setDirectoryEntries(initialDirectory ? { [initialDirectory.currentPath]: initialDirectory.entries } : {})
      setExpandedPaths(initialDirectory ? [initialDirectory.currentPath] : [])
      setHomePath(initialDirectory?.currentPath ?? null)
      setSelectedExistingPath("")
      setPickerError(null)
      setLoadingPath(null)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [initialDirectory, open])

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (tab === "new") inputRef.current?.focus()
      }, 0)
    }
  }, [tab, open])

  const kebab = toKebab(name)
  const newPath = kebab ? `${DEFAULT_NEW_PROJECT_ROOT}/${kebab}` : ""
  const trimmedExisting = selectedExistingPath.trim()

  const canSubmit = tab === "new" ? !!kebab : !!trimmedExisting

  const loadDirectory = async (localPath?: string) => {
    setPickerError(null)
    setLoadingPath(localPath ?? "__root__")
    try {
      const snapshot = await onListDirectories(localPath)
      if (!localPath) {
        setRoots(snapshot.roots)
        setHomePath(snapshot.currentPath)
        setDirectoryEntries({ [snapshot.currentPath]: snapshot.entries })
        setExpandedPaths([snapshot.currentPath])
        return
      }

      if (roots.length === 0) {
        setRoots([{ name: getPathLabel(snapshot.currentPath), localPath: snapshot.currentPath }])
        setHomePath(snapshot.currentPath)
      }
      setDirectoryEntries((current) => ({
        ...current,
        [snapshot.currentPath]: snapshot.entries,
      }))
      setExpandedPaths((current) => current.includes(snapshot.currentPath) ? current : [...current, snapshot.currentPath])
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingPath(null)
    }
  }

  const toggleExpanded = async (localPath: string) => {
    if (expandedPaths.includes(localPath)) {
      setExpandedPaths((current) => current.filter((path) => path !== localPath))
      return
    }

    if (directoryEntries[localPath]) {
      setExpandedPaths((current) => [...current, localPath])
      return
    }

    await loadDirectory(localPath)
  }

  const renderDirectoryNode = (localPath: string, name: string, level: number) => {
    const isExpanded = expandedPaths.includes(localPath)
    const isSelected = selectedExistingPath === localPath
    const children = directoryEntries[localPath] ?? []
    const isLoading = loadingPath === localPath

    return (
      <div key={localPath}>
        <div
          className={cn(
            "grid grid-cols-[auto_1fr] items-center gap-2 px-3 py-2",
            isSelected ? "bg-muted" : "hover:bg-muted/50"
          )}
          style={{ paddingLeft: `${12 + level * 16}px` }}
        >
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-background disabled:opacity-50"
            onClick={() => void toggleExpanded(localPath)}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", isExpanded && "rotate-90")} />
            )}
          </button>
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => setSelectedExistingPath(localPath)}
          >
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{name}</span>
          </button>
        </div>
        {isExpanded && children.length > 0 ? children.map((entry) => renderDirectoryNode(entry.localPath, entry.name, level + 1)) : null}
      </div>
    )
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    if (tab === "new") {
      onConfirm({ mode: "new", localPath: newPath, title: name.trim() })
    } else {
      const folderName = trimmedExisting.split("/").pop() || trimmedExisting
      onConfirm({ mode: "existing", localPath: trimmedExisting, title: folderName })
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogBody className="space-y-4">
          <DialogTitle>Add Project</DialogTitle>

          <SegmentedControl
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "new" as Tab, label: "New Folder" },
              { value: "existing" as Tab, label: "Existing Folder" },
            ]}
            className="w-full mb-2"
            optionClassName="flex-1 justify-center"
          />

          {tab === "new" ? (
            <div className="space-y-2">
              <Input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit()
                  if (e.key === "Escape") onOpenChange(false)
                }}
                placeholder="Project name"
              />
              {newPath && (
                <p className="text-xs text-muted-foreground font-mono">
                  {newPath}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                type="text"
                value={selectedExistingPath}
                onChange={(event) => setSelectedExistingPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void loadDirectory(selectedExistingPath || undefined)
                  }
                }}
                placeholder="Enter a server path, for example /home/bettie/Projects/my-app"
              />
              <p className="text-xs text-muted-foreground">
                Import an existing folder from the connected server machine. You can type a path manually or choose from the root folder list below.
              </p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadDirectory("~")}
                  disabled={loadingPath !== null}
                >
                  Load Root
                </Button>
              </div>
              {roots.length > 0 ? (
                <>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Server Folders
                  </p>
                  <ScrollArea className="max-h-64 rounded-xl border border-border">
                    {roots.map((root) => renderDirectoryNode(root.localPath, root.name, 0))}
                    {homePath && directoryEntries[homePath]?.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No subfolders
                      </div>
                    ) : null}
                  </ScrollArea>
                </>
              ) : loadingPath ? (
                <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading folders from server machine...
                </div>
              ) : null}
              {pickerError ? (
                <p className="text-xs text-destructive">{pickerError}</p>
              ) : null}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {tab === "new" ? "Create" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

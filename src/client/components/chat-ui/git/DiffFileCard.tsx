import { PatchDiff } from "@pierre/diffs/react"
import { Ban, ChevronDown, ChevronUp, Code, Copy, Ellipsis, FolderOpen, LoaderCircle, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react"
import type { ChatAttachment } from "../../../../shared/types"
import { useStickyState } from "../../../hooks/useStickyState"
import { cn } from "../../../lib/utils"
import { AttachmentFileCard, AttachmentImageCard } from "../../messages/AttachmentCard"
import { AttachmentPreviewModal } from "../../messages/AttachmentPreviewModal"
import { classifyAttachmentPreview } from "../../messages/attachmentPreview"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../ui/context-menu"
import { StageCheckbox, type DiffFile, type DiffRenderMode } from "./shared"

export function shouldLoadDiffPatchNow(args: {
  isCollapsed: boolean
  hasPreviewAttachment: boolean
  patch?: string
  patchError?: string
  isPatchLoading: boolean
}) {
  return !args.isCollapsed
    && !args.hasPreviewAttachment
    && args.patch === undefined
    && args.patchError === undefined
    && !args.isPatchLoading
}

function getDiffPreviewAttachment(projectId: string | null, file: DiffFile): ChatAttachment | null {
  if (!projectId || !file.mimeType || typeof file.size !== "number" || file.changeType === "deleted") {
    return null
  }

  if (!file.mimeType.startsWith("image/") && file.mimeType !== "application/pdf") {
    return null
  }

  return {
    id: `diff:${file.path}`,
    kind: file.mimeType.startsWith("image/") ? "image" : "file",
    displayName: file.path.split("/").pop() ?? file.path,
    absolutePath: file.path,
    relativePath: file.path,
    contentUrl: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content`,
    mimeType: file.mimeType,
    size: file.size,
  }
}

export interface DiffFileActions {
  onOpenFile: (path: string) => void
  onOpenInFinder: (path: string) => void
  onDiscardFile: (path: string) => void
  onIgnoreFile: (path: string) => void
  onIgnoreFolder: (path: string) => void
  onCopyFilePath: (path: string) => void
  onCopyRelativePath: (path: string) => void
}

export function canIgnoreDiffFile(file: DiffFile) {
  // New files are ignorable whether they are untracked or already staged (the
  // server unstages staged new files before adding the .gitignore entry).
  // Tracked files stay disabled: .gitignore has no effect on tracked files.
  return file.isUntracked || file.changeType === "added"
}

export function canIgnoreDiffFolder(file: DiffFile) {
  if (!canIgnoreDiffFile(file)) {
    return false
  }
  return file.path.includes("/")
}

export function DiffFileCard({
  file,
  rootRef,
  projectId,
  isCollapsed,
  isChecked,
  editorLabel,
  diffRenderMode,
  wrapLines,
  onToggleCollapsed,
  onToggleChecked,
  fileActions,
  patch,
  patchError,
  isPatchLoading,
  onLoadPatch,
}: {
  file: DiffFile
  rootRef: RefObject<HTMLDivElement | null>
  projectId: string | null
  isCollapsed: boolean
  isChecked: boolean
  editorLabel: string
  diffRenderMode: DiffRenderMode
  wrapLines: boolean
  onToggleCollapsed: () => void
  onToggleChecked: () => void
  fileActions: DiffFileActions
  patch?: string
  patchError?: string
  isPatchLoading: boolean
  onLoadPatch: (path: string) => Promise<string>
}) {
  const canIgnore = canIgnoreDiffFile(file)
  const canIgnoreFolder = canIgnoreDiffFolder(file)
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const autoLoadPatchKeyRef = useRef<string | null>(null)
  const { sentinelRef, isStuck } = useStickyState<HTMLDivElement>({
    rootRef,
    disabled: isCollapsed,
  })
  const previewAttachment = useMemo(() => getDiffPreviewAttachment(projectId, file), [file, projectId])
  const hasPreviewAttachment = previewAttachment !== null
  const shouldLoadPatchWhenVisible = shouldLoadDiffPatchNow({
    isCollapsed,
    hasPreviewAttachment,
    patch,
    patchError,
    isPatchLoading,
  })

  useEffect(() => {
    if (!shouldLoadPatchWhenVisible) {
      return
    }

    const autoLoadKey = `${file.path}\u0000${file.patchDigest}`
    if (autoLoadPatchKeyRef.current === autoLoadKey) {
      return
    }

    autoLoadPatchKeyRef.current = autoLoadKey
    void onLoadPatch(file.path).catch(() => {})
  }, [file.patchDigest, file.path, onLoadPatch, shouldLoadPatchWhenVisible])

  function handleAttachmentClick(attachment: ChatAttachment) {
    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }
    setSelectedAttachmentId(attachment.id)
  }

  function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    cardRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
      view: window,
    }))
  }

  function handleToggleRequest() {
    if (!isCollapsed) {
      onToggleCollapsed()
      return
    }

    if (hasPreviewAttachment || patch !== undefined) {
      onToggleCollapsed()
      return
    }

    if (isPatchLoading) {
      return
    }

    const shouldLoadBeforeExpand = patchError !== undefined || shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment,
      patch,
      patchError,
      isPatchLoading,
    })
    if (!shouldLoadBeforeExpand) {
      onToggleCollapsed()
      return
    }

    void onLoadPatch(file.path).then(() => {
      onToggleCollapsed()
    }).catch(() => {})
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={cardRef} key={file.path} className="relative rounded-lg border border-border bg-background">
          {!isCollapsed ? <div ref={sentinelRef} className="pointer-events-none absolute inset-x-0 top-0 h-px" aria-hidden="true" /> : null}
          <div
            role="button"
            tabIndex={0}
            onClick={handleToggleRequest}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              handleToggleRequest()
            }}
            className={cn(
              "group/header sticky top-0 z-20 flex cursor-pointer items-center justify-between gap-3 bg-background pl-[7px] pr-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              !isCollapsed && !isStuck && "rounded-t-[calc(theme(borderRadius.lg)-1px)]",
              isCollapsed && "rounded-[calc(theme(borderRadius.lg)-1px)]",
              !isCollapsed && "border-b border-border/50"
            )}
          >
            <div className="flex min-w-0 items-center">
              <StageCheckbox
                checked={isChecked}
                onClick={onToggleChecked}
              />
              <div className="min-w-0 truncate select-none ml-2 mr-1">{file.path}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2 select-none">
              <span className="whitespace-nowrap text-xs font-mono">
                {file.additions > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span> : null}
                {file.deletions > 0 ? (
                  <span className={file.additions > 0 ? "ml-2 text-red-600 dark:text-red-400" : "text-red-600 dark:text-red-400"}>
                    -{file.deletions}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                aria-label={`Open actions for ${file.path}`}
                onClick={openContextMenuFromButton}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Ellipsis className="h-3.5 w-3.5 shrink-0" />
              </button>
              {isPatchLoading && isCollapsed && !previewAttachment ? (
                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : isCollapsed ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5 shrink-0" />
              )}
            </div>
          </div>
          {!isCollapsed ? (
            <div className="kanna-diff-patch overflow-hidden rounded-b-[calc(theme(borderRadius.lg)-1px)] pb-[1px]">
              {previewAttachment ? (
                <div className="flex justify-center p-3">
                  {previewAttachment.kind === "image" ? (
                    <AttachmentImageCard
                      attachment={previewAttachment}
                      onClick={() => handleAttachmentClick(previewAttachment)}
                    />
                  ) : (
                    <AttachmentFileCard
                      attachment={previewAttachment}
                      onClick={() => handleAttachmentClick(previewAttachment)}
                    />
                  )}
                </div>
              ) : (
                isPatchLoading ? (
                  <div className="flex items-center justify-center px-3 py-8 text-sm text-muted-foreground">
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    Loading diff...
                  </div>
                ) : patchError ? (
                  <div className="px-3 py-4 text-sm text-destructive">{patchError}</div>
                ) : patch !== undefined ? (
                  <PatchDiff
                    patch={patch}
                    options={{
                      diffStyle: diffRenderMode,
                      disableFileHeader: true,
                      disableBackground: false,
                      overflow: wrapLines ? "wrap" : "scroll",
                      lineDiffType: "word",
                      diffIndicators: "classic",
                    }}
                  />
                ) : (
                  <div className="px-3 py-4 text-sm text-muted-foreground">Diff unavailable.</div>
                )
              )}
            </div>
          ) : null}
          <AttachmentPreviewModal
            attachment={previewAttachment && selectedAttachmentId === previewAttachment.id ? previewAttachment : null}
            onOpenChange={(open) => !open && setSelectedAttachmentId(null)}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            fileActions.onOpenFile(file.path)
          }}
        >
          <Code className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in {editorLabel}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            fileActions.onOpenInFinder(file.path)
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in Finder</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            fileActions.onDiscardFile(file.path)
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Discard Changes</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canIgnore}
          onSelect={(event) => {
            event.stopPropagation()
            if (!canIgnore) return
            fileActions.onIgnoreFile(file.path)
          }}
        >
          <Ban className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Ignore File</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canIgnoreFolder}
          onSelect={(event) => {
            event.stopPropagation()
            if (!canIgnoreFolder) return
            fileActions.onIgnoreFolder(file.path)
          }}
        >
          <Ban className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Ignore folder...</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            fileActions.onCopyFilePath(file.path)
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy File Path</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            fileActions.onCopyRelativePath(file.path)
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy Relative Path</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

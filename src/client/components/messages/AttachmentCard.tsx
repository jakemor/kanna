import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  ReceiptText,
  ScrollText,
  X,
  type LucideIcon,
} from "lucide-react"
import type { ChatAttachment } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { classifyAttachmentIcon, type AttachmentIconKind } from "./attachmentPreview"

type BaseAttachmentCardProps = {
  attachment: ChatAttachment
  previewUrl?: string
  onClick?: () => void
  onRemove?: () => void
  className?: string
}

type AttachmentImageCardProps = BaseAttachmentCardProps & {
  size?: "transcript" | "composer"
}

export function AttachmentImageCard({
  attachment,
  previewUrl,
  onClick,
  onRemove,
  className,
  size = "transcript",
}: AttachmentImageCardProps) {
  const source = attachment.contentUrl || previewUrl
  const isComposer = size === "composer"

  return (
    <div className={cn("group relative flex flex-row items-end", className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group/image relative overflow-hidden rounded-xl border border-border/80 bg-background/85 shadow-sm backdrop-blur-md",
          isComposer ? "min-w-[80px]" : "min-w-[200px]",
        )}
      >
        {source ? (
          <img
            src={source}
            alt={attachment.displayName}
            className={cn(
              "rounded-xl object-contain bg-muted",
              isComposer
                ? "min-h-[50px] min-w-[80px] max-h-[120px] max-w-[200px]"
                : "min-h-[100px] min-w-[200px] max-h-[300px] max-w-[300px]",
            )}
          />
        ) : (
          <div
            className={cn(
              "flex items-center justify-center rounded-xl bg-muted text-muted-foreground",
              isComposer ? "min-h-[64px] min-w-[80px]" : "min-h-[160px] min-w-[200px]",
            )}
          >
            <FileImage className={cn(isComposer ? "size-6" : "size-8")} />
          </div>
        )}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent text-left opacity-0 transition-opacity duration-200 group-hover/image:opacity-100",
            isComposer ? "px-2.5 pb-2 pt-6" : "px-4 pb-3 pt-10",
          )}
        >
          <div className={cn("truncate font-medium text-white", isComposer ? "text-xs" : "text-sm")}>{attachment.displayName}</div>
          <div className="truncate text-xs text-white/80">
            {attachment.mimeType} · {formatAttachmentSize(attachment.size)}
          </div>
        </div>
      </button>
      {onRemove ? <RemoveButton displayName={attachment.displayName} onRemove={onRemove} /> : null}
    </div>
  )
}

export function AttachmentFileCard({
  attachment,
  onClick,
  onRemove,
  className,
}: BaseAttachmentCardProps) {
  const Icon = getAttachmentIcon(classifyAttachmentIcon(attachment))

  return (
    <div className={cn("group relative", className)}>
      <button
        type="button"
        onClick={onClick}
        className="flex w-[200px] items-center gap-2 rounded-xl border border-border bg-background/85 p-1 pr-3 text-left transition-colors hover:bg-accent/50"
      >
        <div className="flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="max-w-[150px] truncate text-[13px] font-medium text-foreground">{attachment.displayName}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {attachment.mimeType} · {formatAttachmentSize(attachment.size)}
          </div>
        </div>
      </button>
      {onRemove ? <RemoveButton displayName={attachment.displayName} onRemove={onRemove} /> : null}
    </div>
  )
}

function RemoveButton({ displayName, onRemove }: { displayName: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className="absolute right-2 top-2 rounded-full bg-background/90 p-1 text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onRemove()
      }}
      aria-label={`Remove ${displayName}`}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  )
}

function getAttachmentIcon(kind: AttachmentIconKind): LucideIcon {
  switch (kind) {
    case "image":
      return FileImage
    case "pdf":
      return ReceiptText
    case "markdown":
      return ScrollText
    case "json":
      return FileJson
    case "table":
      return FileSpreadsheet
    case "code":
      return FileCode2
    case "text":
      return FileText
    case "archive":
      return FileArchive
    case "audio":
      return FileAudio
    case "video":
      return FileVideoCamera
    default:
      return File
  }
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

import { useEffect, useState } from "react"
import { ExternalLink, Link2 } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ChatAttachment } from "../../../shared/types"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogGhostButton,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"
import { createMarkdownComponents } from "./shared"
import { FileContentView } from "./FileContentView"
import {
  TABLE_PREVIEW_COLUMN_LIMIT,
  TEXT_PREVIEW_LIMIT_BYTES,
  classifyAttachmentPreview,
  fetchTextPreview,
  parseDelimitedPreview,
  prettifyJson,
  type AttachmentPreviewKind,
  type TablePreviewData,
} from "./attachmentPreview"
import { formatAttachmentSize } from "./AttachmentCard"

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
    status: "ready"
    kind: Extract<AttachmentPreviewKind, "markdown" | "text" | "json" | "table">
    content?: string
    truncated?: boolean
    table?: TablePreviewData
  }

type LoadablePreviewKind = Extract<AttachmentPreviewKind, "markdown" | "text" | "json" | "table">

interface Props {
  attachment: ChatAttachment | null
  onOpenChange: (open: boolean) => void
}

export function AttachmentPreviewModal({ attachment, onOpenChange }: Props) {
  const [previewCache, setPreviewCache] = useState<Record<string, PreviewState>>({})
  const previewTarget = attachment ? classifyAttachmentPreview(attachment) : null
  const previewState = attachment ? previewCache[attachment.id] : undefined
  const absoluteContentUrl = attachment?.contentUrl ? toAbsoluteUrl(attachment.contentUrl) : ""

  useEffect(() => {
    if (!attachment || !previewTarget || previewTarget.openInNewTab) {
      return
    }

    if (previewTarget.kind === "image" || previewTarget.kind === "pdf" || previewTarget.kind === "external") {
      return
    }

    const previewKind: LoadablePreviewKind = previewTarget.kind
    if (previewState?.status === "loading" || previewState?.status === "ready") {
      return
    }

    let cancelled = false

    setPreviewCache((current) => ({
      ...current,
      [attachment.id]: { status: "loading" },
    }))

    void fetchTextPreview(attachment.contentUrl, TEXT_PREVIEW_LIMIT_BYTES)
      .then(({ content: rawContent, truncated }) => {
        if (cancelled) return

        if (previewKind === "table") {
          const delimiter = attachment.mimeType === "text/tab-separated-values" ? "\t" : ","
          setPreviewCache((current) => ({
            ...current,
            [attachment.id]: {
              status: "ready",
              kind: "table",
              truncated,
              table: parseDelimitedPreview(rawContent, delimiter),
            },
          }))
          return
        }

        const content = previewKind === "json" ? prettifyJson(rawContent) : rawContent
        setPreviewCache((current) => ({
          ...current,
          [attachment.id]: {
            status: "ready",
            kind: previewKind,
            content,
            truncated,
          },
        }))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : "Unable to load preview."
        setPreviewCache((current) => ({
          ...current,
          [attachment.id]: { status: "error", message },
        }))
      })

    return () => {
      cancelled = true
    }
  }, [attachment, previewState?.status, previewTarget])

  async function handleCopyLink() {
    if (!absoluteContentUrl || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return
    }
    await navigator.clipboard.writeText(absoluteContentUrl)
  }

  function handleOpenInNewTab() {
    if (!absoluteContentUrl || typeof window === "undefined") {
      return
    }
    window.open(absoluteContentUrl, "_blank", "noopener,noreferrer")
  }

  return (
    <Dialog open={attachment !== null && !previewTarget?.openInNewTab} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-w-[min(92vw,960px)] overflow-hidden p-0">
        {attachment && previewTarget && !previewTarget.openInNewTab ? (
          <>
            <DialogHeader className="pr-12">
              <DialogTitle className="text-md">{attachment.displayName}</DialogTitle>
            </DialogHeader>
            <DialogBody className="bg-muted/20 p-4">
              {renderAttachmentPreviewBody(attachment, previewTarget.kind, previewState)}
            </DialogBody>
            <DialogFooter className="items-center justify-between gap-3 px-4 py-3">
              <DialogDescription className="truncate">
                {attachment.mimeType} · {formatAttachmentSize(attachment.size)}
              </DialogDescription>
              <div className="flex items-center gap-2">
                <DialogGhostButton type="button" onClick={handleCopyLink}>
                  <Link2 className="mr-2 h-4 w-4" />
                  Copy Link
                </DialogGhostButton>
                <Button type="button" variant="outline" onClick={handleOpenInNewTab}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open In New Tab
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function renderAttachmentPreviewBody(
  attachment: ChatAttachment,
  kind: AttachmentPreviewKind,
  previewState?: PreviewState,
) {
  if (kind === "image") {
    return (
      <div className="flex items-center justify-center">
        <img
          src={attachment.contentUrl}
          alt={attachment.displayName}
          className="max-h-[70vh] w-auto max-w-full rounded-2xl object-contain"
        />
      </div>
    )
  }

  if (kind === "pdf") {
    return (
      <iframe
        src={attachment.contentUrl}
        title={attachment.displayName}
        className="h-[70vh] w-full rounded-xl border border-border bg-background"
      />
    )
  }

  if (!previewState || previewState.status === "loading") {
    return <div className="flex h-[50vh] items-center justify-center text-sm text-muted-foreground">Loading preview…</div>
  }

  if (previewState.status === "error") {
    return <div className="flex h-[50vh] items-center justify-center text-sm text-destructive">{previewState.message}</div>
  }

  if (previewState.kind === "markdown" && previewState.content !== undefined) {
    return (
      <div className="space-y-3">
        {previewState.truncated ? <PreviewNotice message="Preview truncated to 1024 KB." /> : null}
        <div className="prose prose-sm max-w-none overflow-auto rounded-xl border border-border bg-background p-4 prose-invert">
          <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>
            {previewState.content}
          </Markdown>
        </div>
      </div>
    )
  }

  if (previewState.kind === "table" && previewState.table) {
    const hasHeader = previewState.table.rows.length > 0
    const [header, ...bodyRows] = previewState.table.rows
    const notices = [
      previewState.truncated ? "Preview truncated to 1024 KB." : null,
      previewState.table.truncatedRows ? `Showing first ${previewState.table.rows.length} of ${previewState.table.rowCount} rows.` : null,
      previewState.table.truncatedColumns ? `Showing first ${TABLE_PREVIEW_COLUMN_LIMIT} of ${previewState.table.columnCount} columns.` : null,
    ].filter(Boolean)

    return (
      <div className="space-y-3">
        {notices.length > 0 ? <PreviewNotice message={notices.join(" ")} /> : null}
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-border bg-background">
          <table className="min-w-full border-collapse text-xs">
            {hasHeader ? (
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {header.map((cell, index) => (
                    <th key={`${cell}-${index}`} className="border-b border-border px-3 py-2 text-left font-medium text-foreground">
                      {cell || "\u00A0"}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {(hasHeader ? bodyRows : previewState.table.rows).map((row, rowIndex) => (
                <tr key={rowIndex} className="odd:bg-background even:bg-muted/20">
                  {row.map((cell, cellIndex) => (
                    <td key={`${rowIndex}-${cellIndex}`} className="max-w-[320px] border-b border-border px-3 py-2 align-top text-foreground">
                      <div className="whitespace-pre-wrap break-words">{cell || "\u00A0"}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {previewState.truncated ? <PreviewNotice message="Preview truncated to 1024 KB." /> : null}
      <FileContentView content={previewState.content ?? ""} />
    </div>
  )
}

function PreviewNotice({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
      {message}
    </div>
  )
}

function toAbsoluteUrl(path: string): string {
  if (typeof window === "undefined") {
    return path
  }

  return new URL(path, window.location.origin).toString()
}

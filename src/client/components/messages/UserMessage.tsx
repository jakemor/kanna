import { useMemo } from "react"
import type { ChatAttachment } from "../../../shared/types"
import { CornerUpLeft } from "lucide-react"
import { TranscriptMarkdown } from "./shared"
import { classifyAttachmentPreview } from "./attachmentPreview"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"
import { openViewer, viewerAttachmentFromChat } from "../../stores/viewerStore"
import { useTranscriptRenderOptions } from "./render-context"
import { cn } from "../../lib/utils"

interface Props {
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  /**
   * Light the bubble — a jump just landed on this message.
   *
   * The bubble rather than the row box the rest of the transcript lights: a
   * user prompt is a shape on one side of the column, not a full-width block,
   * so washing its container would light mostly empty space beside it.
   */
  flash?: boolean
}

/**
 * Legacy compatibility: steered prompts used to persist the injected
 * <system-message> block inside the transcript content, hidden here at render
 * time. Injections are now wire-only (applied at the harness boundary in
 * startTurnForChat and never stored), so this strip only matters for
 * transcripts written before that change.
 */
function parseSystemMessage(content: string) {
  const match = content.match(/^<system-message>\s*([\s\S]*?)\s*<\/system-message>\s*([\s\S]*)$/)
  if (!match) {
    return { systemMessage: null, body: content }
  }

  return {
    systemMessage: match[1]?.trim() || null,
    body: match[2] ?? "",
  }
}

/**
 * A prompt's attachments: images as previews, everything else as file cards.
 * Shared with QueuedUserMessage so a queued prompt shows its attachments the
 * way they will look once it is sent.
 */
export function UserMessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const renderOptions = useTranscriptRenderOptions()
  const shouldShowImagePlaceholders = renderOptions.attachmentMode === "metadata"
  const canInteractWithAttachments = !renderOptions.readonly || renderOptions.attachmentMode === "bundle"
  const imageAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.kind === "image" && (attachment.contentUrl || shouldShowImagePlaceholders)),
    [attachments, shouldShowImagePlaceholders],
  )
  const fileAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.kind !== "image" || (!attachment.contentUrl && !shouldShowImagePlaceholders)),
    [attachments, shouldShowImagePlaceholders],
  )

  function handleAttachmentClick(attachment: ChatAttachment) {
    if (!canInteractWithAttachments || !attachment.contentUrl) {
      return
    }

    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, document.baseURI || window.location.href).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }

    openViewer({ kind: "attachment", attachment: viewerAttachmentFromChat(attachment) })
  }

  return (
    <>
      {imageAttachments.length > 0 ? (
        <div className="flex max-w-[85%] sm:max-w-[80%] flex-wrap justify-end gap-3">
          {imageAttachments.map((attachment) => (
            <AttachmentImageCard
              key={attachment.id}
              attachment={attachment}
              onClick={canInteractWithAttachments ? () => handleAttachmentClick(attachment) : undefined}
            />
          ))}
        </div>
      ) : null}
      {fileAttachments.length > 0 ? (
        <div className="flex max-w-[85%] sm:max-w-[80%] flex-wrap justify-end gap-2">
          {fileAttachments.map((attachment) => (
            <AttachmentFileCard
              key={attachment.id}
              attachment={attachment}
              onClick={canInteractWithAttachments ? () => handleAttachmentClick(attachment) : undefined}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

export function UserMessage({ content, attachments = [], steered = false, flash = false }: Props) {
  const parsedContent = useMemo(() => parseSystemMessage(content), [content])

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <UserMessageAttachments attachments={attachments} />
        {(parsedContent.body || (!parsedContent.body && attachments.length === 0 && content && !parsedContent.systemMessage)) ? (
          <div className="flex max-w-[85%] items-center gap-2 sm:max-w-[80%]">
            {steered ? (
              <span
                aria-label="Sent mid-turn"
                role="img"
                title="Sent mid-turn"
                className="shrink-0 text-muted-foreground"
              >
                <CornerUpLeft className="h-4 w-4" />
              </span>
            ) : null}
            {/* The flash is a class on the bubble, not a layer inside it: this
                is a `prose` container, and an extra child displaces the
                `:first-child` margin reset onto itself, which grew the bubble
                by a paragraph's top margin for the length of the flash. */}
            <div className={cn(
              "min-w-0 flex-1 rounded-2xl border border-border bg-muted px-3.5 py-1.5 text-primary prose prose-sm prose-invert [&_p]:whitespace-pre-line",
              flash && "kanna-jump-flash",
            )}>
              <TranscriptMarkdown text={parsedContent.body} />
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

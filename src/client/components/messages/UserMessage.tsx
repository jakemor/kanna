import { useMemo, useState } from "react"
import type { ChatAttachment } from "../../../shared/types"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { createMarkdownComponents } from "./shared"
import { classifyAttachmentPreview } from "./attachmentPreview"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"
import { AttachmentPreviewModal } from "./AttachmentPreviewModal"
import { Zap } from "lucide-react"

interface Props {
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  autoContinue?: { scheduleId: string }
}

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

export function UserMessage({ content, attachments = [], steered = false, autoContinue }: Props) {
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const parsedContent = useMemo(() => parseSystemMessage(content), [content])
  const imageAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.kind === "image" && attachment.contentUrl),
    [attachments],
  )
  const fileAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.kind !== "image" || !attachment.contentUrl),
    [attachments],
  )
  const selectedAttachment = attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null

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

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        {imageAttachments.length > 0 ? (
          <div className="flex max-w-[85%] sm:max-w-[80%] flex-wrap justify-end gap-3">
            {imageAttachments.map((attachment) => (
              <AttachmentImageCard
                key={attachment.id}
                attachment={attachment}
                onClick={() => handleAttachmentClick(attachment)}
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
                onClick={attachment.contentUrl ? () => handleAttachmentClick(attachment) : undefined}
              />
            ))}
          </div>
        ) : null}
        {(parsedContent.body || (!parsedContent.body && attachments.length === 0 && content && !parsedContent.systemMessage)) ? (
          <div className="flex max-w-[85%] items-center gap-2 sm:max-w-[80%]">
            {steered ? (
              <Zap
                aria-label="Sent mid-turn"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            ) : null}
            <div className="min-w-0 flex-1 rounded-[20px] border border-border bg-muted px-3.5 py-1.5 text-primary prose prose-sm prose-invert [&_p]:whitespace-pre-line">
              <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{parsedContent.body}</Markdown>
            </div>
          </div>
        ) : null}
        {autoContinue ? (
          <span className="text-xs text-muted-foreground opacity-70">auto-sent</span>
        ) : null}
      </div>
      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
    </>
  )
}

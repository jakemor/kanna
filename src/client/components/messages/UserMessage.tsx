import { useMemo, useState } from "react"
import type { ChatAttachment } from "../../../shared/types"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { createMarkdownComponents } from "./shared"
import { classifyAttachmentPreview } from "./attachmentPreview"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"
import { AttachmentPreviewModal } from "./AttachmentPreviewModal"

interface Props {
  content: string
  attachments?: ChatAttachment[]
}

export function UserMessage({ content, attachments = [] }: Props) {
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
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
                onClick={() => handleAttachmentClick(attachment)}
              />
            ))}
          </div>
        ) : null}
        {content ? (
          <div className="max-w-[85%] sm:max-w-[80%] rounded-[20px] py-1.5 px-3.5 bg-muted text-primary border border-border prose prose-sm prose-invert [&_p]:whitespace-pre-line">
            <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{content}</Markdown>
          </div>
        ) : null}
      </div>
      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
    </>
  )
}

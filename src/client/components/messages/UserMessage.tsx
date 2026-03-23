import { useEffect, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { HydratedChatAttachment } from "../../../shared/types"
import { createMarkdownComponents } from "./shared"

interface Props {
  content: string
  attachments?: HydratedChatAttachment[]
}

export function UserMessage({ content, attachments }: Props) {
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null)
  const expandedImage = attachments?.find((attachment) => attachment.id === expandedImageId) ?? null

  useEffect(() => {
    if (expandedImage) return
    setExpandedImageId(null)
  }, [expandedImage])

  return (
    <>
      <div className="flex gap-2 justify-end">
        <div className="max-w-[85%] sm:max-w-[80%] rounded-[20px] py-1.5 px-3.5 bg-muted text-primary border border-border prose prose-sm prose-invert [&_p]:whitespace-pre-line">
          {attachments?.length ? (
            <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
              {attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  className="overflow-hidden rounded-lg border border-border/80 bg-background/70 text-left cursor-zoom-in"
                  onClick={() => setExpandedImageId(attachment.id)}
                >
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-full max-h-[220px] w-full object-cover"
                  />
                  <div className="border-t border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
                    {attachment.name}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {content.trim() ? (
            <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{content}</Markdown>
          ) : null}
        </div>
      </div>
      {expandedImage ? (
        <button
          type="button"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 cursor-zoom-out"
          onClick={() => setExpandedImageId(null)}
        >
          <img
            src={expandedImage.previewUrl}
            alt={expandedImage.name}
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />
        </button>
      ) : null}
    </>
  )
}

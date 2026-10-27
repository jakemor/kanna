import { useMemo, useRef } from "react"
import type { ChatAttachment } from "../../../shared/types"
import { stripSystemMessages } from "../../../shared/message-preview"
import { CLAMP_LINES, ClampedMessageText, FOLD_SURFACE_ATTRIBUTE } from "./ClampedMessageText"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"
import { viewerAttachmentFromChat } from "../../stores/viewerStore"
import { activateAttachment, attachmentOpenAction } from "../viewer/attachmentActions"
import { useTranscriptRenderOptions } from "./render-context"
import { cn } from "../../lib/utils"

interface Props {
  content: string
  attachments?: ChatAttachment[]
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
 * Split a prompt into what is shown and whether anything was held back.
 *
 * A `<system-message>` block is for the agent, not the reader (see
 * `stripSystemMessages`). Most of what Kanna tells an agent is wire-only and
 * never stored. Two kinds are stored and so reach here: the header on a
 * sub-chat's report, which the report has to carry, and the steer notice in
 * transcripts written before that became wire-only.
 */
function parseSystemMessage(content: string) {
  const body = stripSystemMessages(content)
  return { systemMessage: body === content ? null : true, body }
}

/**
 * A prompt's attachments: images as previews, everything else as file cards.
 * Shared with QueuedUserMessage so a queued prompt shows its attachments the
 * way they will look once it is sent.
 *
 * `align` is the side of the column the prompt sits on: the end for one the
 * user typed, the start for one that was sent to the chat (SourcedMessage).
 */
export function UserMessageAttachments({ attachments, align = "end" }: { attachments: ChatAttachment[]; align?: "start" | "end" }) {
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

    activateAttachment(viewerAttachmentFromChat(attachment))
  }

  function downloads(attachment: ChatAttachment) {
    return canInteractWithAttachments && Boolean(attachment.contentUrl)
      && attachmentOpenAction(viewerAttachmentFromChat(attachment)) === "download"
  }

  return (
    <>
      {imageAttachments.length > 0 ? (
        <div className={cn("flex max-w-[85%] sm:max-w-[80%] flex-wrap", align === "end" ? "justify-end" : "justify-start", "gap-3")}>
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
        <div className={cn("flex max-w-[85%] sm:max-w-[80%] flex-wrap", align === "end" ? "justify-end" : "justify-start", "gap-2")}>
          {fileAttachments.map((attachment) => (
            <AttachmentFileCard
              key={attachment.id}
              attachment={attachment}
              downloads={downloads(attachment)}
              onClick={canInteractWithAttachments ? () => handleAttachmentClick(attachment) : undefined}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

/**
 * The look of a prompt's bubble. One string because a prompt that was sent to
 * the chat (SourcedMessage) is the same bubble on the other side.
 */
export const USER_BUBBLE_CLASS = "min-w-0 rounded-2xl border border-border bg-muted text-primary prose prose-sm prose-invert"

export function UserMessage({ content, attachments = [], flash = false }: Props) {
  const parsedContent = useMemo(() => parseSystemMessage(content), [content])
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <UserMessageAttachments attachments={attachments} />
        {(parsedContent.body || (!parsedContent.body && attachments.length === 0 && content && !parsedContent.systemMessage)) ? (
          // The flash is a class on the bubble, not a layer inside it: a
          // sibling of the text's first block displaces the `:first-child`
          // margin reset onto itself, which grew the bubble by a paragraph's
          // top margin for the length of the flash.
          <div ref={bubbleRef} {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(
            USER_BUBBLE_CLASS,
            "max-w-[85%] px-3.5 py-1.5 sm:max-w-[80%]",
            flash && "kanna-jump-flash",
          )}>
            <ClampedMessageText text={parsedContent.body} lines={CLAMP_LINES.typed} scopeRef={bubbleRef} />
          </div>
        ) : null}
      </div>
    </>
  )
}

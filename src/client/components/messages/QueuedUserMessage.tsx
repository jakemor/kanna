import type { QueuedChatMessage } from "../../../shared/types"
import { Button } from "../ui/button"
import { TranscriptMarkdown } from "./shared"
import { UserMessageAttachments } from "./UserMessage"
import { ArrowUp, X } from "lucide-react"

interface QueuedUserMessageProps {
  message: QueuedChatMessage
  onRemove: () => void
  onSendNow: () => void
}

export function QueuedUserMessage({ message, onRemove, onSendNow }: QueuedUserMessageProps) {
  return (
    <div className="flex flex-col items-end gap-2 py-2">
      <UserMessageAttachments attachments={message.attachments} />
      <div className="flex max-w-[85%] sm:max-w-[80%] flex-col items-end">
        {message.content ? (
          <div className="relative">
            {/* min-w-0 on the grid and on the text track: a `1fr` track sizes to
                min-content by default, so an unbreakable token (a long URL)
                widens the bubble past the column instead of wrapping the way it
                does in UserMessage. */}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2.5 rounded-2xl border border-dashed border-border bg-transparent pl-3.5 pr-1.5 py-1.5 prose prose-sm prose-invert text-left text-primary [&_p]:whitespace-pre-line">
              <div className="min-w-0">
                <TranscriptMarkdown text={message.content} />
              </div>
              <Button
                type="button"
                variant="default"
                size="none"
                aria-label="Send now"
                className="shrink-0 rounded-full size-[24px] bg-muted text-muted-foreground border border-primary/10 hover:!text-primary hover:bg-muted/60"
                onClick={onSendNow}
              >
                <ArrowUp className="size-3.5"/>
              </Button>
            </div>
            <Button
              type="button"
              variant="none"
              size="none"
              aria-label="Cancel message"
              className="!p-0.5 border rounded-full text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground/40 gap-0.5 absolute top-0 left-0 bg-background size-[24px] -translate-x-[28%] -translate-y-[28%]"
              onClick={onRemove}
            >
              <X className="size-3.5"/>
            </Button>
          </div>
        ) : null}

      </div>
    </div>
  )
}

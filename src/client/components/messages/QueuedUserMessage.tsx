import { useMemo, useState } from "react"
import type { MessageSource, QueuedChatMessage } from "../../../shared/types"
import type { ReportSection } from "../../../shared/report-sections"
import { stripSystemMessages } from "../../../shared/message-preview"
import { drawnMessageSource } from "../../lib/message-source"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { CLAMP_LINES, ClampedMessageText, FOLD_SURFACE_ATTRIBUTE } from "./ClampedMessageText"
import { AdoptionNotice, isAdoptionNotice, ReplyQuoteRow, ReportMarker, SourceQuote, sourcedSections } from "./SourcedMessage"
import { UserMessageAttachments } from "./UserMessage"
import { ArrowUp, X } from "lucide-react"

interface QueuedUserMessageProps {
  message: QueuedChatMessage
  /** Each may return the command's promise, which is how long the row stays dimmed. */
  onRemove: () => void | Promise<void>
  onSendNow: () => void | Promise<void>
  /** The queue's first message: ⌘/Ctrl+Enter on an empty composer sends it, and its Send now says so. */
  first?: boolean
}

/**
 * The keys that send the queue's first message from an empty composer
 * (`resolveModifiedEnter`). The composer takes either modifier; this names
 * the one the platform uses.
 */
export const SEND_QUEUED_SHORTCUT_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl+Enter"

/** The dashed outline that says a message is waiting, on either side of the column. */
const QUEUED_BUBBLE_CLASS = "rounded-2xl border border-dashed border-border bg-transparent prose prose-sm prose-invert text-left text-primary"

/**
 * What both controls share. The properties are named because the shared
 * Button's own transition is `all`, which would also ease the corner offsets
 * that place Remove. A press gives by 5%: at 18 and 24px, the 3% a full-size
 * button gives is under a pixel and reads as nothing.
 */
const QUEUED_CONTROL_CLASS = "transition-[color,background-color,scale] duration-150 ease-snappy active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100"

function SendNowButton({ onSendNow, disabled, first }: { onSendNow: () => void; disabled: boolean; first?: boolean }) {
  return (
    <Button
      type="button"
      variant="default"
      size="none"
      aria-label="Send now"
      title={first ? `Send now (${SEND_QUEUED_SHORTCUT_LABEL})` : "Send now"}
      disabled={disabled}
      className={cn(
        QUEUED_CONTROL_CLASS,
        // The circle is 24px. The `before` layer takes the press: 32px, which
        // is as far as it can reach without leaving the bubble.
        "relative shrink-0 rounded-full size-[24px] bg-muted text-muted-foreground border border-primary/10 group-hover:!text-primary hover:bg-muted/60 before:absolute before:-inset-1 before:rounded-full before:content-['']",
      )}
      onClick={onSendNow}
    >
      <ArrowUp className="size-3.5"/>
    </Button>
  )
}

/**
 * Takes the message out of the queue. On the bubble's corner that faces the
 * middle of the column, whichever side the bubble is on.
 *
 * Always there, not only under the pointer: a control that appears on hover
 * does not exist on a touch screen, and on a desktop it has to be found
 * before it can be used.
 */
function RemoveButton({ corner, onRemove, disabled }: { corner: "start" | "end"; onRemove: () => void; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="none"
      size="none"
      aria-label="Remove from queue"
      disabled={disabled}
      className={cn(
        QUEUED_CONTROL_CLASS,
        // The circle is 18px. The `before` layer is what takes the press:
        // 30px, so the target is comfortable without the mark growing.
        "!p-0.5 border rounded-full text-xs font-medium text-muted-foreground hover:text-foreground gap-0.5 absolute top-0 bg-surface -translate-y-[28%] before:absolute before:-inset-1.5 before:rounded-full before:content-['']",
        corner === "start" ? "left-0 -translate-x-[28%]" : "right-0 translate-x-[28%]",
      )}
      onClick={onRemove}
    >
      <X className="size-3"/>
    </Button>
  )
}

interface QueuedFormProps {
  message: QueuedChatMessage
  /** A press on Remove or Send now is on its way to the server. */
  busy: boolean
  onRemove: () => void
  onSendNow: () => void
  first?: boolean
}

/**
 * Dims while a press is being carried out. The queue is the server's: the
 * message stays where it is until the server says it has gone, and without
 * this a press on a slow connection looks like one that missed.
 */
const QUEUED_ROW_CLASS = "flex flex-col gap-2 py-2 transition-opacity duration-150 ease-out motion-reduce:transition-none"

export function QueuedUserMessage({ message, onRemove, onSendNow, first }: QueuedUserMessageProps) {
  const [busy, setBusy] = useState(false)
  // Held until the command settles, not until the row goes: if the server
  // refuses, the message is still queued and has to be usable again.
  const carryOut = (action: () => void | Promise<void>) => () => {
    setBusy(true)
    void Promise.resolve(action()).finally(() => setBusy(false))
  }
  const form = { message, busy, first, onRemove: carryOut(onRemove), onSendNow: carryOut(onSendNow) }
  // A sender this client does not draw waits as the user's own (`drawnMessageSource`).
  const source = drawnMessageSource(message.source)
  if (source?.kind === "report") return <QueuedReport {...form} source={source} />
  return source
    ? <QueuedSourcedMessage {...form} source={source} />
    : <QueuedTypedMessage {...form} />
}

function QueuedTypedMessage({ message, busy, onRemove, onSendNow, first }: QueuedFormProps) {
  // What the sent message will show: without the parts meant for the agent.
  const content = stripSystemMessages(message.content)
  return (
    <div className={cn(QUEUED_ROW_CLASS, "items-end", busy && "opacity-60")}>
      <UserMessageAttachments attachments={message.attachments} />
      <div className="flex max-w-[85%] sm:max-w-[80%] flex-col items-end">
        {/* Rendered even for an attachment-only message: the bubble carries
            Send now and Remove, and without it an image queued with no text
            could not be sent early or taken back. */}
        <div className="relative group">
          {/* min-w-0 on the grid and on the text track: a `1fr` track sizes to
              min-content by default, so an unbreakable token (a long URL)
              widens the bubble past the column instead of wrapping the way it
              does in UserMessage. */}
          <div {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(QUEUED_BUBBLE_CLASS, "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2.5 pl-3.5 pr-1.5 py-1.5")}>
            <div className="min-w-0">
              {content ? (
                <ClampedMessageText text={content} lines={CLAMP_LINES.typed} />
              ) : (
                <p className="text-muted-foreground">Queued</p>
              )}
            </div>
            <SendNowButton onSendNow={onSendNow} disabled={busy} first={first} />
          </div>
          <RemoveButton corner="start" onRemove={onRemove} disabled={busy} />
        </div>
      </div>
    </div>
  )
}

/**
 * A sub-chat's report that arrived mid-turn, in the form it will take once
 * delivered (SourcedMessage): a line per sub-chat, no bubble and no reply.
 * The lines sit in the dashed outline of something still waiting, with Send
 * now leading them and Remove on the far corner, as on any queued message
 * from another chat. It is one message to send or remove, however many
 * sub-chats it covers, so there is one of each control.
 */
function QueuedReport({ message, source, busy, onRemove, onSendNow, first }: QueuedFormProps & { source: Extract<MessageSource, { kind: "report" }> }) {
  const sections = useMemo(() => sourcedSections(message.content, source), [message.content, source])
  // Nothing to read: a report on sub-chats that were stopped before they
  // said anything. Delivered, it draws no line, as there is no reply to
  // point at. Waiting, it still needs its controls, and still says who it
  // is from. Without a reply, "replied" would be wrong.
  const silent = sections.length === 0
  const lines: ReportSection[] = silent
    ? (source.chatIds.length > 0 ? source.chatIds : [null]).map((chatId) => ({ chatId, body: "", status: null }))
    : sections

  return (
    <div className={cn(QUEUED_ROW_CLASS, "items-start", busy && "opacity-60")}>
      <UserMessageAttachments attachments={message.attachments} align="start" />
      <div className="relative group min-w-0 max-w-[85%] sm:max-w-[80%]">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-xl border border-dashed border-border py-1.5 pl-1.5 pr-3.5">
          <SendNowButton onSendNow={onSendNow} disabled={busy} first={first} />
          <div className="flex min-w-0 flex-col items-start gap-1">
            {lines.map((section, index) => isAdoptionNotice(section)
              ? <AdoptionNotice key={index} section={section} />
              : <ReportMarker key={index} section={section} outcome={silent ? "reported" : undefined} />)}
          </div>
        </div>
        <RemoveButton corner="end" onRemove={onRemove} disabled={busy} />
      </div>
    </div>
  )
}

/**
 * A queued message the user did not type, other than a report: an automation
 * or another chat's agent's message that arrived mid-turn. What it will be
 * once delivered (SourcedMessage) in the dashed outline of something still
 * waiting: on the same side, so it does not cross the column when its turn
 * starts, with the same quote over it on the same line, and the same clamped
 * text.
 *
 * A typed prompt's queued bubble, turned around: Send now leads the text
 * instead of trailing it, and Remove sits on the opposite corner. The quote
 * can reach over that corner, and the line between them keeps it 20px up,
 * well clear of Remove and of the 6px around it that also takes a press.
 */
function QueuedSourcedMessage({ message, source, busy, onRemove, onSendNow, first }: QueuedFormProps & { source: MessageSource }) {
  // All of it for the agent leaves nothing to read. It still waits its
  // turn, and still says who it is from.
  const body = useMemo(() => sourcedSections(message.content, source)[0]?.body ?? "", [message.content, source])

  return (
    <div className={cn(QUEUED_ROW_CLASS, "items-start", busy && "opacity-60")}>
      <UserMessageAttachments attachments={message.attachments} align="start" />
      <div className="flex min-w-0 max-w-[85%] flex-col items-start sm:max-w-[80%]">
        <ReplyQuoteRow>
          <SourceQuote source={source} chatId={null} />
        </ReplyQuoteRow>
        <div className="relative group min-w-0 max-w-full">
          <div {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(QUEUED_BUBBLE_CLASS, "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-end gap-2.5 py-1.5 pl-1.5 pr-3.5")}>
            <SendNowButton onSendNow={onSendNow} disabled={busy} first={first} />
            <div className="min-w-0">
              {body
                ? <ClampedMessageText text={body} lines={CLAMP_LINES.sent} />
                : <p className="text-muted-foreground">Queued</p>}
            </div>
          </div>
          <RemoveButton corner="end" onRemove={onRemove} disabled={busy} />
        </div>
      </div>
    </div>
  )
}

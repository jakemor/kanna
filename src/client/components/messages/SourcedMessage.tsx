import { useMemo, useRef, type ReactNode } from "react"
import { CalendarClock, MessageCircle, Split, X } from "lucide-react"
import type { ChatAttachment, MessageSource } from "../../../shared/types"
import { stripSystemMessages } from "../../../shared/message-preview"
import { ADOPTED_REPORT_STATUS, reportOutcome, splitReportSections, type ReportSection } from "../../../shared/report-sections"
import { cn } from "../../lib/utils"
import { useChatReferenceActions, useChatSchedules, useSidebarThread } from "../chat-ui/chat-reference"
import { formatScheduleTrigger } from "../chat-ui/widgets/SchedulesWidget"
import { CLAMP_LINES, ClampedMessageText, FOLD_SURFACE_ATTRIBUTE } from "./ClampedMessageText"
import { ChatReplyQuote } from "./ChatToolMessage"
import { ScheduleCardBox } from "./ScheduleToolMessage"
import { QUOTE_MARK_CENTER_PX, TOOL_QUOTE_CLASS } from "./tool-card"
import { USER_BUBBLE_CLASS, UserMessageAttachments } from "./UserMessage"

/**
 * A message that reached the chat as a prompt without the user typing it: a
 * sub-chat's report, a message another chat's agent sent, or a schedule
 * firing (`MessageSource`).
 *
 * It keeps the bubble of a prompt, because to the agent that is what it is.
 * It sits on the agent's side of the column, because the user did not write
 * it. Over the bubble it quotes where it came from, the way a messaging app
 * quotes what a reply is to: the row of the chat at the other end
 * (`ChatReplyQuote`), or the schedule's card, joined to the bubble by a short
 * line (`ReplyQuoteRow`). The bubble holds only the text, held to a few lines as
 * every prompt's is (ClampedMessageText).
 *
 * A sub-chat's report is the exception: no bubble and no quote, only a line
 * per sub-chat saying it replied (`ReportMarker`).
 */

/**
 * What a sourced message shows, one part per bubble, or for a report one
 * part per line. A report covering several sub-chats is several parts, each
 * tied to the chat that said it.
 */
export function sourcedSections(content: string, source: MessageSource): ReportSection[] {
  if (source.kind !== "report") {
    const body = stripSystemMessages(content)
    return body ? [{ chatId: null, body, status: null }] : []
  }
  const only = source.chatIds.length === 1 ? source.chatIds[0]! : null
  return splitReportSections(content, source.chatIds).map((section) => ({ ...section, chatId: section.chatId ?? only }))
}

/**
 * Where a message came from, as a quote over its bubble.
 *
 * The live thing where there is one: the other chat's row, the schedule's
 * card. Each falls back to a plain line that still says what kind of sender
 * it was, for a chat the sidebar has not heard of, a schedule deleted since,
 * and the exported viewer, which has neither.
 */
export function SourceQuote({ source, chatId }: {
  source: MessageSource
  /** For a report: the sub-chat this part is from. */
  chatId: string | null
}) {
  const schedules = useChatSchedules()

  if (source.kind === "schedule") {
    const schedule = schedules?.schedules.find((candidate) => candidate.id === source.scheduleId)
    if (schedule && schedules) {
      return (
        <ScheduleCardBox
          schedule={schedule}
          context={schedules}
          // No preview of the schedule's message, as its own card has: the
          // message is what the bubble is showing.
          caption={`Automation · ${formatScheduleTrigger(schedule.trigger)}`}
          quote
        />
      )
    }
    return (
      <div className={TOOL_QUOTE_CLASS}>
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">Automation</span>
        </div>
      </div>
    )
  }

  if (source.kind === "agent") return <ChatReplyQuote chatId={source.chatId} title="Another agent" />

  // A report draws its own line (`ReportMarker`), not a quote. This is for
  // completeness, should one ever be drawn as a quoted bubble.
  return <ChatReplyQuote chatId={chatId} title={chatId ? "Sub-chat" : "Sub-chats"} />
}

/** A chat's name in a sentence, opening the chat where there is one to open. */
function ChatName({ chatId, fallback }: { chatId: string | null | undefined; fallback: string }) {
  const actions = useChatReferenceActions()
  const thread = useSidebarThread(chatId)
  if (!thread || !actions || !chatId) return <span>{thread?.title ?? fallback}</span>
  return (
    <button
      type="button"
      onClick={() => actions.onOpenChat(chatId)}
      className="cursor-pointer rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {thread.title}
    </button>
  )
}

/**
 * The news that a sub-chat this chat was waiting on now reports to another:
 * the part of a report with `status: "adopted"`.
 *
 * A line, not a bubble. The sub-chat said nothing here, and its quote over
 * an empty bubble would claim it had. But the line has to be there: the
 * chat was waiting on a result, and without it the wait just ends, with
 * nothing on the page to say why. Both chats are named so either can be
 * opened, the adopter because that is where the result went.
 */
export function AdoptionNotice({ section }: { section: ReportSection }) {
  return (
    <p className="not-prose flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground">
      <Split aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <ChatName chatId={section.chatId} fallback="A sub-chat" />
        {" was adopted by "}
        <ChatName chatId={section.adoptedByChatId} fallback="another chat" />
        {". Its result will not arrive here."}
      </span>
    </p>
  )
}

export function isAdoptionNotice(section: ReportSection) {
  return section.status === ADOPTED_REPORT_STATUS && !section.body
}

/** A quote's own width: what it says, to a limit that keeps a long excerpt from widening the message. */
export const REPLY_QUOTE_WIDTH_CLASS = "min-w-0 max-w-96"

/** The line between a quote and its bubble, in px. */
export const REPLY_LINE = { widthPx: 3, heightPx: 14, clearPx: 3 } as const
/**
 * Where the line starts, from the quote's left edge: under the middle of the
 * quote's leading mark, whatever that mark is. Worked out from the quote's
 * own measurements and not written down a second time, so a change to the
 * quote's padding or its mark moves the line with it.
 */
export const REPLY_LINE_LEFT_PX = QUOTE_MARK_CENTER_PX - REPLY_LINE.widthPx / 2

/**
 * A quote over the bubble it belongs to, with a short line joining them:
 *
 *   [ ◌ quoted chat    ]
 *     |
 *   [ the message                   ]
 *
 * The quote starts at the bubble's left edge and is as wide as what it says,
 * up to 24rem. It is not tied to the bubble's width: over a short message it
 * runs on past the bubble's far edge.
 *
 * The line is a 3px stroke with round ends, 14px long, a shape of its own
 * between two 1px outlines. It stops its own width short of each, so the
 * quote stands 20px off the bubble: 3, the line, 3. A thick line butted
 * against a hairline reads as a collision, and with the gaps it reads as a
 * link.
 *
 * It hangs from the quote's mark: its centre is the mark's centre, 19px from
 * the shared left edge, which puts its own edge at 17.5. Half a pixel,
 * because the mark's slot is an even 16 wide and the line an odd 3, and one
 * of them being a pixel off the other is what this is here to prevent. That
 * is 1.5 clear of where the bubble's 16px corner straightens out, and the
 * line stops 3 above it in any case.
 *
 * It takes the border colour at full strength, which at this weight is a
 * soft grey: firmer than the quote's half-strength outline, and still
 * quieter than any text.
 */
export function ReplyQuoteRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full flex-col items-start">
      <div className={REPLY_QUOTE_WIDTH_CLASS}>{children}</div>
      <span aria-hidden className="my-[3px] h-[14px] w-[3px] rounded-full bg-border" style={{ marginLeft: REPLY_LINE_LEFT_PX }} />
    </div>
  )
}

/**
 * One sub-chat's part of a report, as its parent draws it: a line in the
 * look of a tool call's row, naming the chat and what happened ("Flicker fix
 * replied · still working"). A click opens the sub-chat as a chat card does.
 *
 * There is no bubble with the reply in it, and no Show More. The reply still
 * goes to this chat's agent whole, and the agent relays what matters in its
 * next message, so a bubble here would say the same thing twice. The line is
 * what is left of it: that the sub-chat answered, and where to read it.
 *
 * The title is the chat's live one, from the sidebar. A chat the sidebar
 * does not know is named for what it is, and is not a link.
 */
export function ReportMarker({ section, outcome, flash = false }: {
  section: ReportSection
  /** What to say happened, where the header cannot: see QueuedUserMessage. */
  outcome?: string
  flash?: boolean
}) {
  const actions = useChatReferenceActions()
  const thread = useSidebarThread(section.chatId)
  const chatId = section.chatId
  const failed = section.status === "failed"
  const label = `${thread?.title || "A sub-chat"} ${outcome ?? reportOutcome(section.status)}`
  const content = (
    <span className="grid min-w-0 grid-cols-[auto_1fr] items-center gap-1.5">
      {/* A tool row's mark slot, mark and words (ToolCallMessage). */}
      <span className="relative flex h-5 w-5 items-center justify-center">
        {failed
          ? <X aria-hidden className="size-4 text-destructive" />
          : <MessageCircle aria-hidden className="size-4 text-muted-icon" />}
      </span>
      <span className="h-5 min-w-0 truncate text-left font-medium text-foreground/80">{label}</span>
    </span>
  )
  const rowClass = cn("not-prose flex min-w-0 max-w-full rounded-md text-sm", flash && "kanna-jump-flash")

  if (!thread || !actions || !chatId) return <div className={rowClass}>{content}</div>
  const open = () => actions.onOpenChat(chatId)
  return (
    <button
      type="button"
      onClick={open}
      // The middle button, which `onOpenChat` reads as "in a tab".
      onAuxClick={(event) => { if (event.button === 1) open() }}
      className={cn(rowClass, "cursor-pointer outline-none transition-opacity hover:opacity-60 focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {content}
    </button>
  )
}

/** One part of a delivered message: its quote, the line, and its bubble. */
function SourcedPart({ section, source, flash }: {
  section: ReportSection
  source: MessageSource
  flash: boolean
}) {
  const partRef = useRef<HTMLDivElement | null>(null)
  return (
    // Each child keeps its own width: the bubble is as wide as its text and
    // the quote as wide as its own, whichever is the longer.
    <div ref={partRef} className="flex min-w-0 max-w-[85%] flex-col items-start sm:max-w-[80%]">
      <ReplyQuoteRow>
        <SourceQuote source={source} chatId={section.chatId} />
      </ReplyQuoteRow>
      <div {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(USER_BUBBLE_CLASS, "px-3.5 py-1.5 max-w-full", flash && "kanna-jump-flash")}>
        <ClampedMessageText text={section.body} lines={CLAMP_LINES.sent} scopeRef={partRef} />
      </div>
    </div>
  )
}

interface Props {
  content: string
  source: MessageSource
  attachments?: ChatAttachment[]
  /** Light the bubbles: a jump just landed on this message. See UserMessage. */
  flash?: boolean
}

export function SourcedMessage({ content, source, attachments = [], flash = false }: Props) {
  const sections = useMemo(() => sourcedSections(content, source), [content, source])

  if (source.kind === "report") {
    return (
      <div className="flex flex-col items-start gap-2">
        <UserMessageAttachments attachments={attachments} align="start" />
        {sections.map((section, index) => isAdoptionNotice(section) ? (
          // 2px in, so its 16px mark is centred where a line's 20px slot
          // centres its own, and its words start where the lines' do.
          <div key={index} className="max-w-[85%] pl-0.5 sm:max-w-[80%]">
            <AdoptionNotice section={section} />
          </div>
        ) : (
          <ReportMarker key={index} section={section} flash={flash} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <UserMessageAttachments attachments={attachments} align="start" />
      {sections.map((section, index) => (
        <SourcedPart
          key={index}
          section={section}
          source={source}
          flash={flash}
        />
      ))}
    </div>
  )
}

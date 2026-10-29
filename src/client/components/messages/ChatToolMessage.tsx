import { createContext, useContext, useMemo, useRef, type KeyboardEvent } from "react"
import { Loader2, MessageCircle } from "lucide-react"
import { toMessagePreview } from "../../../shared/message-preview"
import { isWorkingStatus } from "../../../shared/types"
import { CHAT_TOOL_NAMES } from "../../../shared/tools"
import { getThreadDetailLabel } from "../../lib/thread-detail-label"
import type { SidebarThread } from "../../lib/thread-sections"
import { cn, normalizeChatId } from "../../lib/utils"
import { useChatReferenceActions, useSidebarThread } from "../chat-ui/chat-reference"
import { chatOpenMenuItems } from "../chat-ui/ChatOpenMenuItems"
import { SidebarChatHoverCard } from "../chat-ui/sidebar/ChatHoverCard"
import { ThreadRowMenu } from "../chat-ui/sidebar/ThreadRow"
import { ThreadRowContent } from "../chat-ui/ThreadRowContent"
import { useNow } from "../chat-ui/widgets/TasksWidget"
import { resultRecord, text, TOOL_CARD_CAPTION_CLASS, TOOL_CARD_MARK_SLOT_CLASS, toolCardClasses, toolCardErrorText, useToolCardPayload } from "./tool-card"
import type { ProcessedToolCall } from "./types"

/**
 * The card for a chat an agent started or messaged (`create_chat`,
 * `fork_chat`, `send_message`), where the tool call sits in the transcript.
 *
 * It is that chat's row, lifted out of the sidebar: the same status glyph,
 * the same title shimmering while it runs, the same right-click menu and the
 * same hover card. The row says how the chat is doing; the line under it says
 * what this call did to it and with what words. A click opens the chat in
 * the previewer beside this one (`useOpenChat`).
 *
 * Its status is live, not a record of the call. A chat started an hour ago
 * that is still running still spins, and one that finished shows that it has.
 */

export type ChatToolCall = Extract<ProcessedToolCall, { toolKind: "chat" | "unknown_tool" }>

/**
 * Whether a tool call is one this card draws. By kind, and by name for a call
 * recorded before the kind existed: those are filed as unknown tools, with
 * their input and result left in the payload sidecar.
 */
export function isChatToolCall(message: ProcessedToolCall): message is ChatToolCall {
  return message.toolKind === "chat"
    || (message.toolKind === "unknown_tool" && CHAT_TOOL_NAMES.includes(message.toolName))
}

/** What the call did, in the words a person would use for doing it themselves. */
function describeCall(message: ChatToolCall, input: Record<string, unknown>, result: Record<string, unknown> | null): string {
  if (message.toolName === "fork_chat") return "Forked"
  if (message.toolName === "send_message") {
    if (input.delivery === "steer") return "Interrupted with"
    // Known only once the call returns: whether the message started a turn or
    // is waiting behind one.
    return result?.started === false ? "Queued" : "Sent"
  }
  return input.subchat === false ? "Started a chat" : "Started a sub-chat"
}

/** A new chat's id comes back in the result. A message names its chat going in. */
function chatToolTarget(message: ChatToolCall, input: Record<string, unknown>, result: Record<string, unknown> | null): string | null {
  return text(result?.chatId) ?? (message.toolName === "send_message" ? text(input.chatId) : null)
}

/**
 * The chat a call reached, read without a hook: from the input and result the
 * call carries inline. Null for a failed call, and for one recorded before
 * the kind existed, whose input and result are in the payload sidecar.
 */
export function inlineChatToolTarget(message: ChatToolCall): string | null {
  if (message.isError) return null
  return chatToolTarget(message, message.input.payload ?? {}, resultRecord(message.rawResult))
}

export function ChatToolMessage({ message }: { message: ChatToolCall }) {
  const { input, rawResult, result } = useToolCardPayload(message)
  const chatId = chatToolTarget(message, input, result)

  if (message.isError) {
    return <p role="alert" className="text-sm text-destructive">{toolCardErrorText(rawResult, "The chat could not be reached.")}</p>
  }

  const sent = text(input.message)
  return (
    <ChatCard
      chatId={chatId}
      title={text(result?.title) ?? text(input.title) ?? (sent ? toMessagePreview(sent) : "Chat")}
      caption={[describeCall(message, input, result), sent ? toMessagePreview(sent) : null].filter(Boolean).join(" · ")}
      pending={!message.resultEntryId}
    />
  )
}

/**
 * What a call said to the chat it reached, as one line. For the quote on that
 * chat's answer. Read without a hook, like `inlineChatToolTarget`.
 */
export function inlineChatToolExcerpt(message: ChatToolCall): string | null {
  const sent = text(message.input.payload?.message)
  return sent ? toMessagePreview(sent) : null
}

/**
 * A chat's row as the quote over a message: the link between two
 * chats, drawn one way from both ends.
 *
 * A parent sends a sub-chat its task, and the sub-chat's message quotes the
 * parent with this row. It is also the way back to the parent, which no list
 * of chats offers (ParentChatLink). The report that comes back is not quoted
 * in the parent: it is a line of its own (`ReportMarker`).
 *
 * The row has no label of its own. Where it sits, over a message and joined
 * to it, is what says the message is tied to that chat, and a line of words
 * saying so again under every title was most of what a transcript of reports
 * had to read. A second line appears only when there is something to add
 * (`replyCaption`). `said` is the same statement for a reader who cannot see
 * where the row sits.
 *
 * `excerpt` is what was said to the quoted chat, where this transcript holds
 * the call that said it.
 */
export function ChatReplyQuote({ chatId, title, excerpt, interim = false, said = "Message from" }: {
  chatId: string | null
  /** What to call the chat while the sidebar cannot say. */
  title: string
  excerpt?: string | null
  /** The message under the quote is what the chat had to say so far, with more to follow. */
  interim?: boolean
  /** What the quote is, read out ahead of the chat's title and not drawn. */
  said?: string
}) {
  const thread = useSidebarThread(chatId)
  const currentProjectId = useContext(ReplyQuoteProjectContext)
  return <ChatCard chatId={chatId} title={title} caption={replyCaption(thread, currentProjectId, excerpt, interim)} said={said} quote />
}

/**
 * What a quote says of a reply its chat sent while still working. About the
 * message, not the chat: the chat finishes, and this reply stays one it sent
 * on the way. So not "still working", which the quote's live status mark
 * already says for as long as it is true and would be wrong here afterwards.
 */
export const INTERIM_REPLY_NOTE = "Not final"

/**
 * The project of the chat being read, for a quote to tell when the chat it
 * quotes is in another one. Null where that is not known, and then no quote
 * names a project.
 */
export const ReplyQuoteProjectContext = createContext<string | null>(null)

/**
 * The line under a quoted chat's title, or null when the title is all there
 * is to say and the quote is one line. It holds the things that are not what
 * a reader would assume, then what the chat was told. The other chat is
 * usually in this project and usually still open, and a reply is usually its
 * last word. The excerpt comes last because it is the part that can run long
 * and be cut.
 */
export function replyCaption(
  thread: (Pick<SidebarThread, "archived" | "projectId"> & { projectLabel: Pick<SidebarThread["projectLabel"], "text"> }) | null,
  currentProjectId: string | null,
  excerpt?: string | null,
  interim = false,
): string | null {
  const parts: string[] = []
  if (thread && currentProjectId && thread.projectId !== currentProjectId) parts.push(thread.projectLabel.text)
  if (thread?.archived) parts.push("Archived")
  if (interim) parts.push(INTERIM_REPLY_NOTE)
  if (excerpt) parts.push(excerpt)
  return parts.length > 0 ? parts.join(" · ") : null
}

/**
 * The card itself, for a chat known only by its id. A tool call's card is one
 * use. The other, as a quote, is the chat at the far end of a message
 * (`ChatReplyQuote`).
 */
export function ChatCard({ chatId, title, caption, pending = false, quote = false, said }: {
  chatId: string | null
  /** What to call the chat while the sidebar cannot say. */
  title: string
  caption?: string | null
  /** The call that makes the chat has not returned. */
  pending?: boolean
  quote?: boolean
  /** Read out ahead of the title and not drawn: what the card is, where only its place on the page says so. */
  said?: string
}) {
  const actions = useChatReferenceActions()
  const thread = useSidebarThread(chatId)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const running = isWorkingStatus(thread?.row.status)
  const now = useNow(running)
  // One array for as long as the chat is unchanged: the hover card is memoized on it.
  const threads = useMemo(() => (thread ? [thread] : []), [thread])
  const classes = toolCardClasses(quote)
  const captionLine = caption ? <p className={TOOL_CARD_CAPTION_CLASS}>{caption}</p> : null
  // Out of the layout, so the row's gap does not count it.
  const saidFirst = said ? <span className="sr-only">{said} </span> : null

  // Before the call returns there is no chat to show yet, and after it one
  // the sidebar has not heard of (a snapshot behind, or deleted since). Both
  // draw the same card with what the call itself knows, and nothing to open.
  if (!thread || !actions || !chatId) {
    return (
      <div className={cn(classes.box, classes.width)}>
        <div className="flex min-w-0 items-center gap-2.5">
          {saidFirst}
          {pending
            ? <span className={TOOL_CARD_MARK_SLOT_CLASS}><Loader2 className="size-3.5 animate-spin text-logo" /></span>
            : <MessageCircle className="size-4 shrink-0 text-muted-foreground" />}
          <span className={cn("min-w-0 truncate", !pending && "text-muted-foreground")}>{title}</span>
        </div>
        {captionLine}
      </div>
    )
  }

  const open = () => actions.onOpenChat(chatId)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
    event.preventDefault()
    open()
  }

  return (
    <div ref={containerRef} className={classes.width}>
      <ThreadRowMenu
        thread={thread}
        archived={thread.archived}
        editorLabel={actions.editorLabel}
        {...actions.menu}
        leadingItems={chatOpenMenuItems(thread, actions)}
      >
        <div
          role="button"
          tabIndex={0}
          // What the hover card finds the card under the pointer by.
          data-chat-id={normalizeChatId(chatId)}
          onClick={open}
          // The middle button, which `onOpenChat` reads as "in a tab".
          onAuxClick={(event) => { if (event.button === 1) open() }}
          onKeyDown={onKeyDown}
          className={cn(
            classes.box,
            // The border lights at once, as a row's highlight does, and stays
            // lit while the hover card it opened is up. The press is the only
            // thing that moves: a 1.5% give, in and out on the app's curve.
            classes.lit,
            "cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "transition-[scale] duration-150 ease-snappy active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            {saidFirst}
            <ThreadRowContent
              thread={thread}
              showStatus
              // A card is one chat someone pointed at, not a list to scan, so
              // its title never recedes.
              dimIdleTitles={false}
              detailLabel={getThreadDetailLabel(thread, "project-scoped", now)}
            />
          </div>
          {captionLine}
        </div>
      </ThreadRowMenu>
      <SidebarChatHoverCard
        containerRef={containerRef}
        threads={threads}
        side="bottom"
        // Just clear of the card, as under a tab.
        sideOffset={6}
        {...actions.card}
      />
    </div>
  )
}

import type { HydratedTranscriptMessage } from "../../../shared/types"
import { useSidebarReady } from "../../stores/sidebarStore"
import { useSidebarThread } from "../chat-ui/chat-reference"
import { ChatCard, ChatReplyQuote } from "./ChatToolMessage"
import { REPLY_QUOTE_WIDTH_CLASS } from "./SourcedMessage"

/**
 * The way back from a sub-chat to the chat it reports to, for when no message
 * on screen provides one.
 *
 * A sub-chat is usually in no list of chats (`SidebarChatRow.hidden`), so the way back to its
 * parent has to be in its own transcript. It is: the message that started the
 * sub-chat came from the parent's agent, and over its bubble is the parent's
 * row (`ChatReplyQuote`).
 *
 * That message is not always there to carry it. A chat opens on its last
 * stretch, and in a long one the opening message is pages above, not loaded.
 * And a chat taken on by another parent after it began opens with a message
 * from someone else. In both cases this draws the same quote on its own, as
 * the first item of whatever is loaded, so getting back never takes loading
 * the whole chat. It is the quote as it looks over a message, with no line
 * under it: there is no bubble to join. When the opening message is on screen
 * and names the parent, this draws nothing: one quote, not two.
 */

/**
 * The loaded message whose quote already names the parent: the chat's opening
 * message, when the parent's agent sent it and nothing older is still to
 * load. Null when there is none, which is when the link has to stand alone.
 *
 * The parent is the chat's parent now, not the sender of its first message.
 * The two start out the same and part when the chat is handed to another.
 */
export function messageNamingParent(
  messages: readonly HydratedTranscriptMessage[],
  parentChatId: string | null,
  hasOlderMessages: boolean,
): string | null {
  // With older messages still to load, the first prompt held is not the opening.
  if (!parentChatId || hasOlderMessages) return null
  const opening = messages.find((message) => message.kind === "user_prompt" && !message.hidden)
  if (opening?.kind !== "user_prompt") return null
  return opening.source?.kind === "agent" && opening.source.chatId === parentChatId ? opening.id : null
}

export function ParentChatLink({ parentChatId }: { parentChatId: string }) {
  const ready = useSidebarReady()
  const parent = useSidebarThread(parentChatId)
  // A parent the sidebar has not listed yet is not a deleted one. Wait to be
  // told before saying so.
  if (!ready) return null
  return (
    <div className={REPLY_QUOTE_WIDTH_CLASS}>
      {parent
        ? <ChatReplyQuote chatId={parentChatId} title="Parent chat" said="Parent chat:" />
        // An archived parent is still a row and still opens. One the sidebar
        // no longer has was deleted, and a row with nothing behind it would
        // promise a way back that is not there. So this one says what it is.
        : <ChatCard chatId={null} title="Parent chat" caption="No longer available" quote />}
    </div>
  )
}

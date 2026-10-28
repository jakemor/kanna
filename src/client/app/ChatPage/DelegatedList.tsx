import { CheckCheck } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useOutletContext } from "react-router-dom"
import { useChatReferenceActions, useSidebarThread } from "../../components/chat-ui/chat-reference"
import { SidebarChatHoverCard } from "../../components/chat-ui/sidebar/ChatHoverCard"
import { ThreadSections } from "../../components/chat-ui/sidebar/ThreadSections"
import { VIEWER_END_PAD_CLASS, ViewerIconButton, ViewerSurface } from "../../components/viewer/ViewerSurface"
import { delegatedListTitle, delegatedThreads, isUnnamedDelegator } from "../../lib/delegators"
import { cn } from "../../lib/utils"
import { useSidebarStore } from "../../stores/sidebarStore"
import { useViewerStore, type ViewerItem } from "../../stores/viewerStore"
import type { KannaState } from "../useKannaState"
import { useOpenChat } from "../useOpenChat"
import { useStableSidebarThreads } from "../useStableSidebarThreads"

type DelegatedItem = Extract<ViewerItem, { kind: "delegated" }>

/** How often the rows' ages are brought up to date. They read to the minute. */
const AGE_TICK_MS = 60_000

/**
 * The chats under a delegator, as a list to pick from. The navbar's button
 * opens it, in the viewer's pane or, on a phone, over the transcript, and it
 * is in the pane the first time a delegator's page is opened. It closes like
 * anything else there. While the pane is open it is what everything opened
 * on a delegator's page sits over (see `lib/viewer-levels`).
 *
 * It is the left sidebar's list, for one delegator: the same rows, the same
 * sections in the same order (Pinned, In Progress, Relevant, the dates,
 * Archived), the same hover card and right-click menu, by being the same
 * components (`ThreadSections`). So a chat reads here as it reads there, and
 * a change to either is a change to both. What differs is what a click does:
 * the chat opens in this pane, over the list, and Back returns here.
 *
 * Which chats it holds is `delegatedThreads`: the ones directly under the
 * delegator.
 */
export const DelegatedList = memo(function DelegatedList({ item, onClose }: {
  item: DelegatedItem
  onClose: () => void
}) {
  const delegator = useSidebarThread(item.chatId)
  const actions = useChatReferenceActions()
  const openChat = useOpenChat()
  const containerRef = useRef<HTMLDivElement | null>(null)

  const data = useSidebarStore((store) => store.data)
  const allThreads = useStableSidebarThreads(data)
  const threads = useMemo(() => delegatedThreads(allThreads, item.chatId), [allThreads, item.chatId])

  // Mark all as read: the same command opening a chat sends, once for each
  // row with the green dot. Only there while one has it.
  const { socket } = useOutletContext<KannaState>()
  const unreadChatIds = useMemo(() => threads.filter((thread) => thread.row.unread).map((thread) => thread.row.chatId), [threads])
  const markAllRead = useCallback(() => {
    for (const chatId of unreadChatIds) void socket.command({ type: "chat.markRead", chatId }).catch(noop)
  }, [socket, unreadChatIds])

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), AGE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  // A list for a chat that is not a delegator (it was made an ordinary chat
  // again, or deleted) has nothing to be a list of. The floor is taken away
  // by the page; this is for the phone's overlay and for a stored one.
  const sidebarReady = useSidebarStore((store) => store.ready)
  const stillDelegator = Boolean(delegator?.row.delegator)
  useEffect(() => {
    if (sidebarReady && !stillDelegator && useViewerStore.getState().floor === null) useViewerStore.getState().closeAll()
  }, [sidebarReady, stillDelegator])

  // Every way a row opens its chat is a click inside the pane: the chat
  // takes the list's place and remembers the list as what it came from.
  const card = useMemo(() => (actions ? {
    ...actions.card,
    onSelectChat: (chatId: string) => openChat(chatId, { from: "preview" }),
    onSelectMessage: (chatId: string, role: "prompt" | "reply") => openChat(chatId, { from: "preview", jump: role }),
    onOpenArchivedChat: (chatId: string) => openChat(chatId, { from: "preview" }),
  } : null), [actions, openChat])

  // The header is the delegator's name and nothing else. The pane was
  // opened by the compass in the navbar and sits beside that chat's title,
  // so a compass and the word "Delegated" here said it a third time. What
  // the pane is stays in its accessible name, which has no navbar to lean on.
  const title = delegatedListTitle(delegator?.title)
  const named = delegator !== null && delegator !== undefined && !isUnnamedDelegator(delegator.title)
  return (
    <ViewerSurface
      label={named ? `Delegated chats, ${title}` : "Delegated chats"}
      title={title}
      onClose={onClose}
      windowActions={unreadChatIds.length > 0 ? (
        <ViewerIconButton label="Mark all as read" onClick={markAllRead}><CheckCheck /></ViewerIconButton>
      ) : null}
      // Back from a chat is a new card: it opens where the list was left.
      scrollMemoryKey={`delegated:${item.chatId}`}
      // There when a delegator's page opens, without having been asked for.
      quietFocus
    >
      {/* The sidebar's own gutter, so the rows sit in the card as they sit in
          the sidebar. The card's end padding keeps the last one off the
          window's edge where the card runs off it. */}
      <div ref={containerRef} className={cn("px-[7px] pb-2", VIEWER_END_PAD_CLASS)}>
        {threads.length === 0 || !actions || !card ? (
          <p className="px-[10px] py-6 text-sm text-muted-foreground">
            No chats yet. The ones this delegator starts or messages are listed here.
          </p>
        ) : (
          <>
            <ThreadSections
              threads={threads}
              activeChatId={null}
              editorLabel={actions.editorLabel}
              nowMs={nowMs}
              // Kept apart per delegator, and from the sidebar's own.
              expandScope={`delegated:${item.chatId}`}
              detailScope="project-scoped"
              onSelectChat={card.onSelectChat}
              onOpenArchivedChat={card.onOpenArchivedChat}
              onRestoreChat={actions.menu.onRestoreChat}
              onCreateChat={actions.menu.onCreateChat}
              onRenameChat={actions.menu.onRenameChat}
              onShareChat={actions.menu.onShareChat}
              onForkChat={actions.menu.onForkChat}
              onToggleChatPin={actions.menu.onToggleChatPin ?? noop}
              onArchiveChat={actions.menu.onArchiveChat}
              onDeleteChat={actions.menu.onDeleteChat}
              onCopyPath={actions.menu.onCopyPath}
              onOpenExternalPath={actions.menu.onOpenExternalPath}
            />
            <SidebarChatHoverCard containerRef={containerRef} threads={threads} side="left" {...card} />
          </>
        )}
      </div>
    </ViewerSurface>
  )
})

function noop() {}

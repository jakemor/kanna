import { memo, type HTMLAttributes, type ReactNode, type Ref } from "react"
import { Archive, RotateCcw, Split } from "lucide-react"
import { getThreadDetailLabel, type ThreadDetailScope } from "../../../lib/thread-detail-label"
import type { SidebarThread } from "../../../lib/thread-sections"
import { cn, normalizeChatId } from "../../../lib/utils"
import { Button } from "../../ui/button"
import { useChatHasDraft, useChatInputStore } from "../../../stores/chatInputStore"
import { ThreadRowContent } from "../ThreadRowContent"
import { ChatRowMenu } from "./Menus"

interface ThreadRowProps {
  thread: SidebarThread
  isActive: boolean
  /** Archived rows swap Fork/Archive for Restore and get the archived menu. */
  archived?: boolean
  editorLabel: string
  /**
   * Which question the trailing slot answers — see `getThreadDetailLabel`. The
   * row resolves it itself rather than taking a finished node, so its props stay
   * comparable and `memo` can skip a row whose chat did not move. A node prop
   * would be a new element on every render and would defeat that outright.
   */
  detailScope: ThreadDetailScope
  /** Anchor for the age label; the sidebar advances it on a slow interval. */
  nowMs: number
  /** Transient chrome that replaces the slot — the number-jump keycap. */
  detailLabelOverride?: ReactNode
  /**
   * Fade idle/read titles (see `ThreadRowContent`). The Projects tab keeps it —
   * a project's chat list is a long backlog where read rows should recede. The
   * Chats tab turns it off: its rows are already filtered into
   * In Progress / Review / recent-day sections, so the *section* carries the
   * emphasis and dimming inside one would just fight it.
   */
  dimIdleTitles?: boolean
  /** See `ThreadRowContent`. */
  showProjectIcon?: boolean
  onSelect: (chatId: string) => void
  onCreateChat: (projectId: string) => void
  onMarkChatUnread?: (chat: SidebarThread["row"]) => void
  onRenameChat: (chat: SidebarThread["row"]) => void
  onShareChat: (chatId: string) => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onForkChat: (chat: SidebarThread["row"]) => void
  onToggleChatPin?: (chat: SidebarThread["row"]) => void
  onArchiveChat: (chat: SidebarThread["row"]) => void
  onRestoreChat: (chatId: string) => void
  onDeleteChat: (chat: SidebarThread["row"]) => void
}

type ThreadRowBodyProps = Pick<
  ThreadRowProps,
  | "thread" | "isActive" | "archived" | "detailScope" | "nowMs" | "detailLabelOverride"
  | "dimIdleTitles" | "showProjectIcon" | "onSelect" | "onForkChat" | "onArchiveChat" | "onRestoreChat"
> & Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & { ref?: Ref<HTMLDivElement> }

/**
 * The row itself, without the right-click menu around it: click target, status
 * glyph / harness icon, title, and hover-revealed Fork/Archive.
 *
 * Apart from `ThreadRow` for a surface that draws the row as part of
 * something larger and puts the menu on the whole of it (a node in the graph
 * view, where the row heads a card). Two menus, one inside the other, would
 * both open on a right-click.
 *
 * Whatever else it is given goes on its element, which is how the menu's
 * trigger reaches it when `ThreadRow` wraps it.
 */
export function ThreadRowBody({
  thread,
  isActive,
  archived = false,
  detailScope,
  nowMs,
  detailLabelOverride,
  dimIdleTitles = true,
  showProjectIcon = false,
  onSelect,
  onForkChat,
  onArchiveChat,
  onRestoreChat,
  className,
  ...elementProps
}: ThreadRowBodyProps) {
  // Whether there *is* a draft, not what it says. The row shows a pencil and the
  // menu offers "Clear Draft"; neither needs the text, and subscribing to it
  // re-rendered this row on every keystroke in the composer. The card reads the
  // text itself, from inside its own open subtree.
  const hasDraft = useChatHasDraft(thread.row.chatId)
  const detailLabel = detailLabelOverride ?? getThreadDetailLabel(thread, detailScope, nowMs)
  const hoverActions = archived ? (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
      onClick={(event) => {
        event.stopPropagation()
        onRestoreChat(thread.row.chatId)
      }}
      title="Restore chat"
    >
      <RotateCcw className="size-3.5" />
    </Button>
  ) : (
    <>
      {thread.row.canFork ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
          onClick={(event) => {
            event.stopPropagation()
            onForkChat(thread.row)
          }}
          title="Fork chat"
        >
          <Split className="size-3.5" />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
        onClick={(event) => {
          event.stopPropagation()
          onArchiveChat(thread.row)
        }}
        title="Archive chat"
      >
        <Archive className="size-3.5" />
      </Button>
    </>
  )

  return (
    <div
      {...elementProps}
      // Two readers: the sidebar's scroll-to-active querySelector, and the
      // one hover card, which resolves the row under the pointer from it.
      // When the Chats tab renders above the project groups, its copy is
      // found first and the sidebar scrolls up to it.
      data-chat-id={normalizeChatId(thread.chatId)}
      className={cn(
        // Not `transition-all`: that animated the four border colors and the
        // background on every hover, five main-thread animations per row
        // that Chromium cannot composite, and a style recalc plus layerize
        // on every frame while the pointer moved over the list.
        "group flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg border px-2 py-1.5 max-md:py-1.5 text-left text-sm max-md:text-base active:scale-[0.985] transition-transform",
        isActive
          ? "bg-muted hover:bg-muted border-border"
          // The hover, and the same while the row's hover card is up: the
          // pointer leaves the row to reach the card (see
          // `HOVER_CARD_OPEN_ATTRIBUTE`).
          : "border-border/0 hover:border-border hover:bg-muted/20 dark:hover:border-slate-400/10 data-[hover-card-open]:border-border data-[hover-card-open]:bg-muted/20 dark:data-[hover-card-open]:border-slate-400/10",
        className,
      )}
      onClick={() => onSelect(thread.chatId)}
    >
      <ThreadRowContent
        thread={thread}
        showStatus
        isActive={isActive}
        dimIdleTitles={dimIdleTitles}
        hasDraft={hasDraft}
        showProjectIcon={showProjectIcon}
        detailLabel={detailLabel}
        hoverActions={hoverActions}
      />
    </div>
  )
}

/**
 * The canonical sidebar chat row: right-click menu, click target, status glyph /
 * harness icon, title, and hover-revealed Fork/Archive. Used by both sidebar
 * tabs; each passes the `detailScope` its list calls for — the Chats tab spans
 * projects, the Projects tab is already inside one.
 *
 * A div rather than a button so the hover-action Buttons can nest inside it.
 *
 * The row carries no hover card of its own: the sidebar keeps one card for the
 * whole list and finds the row under the pointer by `data-chat-id`. See
 * `SidebarChatHoverCard`.
 *
 * Memoized, and worth keeping that way. There is one of these per chat, each
 * carrying a context menu, and the sidebar snapshot is pushed throughout every
 * turn. Without the memo a single chat streaming a reply re-rendered every row
 * in the app.
 */
function ThreadRowImpl({
  thread,
  isActive,
  archived = false,
  editorLabel,
  detailScope,
  nowMs,
  detailLabelOverride,
  dimIdleTitles = true,
  showProjectIcon = false,
  onSelect,
  onCreateChat,
  onMarkChatUnread,
  onRenameChat,
  onShareChat,
  onCopyPath,
  onOpenExternalPath,
  onForkChat,
  onToggleChatPin,
  onArchiveChat,
  onRestoreChat,
  onDeleteChat,
}: ThreadRowProps) {
  return (
    <ThreadRowMenu
      thread={thread}
      archived={archived}
      editorLabel={editorLabel}
      onCreateChat={onCreateChat}
      onMarkChatUnread={onMarkChatUnread}
      onRenameChat={onRenameChat}
      onShareChat={onShareChat}
      onCopyPath={onCopyPath}
      onOpenExternalPath={onOpenExternalPath}
      onForkChat={onForkChat}
      onToggleChatPin={onToggleChatPin}
      onArchiveChat={onArchiveChat}
      onRestoreChat={onRestoreChat}
      onDeleteChat={onDeleteChat}
    >
      <ThreadRowBody
        thread={thread}
        isActive={isActive}
        archived={archived}
        detailScope={detailScope}
        nowMs={nowMs}
        detailLabelOverride={detailLabelOverride}
        dimIdleTitles={dimIdleTitles}
        showProjectIcon={showProjectIcon}
        onSelect={onSelect}
        onForkChat={onForkChat}
        onArchiveChat={onArchiveChat}
        onRestoreChat={onRestoreChat}
      />
    </ThreadRowMenu>
  )
}

/** What a chat's right-click menu does, as the sidebar hands it to a row. */
export type ThreadRowMenuActions = Pick<
  ThreadRowProps,
  | "onCreateChat" | "onMarkChatUnread" | "onRenameChat" | "onShareChat" | "onCopyPath" | "onOpenExternalPath"
  | "onForkChat" | "onToggleChatPin" | "onArchiveChat" | "onRestoreChat" | "onDeleteChat"
>

/**
 * A chat's right-click menu, around whatever stands for the chat.
 *
 * Apart from `ThreadRow` so that anywhere else a chat is listed (the chats in
 * a channel's menu) gets this menu and not a copy of it: the same items, in
 * the same order, doing the same things.
 */
export function ThreadRowMenu({
  thread,
  archived = false,
  editorLabel,
  onCreateChat,
  onMarkChatUnread,
  onRenameChat,
  onShareChat,
  onCopyPath,
  onOpenExternalPath,
  onForkChat,
  onToggleChatPin,
  onArchiveChat,
  onRestoreChat,
  onDeleteChat,
  leadingItems,
  children,
}: Pick<ThreadRowProps, "thread" | "archived" | "editorLabel"> & ThreadRowMenuActions & {
  /** See `ChatRowMenu`. */
  leadingItems?: ReactNode
  children: ReactNode
}) {
  const hasDraft = useChatHasDraft(thread.row.chatId)
  const clearDraft = useChatInputStore((state) => state.clearDraft)

  return (
    <ChatRowMenu
      leadingItems={leadingItems}
      canFork={thread.row.canFork}
      archived={archived}
      pinned={Boolean(thread.row.pinnedAt)}
      onTogglePin={!archived && onToggleChatPin ? () => onToggleChatPin(thread.row) : undefined}
      editorLabel={editorLabel}
      repoUrl={thread.projectLabel.repoUrl}
      onNewChat={() => onCreateChat(thread.projectId)}
      onRestore={archived ? () => onRestoreChat(thread.row.chatId) : undefined}
      onMarkUnread={!archived && onMarkChatUnread ? () => onMarkChatUnread(thread.row) : undefined}
      onRename={() => onRenameChat(thread.row)}
      onShare={() => onShareChat(thread.row.chatId)}
      onCopyPath={() => onCopyPath(thread.row.localPath)}
      onOpenInFinder={() => onOpenExternalPath("open_finder", thread.row.localPath)}
      onOpenInEditor={() => onOpenExternalPath("open_editor", thread.row.localPath)}
      onFork={() => onForkChat(thread.row)}
      onClearDraft={hasDraft ? () => clearDraft(thread.row.chatId) : undefined}
      onArchive={archived ? () => {} : () => onArchiveChat(thread.row)}
      onDelete={() => onDeleteChat(thread.row)}
    >
      {children}
    </ChatRowMenu>
  )
}

export const ThreadRow = memo(ThreadRowImpl)

import { memo, useMemo, useState } from "react"
import { Archive, ChevronRight, MoreHorizontal, RotateCcw, Split } from "lucide-react"
import type { SidebarChatRow, SidebarData } from "../../../../shared/types"
import {
  computeSidebarThreadSections,
  flattenSidebarThreads,
  type SidebarThread,
} from "../../../lib/thread-sections"
import { cn, normalizeChatId } from "../../../lib/utils"
import { Button } from "../../ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"
import { openContextMenuFromButton } from "../../open-external-menu"
import { ThreadRowContent } from "../ThreadRowContent"
import { ChatRowMenu } from "./Menus"

/**
 * Section header matching the Projects tab's collapsible project headers
 * (same sizing, sticky behavior, chevron, title styling, and hover "…"
 * button). With `onToggle` it's a collapse toggle; without, a static pinned
 * header (In Progress / Review) whose empty chevron slot keeps its title
 * aligned with the buckets'. `onArchiveAll` adds the "…" button and a
 * matching right-click menu with Archive All.
 */
function SectionHeader({
  label,
  onToggle,
  isExpanded,
  onArchiveAll,
}: {
  label: string
  onToggle?: () => void
  isExpanded?: boolean
  onArchiveAll?: () => void
}) {
  const collapsible = onToggle != null
  const header = (
    <div
      className={cn(
        "group/section sticky top-0 z-10 relative flex items-center bg-background p-[10px] dark:bg-card",
        collapsible && "cursor-pointer select-none"
      )}
      onClick={onToggle}
    >
      <div className="flex items-center gap-2.5">
        {collapsible ? (
          <span className="relative size-3.5 shrink-0">
              <ChevronRight
                className={cn(
                  "translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200",
                  isExpanded && "rotate-90"
                )}
              />
          </span>
        ) : null}
        <span className="max-w-[150px] truncate whitespace-nowrap text-sm max-md:text-base text-muted-foreground">{label}</span>
      </div>
      {onArchiveAll ? (
        <div className="absolute right-2 flex items-center gap-[1px] opacity-100 md:opacity-0 md:group-hover/section:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-5.5 w-5.5 !rounded"
            onClick={openContextMenuFromButton}
          >
            <MoreHorizontal className="size-3.5 text-slate-500 dark:text-slate-400" />
          </Button>
        </div>
      ) : null}
    </div>
  )

  if (!onArchiveAll) return header
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onArchiveAll()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Archive All</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface Props {
  data: SidebarData
  activeChatId: string | null
  editorLabel: string
  /** Anchor for the date buckets; bucketing runs in the browser so it always follows the user's local timezone. */
  nowMs: number
  onSelectChat: (chatId: string) => void
  onOpenArchivedChat: (chatId: string) => void
  onRestoreChat: (chatId: string) => void
  onCreateChat: (projectId: string) => void
  onRenameChat: (chat: SidebarChatRow) => void
  onShareChat: (chatId: string) => void
  onForkChat: (chat: SidebarChatRow) => void
  onArchiveChat: (chat: SidebarChatRow) => void
  onDeleteChat: (chat: SidebarChatRow) => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
}

/**
 * The New Sidebar's Chats tab: In Progress and Review lead (same membership as
 * the palette's sections), followed by collapsible date buckets — This Week,
 * Last Week, Last 30 Days — and a trailing Archived section. Only This Week
 * starts expanded; empty sections never render. Rows reuse the palette's
 * compact thread row (no prompt preview) and the standard chat context menu;
 * bucket headers offer Archive All via "…" or right-click.
 */
function ThreadSectionsImpl({
  data,
  activeChatId,
  editorLabel,
  nowMs,
  onSelectChat,
  onOpenArchivedChat,
  onRestoreChat,
  onCreateChat,
  onRenameChat,
  onShareChat,
  onForkChat,
  onArchiveChat,
  onDeleteChat,
  onCopyPath,
  onOpenExternalPath,
}: Props) {
  const sections = useMemo(
    () => computeSidebarThreadSections(flattenSidebarThreads(data), nowMs),
    [data, nowMs]
  )
  const normalizedActiveChatId = activeChatId ? normalizeChatId(activeChatId) : null
  // User toggles override each bucket's default (Today/Yesterday open, rest
  // closed). Keyed by stable bucket key so state survives day rollovers sanely.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({})

  const toggleBucket = (key: string, defaultExpanded: boolean) => {
    setExpandOverrides((previous) => ({
      ...previous,
      [key]: !(previous[key] ?? defaultExpanded),
    }))
  }

  const pinnedGroups = [
    { key: "in-progress", heading: "In Progress", threads: sections.inProgress },
    { key: "review", heading: "Review", threads: sections.review },
  ].filter((group) => group.threads.length > 0)

  if (pinnedGroups.length === 0 && sections.buckets.length === 0 && sections.archived.length === 0) return null

  const renderRow = (thread: SidebarThread) => (
    <ChatRowMenu
      key={thread.chatId}
      canFork={thread.row.canFork}
      editorLabel={editorLabel}
      onNewChat={() => onCreateChat(thread.projectId)}
      onRename={() => onRenameChat(thread.row)}
      onShare={() => onShareChat(thread.row.chatId)}
      onCopyPath={() => onCopyPath(thread.row.localPath)}
      onOpenInFinder={() => onOpenExternalPath("open_finder", thread.row.localPath)}
      onOpenInEditor={() => onOpenExternalPath("open_editor", thread.row.localPath)}
      onFork={() => onForkChat(thread.row)}
      onArchive={() => onArchiveChat(thread.row)}
      onDelete={() => onDeleteChat(thread.row)}
    >
      <div
        // Same marker ChatRow uses. Because this section renders above the
        // project groups, the sidebar's scroll-to-active querySelector finds
        // this top copy first and scrolls up to it. A div (not a button) so
        // the hover action Buttons can nest inside.
        data-chat-id={normalizeChatId(thread.chatId)}
        className={cn(
          "group flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg border px-2 py-1.5 max-md:py-1.5 text-left text-sm max-md:text-base active:scale-[0.985] transition-all",
          normalizeChatId(thread.chatId) === normalizedActiveChatId
            ? "bg-muted hover:bg-muted border-border"
            : "border-border/0 hover:border-border hover:bg-muted/20 dark:hover:border-slate-400/10",
        )}
        onClick={() => onSelectChat(thread.chatId)}
      >
        <ThreadRowContent
          thread={thread}
          showStatus
          hoverActions={(
            <>
              {thread.row.canFork ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
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
                className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
                onClick={(event) => {
                  event.stopPropagation()
                  onArchiveChat(thread.row)
                }}
                title="Archive chat"
              >
                <Archive className="size-3.5" />
              </Button>
            </>
          )}
        />
      </div>
    </ChatRowMenu>
  )

  return (
    <div>
      {pinnedGroups.map((group) => (
        <div key={group.key}>
          <SectionHeader label={group.heading} />
          <div className="space-y-[2px] mb-3">
            {group.threads.map(renderRow)}
          </div>
        </div>
      ))}
      {sections.buckets.map((bucket) => {
        const isExpanded = expandOverrides[bucket.key] ?? bucket.defaultExpanded
        return (
          <div key={bucket.key}>
            <SectionHeader
              label={bucket.label}
              isExpanded={isExpanded}
              onToggle={() => toggleBucket(bucket.key, bucket.defaultExpanded)}
              onArchiveAll={() => {
                for (const thread of bucket.threads) onArchiveChat(thread.row)
              }}
            />
            {isExpanded ? (
              <div className="space-y-[2px] mb-3">
                {bucket.threads.map(renderRow)}
              </div>
            ) : null}
          </div>
        )
      })}
      {sections.archived.length > 0 ? (() => {
        const isExpanded = expandOverrides["archived"] ?? false
        return (
          <div>
            <SectionHeader
              label="Archived"
              isExpanded={isExpanded}
              onToggle={() => toggleBucket("archived", false)}
            />
            {isExpanded ? (
              <div className="space-y-[2px] mb-3">
                {sections.archived.map((thread) => (
                  <ChatRowMenu
                    key={thread.chatId}
                    archived
                    canFork={thread.row.canFork}
                    editorLabel={editorLabel}
                    onNewChat={() => onCreateChat(thread.projectId)}
                    onRestore={() => onRestoreChat(thread.row.chatId)}
                    onRename={() => onRenameChat(thread.row)}
                    onShare={() => onShareChat(thread.row.chatId)}
                    onCopyPath={() => onCopyPath(thread.row.localPath)}
                    onOpenInFinder={() => onOpenExternalPath("open_finder", thread.row.localPath)}
                    onOpenInEditor={() => onOpenExternalPath("open_editor", thread.row.localPath)}
                    onFork={() => onForkChat(thread.row)}
                    onArchive={() => {}}
                    onDelete={() => onDeleteChat(thread.row)}
                  >
                    <div
                      data-chat-id={normalizeChatId(thread.chatId)}
                      className={cn(
                        "group flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg border px-2 py-1.5 max-md:py-1.5 text-left text-sm max-md:text-base active:scale-[0.985] transition-all",
                        normalizeChatId(thread.chatId) === normalizedActiveChatId
                          ? "bg-muted hover:bg-muted border-border"
                          : "border-border/0 hover:border-border hover:bg-muted/20 dark:hover:border-slate-400/10",
                      )}
                      onClick={() => onOpenArchivedChat(thread.chatId)}
                    >
                      <ThreadRowContent
                        thread={thread}
                        showStatus
                        hoverActions={(
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
                            onClick={(event) => {
                              event.stopPropagation()
                              onRestoreChat(thread.row.chatId)
                            }}
                            title="Restore chat"
                          >
                            <RotateCcw className="size-3.5" />
                          </Button>
                        )}
                      />
                    </div>
                  </ChatRowMenu>
                ))}
              </div>
            ) : null}
          </div>
        )
      })() : null}
    </div>
  )
}

export const ThreadSections = memo(ThreadSectionsImpl)

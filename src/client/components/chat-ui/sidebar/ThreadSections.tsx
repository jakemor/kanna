import { memo, useMemo, useState } from "react"
import { Archive, ChevronRight, MoreHorizontal } from "lucide-react"
import type { SidebarChatRow } from "../../../../shared/types"
import {
  computeSidebarThreadSections,
  mergeRelevantThreads,
  type SidebarThread,
} from "../../../lib/thread-sections"
import { useDraftStartTimes } from "../../../stores/chatInputStore"
import { usePendingSendTimes } from "../../../stores/pendingSendStore"
import { cn, normalizeChatId } from "../../../lib/utils"
import { Button } from "../../ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"
import { openContextMenuFromButton } from "../../open-external-menu"
import { ThreadRow } from "./ThreadRow"

/**
 * Section header matching the Projects tab's collapsible project headers
 * (same sizing, sticky behavior, chevron, title styling, and hover "…"
 * button). With `onToggle` it's a collapse toggle; without, a static pinned
 * header (In Progress / Review) whose empty chevron slot keeps its title
 * aligned with the buckets'. `onArchiveAll` adds the "…" button and a
 * matching right-click menu with Archive All.
 */
export function SectionHeader({
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
      {/* Chevron trails the label rather than leading it, so every title starts
          at the same left edge — including the non-collapsible In Progress
          header, which has no chevron to occupy a leading slot. */}
      <div className="flex items-center gap-1">
        {/* Faint by design: in this tab the chat rows carry full contrast, so
            the section labels stay quiet chrome you scan past. (The Projects
            tab is the other way round — full-contrast project headers over
            dimmable rows.) */}
        <span className="max-w-[150px] truncate whitespace-nowrap text-sm text-slate-500 max-md:text-base dark:text-slate-400">{label}</span>
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
  /** Already flattened and identity-stabilized — see `useStableSidebarThreads`. */
  threads: SidebarThread[]
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
 * The New Sidebar's Chats tab: In Progress leads, then Relevant (Review folded
 * in — see `mergeRelevantThreads`), followed by collapsible date buckets —
 * Today, Yesterday, This Week, Last 30 Days — and a trailing Archived section.
 * Only the first date bucket starts expanded, so everything below the most
 * recent day of activity is folded away; empty sections never render. Rows reuse the palette's
 * compact thread row (no prompt preview) and the standard chat context menu;
 * bucket headers offer Archive All via "…" or right-click.
 */
function ThreadSectionsImpl({
  threads,
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
  // Drafts are browser-local, so they reach the sections as an argument rather
  // than as a field on the rows the server sent.
  const draftStartTimes = useDraftStartTimes()
  // Same reason as the drafts: a send this browser has made but not yet seen
  // acknowledged is not on the rows either, and without it the chat you just
  // sent to would drop out of every section until the server caught up.
  const pendingSends = usePendingSendTimes()
  const sections = useMemo(
    () => computeSidebarThreadSections(threads, nowMs, draftStartTimes, pendingSends),
    [draftStartTimes, nowMs, pendingSends, threads]
  )
  // This tab shows Review inside Relevant rather than as its own header.
  const relevant = useMemo(
    () => mergeRelevantThreads(sections, draftStartTimes),
    [draftStartTimes, sections]
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
  ].filter((group) => group.threads.length > 0)

  // Relevant counts here too: it drains chats out of the buckets, so a tab whose
  // every chat is flagged would otherwise have an empty `buckets` and render nothing.
  if (
    pinnedGroups.length === 0
    && relevant.length === 0
    && sections.buckets.length === 0
    && sections.archived.length === 0
  ) return null

  const renderRow = (thread: SidebarThread) => (
    <ThreadRow
      key={thread.chatId}
      thread={thread}
      isActive={normalizeChatId(thread.chatId) === normalizedActiveChatId}
      editorLabel={editorLabel}
      detailScope="cross-project"
      nowMs={nowMs}
      dimIdleTitles={false}
      onSelect={onSelectChat}
      onCreateChat={onCreateChat}
      onRenameChat={onRenameChat}
      onShareChat={onShareChat}
      onCopyPath={onCopyPath}
      onOpenExternalPath={onOpenExternalPath}
      onForkChat={onForkChat}
      onArchiveChat={onArchiveChat}
      onRestoreChat={onRestoreChat}
      onDeleteChat={onDeleteChat}
    />
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
      {relevant.length > 0 ? (() => {
        // Collapsible like a date bucket, but starts open — it's the reason the
        // section exists. Sits above Today so everything waiting on you or
        // touching the current diff reads as one group rather than scattered
        // across the buckets.
        const isExpanded = expandOverrides["relevant"] ?? true
        return (
          <div>
            <SectionHeader
              label="Relevant"
              isExpanded={isExpanded}
              onToggle={() => toggleBucket("relevant", true)}
              onArchiveAll={() => {
                for (const thread of relevant) onArchiveChat(thread.row)
              }}
            />
            {isExpanded ? (
              <div className="space-y-[2px] mb-3">
                {relevant.map(renderRow)}
              </div>
            ) : null}
          </div>
        )
      })() : null}
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
                  <ThreadRow
                    key={thread.chatId}
                    thread={thread}
                    archived
                    isActive={normalizeChatId(thread.chatId) === normalizedActiveChatId}
                    editorLabel={editorLabel}
                    detailScope="cross-project"
                    nowMs={nowMs}
                    dimIdleTitles={false}
                    onSelect={onOpenArchivedChat}
                    onCreateChat={onCreateChat}
                    onRenameChat={onRenameChat}
                    onShareChat={onShareChat}
                    onCopyPath={onCopyPath}
                    onOpenExternalPath={onOpenExternalPath}
                    onForkChat={onForkChat}
                    onArchiveChat={onArchiveChat}
                    onRestoreChat={onRestoreChat}
                    onDeleteChat={onDeleteChat}
                  />
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

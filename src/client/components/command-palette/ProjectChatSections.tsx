import { useChatHasDraft } from "../../stores/chatInputStore"
import { computeSidebarThreadSections, type SidebarThread } from "../../lib/thread-sections"
import { getThreadDetailLabel, type ThreadDetailScope } from "../../lib/thread-detail-label"
import { ThreadRowContent } from "../chat-ui/ThreadRowContent"
import { CommandGroup, CommandItem } from "../ui/command"

export function ThreadItem({
  thread,
  onSelect,
  showStatus = false,
  scope,
  nowMs,
}: {
  thread: SidebarThread
  onSelect: (thread: SidebarThread) => void
  /** Use the sidebar status glyph (ping dots / spinner) instead of the chat icon. */
  showStatus?: boolean
  /**
   * Whether this list spans projects. The detail slot follows from it — see
   * `getThreadDetailLabel`. Taking the scope rather than a finished label is
   * what keeps the palette in step with the sidebar.
   */
  scope: ThreadDetailScope
  nowMs: number
}) {
  // Same treatment as the sidebar: a chat you left mid-sentence swaps its
  // harness glyph for a pencil.
  const hasDraft = useChatHasDraft(thread.chatId)
  return (
    <CommandItem value={`thread-${thread.chatId}`} onSelect={() => onSelect(thread)}>
      <ThreadRowContent
        thread={thread}
        showStatus={showStatus}
        showPreview
        // Every palette row is something you might be about to open, so none of
        // them recede the way an ambient sidebar list does.
        dimIdleTitles={false}
        hasDraft={hasDraft}
        detailLabel={getThreadDetailLabel(thread, scope, nowMs)}
      />
    </CommandItem>
  )
}

export interface ProjectChatGroup {
  key: string
  label: string
  threads: SidebarThread[]
}

/**
 * One project's chats under the sidebar Chats tab's headings — Pinned,
 * In Progress, Review, Relevant, date buckets, Archived — empty groups
 * dropped.
 * The palette's "Chats in <project>" page and the new chat page's project card
 * both group by this, so the two read the same.
 */
export function getProjectChatGroups(threads: SidebarThread[], nowMs: number, {
  includeArchived = true,
  limit,
}: {
  includeArchived?: boolean
  /** Rows to show at most, taken in heading order. */
  limit?: number
} = {}): ProjectChatGroup[] {
  const sections = computeSidebarThreadSections(threads, nowMs)
  let remaining = limit ?? Number.POSITIVE_INFINITY
  return [
    { key: "pinned", label: "Pinned", threads: sections.pinned },
    { key: "in-progress", label: "In Progress", threads: sections.inProgress },
    { key: "review", label: "Review", threads: sections.review },
    { key: "relevant", label: "Relevant", threads: sections.relevant },
    ...sections.buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, threads: bucket.threads })),
    ...(includeArchived ? [{ key: "archived", label: "Archived", threads: sections.archived }] : []),
  ].map((group) => {
    const shown = group.threads.slice(0, Math.max(0, remaining))
    remaining -= shown.length
    return { ...group, threads: shown }
  }).filter((group) => group.threads.length > 0)
}

/** `getProjectChatGroups` as flat command groups. Must sit inside a cmdk `Command`. */
export function ProjectChatSections({
  threads,
  nowMs,
  onSelect,
}: {
  /** The project's chats, active and archived. */
  threads: SidebarThread[]
  nowMs: number
  onSelect: (thread: SidebarThread) => void
}) {
  return getProjectChatGroups(threads, nowMs).map((group) => (
    <CommandGroup key={group.key} heading={group.label}>
      {group.threads.map((thread) => (
        <ThreadItem
          key={thread.chatId}
          thread={thread}
          onSelect={onSelect}
          showStatus
          scope="project-scoped"
          nowMs={nowMs}
        />
      ))}
    </CommandGroup>
  ))
}

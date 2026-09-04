import { memo, useMemo } from "react"
import type { SidebarChatRow } from "../../../../shared/types"
import { getArchivedThreads, type SidebarThread } from "../../../lib/thread-sections"
import { normalizeChatId } from "../../../lib/utils"
import { SectionHeader } from "./ThreadSections"
import { ThreadRow } from "./ThreadRow"

interface Props {
  /** Every thread, active and archived — the archived ones are picked out here. */
  threads: SidebarThread[]
  activeChatId: string | null
  editorLabel: string
  nowMs: number
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
 * The New Sidebar's Archived view: every archived chat in the workspace, most
 * recently archived first.
 *
 * One flat list with no date buckets — an archive is browsed by "what did I put
 * away recently", not by which day each conversation happened on. Rows are the
 * same `ThreadRow` the other views use, in their archived mode: selecting one
 * opens it without unarchiving, and each row carries a Restore button (and menu
 * item) to put it back.
 */
function ArchivedSectionImpl({
  threads,
  activeChatId,
  editorLabel,
  nowMs,
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
  const archived = useMemo(() => getArchivedThreads(threads), [threads])
  const normalizedActiveChatId = activeChatId ? normalizeChatId(activeChatId) : null

  return (
    <div>
      <SectionHeader label="Archived" />
      {archived.length === 0 ? (
        <p className="p-2 mt-4 text-center text-sm text-slate-400">No archived chats</p>
      ) : (
        <div className="space-y-[2px] mb-3">
          {archived.map((thread) => (
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
      )}
    </div>
  )
}

export const ArchivedSection = memo(ArchivedSectionImpl)

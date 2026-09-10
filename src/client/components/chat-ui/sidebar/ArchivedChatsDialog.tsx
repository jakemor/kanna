import { RotateCcw } from "lucide-react"
import type { SidebarChatRow } from "../../../../shared/types"
import { formatSidebarAgeLabel } from "../../../lib/formatters"
import { getSidebarChatTimestamp } from "../../../lib/sidebarChats"
import { Button } from "../../ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog"

/**
 * One project's archived chats, opened from its sidebar menu — the Projects
 * view's counterpart to the Archived view, which covers the whole workspace.
 *
 * Opening a chat closes the dialog — you're leaving for it — while restoring
 * leaves it open, since putting several chats back is one errand and each row
 * drops out of the list on the next snapshot anyway.
 */
export function ArchivedChatsDialog({
  open,
  description,
  chats,
  nowMs,
  onOpenChange,
  onOpenChat,
  onRestoreChat,
}: {
  open: boolean
  /** Subtitle under the heading: the project's path. */
  description?: string
  chats: SidebarChatRow[]
  nowMs: number
  onOpenChange: (open: boolean) => void
  onOpenChat: (chatId: string) => void
  onRestoreChat: (chatId: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Archived Chats</DialogTitle>
          <DialogDescription>{description ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-1">
          {chats.length ? (
            chats.map((chat) => (
              <div
                key={chat.chatId}
                className="group flex items-center gap-1 rounded-lg border border-border/0 pr-1 transition-colors hover:border-border hover:bg-muted"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left"
                  onClick={() => {
                    onOpenChat(chat.chatId)
                    onOpenChange(false)
                  }}
                >
                  <span className="min-w-0 truncate text-sm">{chat.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSidebarAgeLabel(chat.archivedAt ?? getSidebarChatTimestamp(chat), nowMs)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  title="Restore chat"
                  aria-label={`Restore ${chat.title}`}
                  onClick={() => onRestoreChat(chat.chatId)}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            ))
          ) : (
            <p className="px-1 py-3 text-sm text-muted-foreground">No archived chats</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

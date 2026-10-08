import type { ReactNode } from "react"
import { Archive, Code, Copy, EyeOff, FolderOpen, Github, Mail, Pencil, PencilOff, Pin, PinOff, RotateCcw, Split, SquarePen, Trash2, UserRoundPlus } from "lucide-react"
import { getRepoUrlLabel } from "../../../../shared/git-url"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../ui/context-menu"
import { useOpenedOnce } from "../../../hooks/useOpenedOnce"

/**
 * "Open on GitHub" (or GitLab, or whatever host the remote names), sitting with
 * the other Open-in items.
 *
 * Renders nothing without a URL — a project with no `origin`, or one whose
 * remote is a bare path, has no page to open, and a permanently disabled row in
 * every menu would cost more than it explains.
 *
 * Opens in *this* browser rather than through `system.openExternal`: that
 * command opens things on the machine the project lives on, which is the wrong
 * screen the moment that machine isn't the one you're sitting at.
 */
export function OpenRepoMenuItem({ repoUrl }: { repoUrl?: string }) {
  if (!repoUrl) return null

  return (
    <ContextMenuItem
      onSelect={(event) => {
        event.preventDefault()
        window.open(repoUrl, "_blank", "noopener,noreferrer")
      }}
    >
      <Github className="h-3.5 w-3.5" />
      <span className="text-xs font-medium">Open on {getRepoUrlLabel(repoUrl)}</span>
    </ContextMenuItem>
  )
}

export function ProjectSectionMenu({
  editorLabel,
  repoUrl,
  onNewChat,
  newChatDisabled = false,
  onRename,
  onCopyPath,
  onShowArchived,
  onOpenInFinder,
  onOpenInEditor,
  onHide,
  pinned,
  onTogglePin,
  children,
}: {
  /** With `onTogglePin`, adds Pin / Unpin: the Channels view pins projects. */
  pinned?: boolean
  onTogglePin?: () => void
  editorLabel: string
  /** The project's forge page; absent when it has no browsable origin. */
  repoUrl?: string
  onNewChat: () => void
  newChatDisabled?: boolean
  onRename: () => void
  onCopyPath: () => void
  onShowArchived: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onHide: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="[&_svg]:size-3.5">
        <ContextMenuItem onSelect={onNewChat} disabled={newChatDisabled}>
          <SquarePen />
          <span>New Chat</span>
        </ContextMenuItem>
        {onTogglePin ? (
          <ContextMenuItem onSelect={onTogglePin}>
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            <span className="text-xs font-medium">{pinned ? "Unpin" : "Pin"}</span>
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={onRename}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Rename</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyPath()
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy Path</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onShowArchived()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Show Archived</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Show in Finder</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInEditor()
          }}
        >
          <Code className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in {editorLabel}</span>
        </ContextMenuItem>
        <OpenRepoMenuItem repoUrl={repoUrl} />
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onHide()
          }}
        >
          <EyeOff className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Hide</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ChatRowMenu({
  canFork,
  archived,
  pinned,
  onTogglePin,
  editorLabel,
  repoUrl,
  onNewChat,
  onMarkUnread,
  onRename,
  onShare,
  onCopyPath,
  onOpenInFinder,
  onOpenInEditor,
  onFork,
  onArchive,
  onRestore,
  onClearDraft,
  onDelete,
  leadingItems,
  children,
}: {
  pinned?: boolean
  onTogglePin?: () => void
  canFork?: boolean
  /** Archived chats swap the Archive item for a leading Restore item. */
  archived?: boolean
  editorLabel: string
  /** The project's forge page; absent when it has no browsable origin. */
  repoUrl?: string
  /** Starts a fresh chat in this chat's project. */
  onNewChat: () => void
  onMarkUnread?: () => void
  onRename: () => void
  onShare: () => void
  onCopyPath: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onFork: () => void
  onArchive: () => void
  onRestore?: () => void
  /**
   * Throws away the chat's unsent draft. Absent when there is no draft, which
   * is most rows — a section that only ever appears when there's something to
   * clear beats a permanently greyed-out item in every menu.
   */
  onClearDraft?: () => void
  onDelete: () => void
  /**
   * Items for where the chat is being shown, ahead of the chat's own and set
   * off from them: a tab's Close items. They act on the place, not the chat.
   */
  leadingItems?: ReactNode
  children: ReactNode
}) {
  // There is one of these per sidebar row and the menu below is a dozen items
  // with icons, rebuilt on every render of the row that owns it. Nothing is
  // built until the menu has actually been opened once — see `useOpenedOnce`.
  const [menuOpened, handleMenuOpenChange] = useOpenedOnce()

  return (
    <ContextMenu onOpenChange={handleMenuOpenChange}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      {!menuOpened ? null : (
        <ContextMenuContent className="[&_svg]:size-3.5">
          {onMarkUnread ? (
            <ContextMenuGroup>
              <ContextMenuItem onSelect={onMarkUnread}>
                <Mail />
                <span>Unread</span>
              </ContextMenuItem>
            </ContextMenuGroup>
          ) : null}
          {leadingItems ? (
            <>
              {leadingItems}
              <ContextMenuSeparator />
            </>
          ) : null}
          {onTogglePin ? (
            <ContextMenuItem onSelect={onTogglePin}>
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              <span className="text-xs font-medium">{pinned ? "Unpin" : "Pin"}</span>
            </ContextMenuItem>
          ) : null}
          {/* Draft leads: its own section, for something only this chat has and
              only while it has it — so when it's there, it's what you opened the
              menu for. */}
          {onClearDraft ? (
            <>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  onClearDraft()
                }}
              >
                <PencilOff className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Clear Draft</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}

          {archived && onRestore ? (
            <>
              <ContextMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  onRestore()
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Restore</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}

          {/* Chat actions */}
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onRename()
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Rename</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onShare()
            }}
          >
            <UserRoundPlus className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Share</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canFork}
            onSelect={(event) => {
              event.preventDefault()
              if (!canFork) return
              onFork()
            }}
          >
            <Split className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Fork</span>
          </ContextMenuItem>

          <ContextMenuSeparator />

          {/* Project actions */}
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onNewChat()
            }}
          >
            <SquarePen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">New Chat</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={(event) => {
              event.stopPropagation()
              onCopyPath()
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Copy Path</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onOpenInFinder()
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Open in Finder</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={(event) => {
              event.stopPropagation()
              onOpenInEditor()
            }}
          >
            <Code className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Open in {editorLabel}</span>
          </ContextMenuItem>
          <OpenRepoMenuItem repoUrl={repoUrl} />

          <ContextMenuSeparator />

          {/* Chat lifecycle */}
          {!archived ? (
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onArchive()
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">Archive Chat</span>
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onDelete()
            }}
            className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Delete Chat</span>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

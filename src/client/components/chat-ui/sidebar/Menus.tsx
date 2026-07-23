import type { ReactNode } from "react"
import { Archive, Code, Copy, EyeOff, FolderOpen, Pencil, RotateCcw, Split, SquarePen, Trash2, UserRoundPlus } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../ui/context-menu"

export function ProjectSectionMenu({
  editorLabel,
  onRename,
  onCopyPath,
  onShowArchived,
  onOpenInFinder,
  onOpenInEditor,
  onHide,
  children,
}: {
  editorLabel: string
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
      <ContextMenuContent>
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
  editorLabel,
  onNewChat,
  onRename,
  onShare,
  onCopyPath,
  onOpenInFinder,
  onOpenInEditor,
  onFork,
  onArchive,
  onRestore,
  onDelete,
  children,
}: {
  canFork?: boolean
  /** Archived chats swap the Archive item for a leading Restore item. */
  archived?: boolean
  editorLabel: string
  /** Starts a fresh chat in this chat's project. */
  onNewChat: () => void
  onRename: () => void
  onShare: () => void
  onCopyPath: () => void
  onOpenInFinder: () => void
  onOpenInEditor: () => void
  onFork: () => void
  onArchive: () => void
  onRestore?: () => void
  onDelete: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
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
    </ContextMenu>
  )
}

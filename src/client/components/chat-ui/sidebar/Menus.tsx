import type { ReactNode } from "react"
import { Pencil, Trash2 } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"

export function ProjectSectionMenu({
  onRemove,
  children,
}: {
  onRemove: () => void
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
            event.stopPropagation()
            onRemove()
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-4 w-4" />
          <span className="text-xs font-medium">Hide</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function FeatureSectionMenu({
  onRename,
  onDelete,
  children,
}: {
  onRename: () => void
  onDelete: () => void
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
            event.stopPropagation()
            onRename()
          }}
        >
          <Pencil className="h-4 w-4" />
          <span className="text-xs font-medium">Rename Feature</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onDelete()
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-4 w-4" />
          <span className="text-xs font-medium">Delete Feature</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

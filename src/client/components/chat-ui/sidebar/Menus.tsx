import type { ReactNode } from "react"
import { Pencil, Trash2 } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"
import { ActionMenu, ActionMenuItem } from "../../ui/action-menu"

// ─── ProjectSectionMenu ────────────────────────────────────────────────────

interface ProjectSectionMenuProps {
  onRemove: () => void
  children: ReactNode
  /** Mobile long-press position — opens ActionMenu at these coordinates */
  mobileMenuPosition?: { x: number; y: number } | null
  onMobileMenuClose?: () => void
  /**
   * When true, the Radix ContextMenu wrapper is not rendered.
   * Use on touch devices to prevent iOS from opening the menu via its
   * own ~500ms contextmenu event (which bypasses our 2.5s custom timer).
   */
  skipContextMenu?: boolean
}

export function ProjectSectionMenu({
  onRemove,
  children,
  mobileMenuPosition,
  onMobileMenuClose,
  skipContextMenu,
}: ProjectSectionMenuProps) {
  return (
    <>
      {/* Desktop right-click context menu */}
      {skipContextMenu ? children : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={(e) => { e.stopPropagation(); onRemove() }}
              className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
            >
              <Trash2 className="h-4 w-4" />
              <span className="text-xs font-medium">Hide</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Mobile long-press action menu */}
      <ActionMenu
        open={!!mobileMenuPosition}
        onOpenChange={(open) => { if (!open) onMobileMenuClose?.() }}
        position={mobileMenuPosition ?? null}
      >
        <ActionMenuItem
          onSelect={() => { onMobileMenuClose?.(); onRemove() }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-4 w-4" />
          <span>Hide</span>
        </ActionMenuItem>
      </ActionMenu>
    </>
  )
}

// ─── FeatureSectionMenu ────────────────────────────────────────────────────

interface FeatureSectionMenuProps {
  onRename: () => void
  onDelete: () => void
  children: ReactNode
  /** Mobile long-press position — opens ActionMenu at these coordinates */
  mobileMenuPosition?: { x: number; y: number } | null
  onMobileMenuClose?: () => void
  /**
   * When true, the Radix ContextMenu wrapper is not rendered.
   * Use on touch devices to prevent iOS from opening the menu via its
   * own ~500ms contextmenu event.
   */
  skipContextMenu?: boolean
}

export function FeatureSectionMenu({
  onRename,
  onDelete,
  children,
  mobileMenuPosition,
  onMobileMenuClose,
  skipContextMenu,
}: FeatureSectionMenuProps) {
  return (
    <>
      {/* Desktop right-click context menu */}
      {skipContextMenu ? children : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={(e) => { e.stopPropagation(); onRename() }}>
              <Pencil className="h-4 w-4" />
              <span className="text-xs font-medium">Rename Feature</span>
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={(e) => { e.stopPropagation(); onDelete() }}
              className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
            >
              <Trash2 className="h-4 w-4" />
              <span className="text-xs font-medium">Delete Feature</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Mobile long-press action menu */}
      <ActionMenu
        open={!!mobileMenuPosition}
        onOpenChange={(open) => { if (!open) onMobileMenuClose?.() }}
        position={mobileMenuPosition ?? null}
      >
        <ActionMenuItem onSelect={() => { onMobileMenuClose?.(); onRename() }}>
          <Pencil className="h-4 w-4" />
          <span>Rename Feature</span>
        </ActionMenuItem>
        <ActionMenuItem
          onSelect={() => { onMobileMenuClose?.(); onDelete() }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete Feature</span>
        </ActionMenuItem>
      </ActionMenu>
    </>
  )
}

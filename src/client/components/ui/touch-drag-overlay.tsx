/**
 * TouchDragOverlay
 *
 * A portal-rendered floating card that follows the user's finger during a
 * touch drag. The card appears above the touch point so the user's hand
 * doesn't obscure the label.
 *
 * Usage:
 *   <TouchDragOverlay position={dragPosition}>
 *     <FolderGit2 /> My Feature
 *   </TouchDragOverlay>
 */
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { cn } from "../../lib/utils"

interface TouchDragOverlayProps {
  /** Live finger position from useTouchInteraction's dragPosition */
  position: { x: number; y: number } | null
  children: ReactNode
  className?: string
}

export function TouchDragOverlay({ position, children, className }: TouchDragOverlayProps) {
  if (!position) return null

  return createPortal(
    <div
      style={{
        position: "fixed",
        // Centre horizontally on finger, float above it
        left: position.x,
        top: position.y,
        transform: "translate(-50%, calc(-100% - 14px))",
        zIndex: 9999,
        pointerEvents: "none",
        willChange: "transform",
      }}
      className={cn(
        "flex items-center gap-2 rounded-xl border-2 border-primary/60 bg-card px-3 py-2",
        "shadow-[0_8px_32px_rgba(0,0,0,0.25)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.5)]",
        "min-w-[120px] max-w-[240px]",
        "scale-[1.04]",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  )
}

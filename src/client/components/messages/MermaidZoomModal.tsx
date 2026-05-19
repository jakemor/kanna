import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { Minus, Plus, RotateCcw, X } from "lucide-react"
import { Button } from "../ui/button"

interface Props {
  svg: string
  onClose: () => void
}

export function MermaidZoomModal({ svg, onClose }: Props) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const clampScale = (s: number) => Math.min(8, Math.max(0.25, s))

  const onPointerDown = (e: ReactPointerEvent) => {
    setDrag({ x: e.clientX - offset.x, y: e.clientY - offset.y })
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return
    setOffset({ x: e.clientX - drag.x, y: e.clientY - drag.y })
  }
  const onPointerUp = () => setDrag(null)

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background/95"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram zoom view"
    >
      <div className="flex justify-end gap-1 p-2">
        <Button variant="ghost" size="icon" aria-label="Zoom out"
          className="h-9 w-9" onClick={() => setScale((s) => clampScale(s - 0.25))}>
          <Minus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Zoom in"
          className="h-9 w-9" onClick={() => setScale((s) => clampScale(s + 0.25))}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Reset view"
          className="h-9 w-9" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }) }}>
          <RotateCcw className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close"
          className="h-9 w-9" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div
        className="flex-1 overflow-hidden touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div
          data-mermaid-stage
          className="w-full h-full flex items-center justify-center"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body
  )
}

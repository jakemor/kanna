import { type ComponentPropsWithoutRef, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { useHasFinePointer } from "../../../lib/pointer"
import { cn } from "../../../lib/utils"
import { CHAT_HOVER_CARD_CONTENT_CLASSNAME } from "../sidebar/ChatHoverCard"

/**
 * A widget list's hover card: the left sidebar's chat card
 * (SidebarChatHoverCard), mirrored and made generic. The widget column sits
 * at the window's right edge, so the card opens to the rows' left, over the
 * chat.
 *
 * One instance for the whole list, anchored to whichever row is under the
 * pointer. Rows mark themselves with WidgetRow's `rowKey` (`data-row-key`);
 * one delegated `pointerover` on the list reads it. So "at most one card, on
 * the row under the pointer" holds by construction, and an idle row costs
 * nothing. Desktop only: hover isn't a touch gesture, and a card that opened
 * on tap would fight the row's own tap.
 *
 * `children` renders the card for a hovered key, or null for rows that have
 * nothing to add (the card then stays closed). `dismiss` closes it and holds
 * it closed until the pointer reaches another row; call it before an action
 * that takes the user elsewhere.
 */
export function WidgetHoverCard({
  containerRef,
  children,
  className,
}: {
  /** The list; every row the card describes is somewhere beneath it. */
  containerRef: RefObject<HTMLElement | null>
  children: (rowKey: string, dismiss: () => void) => ReactNode | null
  className?: string
}) {
  const hasFinePointer = useHasFinePointer()
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const hoveredKeyRef = useRef<string | null>(null)
  // A click closes the card while the pointer is still on the row; without
  // this, one pixel of movement would raise it again.
  const dismissedKeyRef = useRef<string | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const setHovered = useCallback((key: string | null) => {
    if (hoveredKeyRef.current === key) return
    hoveredKeyRef.current = key
    setHoveredKey(key)
  }, [])

  const dismiss = useCallback(() => {
    dismissedKeyRef.current = hoveredKeyRef.current
    setHovered(null)
  }, [setHovered])

  // Found in the DOM each render: rows remount (Show more, a refresh), and
  // an anchor holding a detached row would float the card where it was.
  useLayoutEffect(() => {
    const container = containerRef.current
    anchorRef.current = hoveredKey && container
      ? container.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(hoveredKey)}"]`)
      : null
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container || !hasFinePointer) return

    function handlePointerOver(event: PointerEvent) {
      if (event.pointerType === "touch") return
      const row = event.target instanceof Element ? event.target.closest("[data-row-key]") : null
      const key = row instanceof HTMLElement ? row.dataset.rowKey ?? null : null
      if (key != null && key === dismissedKeyRef.current) return
      dismissedKeyRef.current = null
      // Null off a row (a header, "Show more"), which closes the card.
      setHovered(key)
    }

    // The bridge on the card covers the gap, so a pointer on its way to the
    // card is already inside it when the list reports it gone.
    function handlePointerLeave(event: PointerEvent) {
      const next = event.relatedTarget
      if (next instanceof Node && contentRef.current?.contains(next)) return
      setHovered(null)
    }

    // A card left up while the window is in the background would be waiting
    // on the far side of a Cmd-Tab.
    function handleWindowBlur() {
      setHovered(null)
    }

    container.addEventListener("pointerover", handlePointerOver)
    container.addEventListener("pointerleave", handlePointerLeave)
    window.addEventListener("blur", handleWindowBlur)
    return () => {
      container.removeEventListener("pointerover", handlePointerOver)
      container.removeEventListener("pointerleave", handlePointerLeave)
      window.removeEventListener("blur", handleWindowBlur)
    }
  }, [containerRef, hasFinePointer, setHovered])

  const handleContentPointerLeave = useCallback((event: { relatedTarget: EventTarget | null }) => {
    const next = event.relatedTarget
    // Back onto the list: its `pointerover` re-anchors the card in the same
    // move, so clearing here would only flicker it.
    if (next instanceof Node && containerRef.current?.contains(next)) return
    setHovered(null)
  }, [containerRef, setHovered])

  const content = hasFinePointer && hoveredKey ? children(hoveredKey, dismiss) : null

  return (
    <PopoverPrimitive.Root open={content != null} onOpenChange={(open) => { if (!open) dismiss() }}>
      <PopoverPrimitive.Anchor
        virtualRef={anchorRef as ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>["virtualRef"]}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={contentRef}
          side="left"
          // Top-aligned with the row: centred, a tall card floats above the
          // row it describes and leaves you tracing back to which.
          align="start"
          // Clears the sidebar's edge, so the card reads as beside it.
          sideOffset={15}
          collisionPadding={12}
          // A peek, not a destination: never pulls focus in or throws it out.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerLeave={handleContentPointerLeave}
          className={cn(
            CHAT_HOVER_CARD_CONTENT_CLASSNAME,
            // The bridge: an invisible strip of the card over the gap to the
            // row, overlapping the row's first pixels so no subpixel gap drops
            // the pointer on its way across. Full height, since a card near
            // the screen's bottom shifts up and its rows must stay reachable.
            "relative before:absolute before:inset-y-0 before:w-5 before:content-['']",
            "data-[side=right]:before:-left-5 data-[side=left]:before:-right-5",
            // Grows from the row it describes rather than from its own
            // centre (the shared surface's zoom-in-95 otherwise pivots there).
            "origin-(--radix-popover-content-transform-origin)",
            className,
          )}
        >
          {content}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

/**
 * Lazily fetched card details, cached by a key that changes when the thing
 * does (a commit's checks, a branch's tip time, a file's patch digest).
 * Bounded, since a long session hovers a lot of rows.
 *
 * When the key moves under an open card, the old details stay until the new
 * ones land: a card is keyed by its row, so they are the same thing's, only
 * older, and blanking them would collapse the card under the reader.
 */
export function useCardDetails<T>(
  cache: Map<string, T>,
  cacheKey: string | null,
  load: (() => Promise<T>) | null,
  limit = 100,
): T | null {
  const [details, setDetails] = useState<T | null>(() => (cacheKey ? cache.get(cacheKey) ?? null : null))
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    const currentLoad = loadRef.current
    if (!cacheKey || !currentLoad) {
      setDetails(null)
      return
    }
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      setDetails(cached)
      return
    }
    let cancelled = false
    currentLoad()
      .then((result) => {
        if (cache.size >= limit) cache.delete(cache.keys().next().value!)
        cache.set(cacheKey, result)
        if (!cancelled) setDetails(result)
      })
      // The card still says what the row knew; only the fetched part waits,
      // and it simply doesn't appear.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cache, cacheKey, limit])
  return details
}

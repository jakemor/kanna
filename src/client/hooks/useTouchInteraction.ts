/**
 * useTouchInteraction
 *
 * Disambiguates three mobile touch gestures on a single element:
 *   - Quick tap  → onTap
 *   - Hold 300ms + move > 5px → drag (onDragStart / onDragMove / onDragEnd)
 *   - Hold 300ms + stay still for 2.5s → context menu (onContextMenu)
 *
 * Uses native addEventListener with { passive: false } so that
 * e.preventDefault() actually works on iOS Safari (React's synthetic
 * onTouchMove is passive in newer React/browser combos and will silently
 * ignore preventDefault, breaking scroll-locking during drag).
 *
 * Returns a `touchRef` callback-ref to attach to the drag HANDLE element
 * (e.g. a header), and an optional `visualElementRef` (a plain useRef) to
 * attach to the full visual element when the handle and the visual container
 * are different nodes — the visual element is temporarily hidden from
 * pointer-events during drag so that elementFromPoint hits the drop target
 * underneath it.
 */
import { useState, useRef, useCallback, useEffect } from "react"
import type React from "react"

type TouchState = "idle" | "holding" | "armed" | "dragging"

interface Position {
  x: number
  y: number
}

interface DragPosition extends Position {
  elementBelow: Element | null
}

export interface UseTouchInteractionOptions {
  /** False on desktop — skips all listener attachment */
  enabled: boolean
  /**
   * Optional ref to the FULL visual element used for hit-testing during drag.
   * When the touch handle (touchRef) is a child of a larger draggable block,
   * pass the outer element's ref here so it's hidden from elementFromPoint
   * and the drop target below is detected correctly.
   * If omitted, the touch handle element itself is used for hit-testing.
   */
  visualElementRef?: React.RefObject<HTMLElement | null>
  /** Called on a quick tap (touchend before hold timer fires) */
  onTap?: () => void
  /** Called after hold + contextMenuDelay with no movement */
  onContextMenu?: (position: Position) => void
  /** Called when drag begins (armed + moved > dragMoveThreshold) */
  onDragStart?: (position: Position) => void
  /** Called every touchmove while dragging */
  onDragMove?: (position: DragPosition) => void
  /** Called on touchend while dragging */
  onDragEnd?: (position: DragPosition) => void
  /** ms to hold before entering armed state. Default: 300 */
  holdDelay?: number
  /** ms after armed before context menu opens. Default: 2500 */
  contextMenuDelay?: number
  /** Movement that cancels hold (scroll intent). Default: 8px */
  scrollThreshold?: number
  /** Movement after armed that triggers drag. Default: 5px */
  dragMoveThreshold?: number
}

export interface UseTouchInteractionReturn {
  /**
   * Callback ref — attach to the drag handle element:
   *   <div ref={touchRef}>
   * Native touch listeners are registered here with { passive: false }.
   */
  touchRef: (el: HTMLElement | null) => void
  /** True while actively dragging */
  isDragging: boolean
  /** True while armed (hold detected, not yet dragging or menu) */
  isArmed: boolean
  /**
   * Current touch position during drag — update every touchmove.
   * Use this to position a floating drag overlay.
   * Null when not dragging.
   */
  dragPosition: Position | null
}

// Selector for elements that should NOT start a drag/hold
const INTERACTIVE_SELECTOR =
  'button, select, input, textarea, [role="combobox"], [role="listbox"], [data-no-touch-drag]'

function tryVibrate(ms: number) {
  try { navigator.vibrate?.(ms) } catch { /* not available */ }
}

export function useTouchInteraction({
  enabled,
  visualElementRef,
  onTap,
  onContextMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
  holdDelay = 300,
  contextMenuDelay = 2500,
  scrollThreshold = 8,
  dragMoveThreshold = 5,
}: UseTouchInteractionOptions): UseTouchInteractionReturn {
  const [isDragging, setIsDragging] = useState(false)
  const [isArmed, setIsArmed] = useState(false)
  const [dragPosition, setDragPosition] = useState<Position | null>(null)

  // The element native listeners are attached to (set via touchRef callback)
  const [touchEl, setTouchEl] = useState<HTMLElement | null>(null)

  const touchRef = useCallback((el: HTMLElement | null) => {
    setTouchEl(el)
  }, [])

  // Internal state machine — stored in refs so timer callbacks always see latest
  const stateRef = useRef<TouchState>("idle")
  const startPosRef = useRef<Position>({ x: 0, y: 0 })
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep callbacks fresh inside native event handlers (avoid stale closures)
  const cbTap = useRef(onTap)
  const cbContextMenu = useRef(onContextMenu)
  const cbDragStart = useRef(onDragStart)
  const cbDragMove = useRef(onDragMove)
  const cbDragEnd = useRef(onDragEnd)
  cbTap.current = onTap
  cbContextMenu.current = onContextMenu
  cbDragStart.current = onDragStart
  cbDragMove.current = onDragMove
  cbDragEnd.current = onDragEnd

  // Hit-test through either the visual element (if provided) or the touch element
  const getElementBelow = useCallback((clientX: number, clientY: number): Element | null => {
    const el = visualElementRef?.current ?? touchEl
    if (!el) return document.elementFromPoint(clientX, clientY)
    const prev = el.style.pointerEvents
    el.style.pointerEvents = "none"
    const result = document.elementFromPoint(clientX, clientY)
    el.style.pointerEvents = prev
    return result
  }, [visualElementRef, touchEl])

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
    if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null }
  }, [])

  const resetAll = useCallback(() => {
    clearTimers()
    stateRef.current = "idle"
    setIsArmed(false)
    setIsDragging(false)
    setDragPosition(null)
  }, [clearTimers])

  useEffect(() => {
    if (!touchEl || !enabled) return

    const onTouchStart = (e: TouchEvent) => {
      // Ignore touches that originate on interactive children
      if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return
      const touch = e.touches[0]
      if (!touch) return

      startPosRef.current = { x: touch.clientX, y: touch.clientY }
      stateRef.current = "holding"

      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null
        if (stateRef.current !== "holding") return

        // → armed
        stateRef.current = "armed"
        setIsArmed(true)
        tryVibrate(30)

        menuTimerRef.current = setTimeout(() => {
          menuTimerRef.current = null
          if (stateRef.current !== "armed") return

          // → context menu
          tryVibrate(100)
          const pos = { ...startPosRef.current }
          stateRef.current = "idle"
          setIsArmed(false)
          cbContextMenu.current?.(pos)
        }, contextMenuDelay)
      }, holdDelay)
    }

    const onTouchMove = (e: TouchEvent) => {
      const state = stateRef.current
      if (state === "idle") return

      const touch = e.touches[0]
      if (!touch) return

      const dx = touch.clientX - startPosRef.current.x
      const dy = touch.clientY - startPosRef.current.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (state === "holding") {
        // Too much movement = scroll intent, bail
        if (dist > scrollThreshold) {
          clearTimers()
          stateRef.current = "idle"
        }
        return
      }

      if (state === "armed") {
        if (dist > dragMoveThreshold) {
          // Cancel context menu timer, start drag
          if (menuTimerRef.current) { clearTimeout(menuTimerRef.current); menuTimerRef.current = null }
          stateRef.current = "dragging"
          setIsArmed(false)
          setIsDragging(true)
          setDragPosition({ x: touch.clientX, y: touch.clientY })
          e.preventDefault() // prevent scroll during drag
          cbDragStart.current?.({ x: touch.clientX, y: touch.clientY })
        }
        return
      }

      if (state === "dragging") {
        e.preventDefault() // keep scroll locked during drag
        setDragPosition({ x: touch.clientX, y: touch.clientY })
        const elBelow = getElementBelow(touch.clientX, touch.clientY)
        cbDragMove.current?.({ x: touch.clientX, y: touch.clientY, elementBelow: elBelow })
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      const state = stateRef.current

      if (state === "holding") {
        clearTimers()
        stateRef.current = "idle"
        setIsArmed(false)
        setIsDragging(false)
        // Prevent the ghost click iOS fires ~300ms after touchend
        e.preventDefault()
        cbTap.current?.()
        return
      }

      if (state === "armed") {
        // Lifted before drag threshold and before menu timer — cancel silently
        resetAll()
        return
      }

      if (state === "dragging") {
        const touch = e.changedTouches[0]
        if (touch) {
          const elBelow = getElementBelow(touch.clientX, touch.clientY)
          cbDragEnd.current?.({ x: touch.clientX, y: touch.clientY, elementBelow: elBelow })
        }
        resetAll()
      }
    }

    const onTouchCancel = () => {
      if (stateRef.current === "dragging") {
        cbDragEnd.current?.({ x: 0, y: 0, elementBelow: null })
      }
      resetAll()
    }

    touchEl.addEventListener("touchstart", onTouchStart, { passive: false })
    touchEl.addEventListener("touchmove", onTouchMove, { passive: false })
    touchEl.addEventListener("touchend", onTouchEnd)
    touchEl.addEventListener("touchcancel", onTouchCancel)

    return () => {
      touchEl.removeEventListener("touchstart", onTouchStart)
      touchEl.removeEventListener("touchmove", onTouchMove)
      touchEl.removeEventListener("touchend", onTouchEnd)
      touchEl.removeEventListener("touchcancel", onTouchCancel)
      clearTimers()
      stateRef.current = "idle"
    }
  }, [
    touchEl, enabled, holdDelay, contextMenuDelay,
    scrollThreshold, dragMoveThreshold, clearTimers, resetAll, getElementBelow,
  ])

  return { touchRef, isDragging, isArmed, dragPosition }
}

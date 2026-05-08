import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import type { GroupImperativeHandle } from "react-resizable-panels"
import { interpolateLayout, TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "./terminalToggleAnimation"

type UseRightSidebarToggleAnimationParams = {
  projectId: string | null
  shouldRenderRightSidebarLayout: boolean
  showRightSidebar: boolean
  rightSidebarSizePercent: number
}

type UseRightSidebarToggleAnimationResult = {
  isAnimating: RefObject<boolean>
  panelGroupRef: RefObject<GroupImperativeHandle | null>
  sidebarPanelRef: RefObject<HTMLDivElement | null>
  sidebarVisualRef: RefObject<HTMLDivElement | null>
}

export function useRightSidebarToggleAnimation({
  projectId,
  shouldRenderRightSidebarLayout,
  showRightSidebar,
  rightSidebarSizePercent,
}: UseRightSidebarToggleAnimationParams): UseRightSidebarToggleAnimationResult {
  const panelGroupRef = useRef<GroupImperativeHandle | null>(null)
  const sidebarPanelRef = useRef<HTMLDivElement | null>(null)
  const sidebarVisualRef = useRef<HTMLDivElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const animationTimeoutRef = useRef<number | null>(null)
  const isAnimatingRef = useRef(false)
  const previousProjectIdRef = useRef<string | null>(null)
  const previousShouldRenderRightSidebarLayoutRef = useRef(false)
  const previousShowRightSidebarRef = useRef(false)

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
      if (animationTimeoutRef.current !== null) {
        window.clearTimeout(animationTimeoutRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    if (!shouldRenderRightSidebarLayout) {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      if (animationTimeoutRef.current !== null) {
        window.clearTimeout(animationTimeoutRef.current)
        animationTimeoutRef.current = null
      }
      isAnimatingRef.current = false
      return
    }

    const group = panelGroupRef.current
    if (!group) return

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (animationTimeoutRef.current !== null) {
      window.clearTimeout(animationTimeoutRef.current)
      animationTimeoutRef.current = null
    }

    const previousProjectId = previousProjectIdRef.current
    const didProjectChange = previousProjectId !== null && previousProjectId !== projectId
    const isInitialOpen = showRightSidebar && !previousShowRightSidebarRef.current
    const isInitialRender = !previousShouldRenderRightSidebarLayoutRef.current
    const targetLayout: [number, number] = showRightSidebar ? [100 - rightSidebarSizePercent, rightSidebarSizePercent] : [100, 0]
    const shouldSkipAnimation = didProjectChange || (isInitialRender && showRightSidebar)
    const currentLayout: [number, number] = isInitialOpen || isInitialRender
      ? [100, 0]
      : [
          group.getLayout().workspace ?? targetLayout[0],
          group.getLayout().rightSidebar ?? targetLayout[1],
        ]

    previousProjectIdRef.current = projectId
    previousShouldRenderRightSidebarLayoutRef.current = shouldRenderRightSidebarLayout
    previousShowRightSidebarRef.current = showRightSidebar

    if (
      shouldSkipAnimation ||
      (Math.abs(currentLayout[0] - targetLayout[0]) < 0.1 &&
      Math.abs(currentLayout[1] - targetLayout[1]) < 0.1)
    ) {
      group.setLayout({ workspace: targetLayout[0], rightSidebar: targetLayout[1] })
      sidebarPanelRef.current?.setAttribute("data-right-sidebar-open", showRightSidebar ? "true" : "false")
      sidebarVisualRef.current?.setAttribute("data-right-sidebar-open", showRightSidebar ? "true" : "false")
      sidebarVisualRef.current?.setAttribute("data-right-sidebar-animated", "false")
      return
    }

    isAnimatingRef.current = true
    sidebarPanelRef.current?.setAttribute("data-right-sidebar-open", showRightSidebar ? "true" : "false")
    sidebarVisualRef.current?.setAttribute("data-right-sidebar-open", showRightSidebar ? "true" : "false")
    sidebarVisualRef.current?.setAttribute("data-right-sidebar-animated", "true")
    group.setLayout({ workspace: currentLayout[0], rightSidebar: currentLayout[1] })
    const startTime = performance.now()

    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / TERMINAL_TOGGLE_ANIMATION_DURATION_MS)
      const nextLayout = interpolateLayout(currentLayout, targetLayout, progress)
      group.setLayout({ workspace: nextLayout[0], rightSidebar: nextLayout[1] })

      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(step)
        return
      }

      group.setLayout({ workspace: targetLayout[0], rightSidebar: targetLayout[1] })
      animationFrameRef.current = null
      animationTimeoutRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false
        animationTimeoutRef.current = null
      }, 0)
    }

    animationFrameRef.current = window.requestAnimationFrame(step)
  }, [projectId, rightSidebarSizePercent, shouldRenderRightSidebarLayout, showRightSidebar])

  useEffect(() => {
    if (shouldRenderRightSidebarLayout) return
    previousShouldRenderRightSidebarLayoutRef.current = false
    previousShowRightSidebarRef.current = false
  }, [shouldRenderRightSidebarLayout])

  return {
    isAnimating: isAnimatingRef,
    panelGroupRef,
    sidebarPanelRef,
    sidebarVisualRef,
  }
}

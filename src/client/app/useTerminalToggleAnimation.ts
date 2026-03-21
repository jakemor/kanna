import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { GroupImperativeHandle } from "react-resizable-panels"
import type { ProjectTerminalLayout } from "../stores/terminalLayoutStore"
import { interpolateLayout, TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "./terminalToggleAnimation"

type UseTerminalToggleAnimationParams = {
  chatInputRef: RefObject<HTMLTextAreaElement | null>
  projectId: string | null
  shouldRenderTerminalLayout: boolean
  showTerminalPane: boolean
  terminalLayout: ProjectTerminalLayout
}

type UseTerminalToggleAnimationResult = {
  isAnimating: RefObject<boolean>
  mainPanelGroupRef: RefObject<GroupImperativeHandle | null>
  terminalFocusRequestVersion: number
  terminalPanelRef: RefObject<HTMLDivElement | null>
  terminalVisualRef: RefObject<HTMLDivElement | null>
}

type ResolveTerminalAnimationStateArgs = {
  previousProjectId: string | null
  projectId: string | null
  previousShouldRenderTerminalLayout: boolean
  previousShowTerminalPane: boolean
  showTerminalPane: boolean
  terminalLayout: ProjectTerminalLayout
  liveLayout: [number, number]
}

type ResolvedTerminalAnimationState = {
  currentLayout: [number, number]
  shouldSkipAnimation: boolean
  targetLayout: [number, number]
}

export function resolveTerminalAnimationState({
  previousProjectId,
  projectId,
  previousShouldRenderTerminalLayout,
  previousShowTerminalPane,
  showTerminalPane,
  terminalLayout,
  liveLayout,
}: ResolveTerminalAnimationStateArgs): ResolvedTerminalAnimationState {
  const didProjectChange = previousProjectId !== null && previousProjectId !== projectId
  const isInitialOpen = showTerminalPane && !previousShowTerminalPane
  const isInitialRender = !previousShouldRenderTerminalLayout
  const isInitialProjectRender = previousProjectId === null && projectId !== null
  const targetLayout: [number, number] = showTerminalPane ? terminalLayout.mainSizes : [100, 0]
  const currentLayout: [number, number] = isInitialOpen || isInitialRender ? [100, 0] : liveLayout

  return {
    currentLayout,
    shouldSkipAnimation: didProjectChange || (isInitialProjectRender && isInitialRender),
    targetLayout,
  }
}

export function useTerminalToggleAnimation({
  chatInputRef,
  projectId,
  shouldRenderTerminalLayout,
  showTerminalPane,
  terminalLayout,
}: UseTerminalToggleAnimationParams): UseTerminalToggleAnimationResult {
  const mainPanelGroupRef = useRef<GroupImperativeHandle | null>(null)
  const terminalPanelRef = useRef<HTMLDivElement | null>(null)
  const terminalVisualRef = useRef<HTMLDivElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const animationTimeoutRef = useRef<number | null>(null)
  const isAnimatingRef = useRef(false)
  const previousProjectIdRef = useRef<string | null>(null)
  const previousShouldRenderTerminalLayoutRef = useRef(false)
  const previousShowTerminalPaneRef = useRef(false)
  const previousFocusedTerminalVisibilityRef = useRef(false)
  const [terminalFocusRequestVersion, setTerminalFocusRequestVersion] = useState(0)

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current
    const didProjectChange = previousProjectId !== null && previousProjectId !== projectId
    const wasVisible = previousFocusedTerminalVisibilityRef.current

    if (!didProjectChange && showTerminalPane && !wasVisible) {
      setTerminalFocusRequestVersion((current) => current + 1)
    }

    if (!didProjectChange && !showTerminalPane && wasVisible) {
      chatInputRef.current?.focus({ preventScroll: true })
    }

    previousFocusedTerminalVisibilityRef.current = showTerminalPane
    previousProjectIdRef.current = projectId
  }, [chatInputRef, projectId, showTerminalPane])

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
    if (!shouldRenderTerminalLayout) {
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

    const group = mainPanelGroupRef.current
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
    const { currentLayout, shouldSkipAnimation, targetLayout } = resolveTerminalAnimationState({
      previousProjectId,
      projectId,
      previousShouldRenderTerminalLayout: previousShouldRenderTerminalLayoutRef.current,
      previousShowTerminalPane: previousShowTerminalPaneRef.current,
      showTerminalPane,
      terminalLayout,
      liveLayout: [
        group.getLayout().chat ?? terminalLayout.mainSizes[0],
        group.getLayout().terminal ?? terminalLayout.mainSizes[1],
      ],
    })

    previousShouldRenderTerminalLayoutRef.current = shouldRenderTerminalLayout
    previousShowTerminalPaneRef.current = showTerminalPane

    if (
      shouldSkipAnimation ||
      Math.abs(currentLayout[0] - targetLayout[0]) < 0.1 &&
      Math.abs(currentLayout[1] - targetLayout[1]) < 0.1
    ) {
      group.setLayout({ chat: targetLayout[0], terminal: targetLayout[1] })
      terminalPanelRef.current?.setAttribute("data-terminal-open", showTerminalPane ? "true" : "false")
      terminalVisualRef.current?.setAttribute("data-terminal-open", showTerminalPane ? "true" : "false")
      terminalVisualRef.current?.setAttribute("data-terminal-animated", "false")
      return
    }

    isAnimatingRef.current = true
    terminalPanelRef.current?.setAttribute("data-terminal-open", showTerminalPane ? "true" : "false")
    terminalVisualRef.current?.setAttribute("data-terminal-open", showTerminalPane ? "true" : "false")
    terminalVisualRef.current?.setAttribute("data-terminal-animated", "true")
    group.setLayout({ chat: currentLayout[0], terminal: currentLayout[1] })
    const startTime = performance.now()

    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / TERMINAL_TOGGLE_ANIMATION_DURATION_MS)
      const nextLayout = interpolateLayout(currentLayout, targetLayout, progress)
      group.setLayout({ chat: nextLayout[0], terminal: nextLayout[1] })

      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(step)
        return
      }

      group.setLayout({ chat: targetLayout[0], terminal: targetLayout[1] })
      animationFrameRef.current = null
      animationTimeoutRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false
        animationTimeoutRef.current = null
      }, 0)
    }

    animationFrameRef.current = window.requestAnimationFrame(step)
  }, [projectId, shouldRenderTerminalLayout, showTerminalPane, terminalLayout.mainSizes])

  useEffect(() => {
    if (shouldRenderTerminalLayout) return
    previousShouldRenderTerminalLayoutRef.current = false
    previousShowTerminalPaneRef.current = false
  }, [shouldRenderTerminalLayout])

  return {
    isAnimating: isAnimatingRef,
    mainPanelGroupRef,
    terminalFocusRequestVersion,
    terminalPanelRef,
    terminalVisualRef,
  }
}

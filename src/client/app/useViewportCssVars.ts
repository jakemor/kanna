import { useLayoutEffect } from "react"

function isStandaloneDisplayMode() {
  const isIOSStandalone = typeof navigator !== "undefined" && (navigator as any).standalone === true
  const isDisplayStandalone = typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches
  return isIOSStandalone || isDisplayStandalone
}

function readViewportMetrics() {
  const viewport = window.visualViewport
  const height = Math.round(viewport?.height ?? window.innerHeight)
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0))

  return {
    height,
    offsetTop,
  }
}

export function useViewportCssVars() {
  useLayoutEffect(() => {
    let frameId = 0
    let initialOffsetTop: number | null = null
    let maxViewportHeight = 0
    const standalone = isStandaloneDisplayMode()

    const applyViewportMetrics = () => {
      frameId = 0
      const { height, offsetTop } = readViewportMetrics()
      if (initialOffsetTop === null) {
        initialOffsetTop = offsetTop
      }
      if (height > maxViewportHeight) {
        maxViewportHeight = height
      }

      const offsetDelta = Math.max(0, offsetTop - initialOffsetTop)
      const keyboardOpen = maxViewportHeight - height > 120 || offsetDelta > 12
      const root = document.documentElement
      root.style.setProperty("--app-shell-height", `${height}px`)
      root.style.setProperty(
        "--app-shell-offset-top",
        standalone
          ? keyboardOpen
            ? `max(0px, calc(${offsetDelta}px - env(safe-area-inset-top)))`
            : "0px"
          : `${offsetDelta}px`
      )
      root.style.setProperty(
        "--app-composer-bottom-padding",
        standalone
          ? keyboardOpen ? "0px" : "max(12px, env(safe-area-inset-bottom))"
          : keyboardOpen ? "12px" : "20px"
      )
    }

    const scheduleViewportMetrics = () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId)
      }

      frameId = window.requestAnimationFrame(applyViewportMetrics)
    }

    scheduleViewportMetrics()

    const viewport = window.visualViewport
    window.addEventListener("resize", scheduleViewportMetrics)
    window.addEventListener("orientationchange", scheduleViewportMetrics)
    viewport?.addEventListener("resize", scheduleViewportMetrics)
    viewport?.addEventListener("scroll", scheduleViewportMetrics)

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId)
      }
      window.removeEventListener("resize", scheduleViewportMetrics)
      window.removeEventListener("orientationchange", scheduleViewportMetrics)
      viewport?.removeEventListener("resize", scheduleViewportMetrics)
      viewport?.removeEventListener("scroll", scheduleViewportMetrics)
    }
  }, [])
}

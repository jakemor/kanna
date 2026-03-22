import { useLayoutEffect } from "react"

function readViewportMetrics() {
  const viewport = window.visualViewport
  const height = Math.round(viewport?.height ?? window.innerHeight)

  return {
    height,
  }
}

export function useViewportCssVars() {
  useLayoutEffect(() => {
    let frameId = 0

    const applyViewportMetrics = () => {
      frameId = 0
      const { height } = readViewportMetrics()
      const root = document.documentElement
      root.style.setProperty("--app-shell-height", `${height}px`)
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

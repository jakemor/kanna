import { useEffect, useState } from "react"

const DESKTOP_QUERY = "(min-width: 768px)"

export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return false
    return window.matchMedia(DESKTOP_QUERY).matches
  })

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_QUERY)
    const handleChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches)
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  return isDesktop
}

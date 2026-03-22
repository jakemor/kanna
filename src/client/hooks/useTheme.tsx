import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type ThemePreference = "light" | "dark" | "system"

interface ThemeContextValue {
  theme: ThemePreference
  resolvedTheme: "light" | "dark"
  setTheme: (theme: ThemePreference) => void
}

const THEME_STORAGE_KEY = "lever-theme"
const MANIFEST_HREF_BY_THEME = {
  light: "/manifest.webmanifest",
  dark: "/manifest-dark.webmanifest",
} as const
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

const isValidTheme = (value: string | null): value is ThemePreference => {
  return value === "light" || value === "dark" || value === "system"
}

const getSystemTheme = (): "light" | "dark" => {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const applyThemeClass = (preference: ThemePreference) => {
  if (typeof document === "undefined") return
  const resolved = preference === "system" ? getSystemTheme() : preference
  document.documentElement.classList.toggle("dark", resolved === "dark")
}

const syncThemeMeta = (resolvedTheme: "light" | "dark") => {
  if (typeof document === "undefined") return

  document.documentElement.style.colorScheme = resolvedTheme

  const themeColorMeta = document.querySelector('meta[name="theme-color"]')
  if (themeColorMeta) {
    const backgroundColor = getComputedStyle(document.body).backgroundColor
    if (backgroundColor) {
      themeColorMeta.setAttribute("content", backgroundColor)
    }
  }

  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]#app-manifest')
  const nextManifestHref = MANIFEST_HREF_BY_THEME[resolvedTheme]
  if (manifestLink && manifestLink.getAttribute("href") !== nextManifestHref) {
    manifestLink.setAttribute("href", nextManifestHref)
  }
}

const getInitialTheme = (): ThemePreference => {
  if (typeof window === "undefined") return "system"
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isValidTheme(stored) ? stored : "system"
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(getInitialTheme)

  useEffect(() => {
    applyThemeClass(theme)
    syncThemeMeta(theme === "system" ? getSystemTheme() : theme)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    }
  }, [theme])

  useEffect(() => {
    if (theme !== "system") return
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      applyThemeClass("system")
      syncThemeMeta(getSystemTheme())
    }

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange)
      return () => mediaQuery.removeEventListener("change", handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [theme])

  const value = useMemo<ThemeContextValue>(() => {
    const resolvedTheme = theme === "system" ? getSystemTheme() : theme
    return { theme, resolvedTheme, setTheme }
  }, [theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}

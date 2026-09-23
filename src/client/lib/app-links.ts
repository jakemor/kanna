import { SETTINGS_SECTIONS } from "../app/settings/registry"

/** App routes must be recognized before absolute workspace file paths. */
export function parseAppLink(href: string | undefined, origin?: string): string | null {
  if (!href) return null
  let path = href
  if (/^https?:\/\//i.test(href)) {
    if (!origin) return null
    try {
      const url = new URL(href)
      if (url.origin !== new URL(origin).origin) return null
      path = `${url.pathname}${url.search}${url.hash}`
    } catch {
      return null
    }
  }
  const match = /^\/settings(?:\/([a-z-]+))?\/?(?:[?#].*)?$/.exec(path)
  if (!match) return null
  return !match[1] || SETTINGS_SECTIONS.some(section => section.id === match[1]) ? path : null
}

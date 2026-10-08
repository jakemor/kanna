/**
 * Path utilities for stripping workspace prefixes in display.
 * Supports both local paths (from localPath) and sandbox paths (/home/user/workspace).
 */

export interface ParsedLocalFileLink {
  path: string
  line?: number
  column?: number
}

const EDITOR_OPEN_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".diff", ".env", ".go", ".graphql", ".h",
  ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".log", ".lua",
  ".md", ".mjs", ".patch", ".php", ".pl", ".properties", ".py", ".rb", ".rs", ".scss", ".sh",
  ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zsh",
])

const EDITOR_OPEN_FILENAMES = new Set([
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "Dockerfile",
  "Gemfile",
  "Makefile",
  "Procfile",
])

interface ParsedFileTarget {
  path: string
  line?: number
  column?: number
}

function toPositiveInteger(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function decodeLocalFilePath(filePath: string) {
  // Keep separator and NUL escapes encoded while decoding the rest once.
  const pathWithProtectedEscapes = filePath.replace(/%(2f|5c|00)/gi, "%25$1")
  try {
    return decodeURIComponent(pathWithProtectedEscapes)
  } catch {
    return filePath
  }
}

function parseAbsoluteFileTarget(target: string): ParsedFileTarget | null {
  const hashMatch = /^(?<path>\/.+?)#L(?<line>\d+)(?:C(?<column>\d+))?$/.exec(target)
  if (hashMatch?.groups?.path) {
    return {
      path: decodeLocalFilePath(hashMatch.groups.path),
      line: toPositiveInteger(hashMatch.groups.line),
      column: toPositiveInteger(hashMatch.groups.column),
    }
  }

  const suffixMatch = /^(?<path>\/.+?):(?<line>\d+)(?::(?<column>\d+))?$/.exec(target)
  if (suffixMatch?.groups?.path) {
    return {
      path: decodeLocalFilePath(suffixMatch.groups.path),
      line: toPositiveInteger(suffixMatch.groups.line),
      column: toPositiveInteger(suffixMatch.groups.column),
    }
  }

  if (target.startsWith("/")) {
    return { path: decodeLocalFilePath(target) }
  }

  return null
}

export function parseLocalFileLink(target: string | undefined | null): ParsedLocalFileLink | null {
  if (!target) return null
  const trimmed = target.trim()
  if (!trimmed || /^(mailto:|ftp:|file:)/i.test(trimmed)) return null

  if (/^https?:/i.test(trimmed)) {
    if (typeof window === "undefined") {
      return null
    }
    try {
      const url = new URL(trimmed)
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/")) {
        return null
      }
      return parseAbsoluteFileTarget(`${url.pathname}${url.hash}`)
    } catch {
      return null
    }
  }

  return parseAbsoluteFileTarget(trimmed)
}

/**
 * Contract the home directory prefix to "~" for display.
 * e.g., "/Users/jake/Projects/my-app" → "~/Projects/my-app"
 * e.g., "/home/jake" → "/home/jake" (home root stays expanded — "~" is uninformative)
 */
export function formatPathWithTilde(path: string) {
  const homeMatch = path.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/)
  const homePrefix = homeMatch?.[0]
  // At the home root itself, "~" is uninformative — show the expanded path.
  if (homePrefix && path === homePrefix) return path
  if (homePrefix && path.startsWith(`${homePrefix}/`)) return `~/${path.slice(homePrefix.length + 1)}`
  return path
}

/**
 * Drop leading directories until the path fits in `maxLength` characters.
 * e.g., "~/Projects/clients/acme/apps/web" → "…/acme/apps/web"
 * The tail is what identifies a project, so it survives; a single segment
 * longer than the budget is returned whole rather than cut mid-word.
 * Used where the path lands in a box that cannot clip it, like a textarea
 * placeholder.
 */
export function abbreviatePathHead(path: string, maxLength: number) {
  if (path.length <= maxLength) return path
  const segments = path.split("/").filter((segment) => segment.length > 0)
  for (let start = 1; start < segments.length; start += 1) {
    const candidate = `…/${segments.slice(start).join("/")}`
    if (candidate.length <= maxLength) return candidate
  }
  return segments[segments.length - 1] ?? path
}

export function shouldOpenLocalFileLinkInEditor(filePath: string) {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  if (EDITOR_OPEN_FILENAMES.has(fileName)) return true
  const extensionIndex = fileName.lastIndexOf(".")
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ""
  return EDITOR_OPEN_EXTENSIONS.has(extension)
}


/**
 * Strip workspace prefix for display.
 * e.g., "/home/user/workspace/src/foo.ts" → "src/foo.ts"
 * e.g., "/Users/jake/Projects/my-app/src/foo.ts" → "src/foo.ts" (when localPath is set)
 */
export function stripWorkspacePath(path: string | undefined, localPath: string | undefined | null): string {
  if (!path) return ""
  // Try localPath first (with or without trailing slash)
  if (localPath) {
    const withSlash = localPath.endsWith("/") ? localPath : `${localPath}/`
    if (path.startsWith(withSlash)) return path.slice(withSlash.length)
    if (path === localPath) return ""
  }
  // Fallback to sandbox path
  return path.replace(/^\/home\/user\/workspace\//, "")
}

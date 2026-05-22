import { useEffect, useState } from "react"
import { useTheme } from "../../hooks/useTheme"

const SIZE_CEILING = 200 * 1024

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  rb: "ruby",
  ruby: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  json: "json",
  json5: "json5",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  cpp: "cpp",
  "c++": "cpp",
  c: "c",
  h: "c",
  swift: "swift",
  kt: "kotlin",
  kotlin: "kotlin",
  php: "php",
  toml: "toml",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
  vue: "vue",
  svelte: "svelte",
}

function resolveLang(lang: string): string | null {
  return LANG_MAP[lang.toLowerCase()] ?? null
}

const PRE_OPEN = /^<pre[^>]*>/
const PRE_CLOSE = /<\/pre>\s*$/
const CODE_OPEN = /^<code[^>]*>/
const CODE_CLOSE = /<\/code>\s*$/

function stripShikiWrappers(html: string): string {
  return html
    .replace(PRE_OPEN, "")
    .replace(PRE_CLOSE, "")
    .replace(CODE_OPEN, "")
    .replace(CODE_CLOSE, "")
}

interface HighlightedState {
  source: string
  theme: string
  lang: string
  html: string
}

export function HighlightedCode({ source, lang }: { source: string; lang: string }) {
  const { resolvedTheme } = useTheme()
  const shikiTheme = resolvedTheme === "dark" ? "github-dark" : "github-light"
  const resolvedLang = resolveLang(lang)
  const shouldHighlight = resolvedLang !== null && source.length <= SIZE_CEILING
  const [highlighted, setHighlighted] = useState<HighlightedState | null>(null)

  useEffect(() => {
    if (!shouldHighlight || resolvedLang === null) return
    let cancelled = false
    import("shiki")
      .then(async (mod) => {
        if (cancelled) return
        const html = await mod.codeToHtml(source, { lang: resolvedLang, theme: shikiTheme })
        if (cancelled) return
        setHighlighted({ source, theme: shikiTheme, lang: resolvedLang, html: stripShikiWrappers(html) })
      })
      .catch(() => {
        if (typeof console !== "undefined") console.warn("[transcript] Shiki unavailable; falling back to plain code")
      })
    return () => {
      cancelled = true
    }
  }, [shouldHighlight, source, resolvedLang, shikiTheme])

  const fallbackLang = resolvedLang ?? lang.toLowerCase()
  const isCurrent =
    highlighted !== null &&
    highlighted.source === source &&
    highlighted.theme === shikiTheme &&
    highlighted.lang === resolvedLang

  if (isCurrent) {
    return (
      <code
        className={`block text-xs whitespace-pre language-${fallbackLang} shiki-highlighted`}
        dangerouslySetInnerHTML={{ __html: highlighted.html }}
      />
    )
  }
  return <code className={`block text-xs whitespace-pre language-${fallbackLang}`}>{source}</code>
}

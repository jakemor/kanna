import { File as CodeFile, type FileOptions } from "@pierre/diffs/react"
import { Code, FileCode, FileDiff, WrapText } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "../../hooks/useTheme"
import { openViewer } from "../../stores/viewerStore"
import { OpenFileSelect } from "../open-external-menu"
import { fetchTextPreview, TEXT_PREVIEW_LIMIT_BYTES } from "../messages/attachmentPreview"
import { Skeleton } from "../ui/skeleton"
import type { DiffViewerContext } from "../chat-ui/git/DiffViewer"
import { splitDiffPath } from "../chat-ui/git/shared"
import { hasRenderedView, RenderedFilePreview } from "./AttachmentViewer"
import { ViewerIconButton, ViewerPanes, ViewerSurface, ViewerToggle } from "./ViewerSurface"

type FileTextState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; contents: string; truncated: boolean }

/** Reads the file's text. */
function useFileText(url: string): FileTextState {
  const [state, setState] = useState<FileTextState>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })
    fetchTextPreview(url, TEXT_PREVIEW_LIMIT_BYTES)
      .then(({ content, truncated }) => {
        if (!cancelled) setState({ status: "ready", contents: content, truncated })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [url])
  return state
}

/**
 * A project file, as it reads on disk: what a file link in the chat opens,
 * rather than switching to the editor. Code is highlighted, and a link to a
 * line lands on that line, marked. Markdown and CSV open as their preview
 * (a link to a line opens the text, where the line is). The editor, and the
 * file's diff when it has changes, are a button away.
 */
export function FileViewer({
  projectId,
  path,
  line,
  context,
  onClose,
}: {
  projectId: string
  /** Relative to the project. */
  path: string
  line?: number
  context: DiffViewerContext
  onClose: () => void
}) {
  const { name, folder } = splitDiffPath(path)
  const changed = context.files.find((file) => file.path === path)
  // A changed file's digest rides along, so the agent's next edit reads
  // again rather than a cached copy (the server only looks at the path).
  const url = `/api/projects/${projectId}/files/${encodeURIComponent(path)}/content${changed ? `?v=${encodeURIComponent(changed.patchDigest)}` : ""}`
  const attachment = useMemo(() => ({ url, name, mimeType: "text/plain", size: null }), [name, url])
  const renderable = hasRenderedView(attachment)
  const [view, setView] = useState<"preview" | "original">(renderable && line === undefined ? "preview" : "original")
  const showPreview = renderable && view === "preview"

  const subtitle = [folder, line !== undefined ? `line ${line}` : null].filter(Boolean).join(" · ")
  const openInEditor = () => context.onOpenFile(path, { line })

  return (
    <ViewerSurface
      label={`View ${path}`}
      icon={<FileCode />}
      title={name}
      // RTL so a long folder loses its start, not its end; <bdi> keeps the
      // path reading left to right.
      subtitle={subtitle ? <span className="block truncate text-left [direction:rtl]"><bdi>{subtitle}</bdi></span> : undefined}
      onClose={onClose}
      center={renderable ? (
        <ViewerToggle
          value={view}
          onChange={setView}
          options={[{ value: "preview", label: "Preview" }, { value: "original", label: "Original" }]}
        />
      ) : undefined}
      toolbar={(
        <>
          {changed ? (
            <ViewerIconButton label="Show changes" onClick={() => openViewer({ kind: "diff", projectId, path })}><FileDiff /></ViewerIconButton>
          ) : null}
          {showPreview ? null : (
            <ViewerIconButton label={context.wrapLines ? "Disable word wrap" : "Enable word wrap"} active={context.wrapLines} onClick={() => context.onWrapLinesChange(!context.wrapLines)}><WrapText /></ViewerIconButton>
          )}
          <OpenFileSelect isMac={context.isMac} onOpenExternal={(action, editor) => context.onOpenFile(path, { line, action, editor })} />
        </>
      )}
    >
      {renderable ? (
        <ViewerPanes
          value={view}
          panes={{
            preview: () => <RenderedFilePreview attachment={attachment} fill />,
            original: () => <FileText url={url} name={name} line={line} wrap={context.wrapLines} editorLabel={context.editorLabel} onOpenInEditor={openInEditor} />,
          }}
        />
      ) : (
        <FileText url={url} name={name} line={line} wrap={context.wrapLines} editorLabel={context.editorLabel} onOpenInEditor={openInEditor} />
      )}
    </ViewerSurface>
  )
}

/** The file's text, read when it's first shown: a CSV opened as its table may never need it. */
function FileText({ url, name, line, wrap, editorLabel, onOpenInEditor }: {
  url: string
  name: string
  line?: number
  wrap: boolean
  editorLabel: string
  onOpenInEditor: () => void
}) {
  const text = useFileText(url)
  if (text.status === "loading") return <CodeSkeleton />
  if (text.status === "error") {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">Couldn't read this file.</p>
        <button
          type="button"
          onClick={onOpenInEditor}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          <Code className="size-3.5" /> Open in {editorLabel}
        </button>
      </div>
    )
  }
  if (text.contents.length === 0) {
    return <div className="flex min-h-full items-center justify-center p-6 text-sm text-muted-foreground">Empty file.</div>
  }
  return <CodeView name={name} contents={text.contents} line={line} wrap={wrap} />
}

// Uneven widths, indented like code.
const SKELETON_CODE_LINES = [
  { indent: 0, width: "34%" },
  { indent: 1, width: "58%" },
  { indent: 1, width: "46%" },
  { indent: 2, width: "63%" },
  { indent: 2, width: "40%" },
  { indent: 1, width: "28%" },
  { indent: 0, width: "18%" },
]

function CodeSkeleton() {
  return (
    <div className="space-y-2 px-4 py-4" aria-busy aria-label="Loading file">
      {SKELETON_CODE_LINES.map((entry, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3 w-5 shrink-0 bg-foreground/[0.05]" />
          <Skeleton className="h-3" style={{ marginLeft: `${entry.indent * 12}px`, width: entry.width }} />
        </div>
      ))}
    </div>
  )
}

/** How long to wait for the highlighted file to draw the line before giving up on the jump. */
const LINE_JUMP_TIMEOUT_MS = 3_000

/**
 * The file, highlighted, with the linked line marked and scrolled to the
 * middle of the view. The renderer draws into its own shadow root, a frame
 * or more after mounting, so the jump waits for the line to exist.
 */
function CodeView({ name, contents, line, wrap }: { name: string; contents: string; line?: number; wrap: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const file = useMemo(() => ({ name, contents }), [contents, name])
  const selectedLines = useMemo(() => (line === undefined ? null : { start: line, end: line }), [line])
  // The app's theme, not the system's (the renderer's default): a light app
  // on a dark Mac drew light text on its light background.
  const { resolvedTheme } = useTheme()
  const options = useMemo<FileOptions<undefined>>(() => ({
    disableFileHeader: true,
    overflow: wrap ? "wrap" : "scroll",
    themeType: resolvedTheme,
  }), [resolvedTheme, wrap])

  useEffect(() => {
    if (line === undefined) return
    const started = performance.now()
    let frame = requestAnimationFrame(function find() {
      const hosts = containerRef.current?.querySelectorAll("*") ?? []
      for (const host of hosts) {
        const target = host.shadowRoot?.querySelector(`[data-line="${line}"]`)
        if (target) {
          target.scrollIntoView({ block: "center" })
          return
        }
      }
      if (performance.now() - started < LINE_JUMP_TIMEOUT_MS) frame = requestAnimationFrame(find)
    })
    return () => cancelAnimationFrame(frame)
  }, [contents, line])

  return (
    <div ref={containerRef} className="kanna-diff-patch">
      <CodeFile file={file} selectedLines={selectedLines} options={options} />
    </div>
  )
}

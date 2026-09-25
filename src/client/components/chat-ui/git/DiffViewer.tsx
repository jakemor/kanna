import { ChevronDown, Columns2, FileDiff, FoldVertical, Rows3, UnfoldVertical, WrapText } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { EditorOpenSettings, OpenExternalAction } from "../../../../shared/protocol"
import { DIFF_REVIEW_STORAGE_KEY_PREFIX } from "../../../lib/storageKeys"
import { cn } from "../../../lib/utils"
import { OpenFileSelect } from "../../open-external-menu"
import { isDiffPathChecked, useDiffCommitStore } from "../../../stores/diffCommitStore"
import { useRightSidebarStore } from "../../../stores/rightSidebarStore"
import { useViewerStore, type ViewerAttachment } from "../../../stores/viewerStore"
import { hasRenderedView, RenderedFilePreview } from "../../viewer/AttachmentViewer"
import { ViewerDivider, ViewerIconButton, ViewerSurface, ViewerToggle } from "../../viewer/ViewerSurface"
import { DiffPatchSkeleton, DiffPatchView } from "./DiffPatchView"
import { diffHold, DiffFileStat, diffStatus, getDiffPreviewAttachment, sortByPath, splitDiffPath, type DiffFile, type DiffRenderMode } from "./shared"

interface PatchEntry {
  /** The file's patch digest when this was read: a new digest means read again. */
  digest: string
  patch?: string
  error?: string
  loading: boolean
}

/** Files the list holds before "Load more": a long change set opens at once and scrolls smoothly. */
export const DIFF_VIEWER_PAGE_SIZE = 25
/** A diff line's height, for holding a file's place before it's drawn. */
const ESTIMATED_LINE_HEIGHT = 20
/** How far outside the view a file starts loading and drawing, so scrolling lands on diffs, not skeletons. */
const DRAW_AHEAD = "1200px 0px"

/** What the viewer needs from the page to show diffs: the files, and how to read and open them. */
export interface DiffViewerContext {
  /** The project these files belong to: a diff opened in another shows nothing. */
  projectId: string
  files: DiffFile[]
  /**
   * Whether `files` is the working tree's, not the empty list a page starts
   * with before the first snapshot. A reload mounts the viewer before then,
   * and an empty list that isn't real mustn't close it. Absent means ready.
   */
  filesReady?: boolean
  editorLabel: string
  diffRenderMode: DiffRenderMode
  wrapLines: boolean
  onDiffRenderModeChange: (mode: DiffRenderMode) => void
  onWrapLinesChange: (wrap: boolean) => void
  /** fullContext: the whole file around the changes ("Show full file"). */
  onLoadPatch: (path: string, options?: { fullContext?: boolean }) => Promise<string>
  /**
   * Opens a project file outside Kanna: in the editor by default, at a line
   * when there is one, or wherever the viewer's "Open in…" menu names.
   */
  onOpenFile: (path: string, options?: { line?: number; action?: OpenExternalAction; editor?: EditorOpenSettings }) => void
  /** Which apps the "Open in…" menu can name (Xcode, Finder vs Folder). */
  isMac: boolean
}

/**
 * A changed file as it reads now, from the working tree. The digest rides
 * along in the address so an edit reads the file again rather than a cached
 * copy (the server only looks at the path).
 */
function workingTreeAttachment(projectId: string, file: DiffFile): ViewerAttachment {
  return {
    url: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content?v=${encodeURIComponent(file.patchDigest)}`,
    name: splitDiffPath(file.path).name,
    mimeType: file.mimeType ?? "text/plain",
    size: file.size ?? null,
  }
}

/**
 * What a file shows instead of its diff until you ask (diffHold, GitHub's
 * precautions), or null once it's drawn as usual. An image or PDF shows as
 * itself, so it's never held; a held file that can load stops being held
 * once you click "Load diff".
 */
function heldBack(projectId: string, file: DiffFile, loaded: ReadonlySet<string>) {
  if (getDiffPreviewAttachment(projectId, file)) return null
  const hold = diffHold(file)
  if (!hold || (hold.loadable && loaded.has(file.path))) return null
  return hold
}

/**
 * The files the viewer lists: the ones checked for the commit, in the
 * Changes card's order (tree order), plus the one you opened if it isn't
 * checked (you asked to see it).
 */
export function reviewFiles(files: readonly DiffFile[], isChecked: (path: string) => boolean, openedPath: string) {
  return files.filter((file) => isChecked(file.path) || file.path === openedPath)
}

/** How many files to hold: whole pages, enough to reach the one asked for. */
export function pageLimit(limit: number, index: number) {
  if (index < limit) return limit
  return Math.ceil((index + 1) / DIFF_VIEWER_PAGE_SIZE) * DIFF_VIEWER_PAGE_SIZE
}

/** Where a file's patch is kept: the three-line diff and the full file are read and kept apart. */
function patchKey(path: string, full: boolean) {
  return full ? `${path}\u0000full` : path
}

/**
 * Whether "Show full file" has anything to add: a changed file whose diff
 * leaves some of it out. An added or deleted file's diff already is the
 * whole file.
 */
function canShowFullFile(file: DiffFile) {
  return (file.changeType === "modified" || file.changeType === "renamed") && file.additions + file.deletions > 0
}

/**
 * Where the list was, for a reload to come back to: the file at the top, how
 * far into it, and each file's own state. The chat's viewer names the file;
 * this holds the rest. Per tab (sessionStorage), and gone once the viewer closes.
 */
interface ReviewState {
  path: string
  offset: number
  collapsed: string[]
  previewing: string[]
  full: string[]
  loaded: string[]
}

function readReviewState(projectId: string): ReviewState | null {
  try {
    const raw = sessionStorage.getItem(`${DIFF_REVIEW_STORAGE_KEY_PREFIX}${projectId}`)
    return raw ? JSON.parse(raw) as ReviewState : null
  } catch {
    return null
  }
}

function writeReviewState(projectId: string, state: ReviewState) {
  try {
    sessionStorage.setItem(`${DIFF_REVIEW_STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(state))
  } catch {
    // Storage full or off: a reload starts at the file's top instead.
  }
}

function clearReviewState(projectId: string) {
  try {
    sessionStorage.removeItem(`${DIFF_REVIEW_STORAGE_KEY_PREFIX}${projectId}`)
  } catch {
    // Nothing to clear.
  }
}

/** How long a restored position is held while the files around it draw, unless you scroll first. */
const RESTORE_HOLD_MS = 4_000

function toggled(set: ReadonlySet<string>, key: string) {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * The change set in the viewer, as on GitHub's "Files changed": every file
 * checked for the commit, one after another in one scroll, each as tall as
 * its diff. A file's header sticks while you're in it; the viewer's header
 * counts which file that is, and j/k jump between them.
 *
 * Built to stay quick on a large change: a page of files at a time, and a
 * file's patch is read and drawn only once it comes near the view (until
 * then it holds its place at about its size). Binaries, deleted, generated
 * and very large files wait, as on GitHub (diffHold).
 */
export function DiffViewer({
  projectId,
  path,
  openCount = 0,
  context,
  onClose,
}: {
  projectId: string
  /** The file that was opened: the list starts scrolled to it. */
  path: string
  /** Changes with every open, so opening the same file again jumps back to it. */
  openCount?: number
  context: DiffViewerContext
  onClose: () => void
}) {
  const selection = useDiffCommitStore((store) => store.selectionsByProjectId[projectId])
  const files = useMemo(
    () => reviewFiles(sortByPath(context.files), (candidate) => isDiffPathChecked(selection, candidate), path),
    [context.files, path, selection],
  )
  const openedIndex = files.findIndex((file) => file.path === path)
  const [limit, setLimit] = useState(DIFF_VIEWER_PAGE_SIZE)
  const shownCount = Math.min(files.length, pageLimit(limit, openedIndex))
  const shown = useMemo(() => files.slice(0, shownCount), [files, shownCount])

  // A reload, or coming back from another chat, opens on the file the list
  // was scrolled to; when this tab left the list there, it comes back to the
  // same spot in it, each file as it was.
  const [restored] = useState(() => {
    const state = readReviewState(projectId)
    return state && state.path === path ? state : null
  })
  const [patches, setPatches] = useState<Record<string, PatchEntry>>({})
  // Files that have come near the view: read and drawn from then on.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(restored?.collapsed))
  const [previewing, setPreviewing] = useState<ReadonlySet<string>>(() => new Set(restored?.previewing))
  // Held-back files you asked to see anyway ("Load diff").
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set(restored?.loaded))
  // Files shown whole, their changes in place ("Show full file").
  const [fullFiles, setFullFiles] = useState<ReadonlySet<string>>(() => new Set(restored?.full))
  const [activeIndex, setActiveIndex] = useState(Math.max(0, openedIndex))
  // Bumped by each jump, so one renders (and scrolls) even when nothing else changed.
  const [, setJumpCount] = useState(0)

  const listRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const pendingScrollRef = useRef<string | null>(path)
  // Where the last jump left the scroll, and to which file: a file too near
  // the end to reach the top still counts as the one you jumped to.
  const lastJumpRef = useRef<{ index: number; top: number } | null>(null)
  // The spot a reload comes back to, held until you scroll or jump.
  const restoreRef = useRef(restored ? { path: restored.path, offset: restored.offset } : null)
  const firstOpenCountRef = useRef(openCount)
  const shownRef = useRef(shown)
  shownRef.current = shown
  // How far into the file at the top the list is, kept as you scroll.
  const offsetRef = useRef(restored?.offset ?? 0)

  // Everything was committed or unchecked: nothing left to review. Not
  // before the files have arrived, though: that's a reload, still loading.
  const filesReady = context.filesReady !== false
  useEffect(() => {
    if (filesReady && files.length === 0) onClose()
  }, [files.length, filesReady, onClose])

  const { onLoadPatch } = context
  const load = useCallback((target: DiffFile, full: boolean) => {
    const key = patchKey(target.path, full)
    setPatches((current) => ({ ...current, [key]: { digest: target.patchDigest, loading: true } }))
    onLoadPatch(target.path, full ? { fullContext: true } : undefined)
      .then((patch) => setPatches((current) => (
        current[key]?.digest === target.patchDigest
          ? { ...current, [key]: { digest: target.patchDigest, patch, loading: false } }
          : current
      )))
      .catch((error: unknown) => setPatches((current) => (
        current[key]?.digest === target.patchDigest
          ? { ...current, [key]: { digest: target.patchDigest, error: error instanceof Error ? error.message : String(error), loading: false } }
          : current
      )))
  }, [onLoadPatch])

  // Read the patches the view needs: files that have come near it, open and
  // showing their diff. A changed digest (the agent kept editing) reads again.
  useEffect(() => {
    for (const file of shown) {
      if (!seen.has(file.path) || collapsed.has(file.path) || previewing.has(file.path)) continue
      if (heldBack(projectId, file, loaded)) continue
      const full = fullFiles.has(file.path)
      const entry = patches[patchKey(file.path, full)]
      if (!entry || entry.digest !== file.patchDigest) load(file, full)
    }
  }, [collapsed, fullFiles, load, loaded, patches, previewing, projectId, seen, shown])

  // A file is drawn once it comes within DRAW_AHEAD of the view, and stays.
  useEffect(() => {
    const scroller = listRef.current?.parentElement
    if (!scroller || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => {
      const arrived = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => (entry.target as HTMLElement).dataset.path)
        .filter((value): value is string => Boolean(value))
      if (arrived.length === 0) return
      setSeen((current) => {
        if (arrived.every((value) => current.has(value))) return current
        const next = new Set(current)
        for (const value of arrived) next.add(value)
        return next
      })
    }, { root: scroller, rootMargin: DRAW_AHEAD })
    for (const section of sectionRefs.current.values()) observer.observe(section)
    return () => observer.disconnect()
  }, [shown])

  // Which file you're in: the last whose top has reached the top of the view.
  useEffect(() => {
    const scroller = listRef.current?.parentElement
    if (!scroller) return
    let frame = 0
    function update() {
      frame = 0
      if (!scroller) return
      const top = scroller.scrollTop
      const jump = lastJumpRef.current
      if (jump && Math.abs(jump.top - top) < 2) {
        setActiveIndex(jump.index)
        return
      }
      lastJumpRef.current = null
      let index = 0
      for (const [position, file] of shown.entries()) {
        const section = sectionRefs.current.get(file.path)
        if (!section || section.offsetTop > top + 1) break
        index = position
      }
      const section = sectionRefs.current.get(shown[index]?.path ?? "")
      offsetRef.current = section ? Math.max(0, Math.round(top - section.offsetTop)) : 0
      setActiveIndex(index)
      scheduleSave()
    }
    function handleScroll() {
      if (!frame) frame = requestAnimationFrame(update)
    }
    scroller.addEventListener("scroll", handleScroll, { passive: true })
    return () => {
      scroller.removeEventListener("scroll", handleScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [shown])

  // Opening a file (here, or another row in the Changes card while this is
  // open) scrolls to it.
  useLayoutEffect(() => {
    pendingScrollRef.current = path
    // Opening a file (not the reload that restored this) goes to its top.
    if (openCount !== firstOpenCountRef.current) restoreRef.current = null
  }, [openCount, path])

  // The file you're in, for the Changes card to light: scrolling here moves
  // the card's highlight, as clicking there moves this.
  const setScrolledDiffPath = useViewerStore((store) => store.setScrolledDiffPath)
  const activePath = shown[Math.min(activeIndex, shown.length - 1)]?.path ?? null
  useEffect(() => {
    setScrolledDiffPath(activePath)
  }, [activePath, setScrolledDiffPath])

  // A jump waits for its file to be in the list (a jump past the loaded page
  // loads more first), then scrolls with no animation: it's a keypress or a
  // click, and you want to be there.
  useLayoutEffect(() => {
    const target = pendingScrollRef.current
    const scroller = listRef.current?.parentElement
    const section = target ? sectionRefs.current.get(target) : undefined
    if (!target || !scroller || !section) return
    pendingScrollRef.current = null
    const index = shown.findIndex((file) => file.path === target)
    const restore = restoreRef.current?.path === target ? restoreRef.current : null
    scroller.scrollTop = section.offsetTop + (restore?.offset ?? 0)
    offsetRef.current = restore?.offset ?? 0
    lastJumpRef.current = { index, top: scroller.scrollTop }
    setActiveIndex(index)
    // Now, not a render later: the card's highlight lands with the jump.
    useViewerStore.getState().setScrolledDiffPath(target)
  })

  const jumpTo = useCallback((index: number) => {
    const clamped = Math.min(files.length - 1, Math.max(0, index))
    const target = files[clamped]
    if (!target) return
    pendingScrollRef.current = target.path
    restoreRef.current = null
    setLimit((current) => pageLimit(current, clamped))
    setJumpCount((count) => count + 1)
  }, [files])

  const hasFiles = files.length > 0
  // A restored spot is held while the files draw (a patch arriving, a file
  // above growing from its placeholder to its diff), since each would push
  // it. The first sign of you moving (wheel, touch, a key, a click) lets go.
  useEffect(() => {
    const scroller = listRef.current?.parentElement
    const list = listRef.current
    if (!restoreRef.current || !scroller || !list) return
    function apply() {
      const restore = restoreRef.current
      const section = restore ? sectionRefs.current.get(restore.path) : undefined
      if (!restore || !scroller || !section) return
      scroller.scrollTop = section.offsetTop + restore.offset
      offsetRef.current = restore.offset
      lastJumpRef.current = { index: shownRef.current.findIndex((file) => file.path === restore.path), top: scroller.scrollTop }
    }
    function release() {
      restoreRef.current = null
      cleanup()
    }
    const observer = new ResizeObserver(apply)
    observer.observe(list)
    const timer = window.setTimeout(release, RESTORE_HOLD_MS)
    const scrollerEvents = ["wheel", "touchstart", "pointerdown"] as const
    for (const type of scrollerEvents) scroller.addEventListener(type, release, { passive: true })
    window.addEventListener("keydown", release, true)
    function cleanup() {
      observer.disconnect()
      window.clearTimeout(timer)
      for (const type of scrollerEvents) scroller?.removeEventListener(type, release)
      window.removeEventListener("keydown", release, true)
    }
    return cleanup
    // Once the list is there to hold: a reload renders it only when the
    // files arrive.
  }, [hasFiles])

  // Saving where the list is, a moment after it settles.
  const saveRef = useRef<() => void>(() => {})
  saveRef.current = () => {
    const current = shown[Math.min(activeIndex, shown.length - 1)]
    if (!current) return
    writeReviewState(projectId, {
      path: current.path,
      offset: offsetRef.current,
      collapsed: [...collapsed],
      previewing: [...previewing],
      full: [...fullFiles],
      loaded: [...loaded],
    })
  }
  const saveTimerRef = useRef(0)
  function scheduleSave() {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => saveRef.current(), 150)
  }
  useEffect(() => {
    saveRef.current()
  }, [activeIndex, collapsed, fullFiles, loaded, previewing])
  // Closing the viewer is done with this review: the next open starts fresh.
  // Going to another chat isn't: a chat still reviewing this project comes
  // back to it here. (A reload never gets here; it doesn't unmount.)
  useEffect(() => () => {
    window.clearTimeout(saveTimerRef.current)
    const stillReviewing = Object.values(useRightSidebarStore.getState().chatViewers)
      .some((viewer) => viewer.item.kind === "diff" && viewer.item.projectId === projectId)
    if (!stillReviewing) clearReviewState(projectId)
  }, [projectId])

  const totals = useMemo(() => files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  ), [files])

  if (files.length === 0) {
    // A reload, before the working tree's files arrive: the frame, loading.
    return filesReady ? null : (
      <ViewerSurface label="Review changes" icon={<FileDiff />} title="Changes" onClose={onClose}>
        <DiffPatchSkeleton />
      </ViewerSurface>
    )
  }
  const remaining = files.length - shownCount

  return (
    <ViewerSurface
      label="Review changes"
      icon={<FileDiff />}
      title="Changes"
      subtitle={`${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}`}
      navigation={{
        index: Math.min(activeIndex, files.length - 1),
        count: files.length,
        onPrevious: () => jumpTo(activeIndex - 1),
        onNext: () => jumpTo(activeIndex + 1),
      }}
      onClose={onClose}
      toolbar={(
        <>
          <DiffFileStat additions={totals.additions} deletions={totals.deletions} className="px-1" />
          <ViewerDivider />
          <ViewerIconButton label="Unified diff" active={context.diffRenderMode === "unified"} onClick={() => context.onDiffRenderModeChange("unified")}><Rows3 /></ViewerIconButton>
          <ViewerIconButton label="Side-by-side diff" active={context.diffRenderMode === "split"} onClick={() => context.onDiffRenderModeChange("split")}><Columns2 /></ViewerIconButton>
          <ViewerIconButton label={context.wrapLines ? "Disable word wrap" : "Enable word wrap"} active={context.wrapLines} onClick={() => context.onWrapLinesChange(!context.wrapLines)}><WrapText /></ViewerIconButton>
        </>
      )}
    >
      {/* relative: each file's offsetTop is then its place in the scroll. */}
      <div ref={listRef} className="relative">
        {shown.map((file) => {
          const full = fullFiles.has(file.path)
          const entry = patches[patchKey(file.path, full)]
          const isCurrent = entry?.digest === file.patchDigest
          return (
            <DiffFileSection
              key={file.path}
              sectionRef={(element) => {
                if (element) sectionRefs.current.set(file.path, element)
                else sectionRefs.current.delete(file.path)
              }}
              projectId={projectId}
              file={file}
              context={context}
              drawn={seen.has(file.path)}
              collapsed={collapsed.has(file.path)}
              previewing={previewing.has(file.path)}
              hold={heldBack(projectId, file, loaded)}
              full={full}
              patch={isCurrent ? entry?.patch : undefined}
              patchError={isCurrent ? entry?.error : undefined}
              isLoading={!isCurrent || Boolean(entry?.loading)}
              onToggleCollapsed={() => setCollapsed((current) => toggled(current, file.path))}
              onTogglePreview={() => setPreviewing((current) => toggled(current, file.path))}
              onLoadHeld={() => setLoaded((current) => toggled(current, file.path))}
              onToggleFull={() => setFullFiles((current) => toggled(current, file.path))}
              onRetry={() => load(file, full)}
            />
          )
        })}
        {remaining > 0 ? (
          <div className="flex justify-center px-4 py-6">
            <button
              type="button"
              onClick={() => setLimit(shownCount + DIFF_VIEWER_PAGE_SIZE)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-[background-color,scale] duration-150 ease-snappy hover:bg-muted active:scale-[0.97]"
            >
              Load {Math.min(DIFF_VIEWER_PAGE_SIZE, remaining).toLocaleString()} more
              {remaining > DIFF_VIEWER_PAGE_SIZE ? <span className="text-muted-foreground">· {remaining.toLocaleString()} left</span> : null}
            </button>
          </div>
        ) : null}
      </div>
    </ViewerSurface>
  )
}

/** One file in the list: a header that sticks while you're in it, then its diff (or preview). */
function DiffFileSection({
  sectionRef,
  projectId,
  file,
  context,
  drawn,
  collapsed,
  previewing,
  hold,
  full,
  patch,
  patchError,
  isLoading,
  onToggleCollapsed,
  onTogglePreview,
  onLoadHeld,
  onToggleFull,
  onRetry,
}: {
  sectionRef: (element: HTMLElement | null) => void
  projectId: string
  file: DiffFile
  context: DiffViewerContext
  drawn: boolean
  collapsed: boolean
  previewing: boolean
  hold: { message: string; loadable: boolean } | null
  full: boolean
  patch?: string
  patchError?: string
  isLoading: boolean
  onToggleCollapsed: () => void
  onTogglePreview: () => void
  onLoadHeld: () => void
  onToggleFull: () => void
  onRetry: () => void
}) {
  const status = diffStatus(file)
  const { name, folder } = splitDiffPath(file.path)
  const attachment = useMemo(() => workingTreeAttachment(projectId, file), [file, projectId])
  // A deleted file has nothing left in the working tree to render.
  const previewable = file.changeType !== "deleted" && hasRenderedView(attachment)
  const changedLines = file.additions + file.deletions
  // Only while there's a text diff on screen to widen: not a preview, a held
  // file, or an image shown as itself.
  const fullToggle = canShowFullFile(file) && !collapsed && !(previewable && previewing) && !hold
    && !getDiffPreviewAttachment(projectId, file)

  let body: ReactNode = null
  if (collapsed) {
    body = null
  } else if (!drawn) {
    // Holds the file's place at about its size, so the scrollbar and the
    // files below don't jump when it's drawn.
    const lines = hold ? 3 : changedLines + 8
    body = <div aria-hidden style={{ height: Math.max(80, lines * ESTIMATED_LINE_HEIGHT) }} />
  } else if (previewable && previewing) {
    body = <RenderedFilePreview attachment={attachment} />
  } else if (hold) {
    body = (
      <div className="flex items-center justify-center gap-3 px-4 py-6 text-sm text-muted-foreground">
        <span>{hold.message}</span>
        {hold.loadable ? (
          <button
            type="button"
            onClick={onLoadHeld}
            className="rounded-lg border border-border px-3 py-1.5 text-foreground transition-[background-color,scale] duration-150 ease-snappy hover:bg-muted active:scale-[0.97]"
          >
            Load diff
          </button>
        ) : null}
      </div>
    )
  } else {
    body = (
      <DiffPatchView
        projectId={projectId}
        file={file}
        patch={patch}
        patchError={patchError}
        isLoading={isLoading}
        diffRenderMode={context.diffRenderMode}
        wrapLines={context.wrapLines}
        onRetry={onRetry}
      />
    )
  }

  return (
    <section ref={sectionRef} data-path={file.path} aria-label={file.path} className="border-b border-border">
      {/* Sticks to the top of the view while you're in this file, and goes
          up with it when the next file's header arrives. */}
      <header
        className={cn(
          "sticky top-0 z-10 h-10 items-center gap-2 bg-background px-2 dark:bg-card",
          !collapsed && "border-b border-border",
          // With Diff / Preview, three columns with equal sides, as the
          // viewer's own header: the switch sits dead centre on the file
          // whatever the name or the buttons weigh. Without it, a plain row,
          // so the name gets the width.
          previewable ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "flex",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-2", !previewable && "flex-1")}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={cn("size-4 transition-transform duration-150 ease-snappy", collapsed && "-rotate-90")} />
          </button>
          <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", status.className)} title={status.label}>{status.letter}</span>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 max-w-[60%] shrink-0 truncate text-sm font-medium text-foreground">{name}</span>
            {/* RTL so a long folder loses its start, not its end; <bdi> keeps
                the path reading left to right. */}
            {folder ? <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground [direction:rtl]"><bdi>{folder}</bdi></span> : null}
          </div>
        </div>
        {previewable ? (
          <div className="flex items-center">
            <ViewerToggle
              value={previewing ? "preview" : "diff"}
              onChange={(value) => {
                if ((value === "preview") !== previewing) onTogglePreview()
              }}
              options={[{ value: "diff", label: "Diff" }, { value: "preview", label: "Preview" }]}
            />
          </div>
        ) : null}
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
          {/* A binary has no lines to count; GitHub's BIN says so where they'd be. */}
          {file.binary
            ? <span className="px-1 font-mono text-xs text-muted-foreground">BIN</span>
            : <DiffFileStat additions={file.additions} deletions={file.deletions} className="px-1" />}
          {fullToggle ? (
            <ViewerIconButton label={full ? "Hide full file" : "Show full file"} active={full} onClick={onToggleFull}>
              {full ? <FoldVertical /> : <UnfoldVertical />}
            </ViewerIconButton>
          ) : null}
          <OpenFileSelect isMac={context.isMac} onOpenExternal={(action, editor) => context.onOpenFile(file.path, { action, editor })} />
        </div>
      </header>
      {body}
    </section>
  )
}

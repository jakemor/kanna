import { ArrowLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, File, FileArchive, FileText, Folder, FolderOpen, Link2, Lock } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { zipListingUrl, type ZipListing } from "../../../shared/zip-preview"
import { cn } from "../../lib/utils"
import type { ViewerAttachment } from "../../stores/viewerStore"
import { formatAttachmentSize } from "../messages/AttachmentCard"
import { TEXT_PREVIEW_LIMIT_BYTES } from "../messages/attachmentPreview"
import { Skeleton } from "../ui/skeleton"
import { downloadAttachment } from "./attachmentActions"
import { RenderedFilePreview } from "./AttachmentViewer"
import { ViewerIconButton, ViewerPanes, ViewerSurface } from "./ViewerSurface"
import {
  allZipFolders,
  buildZipTree,
  initialExpandedFolders,
  opensInZipViewer,
  visibleZipRows,
  zipEntryAttachment,
  type ZipTreeFolder,
  type ZipTreeRow,
} from "./zipTree"

type ListingState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listing: ZipListing }

/** The listing, read once per zip, from the server that has the file (`src/server/zip-preview.ts`). */
function useZipListing(url: string): ListingState {
  const [state, setState] = useState<{ url: string; value: ListingState }>({ url, value: { status: "loading" } })
  useEffect(() => {
    const controller = new AbortController()
    setState({ url, value: { status: "loading" } })
    fetch(new URL(zipListingUrl(url), document.baseURI || window.location.href), { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (ZipListing & { error?: string }) | null
        if (!response.ok || !body || !Array.isArray(body.entries)) throw new Error(body?.error ?? "Couldn't read this zip.")
        setState({ url, value: { status: "ready", listing: body } })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ url, value: { status: "error", message: error instanceof Error ? error.message : "Couldn't read this zip." } })
      })
    return () => controller.abort()
  }, [url])
  return state.url === url ? state.value : { status: "loading" }
}

function absoluteUrl(url: string) {
  return new URL(url, document.baseURI || window.location.href).toString()
}

/**
 * A zip's contents, without unpacking it: its folders and files with their
 * sizes, and its text files readable in the viewer. A text file opens in
 * the card in place of the tree, with Back to return to it, still open
 * where it was. Download stays in the header for the zip itself.
 */
export function ZipPreview({ attachment, onClose }: { attachment: ViewerAttachment; onClose: () => void }) {
  const state = useZipListing(attachment.url)
  const listing = state.status === "ready" ? state.listing : null
  const tree = useMemo(() => (listing ? buildZipTree(listing.entries) : null), [listing])
  const [expanded, setExpanded] = useState<{ tree: ZipTreeFolder | null; paths: ReadonlySet<string> }>({ tree: null, paths: new Set() })
  if (tree && expanded.tree !== tree) setExpanded({ tree, paths: initialExpandedFolders(tree) })
  const expandedPaths = expanded.tree === tree ? expanded.paths : new Set<string>()
  const folders = useMemo(() => (tree ? allZipFolders(tree) : []), [tree])
  const allExpanded = folders.length > 0 && folders.every((path) => expandedPaths.has(path))

  // The entry opened in the card, by path; null for the tree.
  const [openPath, setOpenPath] = useState<string | null>(null)
  const openEntry = openPath && listing ? listing.entries.find((entry) => !entry.directory && entry.path === openPath) ?? null : null
  const entryAttachment = useMemo(() => (openEntry ? zipEntryAttachment(attachment, openEntry) : null), [attachment, openEntry])

  function toggle(path: string) {
    setExpanded((current) => {
      const paths = new Set(current.paths)
      if (paths.has(path)) paths.delete(path)
      else paths.add(path)
      return { tree: current.tree, paths }
    })
  }

  const subtitle = openEntry
    ? [
      openEntry.size > TEXT_PREVIEW_LIMIT_BYTES ? "first 1 MB" : null,
      openEntry.path.includes("/") ? `${attachment.name} › ${openEntry.path.slice(0, openEntry.path.lastIndexOf("/"))}` : attachment.name,
      formatAttachmentSize(openEntry.size),
    ].filter(Boolean).join(" · ")
    : [
      listing ? `${listing.fileCount.toLocaleString()} ${listing.fileCount === 1 ? "file" : "files"}` : null,
      listing ? `${formatAttachmentSize(listing.totalSize)} unpacked` : null,
      attachment.size !== null ? formatAttachmentSize(attachment.size) : null,
    ].filter(Boolean).join(" · ")

  return (
    <ViewerSurface
      label={`Preview ${attachment.name}`}
      icon={openEntry ? <FileText /> : <FileArchive />}
      title={openEntry ? openEntry.path.slice(openEntry.path.lastIndexOf("/") + 1) : attachment.name}
      subtitle={subtitle}
      onClose={onClose}
      leading={openEntry ? (
        <ViewerIconButton label={`Back to ${attachment.name}`} onClick={() => setOpenPath(null)}><ArrowLeft /></ViewerIconButton>
      ) : undefined}
      toolbar={(
        <>
          {!openEntry && folders.length > 0 ? (
            <ViewerIconButton
              label={allExpanded ? "Collapse all" : "Expand all"}
              onClick={() => setExpanded({ tree, paths: allExpanded ? new Set() : new Set(folders) })}
            >
              {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
            </ViewerIconButton>
          ) : null}
          <ViewerIconButton label="Copy link" onClick={() => void navigator.clipboard?.writeText(absoluteUrl(attachment.url))}><Link2 /></ViewerIconButton>
          <ViewerIconButton label="Download" onClick={() => downloadAttachment(attachment)}><Download /></ViewerIconButton>
        </>
      )}
    >
      <ViewerPanes
        value={openEntry ? "entry" : "tree"}
        panes={{
          tree: () => (
            state.status === "error" ? <ListingError message={state.message} attachment={attachment} />
              : !tree || !listing ? <TreeSkeleton />
                : <ZipTreeList tree={tree} listing={listing} expanded={expandedPaths} onToggle={toggle} onOpen={setOpenPath} />
          ),
          // Keyed by the entry, so a second one starts from its own top and
          // never shows the first one's text while it loads.
          entry: () => (entryAttachment ? <RenderedFilePreview key={entryAttachment.url} attachment={entryAttachment} fill /> : null),
        }}
      />
    </ViewerSurface>
  )
}

/**
 * The tree's left edge is the header's (`ViewerSurface`), repeated: the
 * header's pl-4 less its Back's -ml-2 puts that 28px button at 8px, its
 * arrow's centre at 22px, the icon after it at 44px (centre 52) and the
 * title at 68px. A row puts its chevron in a slot as wide as that button,
 * at the same 8px, with the same gaps, so chevron, icon and name each
 * stand under the header's. The lucide glyphs here (arrow, chevron, file,
 * folder) are all centred in their boxes, so centring the boxes centres
 * the ink. Each level steps in by the distance from the chevron's centre to
 * the icon's, so a child's chevron sits under its parent's folder.
 */
const ROW_PAD = 8
const INDENT = 30
/** Where a top-level row's name starts: the header title's 68px. */
const NAME_INSET = 68
/**
 * The right edge of the sizes: the header's close glyph ends 18px in (its
 * pr-2, the 6px either side of the 16px icon in its 28px button, and the X's
 * own 4px of blank). 17px here, as text ink stops about a pixel short of
 * its box.
 */
const ROW_END_PAD = 17

function ZipTreeList({ tree, listing, expanded, onToggle, onOpen }: {
  tree: ZipTreeFolder
  listing: ZipListing
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const rows = useMemo(() => visibleZipRows(tree, expanded), [expanded, tree])
  if (rows.length === 0) {
    return <div className="flex min-h-full items-center justify-center p-6 text-sm text-muted-foreground">This zip is empty.</div>
  }
  return (
    // Rows touch, with their spacing inside them: a gap between hoverable
    // rows is a strip where the pointer is over nothing, and the highlight
    // flickers off crossing it.
    <div className="py-1 text-sm" role="list" aria-label="Contents">
      {rows.map((row) => <ZipRow key={`${row.node.kind}:${row.node.path}`} row={row} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />)}
      {listing.unsafeEntries > 0 ? (
        <p className="pb-2 pt-3 text-xs text-muted-foreground" style={{ paddingLeft: NAME_INSET, paddingRight: ROW_END_PAD }}>
          {listing.unsafeEntries.toLocaleString()} {listing.unsafeEntries === 1 ? "entry" : "entries"} with a path outside the zip not shown.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Where a level's guide line stands: under its chevron, whose centre is
 * 14px into its 28px slot. A 1px line can't be centred on a whole pixel
 * without straddling two and blurring, so it takes the pixel just left of
 * the centre: crisp at every pixel ratio, half a pixel off.
 */
function guideLeft(level: number) {
  return ROW_PAD + level * INDENT + 14 - 1
}

/**
 * The lines an open folder drops past what's in it. Every row draws one,
 * full height, for each folder it sits in, and the rows touch, so each line
 * runs unbroken from its folder to the last row under it; a closed folder
 * has no rows under it, so no line. An open folder's own row starts its
 * line just below the chevron's point (ink ends ~2px under the row's
 * middle; 4px clear after that). Absolute and inert to the pointer: they
 * neither move the row's contents nor take its clicks.
 */
function TreeGuides({ depth, open }: { depth: number; open: boolean }) {
  if (depth === 0 && !open) return null
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: guideLeft(level) }} />
      ))}
      {open ? (
        <span aria-hidden className="pointer-events-none absolute bottom-0 top-[calc(50%+6px)] w-px bg-border" style={{ left: guideLeft(depth) }} />
      ) : null}
    </>
  )
}

function formatModified(modifiedAt: string | null) {
  if (!modifiedAt) return undefined
  const date = new Date(modifiedAt)
  return Number.isNaN(date.getTime()) ? undefined : `Modified ${date.toLocaleString()}`
}

function ZipRow({ row, expanded, onToggle, onOpen }: {
  row: ZipTreeRow
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const { node, depth } = row
  const padding = { paddingLeft: ROW_PAD + depth * INDENT, paddingRight: ROW_END_PAD }
  const rowClass = "relative flex w-full min-w-0 items-center gap-2 py-1 text-left"

  if (node.kind === "folder") {
    const open = expanded.has(node.path)
    const Icon = open ? FolderOpen : Folder
    return (
      <div role="listitem">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(node.path)}
          className={cn(rowClass, "transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
          style={padding}
        >
          <TreeGuides depth={depth} open={open} />
          {/* As wide as the header's Back (size-7), only as tall as the line. */}
          <span className="flex h-4 w-7 shrink-0 items-center justify-center">
            <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
          </span>
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">{node.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {node.fileCount.toLocaleString()} · {formatAttachmentSize(node.size)}
          </span>
        </button>
      </div>
    )
  }

  const { entry } = node
  const opens = opensInZipViewer(entry)
  const content = (
    <>
      <TreeGuides depth={depth} open={false} />
      {/* The folder rows' chevron, as space, so names line up across both. */}
      <span aria-hidden className="h-4 w-7 shrink-0" />
      {opens ? <FileText className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground/70" />}
      <span className={cn("min-w-0 flex-1 truncate", opens ? "text-foreground" : "text-muted-foreground")}>{node.name}</span>
      {entry.encrypted ? <Lock aria-label="Encrypted" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatAttachmentSize(entry.size)}</span>
    </>
  )
  return (
    <div role="listitem" title={formatModified(entry.modifiedAt)}>
      {opens ? (
        <button
          type="button"
          onClick={() => onOpen(node.path)}
          className={cn(rowClass, "transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none")}
          style={padding}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass} style={padding}>{content}</div>
      )}
    </div>
  )
}

// Uneven, like names, and nested a little, like a tree.
const SKELETON_ROWS: Array<[depth: number, width: string]> = [[0, "34%"], [1, "46%"], [1, "28%"], [2, "52%"], [2, "38%"], [1, "41%"], [0, "30%"], [0, "44%"]]

function TreeSkeleton() {
  return (
    <div className="space-y-3 py-3" aria-busy aria-label="Loading contents">
      {SKELETON_ROWS.map(([depth, width], index) => (
        <div key={index} className="flex items-center gap-2" style={{ paddingLeft: NAME_INSET + depth * INDENT, paddingRight: ROW_END_PAD }}>
          <Skeleton className="h-3.5" style={{ width }} />
        </div>
      ))}
    </div>
  )
}

function ListingError({ message, attachment }: { message: string; attachment: ViewerAttachment }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-[48ch] text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => downloadAttachment(attachment)}
        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
      >
        <Download className="size-3.5" /> Download
      </button>
    </div>
  )
}

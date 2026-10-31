import { ArrowDown, ArrowUp, ChevronsUpDown, Download, ExternalLink, File, FileImage, FileJson, FileText, FileVideo, Link2, Sheet } from "lucide-react"
import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { cn } from "../../lib/utils"
import { formatAttachmentSize } from "../messages/AttachmentCard"
import {
  classifyAttachmentPreview,
  fetchTextPreview,
  parseDelimitedPreview,
  prettifyJson,
  TEXT_PREVIEW_LIMIT_BYTES,
  type AttachmentPreviewKind,
  type TablePreviewData,
} from "../messages/attachmentPreview"
import { FileContentView } from "../messages/FileContentView"
import { TranscriptMarkdown } from "../messages/shared"
import { Skeleton } from "../ui/skeleton"
import type { ViewerAttachment } from "../../stores/viewerStore"
import { downloadAttachment, openAttachmentInNewTab, openInBrowserLabel, opensInBrowser } from "./attachmentActions"
import { pdfPreviewUrl, servedInline } from "./attachmentOpenAction"
import { ViewerIconButton, ViewerPanes, ViewerSurface, ViewerToggle, type ViewerNavigation } from "./ViewerSurface"
import { isZipAttachment } from "../../../shared/zip-preview"
import { ZipPreview } from "./ZipPreview"

/** Rows and columns the table view reads: the viewer has the room, and a sort wants the rows. */
const VIEWER_TABLE_LIMITS = { rows: 1_000, columns: 50 }

/** A one-line row: text-xs's 16px line, py-1.5, and its 1px rule. */
const FILLER_ROW_HEIGHT = 29
/** An empty column past the data. */
const FILLER_COLUMN_WIDTH = 120

type TextKind = Extract<AttachmentPreviewKind, "markdown" | "text" | "json" | "table">

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string; truncated: boolean; table?: TablePreviewData }

const KIND_ICONS: Record<AttachmentPreviewKind, typeof File> = {
  image: FileImage,
  video: FileVideo,
  pdf: FileText,
  markdown: FileText,
  text: FileText,
  json: FileJson,
  table: Sheet,
  external: File,
}

function absoluteUrl(url: string) {
  return new URL(url, document.baseURI || window.location.href).toString()
}

/** Reads a text-shaped attachment once per open, with the table parsed for the table view. */
function useTextContent(attachment: ViewerAttachment, kind: AttachmentPreviewKind): LoadState | null {
  const [state, setState] = useState<LoadState | null>(null)
  useEffect(() => {
    if (kind !== "markdown" && kind !== "text" && kind !== "json" && kind !== "table") {
      setState(null)
      return
    }
    const textKind: TextKind = kind
    let cancelled = false
    setState({ status: "loading" })
    fetchTextPreview(attachment.url, TEXT_PREVIEW_LIMIT_BYTES)
      .then(({ content, truncated }) => {
        if (cancelled) return
        if (textKind === "table") {
          const tab = attachment.mimeType === "text/tab-separated-values" || attachment.name.toLowerCase().endsWith(".tsv")
          setState({ status: "ready", content, truncated, table: parseDelimitedPreview(content, tab ? "\t" : ",", VIEWER_TABLE_LIMITS) })
          return
        }
        setState({ status: "ready", content: textKind === "json" ? prettifyJson(content) : content, truncated })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "Couldn't load this file." })
      })
    return () => {
      cancelled = true
    }
  }, [attachment.mimeType, attachment.name, attachment.url, kind])
  return state
}

/**
 * What a preview left out, briefly: "first 1,000 of 1,001 rows". A sort only
 * reorders what's shown, which "first" already says.
 */
export function truncationNotes(content: { truncated: boolean; table?: TablePreviewData }): string[] {
  const table = content.table
  return [
    content.truncated ? "first 1 MB" : null,
    table?.truncatedRows ? `first ${table.rows.length.toLocaleString()} of ${table.rowCount.toLocaleString()} rows` : null,
    table?.truncatedColumns ? `first ${VIEWER_TABLE_LIMITS.columns} of ${table.columnCount} columns` : null,
  ].filter((note): note is string => note !== null)
}

export type RenderView = "rendered" | "original"

function previewKind(attachment: ViewerAttachment) {
  return classifyAttachmentPreview({ mimeType: attachment.mimeType, displayName: attachment.name, size: attachment.size }).kind
}

/** Whether a file reads differently rendered than as its text: markdown, and CSV/TSV as a table. */
export function hasRenderedView(attachment: ViewerAttachment) {
  const kind = previewKind(attachment)
  return kind === "markdown" || kind === "table"
}

/**
 * An attachment at full size: images and video fit, PDFs fill, text reads.
 * `navigation` steps through the chat's other attachments.
 */
export function AttachmentViewer({ attachment, onClose, navigation }: {
  attachment: ViewerAttachment
  onClose: () => void
  navigation?: ViewerNavigation
}) {
  const kind = previewKind(attachment)
  const content = useTextContent(attachment, kind)
  const [view, setView] = useState<RenderView>("rendered")
  // After the hooks, which read nothing for a zip, so their order holds when
  // the viewer goes from a zip to another file.
  if (isZipAttachment(attachment)) return <ZipPreview attachment={attachment} onClose={onClose} navigation={navigation} />
  const Icon = KIND_ICONS[kind]
  // What was left out leads the subtitle, before type and size, rather than
  // taking a row of the body: it's the part of the file's description that
  // changes how you read what's below.
  const subtitle = [
    ...(content?.status === "ready" ? truncationNotes(content) : []),
    attachment.mimeType,
    attachment.size !== null ? formatAttachmentSize(attachment.size) : null,
  ].filter(Boolean).join(" · ")

  return (
    <ViewerSurface
      label={`Preview ${attachment.name}`}
      icon={<Icon />}
      title={attachment.name}
      subtitle={subtitle}
      onClose={onClose}
      navigation={navigation}
      center={hasRenderedView(attachment) ? (
        <ViewerToggle
          value={view}
          onChange={setView}
          options={[{ value: "rendered", label: "Preview" }, { value: "original", label: "Original" }]}
        />
      ) : undefined}
      toolbar={(
        <>
          <ViewerIconButton label="Copy link" onClick={() => void navigator.clipboard?.writeText(absoluteUrl(attachment.url))}><Link2 /></ViewerIconButton>
          {/* No "open" for a file whose tab would only download it. */}
          {opensInBrowser(attachment) ? (
            <ViewerIconButton label={openInBrowserLabel()} onClick={() => openAttachmentInNewTab(kind === "pdf" ? { url: pdfPreviewUrl(attachment.url) } : attachment)}><ExternalLink /></ViewerIconButton>
          ) : null}
          <ViewerIconButton label="Download" onClick={() => downloadAttachment(attachment)}><Download /></ViewerIconButton>
        </>
      )}
      bodyClassName={kind === "image" || kind === "video" ? "bg-muted/30" : undefined}
    >
      {hasRenderedView(attachment) ? (
        <ViewerPanes
          value={view}
          panes={{
            rendered: () => <AttachmentBody attachment={attachment} kind={kind} content={content} view="rendered" />,
            original: () => <AttachmentBody attachment={attachment} kind={kind} content={content} view="original" />,
          }}
        />
      ) : (
        <AttachmentBody attachment={attachment} kind={kind} content={content} view={view} />
      )}
    </ViewerSurface>
  )
}

/**
 * A file's rendered view on its own, for a viewer body that isn't an
 * attachment's: a changed markdown or CSV file, previewed in the diff list.
 * Markdown flows at its length like the diffs around it; a table gets a box
 * of its own to scroll, so its header can stick and it doesn't run for a
 * thousand rows between two files.
 */
export function RenderedFilePreview({ attachment, fill = false }: {
  attachment: ViewerAttachment
  /** The preview is the viewer's whole body (a file opened on its own): a table scrolls with it. */
  fill?: boolean
}) {
  const kind = previewKind(attachment)
  const content = useTextContent(attachment, kind)
  const body = <AttachmentBody attachment={attachment} kind={kind} content={content} view="rendered" />
  return kind === "table" && !fill ? <div className="max-h-[70vh] overflow-auto">{body}</div> : body
}

function AttachmentBody({ attachment, kind, content, view }: {
  attachment: ViewerAttachment
  kind: AttachmentPreviewKind
  content: LoadState | null
  view: RenderView
}) {
  if (kind === "image") {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        {/* 80vh, not max-h-full: the body only has a min-height, so a
            percentage cap resolves to nothing and a tall phone screenshot
            ran far below the fold. Auto width/height never upscale. */}
        <img src={attachment.url} alt={attachment.name} className="h-auto max-h-[80vh] w-auto max-w-full rounded-lg object-contain shadow-sm" />
      </div>
    )
  }
  if (kind === "video") {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <video src={attachment.url} controls className="max-h-full max-w-full rounded-lg" aria-label={attachment.name} />
      </div>
    )
  }
  if (kind === "pdf") return <PdfFrame attachment={attachment} />
  // Never opened for these: `activateAttachment` sends them to a tab or a download.
  if (kind === "external") return null
  if (!content || content.status === "loading") return kind === "table" && view === "rendered" ? <TableSkeleton /> : <TextSkeleton />
  if (content.status === "error") {
    return <div className="flex min-h-full items-center justify-center p-6 text-sm text-destructive">{content.message}</div>
  }

  if (kind === "table" && content.table && view === "rendered") {
    return <SortableTable table={content.table} />
  }
  if (kind === "markdown" && view === "rendered") {
    return (
      // A reading measure: ~72 characters a line, centred, however wide the
      // viewer is. Long lines of prose are hard to track back across.
      <article className="mx-auto max-w-[72ch] px-6 py-8">
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <TranscriptMarkdown text={content.content} />
        </div>
      </article>
    )
  }
  return (
    <div className="p-4">
      <FileContentView content={content.content} />
    </div>
  )
}

/**
 * A PDF in an iframe, mounted only once the server has said it shows it.
 * An iframe on a URL served as `attachment` (an older server sent agents'
 * PDFs that way) is a download: the frame stays blank, and the file is
 * saved again each time the frame mounts, which a viewer restored on reload
 * does with no click. A fetch never downloads, and the check stops at the
 * headers. It skips the cache, which may hold an answer from before the
 * server changed (`pdfPreviewUrl`), and so clears it for the frame.
 */
function PdfFrame({ attachment }: { attachment: ViewerAttachment }) {
  const url = pdfPreviewUrl(attachment.url)
  const [state, setState] = useState<{ url: string; inline: boolean } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(url, { signal: controller.signal, cache: "reload" })
      .then((response) => {
        setState({ url, inline: response.ok && servedInline(response.headers, "application/pdf") })
        controller.abort()
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ url, inline: false })
      })
    return () => controller.abort()
  }, [url])
  if (state?.url !== url) return null
  if (state.inline) return <iframe src={url} title={attachment.name} className="size-full border-0" />
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">This PDF can't be shown here.</p>
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

// Uneven widths: text of varying length, not a grid waiting to fill.
const SKELETON_LINES = ["62%", "48%", "71%", "40%", "66%", "55%", "30%", "58%"]

function TextSkeleton() {
  return (
    <div className="mx-auto max-w-[72ch] space-y-3 px-6 py-8" aria-busy aria-label="Loading preview">
      {SKELETON_LINES.map((width, index) => <Skeleton key={index} className="h-3.5" style={{ width }} />)}
    </div>
  )
}

// Column widths and, per cell, how full its bar runs: uneven, like data, and
// the same every time, so the grid doesn't reshuffle between loads.
const SKELETON_COLUMN_WIDTHS = [72, 148, 112, 188, 96, 136, 120, 164, 104, 140, 128, 176, 92, 152]
const SKELETON_FILLS = [0.72, 0.48, 0.86, 0.58, 0.4, 0.94, 0.64, 0.52, 0.78, 0.44, 0.68, 0.9]
const SKELETON_ROWS = 40

/**
 * A table on its way: the viewer's grid, header and all, in the table's own
 * cell geometry so nothing moves when the rows land, with a band of light
 * running through it corner to corner. Each cell's delay is its diagonal
 * (row + column), so the band sweeps from the top left to the bottom right.
 * More than the card holds; the scroller clips it. Still under reduced
 * motion.
 */
function TableSkeleton() {
  return (
    <div className="h-full overflow-hidden" aria-busy aria-label="Loading table">
      <table className="table-fixed border-collapse text-xs" style={{ width: SKELETON_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0) }}>
        <colgroup>
          {SKELETON_COLUMN_WIDTHS.map((width, column) => <col key={column} style={{ width }} />)}
        </colgroup>
        <thead>
          <tr>
            {SKELETON_COLUMN_WIDTHS.map((_, column) => (
              <th key={column} className="px-3 py-2 shadow-[inset_0_-1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]">
                <div className="flex h-4 items-center">
                  <SkeletonBar diagonal={column} fill={0.55 + (column % 3) * 0.12} strong />
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: SKELETON_ROWS }, (_, row) => (
            <tr key={row}>
              {SKELETON_COLUMN_WIDTHS.map((_, column) => (
                <td key={column} className="border-b border-r border-border/60 px-3 py-1.5">
                  <div className="flex h-4 items-center">
                    <SkeletonBar diagonal={row + 1 + column} fill={SKELETON_FILLS[(row * 5 + column * 7) % SKELETON_FILLS.length]!} />
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SkeletonBar({ diagonal, fill, strong = false }: { diagonal: number; fill: number; strong?: boolean }) {
  return (
    <div
      className={cn("kanna-table-wave h-2 rounded-full", strong ? "bg-foreground/15" : "bg-foreground/10")}
      style={{ width: `${fill * 100}%`, animationDelay: `${diagonal * 40}ms` }}
    />
  )
}

// Web addresses inside a cell, wherever they sit in its text.
const CELL_URL_PATTERN = /https?:\/\/[^\s<>"']+/gu

/**
 * A cell's text with its web addresses as links. They open in a new tab: the
 * viewer is where you're reading, and a link that replaced it would lose your
 * place in the table.
 */
export function CellText({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(CELL_URL_PATTERN)) {
    // Trailing punctuation is the sentence's, not the address's.
    const url = match[0].replace(/[.,;:!?)\]]+$/u, "")
    const start = match.index ?? 0
    if (start > last) parts.push(text.slice(last, start))
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(event) => event.stopPropagation()}
        className="text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
      >
        {url}
      </a>,
    )
    last = start + url.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

type SortState = { column: number; direction: "asc" | "desc" } | null

/** A cell as a number when it reads as one: "1,204", "$3.50", "42%", "-7". */
function numericValue(cell: string): number | null {
  const cleaned = cell.trim().replace(/[,$€£%]/gu, "")
  if (cleaned === "" || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/iu.test(cleaned)) return null
  return Number(cleaned)
}

const cellCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * The rows' indices in sorted order, by one column. Numbers as numbers when
 * both cells are numeric, text otherwise (with digits in order: "item 2"
 * before "item 10"). Empty cells always sink to the bottom, whichever
 * direction. Each cell is read once up front, not once per comparison: the
 * numeric check is a regex, and a thousand rows compare ten thousand times.
 */
export function sortedRowOrder(rows: readonly string[][], sort: SortState): number[] {
  const order = rows.map((_, index) => index)
  if (!sort) return order
  const keys = rows.map((row) => {
    const text = row[sort.column] ?? ""
    const empty = !text.trim()
    return { text, empty, number: empty ? null : numericValue(text) }
  })
  const factor = sort.direction === "asc" ? 1 : -1
  return order.sort((left, right) => {
    const a = keys[left]!
    const b = keys[right]!
    if (a.empty || b.empty) return (a.empty ? 1 : 0) - (b.empty ? 1 : 0)
    if (a.number !== null && b.number !== null) return (a.number - b.number) * factor
    return cellCollator.compare(a.text, b.text) * factor
  })
}

export function sortTableRows(rows: readonly string[][], sort: SortState): string[][] {
  return sortedRowOrder(rows, sort).map((index) => rows[index]!)
}

const EMPTY_ROW: string[] = []

/** Rows in the first paint (a tall screen's worth), then in each chunk after. */
const FIRST_ROW_CHUNK = 60
const ROW_CHUNK = 100

/** A column's widest, as a cell: 28rem. Longer text wraps inside it. */
const MAX_COLUMN_WIDTH = 448
const MIN_COLUMN_WIDTH = 48
/** px-3 either side, the rule, and a pixel of slack against rounding into a wrap. */
const CELL_CHROME = 24 + 1 + 2
/** The header's sort arrow and the gap before it. */
const HEADER_ICON = 12 + 4
/** Cells measured per column: the longest by characters, which are near enough the widest. */
const MEASURED_CELLS = 8

let measureContext: CanvasRenderingContext2D | null | undefined

/**
 * Each column's width, from its header and its longest cells, measured in
 * the table's font (text-xs). What an auto table would settle on, without
 * laying out every row to find it.
 */
function measureColumnWidths(header: string[], body: string[][], columnCount: number, numericColumns: boolean[]): number[] {
  measureContext ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")
  const context = measureContext
  const family = typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily
  const textWidth = (text: string, weight: number) => {
    if (!context) return text.length * 7
    context.font = `${weight} 12px ${family}`
    return Math.max(...text.split("\n").map((line) => context.measureText(line).width))
  }
  const digitWidth = textWidth("0", 400)
  return Array.from({ length: columnCount }, (_, column) => {
    const longest: string[] = []
    for (const row of body) {
      const cell = row[column]
      if (!cell) continue
      if (longest.length < MEASURED_CELLS) {
        longest.push(cell)
        longest.sort((a, b) => b.length - a.length)
      } else if (cell.length > longest[MEASURED_CELLS - 1]!.length) {
        longest[MEASURED_CELLS - 1] = cell
        longest.sort((a, b) => b.length - a.length)
      }
    }
    const cellWidth = Math.max(0, ...longest.map((cell) => (
      // Numbers are tabular: every digit as wide as a zero.
      numericColumns[column] ? Math.max(textWidth(cell, 400), cell.length * digitWidth) : textWidth(cell, 400)
    )))
    const headerWidth = textWidth(header[column] || `Column ${column + 1}`, 500) + HEADER_ICON
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(Math.max(cellWidth, headerWidth) + CELL_CHROME)))
  })
}

/**
 * One body row. Memoized and keyed by its place in the file, so a sort moves
 * the rows' DOM rather than re-rendering every cell into a new position.
 */
const TableRow = memo(function TableRow({ row, columnCount, numericColumns, fillColumns }: {
  row: string[]
  columnCount: number
  numericColumns: boolean[]
  fillColumns: number
}) {
  return (
    <tr className="hover:bg-muted/40">
      {Array.from({ length: columnCount }, (_, column) => (
        <td
          key={column}
          className={cn(
            // A full grid: row and column rules alike, in the body's
            // softer tone, closed on the right like the header.
            "border-b border-r border-border/60 px-3 py-1.5 align-top text-foreground",
            numericColumns[column] && "text-right tabular-nums",
          )}
        >
          <div className="whitespace-pre-wrap break-words">{row[column] ? <CellText text={row[column]!} /> : " "}</div>
        </td>
      ))}
      <FillerCells count={fillColumns} />
    </tr>
  )
})

function FillerCells({ count }: { count: number }) {
  return Array.from({ length: count }, (_, column) => (
    <td
      key={`filler-${column}`}
      aria-hidden
      className="border-b border-r border-border/60 p-0"
      style={{ width: FILLER_COLUMN_WIDTH, minWidth: FILLER_COLUMN_WIDTH }}
    />
  ))
}

/**
 * A CSV as a table: sticky header, click a column to sort it (ascending,
 * descending, then back to the file's order), numbers aligned right.
 */
function SortableTable({ table }: { table: TablePreviewData }) {
  const [sort, setSort] = useState<SortState>(null)
  // Derived once per table: a fresh `body` each render would redo the sort
  // and the numeric scan (every cell) on every render, sorts included.
  const header = table.rows[0] ?? EMPTY_ROW
  const body = useMemo(() => table.rows.slice(1), [table.rows])
  const columnCount = useMemo(() => body.reduce((max, row) => Math.max(max, row.length), header.length), [body, header])
  const order = useMemo(() => sortedRowOrder(body, sort), [body, sort])
  const numericColumns = useMemo(() => Array.from({ length: columnCount }, (_, column) => {
    // The first column is the row's label, whatever it holds (an id, a
    // year): it reads left, where the eye starts each row.
    if (column === 0) return false
    const cells = body.map((row) => row[column] ?? "").filter((cell) => cell.trim())
    return cells.length > 0 && cells.every((cell) => numericValue(cell) !== null)
  }), [body, columnCount])
  const columnWidths = useMemo(() => measureColumnWidths(header, body, columnCount, numericColumns), [body, columnCount, header, numericColumns])

  // The first screen of rows paints at once, the rest follow a chunk at a
  // time in transitions: all of them in one go is tens of thousands of cells,
  // and the viewer froze while they built. A click on a header still lands
  // between chunks. Starts over for a new table.
  const [renderedRows, setRenderedRows] = useState({ body, count: FIRST_ROW_CHUNK })
  const renderedCount = renderedRows.body === body ? renderedRows.count : FIRST_ROW_CHUNK
  if (renderedRows.body !== body) setRenderedRows({ body, count: FIRST_ROW_CHUNK })
  useEffect(() => {
    if (renderedCount >= body.length) return
    const frame = requestAnimationFrame(() => {
      startTransition(() => setRenderedRows((current) => ({ body: current.body, count: current.count + ROW_CHUNK })))
    })
    return () => cancelAnimationFrame(frame)
  }, [body.length, renderedCount])
  const pendingRows = Math.max(0, body.length - renderedCount)

  function cycle(column: number) {
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: "asc" }
      if (current.direction === "asc") return { column, direction: "desc" }
      return null
    })
  }

  // The table is as wide as its content, from the left: two short columns
  // stay two short columns rather than spreading across the card. The rest of
  // the card is still grid, like a spreadsheet's empty cells: empty columns
  // to the right, blank rows below, as many as the card has room for. Always
  // one column at least, so a table wider than the card still ends in empty
  // grid when you scroll to its edge. Both come from measuring, so the real
  // columns keep their own widths.
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const tableRef = useRef<HTMLTableElement | null>(null)
  const lastHeaderRef = useRef<HTMLTableCellElement | null>(null)
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)
  const [fill, setFill] = useState({ columns: 1, rows: 0, clipWidth: 0, height: 0 })

  useLayoutEffect(() => {
    const scroller = wrapperRef.current?.parentElement
    const tableElement = tableRef.current
    if (!scroller || !tableElement) return
    function measure() {
      const lastHeader = lastHeaderRef.current
      const tbody = bodyRef.current
      if (!scroller || !tableElement || !lastHeader || !tbody) return
      // Kept but hidden behind "Original": nothing to measure, and a
      // measurement of nothing would re-render every row for it.
      if (tableElement.checkVisibility?.() === false) return
      const top = tableElement.getBoundingClientRect()
      const spareWidth = scroller.clientWidth - (lastHeader.getBoundingClientRect().right - top.left)
      const spareHeight = scroller.clientHeight - (tbody.getBoundingClientRect().bottom - top.top)
      const columns = spareWidth > 0 ? Math.ceil(spareWidth / FILLER_COLUMN_WIDTH) : 1
      const rows = spareHeight > 0 ? Math.ceil(spareHeight / FILLER_ROW_HEIGHT) : 0
      // Rounding up overshoots the card; the overshoot is cut at its edge.
      const clipWidth = spareWidth > 0 ? scroller.clientWidth : 0
      const height = scroller.clientHeight
      setFill((current) => (
        current.columns === columns && current.rows === rows && current.clipWidth === clipWidth && current.height === height
          ? current
          : { columns, rows, clipWidth, height }
      ))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(tableElement)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={wrapperRef}
      // The empty rows and columns round up to whole ones, so the last of
      // each is cut at the card's edge rather than adding a scroll of a few
      // pixels. Clip, not hidden: hidden would make this the scroller and
      // unstick the header.
      className={cn(
        fill.clipWidth > 0 ? "overflow-x-clip" : "min-w-max",
        fill.rows > 0 && "overflow-y-clip",
      )}
      style={{
        maxWidth: fill.clipWidth > 0 ? fill.clipWidth : undefined,
        maxHeight: fill.rows > 0 ? fill.height : undefined,
      }}
    >
      {/* Fixed layout, with widths measured up front: an auto table sizes its
          columns from every cell, so each chunk of rows would lay out the
          whole table again (and shift the columns under you). */}
      <table
        ref={tableRef}
        className="table-fixed border-collapse text-xs"
        style={{ width: columnWidths.reduce((sum, width) => sum + width, 0) + fill.columns * FILLER_COLUMN_WIDTH }}
      >
        <colgroup>
          {columnWidths.map((width, column) => <col key={column} style={{ width }} />)}
          {Array.from({ length: fill.columns }, (_, column) => <col key={`filler-${column}`} style={{ width: FILLER_COLUMN_WIDTH }} />)}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background dark:bg-card">
          <tr>
            {Array.from({ length: columnCount }, (_, column) => {
              const active = sort?.column === column
              return (
                // The header's rules (under it, and after each column) are
                // inset shadows, not borders: in a collapsed table borders
                // belong to the grid, so they'd stay behind while the sticky
                // header moves. The last column keeps its rule too: the table
                // ends before the card does, and the rule closes it.
                <th
                  key={column}
                  ref={column === columnCount - 1 ? lastHeaderRef : undefined}
                  className="p-0 text-left font-medium shadow-[inset_0_-1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]"
                >
                  <button
                    type="button"
                    onClick={() => cycle(column)}
                    aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                    className={cn(
                      "group/sort flex w-full items-center gap-1 px-3 py-2 transition-colors hover:bg-muted",
                      numericColumns[column] && "justify-end",
                      active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{header[column] || `Column ${column + 1}`}</span>
                    {active
                      ? (sort.direction === "asc" ? <ArrowUp className="size-3 shrink-0" /> : <ArrowDown className="size-3 shrink-0" />)
                      : <ChevronsUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover/sort:opacity-60" />}
                  </button>
                </th>
              )
            })}
            {Array.from({ length: fill.columns }, (_, column) => (
              <th
                key={`filler-${column}`}
                aria-hidden
                className="p-0 shadow-[inset_0_-1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]"
                style={{ width: FILLER_COLUMN_WIDTH, minWidth: FILLER_COLUMN_WIDTH }}
              />
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {order.slice(0, renderedCount).map((index) => (
            <TableRow key={index} row={body[index]!} columnCount={columnCount} numericColumns={numericColumns} fillColumns={fill.columns} />
          ))}
          {/* Holds the rows still to come, so the scrollbar is the table's
              length from the start rather than growing under the thumb. */}
          {pendingRows > 0 ? (
            <tr aria-hidden>
              <td colSpan={columnCount + fill.columns} className="p-0" style={{ height: pendingRows * FILLER_ROW_HEIGHT }} />
            </tr>
          ) : null}
        </tbody>
        {fill.rows > 0 ? (
          <tbody aria-hidden>
            {Array.from({ length: fill.rows }, (_, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: columnCount }, (_, column) => (
                  <td key={column} className="border-b border-r border-border/60 px-3 py-1.5">
                    <div>{"\u00A0"}</div>
                  </td>
                ))}
                <FillerCells count={fill.columns} />
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  )
}

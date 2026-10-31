import { zipEntryTextKind, zipEntryUrl, type ZipListingEntry } from "../../../shared/zip-preview"
import { JSON_PREVIEW_LIMIT_BYTES } from "../messages/attachmentPreview"
import type { ViewerAttachment } from "../../stores/viewerStore"

export interface ZipTreeFolder {
  kind: "folder"
  name: string
  /** "" for the archive's root. */
  path: string
  children: ZipTreeNode[]
  /** Everything under it, unpacked. */
  size: number
  fileCount: number
}

export interface ZipTreeFile {
  kind: "file"
  name: string
  path: string
  entry: ZipListingEntry
}

export type ZipTreeNode = ZipTreeFolder | ZipTreeFile

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * A listing as folders and files. A zip needn't hold its folders as entries
 * of their own (many tools write only the files), so a folder is made for
 * every path a file sits under. A path listed twice is shown once, as the
 * first, which is the one the server opens. Folders before files, then by
 * name with numbers in order ("part 2" before "part 10").
 */
export function buildZipTree(entries: readonly ZipListingEntry[]): ZipTreeFolder {
  const root: ZipTreeFolder = { kind: "folder", name: "", path: "", children: [], size: 0, fileCount: 0 }
  const folders = new Map<string, ZipTreeFolder>([["", root]])
  const files = new Set<string>()

  function folderAt(folderPath: string): ZipTreeFolder {
    const existing = folders.get(folderPath)
    if (existing) return existing
    const slash = folderPath.lastIndexOf("/")
    const parent = folderAt(slash >= 0 ? folderPath.slice(0, slash) : "")
    const folder: ZipTreeFolder = { kind: "folder", name: folderPath.slice(slash + 1), path: folderPath, children: [], size: 0, fileCount: 0 }
    parent.children.push(folder)
    folders.set(folderPath, folder)
    return folder
  }

  for (const entry of entries) {
    if (entry.directory) {
      folderAt(entry.path)
      continue
    }
    if (files.has(entry.path)) continue
    files.add(entry.path)
    const slash = entry.path.lastIndexOf("/")
    folderAt(slash >= 0 ? entry.path.slice(0, slash) : "").children.push({
      kind: "file",
      name: entry.path.slice(slash + 1),
      path: entry.path,
      entry,
    })
  }

  function settle(folder: ZipTreeFolder) {
    folder.size = 0
    folder.fileCount = 0
    for (const child of folder.children) {
      if (child.kind === "folder") {
        settle(child)
        folder.size += child.size
        folder.fileCount += child.fileCount
      } else {
        folder.size += child.entry.size
        folder.fileCount += 1
      }
    }
    folder.children.sort((a, b) => (a.kind === b.kind ? nameCollator.compare(a.name, b.name) : a.kind === "folder" ? -1 : 1))
  }
  settle(root)
  return root
}

export interface ZipTreeRow {
  node: ZipTreeNode
  depth: number
}

/** The rows on screen: every node whose folders above it are all open. */
export function visibleZipRows(root: ZipTreeFolder, expanded: ReadonlySet<string>): ZipTreeRow[] {
  const rows: ZipTreeRow[] = []
  function walk(folder: ZipTreeFolder, depth: number) {
    for (const child of folder.children) {
      rows.push({ node: child, depth })
      if (child.kind === "folder" && expanded.has(child.path)) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/**
 * The folders open when the zip is: the one folder most zips are wrapped in,
 * and any lone folder inside that, down to where there's a choice to make.
 */
export function initialExpandedFolders(root: ZipTreeFolder): Set<string> {
  const expanded = new Set<string>()
  let folder = root
  while (folder.children.length === 1 && folder.children[0]!.kind === "folder") {
    folder = folder.children[0] as ZipTreeFolder
    expanded.add(folder.path)
  }
  return expanded
}

export function allZipFolders(root: ZipTreeFolder): string[] {
  const paths: string[] = []
  function walk(folder: ZipTreeFolder) {
    for (const child of folder.children) {
      if (child.kind !== "folder") continue
      paths.push(child.path)
      walk(child)
    }
  }
  walk(root)
  return paths
}

/** Whether a click opens the entry in the viewer: text the server will inflate. */
export function opensInZipViewer(entry: ZipListingEntry) {
  return !entry.directory && !entry.encrypted && zipEntryTextKind(entry.path) !== null
}

/**
 * An entry as an attachment of its own, for the viewer's text, markdown and
 * table bodies. An entry has no type, so it gets the one its name reads as.
 * JSON past what the viewer prettifies reads as plain text rather than not
 * at all (`classifyAttachmentPreview`).
 */
export function zipEntryAttachment(zip: Pick<ViewerAttachment, "url">, entry: ZipListingEntry): ViewerAttachment {
  const kind = zipEntryTextKind(entry.path)
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1)
  const mimeType = kind === "markdown" ? "text/markdown"
    : kind === "json" && entry.size <= JSON_PREVIEW_LIMIT_BYTES ? "application/json"
      : kind === "table" ? (name.toLowerCase().endsWith(".tsv") ? "text/tab-separated-values" : "text/csv")
        : "text/plain"
  return { url: zipEntryUrl(zip.url, entry.path), name, mimeType, size: entry.size }
}

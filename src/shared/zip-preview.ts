import { CODE_OR_CONFIG_EXTENSIONS } from "./text-files"

/**
 * A zip's contents, read from its central directory without unpacking it
 * (`src/server/zip-preview.ts`), for the viewer's tree (`ZipPreview.tsx`).
 * Asked of the routes that already serve the file, so the same auth and
 * path checks stand in front of it: `?zip=list` for the listing,
 * `?zip=entry&path=<entry>` for one text entry's bytes.
 */
export interface ZipListing {
  entries: ZipListingEntry[]
  /** Files, not counting folders. */
  fileCount: number
  /** What the files come to unpacked. */
  totalSize: number
  /** Entries left out for a path that climbs out of the archive (`..`) or starts at the root. */
  unsafeEntries: number
}

export interface ZipListingEntry {
  /** Relative, with `/` between folders, and no trailing slash on a folder. */
  path: string
  directory: boolean
  /** Unpacked. */
  size: number
  compressedSize: number
  /** ISO 8601. In UTC (`Z`) when the archive stored a UTC time; otherwise the local time it was made at, with no zone. */
  modifiedAt: string | null
  encrypted: boolean
}

export const ZIP_PREVIEW_LIMITS = {
  /** Entries a listing reads; more is an archive too big to list. */
  entries: 10_000,
  /** The central directory, read in one piece: about 100 bytes an entry, so the entry cap comes first. */
  centralDirectoryBytes: 8 * 1024 * 1024,
  /** One entry, inflated in memory. The viewer reads the first 1 MB of it. */
  entryBytes: 4 * 1024 * 1024,
} as const

export type ZipEntryTextKind = "markdown" | "json" | "table" | "text"

/** Text by name beyond code and config: logs, and the files a repository has at its top. */
const EXTRA_TEXT_EXTENSIONS = new Set([".log", ".markdown", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc"])
const TEXT_FILE_NAMES = new Set(["readme", "license", "licence", "changelog", "authors", "makefile", "dockerfile", "procfile", "gemfile"])

/**
 * How an entry reads, by its name alone (an entry has no type): the same
 * rules the viewer applies to an attachment (`classifyAttachmentPreview`).
 * Null for anything that isn't text, which the server won't inflate.
 */
export function zipEntryTextKind(entryPath: string): ZipEntryTextKind | null {
  const name = entryPath.slice(entryPath.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  const extension = dot >= 0 ? name.slice(dot) : ""
  if (extension === ".md") return "markdown"
  if (extension === ".json") return "json"
  if (extension === ".csv" || extension === ".tsv") return "table"
  if (CODE_OR_CONFIG_EXTENSIONS.has(extension) || EXTRA_TEXT_EXTENSIONS.has(extension)) return "text"
  if (TEXT_FILE_NAMES.has(dot > 0 ? name.slice(0, dot) : name)) return "text"
  return null
}

const ZIP_MIME_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"])

export function isZipAttachment(attachment: { name: string; mimeType?: string }) {
  const type = (attachment.mimeType ?? "").split(";")[0]!.trim().toLowerCase()
  return ZIP_MIME_TYPES.has(type) || attachment.name.toLowerCase().endsWith(".zip")
}

/** The two routes that answer `?zip=`: an upload's content, and a file an agent sent the chat. */
const ZIP_SERVING_ROUTE = /^\/api\/(projects\/[^/]+\/uploads\/[^/]+\/content|chats\/[^/]+\/media\/[^/]+)$/

/** Whether a file's address is one this server lists zips at. Another site's zip has no listing. */
export function servesZipListing(url: string) {
  return ZIP_SERVING_ROUTE.test(new URL(url, "http://kanna.invalid").pathname)
}

export function zipListingUrl(url: string) {
  return withZipQuery(url, { zip: "list" })
}

export function zipEntryUrl(url: string, entryPath: string) {
  return withZipQuery(url, { zip: "entry", path: entryPath })
}

function withZipQuery(url: string, params: Record<string, string>) {
  const [base, hash = ""] = url.split("#", 2) as [string, string?]
  const query = new URLSearchParams(params).toString()
  return `${base}${base.includes("?") ? "&" : "?"}${query}${hash ? `#${hash}` : ""}`
}

import type { ViewerAttachment } from "../../stores/viewerStore"
import { classifyAttachmentPreview, CODE_OR_CONFIG_EXTENSIONS, getFileExtension } from "../messages/attachmentPreview"
import { isZipAttachment, servesZipListing } from "../../../shared/zip-preview"

// Pure, with no store behind it, so the store that restores the viewer on
// load can ask it too (`persistedChatViewers` in stores/rightSidebarStore.ts).

type OpenableAttachment = Pick<ViewerAttachment, "url" | "name" | "mimeType" | "size">

/**
 * What a click on an attachment does. The viewer only for a file it can
 * really show; a panel that opens on nothing (a Word file's "No preview", a
 * PDF whose route forces a download) is a dead end. Otherwise a tab, where the
 * browser would show the file, and otherwise a download, since a tab would
 * only have downloaded it, leaving a blank page behind.
 */
export type AttachmentOpenAction = "preview" | "tab" | "download"

export function attachmentOpenAction(attachment: OpenableAttachment): AttachmentOpenAction {
  if (canPreview(attachment)) return "preview"
  return opensInBrowser(attachment) ? "tab" : "download"
}

// What <img> and <video> draw in every browser the app runs in. HEIC and
// TIFF are Safari's only; MKV and AVI play nowhere reliably.
const PREVIEWABLE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)$/
const PREVIEWABLE_VIDEO = /^video\/(mp4|webm|ogg|quicktime)$/
const PREVIEWABLE_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".mov", ".ogv"])

/**
 * Whether the viewer has something to show. Images and video draw whatever
 * the route's headers say. Text is fetched, which another site may refuse.
 * A PDF is an iframe, which shows it only where a tab would.
 */
function canPreview(attachment: OpenableAttachment) {
  const kind = classifyAttachmentPreview({ mimeType: attachment.mimeType ?? "", displayName: attachment.name, size: attachment.size }).kind
  const type = baseType(attachment.mimeType)
  switch (kind) {
    case "image":
      return PREVIEWABLE_IMAGE.test(type)
    case "video":
      return PREVIEWABLE_VIDEO.test(type) || PREVIEWABLE_VIDEO_EXTENSIONS.has(getFileExtension(attachment.name))
    case "pdf":
      return isSameOrigin(attachment.url) && opensInBrowser(attachment)
    case "external":
      // A zip is listed by the server that stores it (`?zip=list`, see
      // src/server/zip-preview.ts), so only one at an address of ours. A
      // .tar.gz has no index to read without unpacking it, and downloads.
      return isZipAttachment(attachment) && isSameOrigin(attachment.url) && servesZipListing(attachment.url)
    default:
      return isSameOrigin(attachment.url)
  }
}

/**
 * Whether a file's address, opened in a tab of its own, shows the file or
 * only starts a download.
 *
 * Two things decide it. The Content-Type the server sends, and what the
 * browser shows for it: images, PDFs, audio, video, JSON and most text show;
 * archives, Office files, binaries and CSV download (Chrome downloads
 * text/csv and text/tab-separated-values, see Chromium's
 * kUnsupportedTextTypes). And the route: a file an agent sent this chat is
 * served from `/api/chats/<id>/media/` with `Content-Disposition: attachment`
 * for anything but a few image, video and PDF types (`handleTranscriptMediaContent`
 * in src/server/server.ts). Uploads have no disposition, and are served by
 * name: code and config as text/plain, the rest by extension
 * (`inferAttachmentContentType` in src/server/uploads.ts). Another site's
 * file is guessed by its type.
 */
export function opensInBrowser(attachment: Pick<ViewerAttachment, "url" | "name" | "mimeType">): boolean {
  if (isTranscriptMedia(attachment.url)) return TRANSCRIPT_MEDIA_INLINE.test(baseType(attachment.mimeType))
  return browserShows(servedType(attachment))
}

/** Mirrors the inline list in `handleTranscriptMediaContent`. */
const TRANSCRIPT_MEDIA_INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg)|application\/pdf)$/

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp3|wav|x-wav|wave|ogg|flac|x-flac|aac|mp4|x-m4a|webm)|application\/(pdf|json))$/

/** text/* a browser saves rather than shows. */
const DOWNLOADED_TEXT_TYPES = new Set([
  "text/csv", "text/x-csv", "text/comma-separated-values", "text/tab-separated-values", "text/tsv",
  "text/calendar", "text/x-calendar", "text/vcard", "text/x-vcard", "text/rtf",
])

function browserShows(type: string) {
  if (type.startsWith("text/")) return !DOWNLOADED_TEXT_TYPES.has(type)
  return INLINE_TYPES.test(type) || type.endsWith("+json")
}

/** The type an upload is served with, which goes by its name before what was sniffed. */
function servedType(attachment: Pick<ViewerAttachment, "name" | "mimeType">) {
  const extension = getFileExtension(attachment.name)
  if (extension === ".csv") return "text/csv"
  if (extension === ".tsv") return "text/tab-separated-values"
  if (extension === ".json") return "application/json"
  if (extension === ".md") return "text/markdown"
  if (CODE_OR_CONFIG_EXTENSIONS.has(extension)) return "text/plain"
  return baseType(attachment.mimeType)
}

/** Older transcripts' sent files have no type at all. */
function baseType(mimeType: string | undefined) {
  return (mimeType ?? "").split(";")[0]!.trim().toLowerCase()
}

function isTranscriptMedia(url: string) {
  return /^\/api\/chats\/[^/]+\/media\//.test(new URL(url, "http://kanna.invalid").pathname)
}

/** A path on this server, or a full address that names it. */
function isSameOrigin(url: string) {
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) return true
  return typeof window !== "undefined" && new URL(url).origin === window.location.origin
}

/**
 * The address a PDF is shown from. An agent's PDF was served as a download
 * until the media route let PDFs through inline, and that route says
 * `immutable` for a year, so a browser that fetched one before still has
 * the download in its cache under the plain address, and an iframe there
 * kept saving it rather than showing it. The route reads only the path, so
 * a query is the same file under a cache key no old response holds.
 */
export function pdfPreviewUrl(url: string) {
  if (!isTranscriptMedia(url)) return url
  return `${url}${url.includes("?") ? "&" : "?"}inline=1`
}

/**
 * Whether a response is one the browser shows rather than saves. The client
 * guesses that from the type and route; this is the server's own answer,
 * read from the headers, for what must not guess: an iframe on a download
 * URL saves the file every time it mounts, and a viewer restored on reload
 * mounts it with no click at all.
 */
export function servedInline(headers: Pick<Headers, "get">, expectedType: string) {
  if (/^\s*attachment\b/i.test(headers.get("content-disposition") ?? "")) return false
  return baseType(headers.get("content-type") ?? "") === expectedType
}

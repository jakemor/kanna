import { CODE_OR_CONFIG_EXTENSIONS } from "../../../shared/text-files"
import type { ChatAttachment } from "../../../shared/types"

export { CODE_OR_CONFIG_EXTENSIONS }

export const TEXT_PREVIEW_LIMIT_BYTES = 1024 * 1024
export const JSON_PREVIEW_LIMIT_BYTES = 256 * 1024
export const TABLE_PREVIEW_ROW_LIMIT = 200
export const TABLE_PREVIEW_COLUMN_LIMIT = 20

const ARCHIVE_EXTENSIONS = new Set([".7z", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz", ".zip"])
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"])
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mov", ".mp4", ".mkv", ".webm"])

export type AttachmentIconKind =
  | "image"
  | "pdf"
  | "markdown"
  | "json"
  | "table"
  | "code"
  | "text"
  | "archive"
  | "audio"
  | "video"
  | "file"

export type AttachmentPreviewKind =
  | "image"
  | "video"
  | "pdf"
  | "markdown"
  | "text"
  | "json"
  | "table"
  | "external"

export interface AttachmentPreviewTarget {
  kind: AttachmentPreviewKind
  openInNewTab: boolean
}

export interface TextPreviewResult {
  content: string
  truncated: boolean
}

export interface TablePreviewData {
  rows: string[][]
  rowCount: number
  columnCount: number
  truncatedRows: boolean
  truncatedColumns: boolean
}

/** What classifying needs of an attachment, whichever surface it came from. */
export type PreviewableAttachment = Pick<ChatAttachment, "mimeType" | "displayName"> & { size: number | null }

export function classifyAttachmentPreview(attachment: PreviewableAttachment): AttachmentPreviewTarget {
  const mimeType = attachment.mimeType.toLowerCase()
  const extension = getFileExtension(attachment.displayName)

  if (mimeType.startsWith("image/")) {
    return { kind: "image", openInNewTab: false }
  }
  if (mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
    return { kind: "video", openInNewTab: false }
  }
  if (mimeType === "application/pdf") {
    return { kind: "pdf", openInNewTab: false }
  }
  if (mimeType === "application/json") {
    return attachment.size === null || attachment.size <= JSON_PREVIEW_LIMIT_BYTES
      ? { kind: "json", openInNewTab: false }
      : { kind: "external", openInNewTab: true }
  }
  if (extension === ".md") {
    return { kind: "markdown", openInNewTab: false }
  }
  if (mimeType === "text/csv" || mimeType === "text/tab-separated-values" || extension === ".csv" || extension === ".tsv") {
    return { kind: "table", openInNewTab: false }
  }
  if (mimeType.startsWith("text/")) {
    return { kind: "text", openInNewTab: false }
  }
  if (CODE_OR_CONFIG_EXTENSIONS.has(extension)) {
    return { kind: "text", openInNewTab: false }
  }
  return { kind: "external", openInNewTab: true }
}

export function classifyAttachmentIcon(attachment: ChatAttachment): AttachmentIconKind {
  const mimeType = attachment.mimeType.toLowerCase()
  const extension = getFileExtension(attachment.displayName)

  if (mimeType.startsWith("image/")) return "image"
  if (mimeType === "application/pdf" || extension === ".pdf") return "pdf"
  if (mimeType === "application/json" || extension === ".json" || extension === ".jsonc") return "json"
  if (extension === ".md") return "markdown"
  if (mimeType === "text/csv" || mimeType === "text/tab-separated-values" || extension === ".csv" || extension === ".tsv") return "table"
  if (mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) return "audio"
  if (mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) return "video"
  if (mimeType.includes("zip") || mimeType.includes("archive") || ARCHIVE_EXTENSIONS.has(extension)) return "archive"
  if (CODE_OR_CONFIG_EXTENSIONS.has(extension)) {
    if (extension === ".txt") return "text"
    return "code"
  }
  if (mimeType.startsWith("text/")) return "text"
  return "file"
}

export async function fetchTextPreview(url: string, limitBytes: number): Promise<TextPreviewResult> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null
  const timeoutId = typeof window !== "undefined" && controller
    ? window.setTimeout(() => controller.abort("preview-timeout"), 15000)
    : null

  try {
    const response = await fetch(resolvePreviewUrl(url), {
      signal: controller?.signal,
      headers: {
        Accept: "text/plain, text/markdown, application/json, text/csv, text/tab-separated-values, */*",
      },
    })
    if (!response.ok) {
      throw new Error(`Preview request failed with status ${response.status}`)
    }

    if (!response.body) {
      const text = await response.text()
      const bytes = new TextEncoder().encode(text)
      const truncated = bytes.length > limitBytes
      const content = truncated ? new TextDecoder().decode(bytes.slice(0, limitBytes)) : text
      return { content, truncated }
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    let truncated = false

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const remaining = limitBytes - received
      if (remaining <= 0) {
        truncated = true
        await reader.cancel()
        break
      }

      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining))
        received += remaining
        truncated = true
        await reader.cancel()
        break
      }

      chunks.push(value)
      received += value.byteLength
    }

    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return { content: new TextDecoder().decode(bytes), truncated }
  } catch (error) {
    if (isPreviewTimeout(error)) {
      throw new Error("Preview request timed out")
    }
    throw error
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  }
}

export function prettifyJson(content: string): string {
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`
  } catch {
    return content
  }
}

export function parseDelimitedPreview(
  content: string,
  delimiter: "," | "\t",
  limits: { rows: number; columns: number } = { rows: TABLE_PREVIEW_ROW_LIMIT, columns: TABLE_PREVIEW_COLUMN_LIMIT },
): TablePreviewData {
  const rows = parseDelimitedRows(content, delimiter)
  const rowCount = rows.length
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const truncatedRows = rowCount > limits.rows
  const truncatedColumns = columnCount > limits.columns

  return {
    rows: rows.slice(0, limits.rows).map((row) => row.slice(0, limits.columns)),
    rowCount,
    columnCount,
    truncatedRows,
    truncatedColumns,
  }
}

export function getFileExtension(fileName: string) {
  const index = fileName.lastIndexOf(".")
  return index >= 0 ? fileName.slice(index).toLowerCase() : ""
}

function resolvePreviewUrl(url: string) {
  if (typeof window === "undefined") {
    return url
  }

  return new URL(url, document.baseURI || window.location.href).toString()
}

function isPreviewTimeout(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true
  }

  return typeof error === "string" && error === "preview-timeout"
}

function parseDelimitedRows(content: string, delimiter: "," | "\t") {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentCell = ""
  let inQuotes = false

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const nextChar = content[index + 1]

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        currentCell += "\""
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (!inQuotes && char === delimiter) {
      currentRow.push(currentCell)
      currentCell = ""
      continue
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && nextChar === "\n") {
        index += 1
      }
      currentRow.push(currentCell)
      rows.push(currentRow)
      currentRow = []
      currentCell = ""
      continue
    }

    currentCell += char
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell)
    rows.push(currentRow)
  }

  return rows
}

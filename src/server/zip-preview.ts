import { inflateRawSync } from "node:zlib"
import { ZIP_PREVIEW_LIMITS, zipEntryTextKind, type ZipListing, type ZipListingEntry } from "../shared/zip-preview"

/**
 * A zip read in place, for the viewer: the listing from the central
 * directory, and one text entry inflated in memory. Nothing is unpacked to
 * disk, and nothing is read but the end of the file, the directory, and the
 * one entry asked for. A small parser of our own rather than a library: the
 * ones that read the directory without extracting bring streams and a
 * filesystem API along, and this is the little of the format we need
 * (APPNOTE.TXT 4.3), zip64 included. Spanned archives and compression other
 * than stored or deflate are refused.
 *
 * Every size here is the archive's word, so each is checked before it is
 * used: the directory against its cap and the file's length, an entry's
 * sizes against the entry cap, and the inflated bytes against what the entry
 * declared (a zip bomb declares little and inflates to a lot).
 */

export class ZipPreviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Random access to the archive's bytes. */
export interface ZipSource {
  size: number
  read(start: number, end: number): Promise<Uint8Array>
}

export function bytesZipSource(bytes: Uint8Array): ZipSource {
  return { size: bytes.length, read: async (start, end) => bytes.subarray(start, end) }
}

export function fileZipSource(filePath: string): ZipSource {
  const file = Bun.file(filePath)
  return { size: file.size, read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()) }
}

interface CentralEntry extends ZipListingEntry {
  method: number
  crc32: number
  localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_LENGTH = 22
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_EOCD_LENGTH = 56
const CENTRAL_HEADER_LENGTH = 46
const LOCAL_HEADER_LENGTH = 30
const MAX_COMMENT_LENGTH = 0xffff

const corrupt = (detail: string) => new ZipPreviewError(422, `This zip looks damaged (${detail}).`)

export async function readZipListing(source: ZipSource): Promise<ZipListing> {
  const { entries, unsafeEntries } = await readCentralDirectory(source)
  let fileCount = 0
  let totalSize = 0
  const listed = entries.map(({ method: _method, crc32: _crc, localHeaderOffset: _offset, ...entry }) => {
    if (!entry.directory) {
      fileCount += 1
      totalSize += entry.size
    }
    return entry
  })
  return { entries: listed, fileCount, totalSize, unsafeEntries }
}

/** One text entry's bytes, inflated in memory. */
export async function readZipEntry(source: ZipSource, entryPath: string): Promise<Uint8Array> {
  const requested = normalizeEntryPath(entryPath)
  if (!requested || requested.unsafe || requested.directory) {
    throw new ZipPreviewError(400, "Invalid entry path.")
  }
  const { entries } = await readCentralDirectory(source)
  const entry = entries.find((candidate) => !candidate.directory && candidate.path === requested.path)
  if (!entry) throw new ZipPreviewError(404, "That file isn't in this zip.")
  if (!zipEntryTextKind(entry.path)) throw new ZipPreviewError(415, "Only text files inside a zip can be opened here.")
  if (entry.encrypted) throw new ZipPreviewError(422, "This file is encrypted.")
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipPreviewError(415, `This file is compressed in a way the viewer can't read (method ${entry.method}).`)
  }
  // Deflate can come out a little larger than its input, never by more than
  // a few bytes a block; stored is exactly its size.
  if (entry.size > ZIP_PREVIEW_LIMITS.entryBytes || entry.compressedSize > ZIP_PREVIEW_LIMITS.entryBytes + 64 * 1024) {
    throw new ZipPreviewError(413, `This file is too large to open here (${ZIP_PREVIEW_LIMITS.entryBytes / (1024 * 1024)} MB at most). Download the zip instead.`)
  }

  const header = await readExactly(source, entry.localHeaderOffset, LOCAL_HEADER_LENGTH, "local header out of range")
  const view = dataView(header)
  if (view.getUint32(0, true) !== LOCAL_SIGNATURE) throw corrupt("bad local header")
  const dataStart = entry.localHeaderOffset + LOCAL_HEADER_LENGTH + view.getUint16(26, true) + view.getUint16(28, true)
  const data = await readExactly(source, dataStart, entry.compressedSize, "entry data out of range")

  let bytes: Uint8Array
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw corrupt("stored entry sizes disagree")
    bytes = data
  } else {
    try {
      // The cap is the size the entry declared: a stream that inflates past
      // it stops there rather than filling memory.
      bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
    } catch (error) {
      if (error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ZipPreviewError(422, "This file inflates to more than it declares, so it wasn't opened.")
      }
      throw corrupt("entry won't inflate")
    }
  }
  if (bytes.length !== entry.size) throw corrupt("entry size doesn't match")
  if ((Bun.hash.crc32(bytes) >>> 0) !== entry.crc32) throw corrupt("checksum mismatch")
  return bytes
}

async function readCentralDirectory(source: ZipSource): Promise<{ entries: CentralEntry[]; unsafeEntries: number }> {
  if (source.size < EOCD_LENGTH) throw new ZipPreviewError(422, "This file isn't a zip.")

  // The end record is the last 22 bytes, unless the archive has a comment
  // after it (up to 64 KB). The zip64 locator, if any, sits just before it.
  const tailStart = Math.max(0, source.size - (EOCD_LENGTH + MAX_COMMENT_LENGTH + ZIP64_LOCATOR_LENGTH))
  const tail = await source.read(tailStart, source.size)
  const tailView = dataView(tail)
  let eocd = -1
  for (let offset = tail.length - EOCD_LENGTH; offset >= 0; offset -= 1) {
    if (tailView.getUint32(offset, true) !== EOCD_SIGNATURE) continue
    // The comment's length is the check that this is the record and not
    // the same four bytes inside the comment.
    if (offset + EOCD_LENGTH + tailView.getUint16(offset + 20, true) <= tail.length) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new ZipPreviewError(422, "This file isn't a zip.")

  let disk = tailView.getUint16(eocd + 4, true)
  let directoryDisk = tailView.getUint16(eocd + 6, true)
  let entryCount = tailView.getUint16(eocd + 10, true)
  let directorySize = tailView.getUint32(eocd + 12, true)
  let directoryOffset = tailView.getUint32(eocd + 16, true)

  const locator = eocd - ZIP64_LOCATOR_LENGTH
  if (locator >= 0 && tailView.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
    if (tailView.getUint32(locator + 16, true) > 1) throw new ZipPreviewError(422, "Split zips can't be listed.")
    const recordOffset = readUint64(tailView, locator + 8)
    const record = await readExactly(source, recordOffset, ZIP64_EOCD_LENGTH, "zip64 record out of range")
    const recordView = dataView(record)
    if (recordView.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) throw corrupt("bad zip64 record")
    disk = recordView.getUint32(16, true)
    directoryDisk = recordView.getUint32(20, true)
    entryCount = readUint64(recordView, 32)
    directorySize = readUint64(recordView, 40)
    directoryOffset = readUint64(recordView, 48)
  } else if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw corrupt("zip64 sizes without a zip64 record")
  }

  if (disk !== 0 || directoryDisk !== 0) throw new ZipPreviewError(422, "Split zips can't be listed.")
  if (entryCount > ZIP_PREVIEW_LIMITS.entries) {
    throw new ZipPreviewError(413, `This zip has ${entryCount.toLocaleString("en-US")} entries; the viewer lists up to ${ZIP_PREVIEW_LIMITS.entries.toLocaleString("en-US")}. Download it instead.`)
  }
  if (directorySize > ZIP_PREVIEW_LIMITS.centralDirectoryBytes) {
    throw new ZipPreviewError(413, "This zip's index is too large to list. Download it instead.")
  }
  if (directoryOffset + directorySize > source.size) throw corrupt("index out of range")

  const directory = await source.read(directoryOffset, directoryOffset + directorySize)
  const view = dataView(directory)
  const entries: CentralEntry[] = []
  let unsafeEntries = 0
  let offset = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + CENTRAL_HEADER_LENGTH > directory.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw corrupt("index cut short")
    }
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const dosTime = view.getUint16(offset + 12, true)
    const dosDate = view.getUint16(offset + 14, true)
    const crc32 = view.getUint32(offset + 16, true)
    let compressedSize = view.getUint32(offset + 20, true)
    let size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    let localHeaderOffset = view.getUint32(offset + 42, true)
    const nameStart = offset + CENTRAL_HEADER_LENGTH
    const extraStart = nameStart + nameLength
    const next = extraStart + extraLength + commentLength
    if (next > directory.length) throw corrupt("index cut short")

    const rawName = directory.subarray(nameStart, extraStart)
    let name = decodeName(rawName, (flags & 0x0800) !== 0)
    let modifiedAt = dosDateTime(dosDate, dosTime)

    for (let extra = extraStart; extra + 4 <= extraStart + extraLength;) {
      const id = view.getUint16(extra, true)
      const length = view.getUint16(extra + 2, true)
      const body = extra + 4
      if (body + length > extraStart + extraLength) throw corrupt("bad extra field")
      if (id === 0x0001) {
        // Zip64: the 8-byte values, in this order, for exactly the fields
        // that were too big for their 4 bytes.
        let field = body
        const take = () => {
          if (field + 8 > body + length) throw corrupt("short zip64 field")
          const value = readUint64(view, field)
          field += 8
          return value
        }
        if (size === 0xffffffff) size = take()
        if (compressedSize === 0xffffffff) compressedSize = take()
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = take()
      } else if (id === 0x5455 && length >= 5 && (view.getUint8(body) & 1)) {
        // Extended timestamp: the modified time in UTC, where the DOS one is local.
        modifiedAt = new Date(view.getUint32(body + 1, true) * 1000).toISOString()
      } else if (id === 0x7075 && length >= 5 && view.getUint8(body) === 1) {
        // Info-ZIP's UTF-8 name, for an archive whose main name is in a
        // legacy code page. Only while it still describes that name.
        if (view.getUint32(body + 1, true) === (Bun.hash.crc32(rawName) >>> 0)) {
          name = new TextDecoder().decode(directory.subarray(body + 5, body + length))
        }
      }
      extra = body + length
    }

    offset = next
    const normalized = normalizeEntryPath(name)
    if (!normalized) continue
    if (normalized.unsafe) {
      unsafeEntries += 1
      continue
    }
    entries.push({
      path: normalized.path,
      directory: normalized.directory,
      size,
      compressedSize,
      modifiedAt,
      // Bit 0 for any encryption, bit 6 for strong encryption.
      encrypted: (flags & 0x0041) !== 0,
      method,
      crc32,
      localHeaderOffset,
    })
  }
  return { entries, unsafeEntries }
}

/**
 * An entry's name as a relative path: `/` between folders, no `.` segments
 * or doubled slashes. Unsafe when it starts at a root (`/`, `C:`) or climbs
 * with `..`: the same check guards the one entry a request names. Null for a
 * name that is nothing at all once cleaned.
 */
export function normalizeEntryPath(name: string): { path: string; directory: boolean; unsafe: boolean } | null {
  const slashed = name.replace(/\\/g, "/")
  const directory = slashed.endsWith("/")
  const unsafe = slashed.startsWith("/") || /^[a-z]:/i.test(slashed) || slashed.includes("\0")
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".")
  if (segments.length === 0) return null
  return { path: segments.join("/"), directory, unsafe: unsafe || segments.includes("..") }
}

// IBM code page 437, bytes 0x80 to 0xFF: what a zip's names are in unless
// the archive marks them UTF-8.
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "

function decodeName(bytes: Uint8Array, utf8: boolean) {
  if (utf8) return new TextDecoder().decode(bytes)
  // Many tools write UTF-8 without setting the flag. Valid UTF-8 with
  // anything above ASCII is very unlikely to be meant as CP437.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return Array.from(bytes, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!)).join("")
  }
}

/** A DOS date and time, which carry no zone: the local time the archive was made in. */
function dosDateTime(date: number, time: number): string | null {
  const month = (date >> 5) & 0x0f
  const day = date & 0x1f
  if (date === 0 || month < 1 || month > 12 || day < 1) return null
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${(date >> 9) + 1980}-${pad(month)}-${pad(day)}T${pad(time >> 11)}:${pad((time >> 5) & 0x3f)}:${pad(Math.min(59, (time & 0x1f) * 2))}`
}

function readUint64(view: DataView, offset: number) {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt("size out of range")
  return Number(value)
}

async function readExactly(source: ZipSource, start: number, length: number, detail: string) {
  if (start + length > source.size) throw corrupt(detail)
  const bytes = await source.read(start, start + length)
  if (bytes.length !== length) throw corrupt(detail)
  return bytes
}

function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * The answer to `?zip=` on a route that has already found the file and
 * checked the request may see it, or null when the request didn't ask.
 * `list` is the listing as JSON; `entry&path=` one text entry's bytes, as
 * plain text that is never rendered as a page.
 */
export async function zipPreviewResponse(url: URL, filePath: string): Promise<Response | null> {
  const mode = url.searchParams.get("zip")
  if (mode === null) return null
  try {
    const source = fileZipSource(filePath)
    if (mode === "list") {
      return Response.json(await readZipListing(source), { headers: { "Cache-Control": "no-store" } })
    }
    if (mode === "entry") {
      const entryPath = url.searchParams.get("path")
      if (!entryPath) throw new ZipPreviewError(400, "Invalid entry path.")
      return new Response(await readZipEntry(source, entryPath), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Cache-Control": "no-store",
        },
      })
    }
    throw new ZipPreviewError(400, "Unknown zip request.")
  } catch (error) {
    if (error instanceof ZipPreviewError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } })
    }
    console.error("[zip-preview] Failed to read zip:", error)
    return Response.json({ error: "Couldn't read this zip." }, { status: 500, headers: { "Cache-Control": "no-store" } })
  }
}

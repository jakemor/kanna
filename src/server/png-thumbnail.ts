import { Readable, Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { crc32, createInflate, deflateSync } from "node:zlib"
import { Effect, FileSystem, Option, Schema, Stream } from "effect"

/**
 * Shrinks a PNG without ever holding it decoded.
 *
 * An app icon's source is a 1024x1024 PNG: 4 MB of pixels once decoded, for a
 * mark drawn 16px wide. A PNG's rows come out of its zlib stream top to
 * bottom, and undoing a row's filter needs only the row above it. So the file
 * is read in pieces, inflated as a stream, and each row is averaged into the
 * thumbnail's row as it arrives. Two source rows and one thumbnail row of
 * sums are all that is held, about 20 KB for a 1024px icon.
 *
 * Interlaced PNGs deliver rows in seven passes rather than in order, so they
 * are refused (`UnsupportedPngError`) and the caller finds another way.
 *
 * The row work is plain code driven by node's zlib stream; the pipeline is
 * cancelled through `writePngThumbnail`'s Effect interruption signal.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const READ_CHUNK_BYTES = 64 * 1024

/** A PNG this reader can't stream: interlaced, malformed, or not a PNG. */
export class UnsupportedPngError extends Schema.TaggedError<UnsupportedPngError>()(
  "@kanna/server/png-thumbnail/UnsupportedPngError",
  {
    filePath: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason
  }
}

export class PngFileError extends Schema.TaggedError<PngFileError>()(
  "@kanna/server/png-thumbnail/PngFileError",
  {
    operation: Schema.Literals(["read", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Thrown inside the node stream pipeline, where there is no Effect, and
 * turned into `UnsupportedPngError` where the pipeline is run.
 */
class PngFormatError extends Error {}

export interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlaced: boolean
}

/** Samples per pixel for each PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function parseHeader(bytes: Buffer): PngHeader | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24]!,
    colorType: bytes[25]!,
    interlaced: bytes[28] !== 0,
  }
}

/** The size of a PNG from its first 33 bytes, or null when it isn't one. */
export const readPngHeader = Effect.fn("PngThumbnail.readPngHeader")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* Effect.scoped(
    fs.open(filePath, { flag: "r" }).pipe(Effect.flatMap((file) => file.readAlloc(33))),
  ).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(new PngFileError({ operation: "read", filePath, cause }))),
  )
  return Option.match(bytes, {
    onNone: (): PngHeader | null => null,
    onSome: (read) => parseHeader(Buffer.from(read.buffer, read.byteOffset, read.byteLength)),
  })
})

interface PngParts {
  header: PngHeader | null
  palette: Buffer | null
  /** Per palette entry for colour type 3. */
  paletteAlpha: Buffer | null
}

/**
 * Walks the file's chunks and emits the IDAT payloads, which together are
 * one zlib stream. Fills `parts` from the chunks ahead of the first IDAT.
 */
class ImageDataReader extends Transform {
  private pending: Buffer = Buffer.alloc(0)
  private signatureSeen = false
  // Bytes of the current chunk's payload still to come, and its trailing CRC.
  private payloadLeft = 0
  private skipLeft = 0
  private chunkType = ""
  private collected: Buffer[] = []
  private done = false

  constructor(private readonly parts: PngParts) {
    super()
  }

  override _transform(piece: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    // Node's stream callback is the boundary for parser exceptions.
    try {
      this.consume(piece)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  private consume(piece: Buffer) {
    if (this.done) return
    const pending = this.pending.length ? Buffer.concat([this.pending, piece]) : piece
    let offset = 0
    while (offset < pending.length) {
      if (!this.signatureSeen) {
        if (pending.length - offset < 8) break
        if (!pending.subarray(offset, offset + 8).equals(PNG_SIGNATURE)) throw new PngFormatError("Not a PNG")
        this.signatureSeen = true
        offset += 8
        continue
      }
      if (this.skipLeft > 0) {
        const skipped = Math.min(this.skipLeft, pending.length - offset)
        this.skipLeft -= skipped
        offset += skipped
        continue
      }
      if (this.payloadLeft > 0) {
        const taken = Math.min(this.payloadLeft, pending.length - offset)
        const payload = pending.subarray(offset, offset + taken)
        this.payloadLeft -= taken
        offset += taken
        if (this.chunkType === "IDAT") {
          this.push(payload)
        } else if (this.chunkType === "IHDR" || this.chunkType === "PLTE" || this.chunkType === "tRNS") {
          this.collected.push(payload)
        }
        if (this.payloadLeft === 0) {
          this.skipLeft = 4
          if (this.chunkType === "IHDR") {
            this.parts.header = parseIhdrPayload(Buffer.concat(this.collected))
          } else if (this.chunkType === "PLTE") {
            this.parts.palette = Buffer.concat(this.collected)
          } else if (this.chunkType === "tRNS") {
            this.parts.paletteAlpha = Buffer.concat(this.collected)
          }
          this.collected = []
        }
        continue
      }
      if (pending.length - offset < 8) break
      this.payloadLeft = pending.readUInt32BE(offset)
      this.chunkType = pending.toString("latin1", offset + 4, offset + 8)
      offset += 8
      if (this.chunkType === "IEND") {
        this.done = true
        break
      }
      if (this.payloadLeft === 0) this.skipLeft = 4
    }
    // Copied, not sliced: a slice would pin the whole 64 KB piece.
    this.pending = !this.done && offset < pending.length ? Buffer.from(pending.subarray(offset)) : Buffer.alloc(0)
  }
}

function parseIhdrPayload(payload: Buffer): PngHeader | null {
  if (payload.length < 13) return null
  return {
    width: payload.readUInt32BE(0),
    height: payload.readUInt32BE(4),
    bitDepth: payload[8]!,
    colorType: payload[9]!,
    interlaced: payload[12] !== 0,
  }
}

function paeth(left: number, above: number, aboveLeft: number) {
  const estimate = left + above - aboveLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const aboveLeftDistance = Math.abs(estimate - aboveLeft)
  if (leftDistance <= aboveDistance && leftDistance <= aboveLeftDistance) return left
  return aboveDistance <= aboveLeftDistance ? above : aboveLeft
}

/** Undoes a row's filter in place. `stride` is the bytes in one pixel, at least 1. */
function unfilterRow(filter: number, row: Uint8Array, above: Uint8Array, stride: number) {
  const length = row.length
  switch (filter) {
    case 0:
      return
    case 1:
      for (let index = stride; index < length; index += 1) row[index] = (row[index]! + row[index - stride]!) & 0xff
      return
    case 2:
      for (let index = 0; index < length; index += 1) row[index] = (row[index]! + above[index]!) & 0xff
      return
    case 3:
      for (let index = 0; index < length; index += 1) {
        const left = index >= stride ? row[index - stride]! : 0
        row[index] = (row[index]! + ((left + above[index]!) >> 1)) & 0xff
      }
      return
    case 4:
      for (let index = 0; index < length; index += 1) {
        const left = index >= stride ? row[index - stride]! : 0
        const aboveLeft = index >= stride ? above[index - stride]! : 0
        row[index] = (row[index]! + paeth(left, above[index]!, aboveLeft)) & 0xff
      }
      return
    default:
      throw new PngFormatError(`Unknown PNG filter ${filter}`)
  }
}

/**
 * Receives inflated bytes, cuts them into rows, and box-averages each row into
 * the thumbnail. Colour is averaged weighted by alpha, so a transparent edge
 * doesn't darken the pixels beside it.
 */
class RowAverager extends Writable {
  private header: PngHeader | null = null
  private row: Uint8Array = new Uint8Array(0)
  private above: Uint8Array = new Uint8Array(0)
  private rowFill = 0
  private filter = -1
  private y = 0
  private stride = 1
  private columnOf: Uint16Array = new Uint16Array(0)
  /** Per thumbnail column: alpha-weighted r, g, b, then alpha. */
  private sums: Float64Array = new Float64Array(0)
  private counts: Uint32Array = new Uint32Array(0)
  private outRow = 0
  outWidth = 0
  outHeight = 0
  /** RGBA, `outWidth * outHeight * 4`. */
  pixels: Uint8Array = new Uint8Array(0)

  constructor(
    private readonly parts: PngParts,
    private readonly maxSize: number,
    private readonly background: Background | null
  ) {
    super()
  }

  private begin() {
    const header = this.parts.header
    if (!header) throw new PngFormatError("PNG has no header")
    const channels = CHANNELS[header.colorType]
    const { bitDepth, width, height } = header
    const depthOk = bitDepth === 8 || bitDepth === 16
      || ((header.colorType === 0 || header.colorType === 3) && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4))
    if (!channels || !depthOk || header.interlaced || width === 0 || height === 0) {
      throw new PngFormatError("Unsupported PNG layout")
    }
    if (header.colorType === 3 && (bitDepth === 16 || !this.parts.palette)) {
      throw new PngFormatError("Unsupported PNG palette")
    }
    this.header = header
    this.stride = Math.max(1, (channels * bitDepth) >> 3)
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
    this.row = new Uint8Array(rowBytes)
    this.above = new Uint8Array(rowBytes)

    const scale = Math.min(1, this.maxSize / Math.max(width, height))
    this.outWidth = Math.max(1, Math.round(width * scale))
    this.outHeight = Math.max(1, Math.round(height * scale))
    this.columnOf = new Uint16Array(width)
    for (let x = 0; x < width; x += 1) this.columnOf[x] = Math.floor((x * this.outWidth) / width)
    this.sums = new Float64Array(this.outWidth * 4)
    this.counts = new Uint32Array(this.outWidth)
    this.pixels = new Uint8Array(this.outWidth * this.outHeight * 4)
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      if (!this.header) this.begin()
      const height = this.header!.height
      let offset = 0
      while (offset < chunk.length && this.y < height) {
        if (this.filter < 0) {
          this.filter = chunk[offset]!
          offset += 1
          continue
        }
        const taken = Math.min(this.row.length - this.rowFill, chunk.length - offset)
        this.row.set(chunk.subarray(offset, offset + taken), this.rowFill)
        this.rowFill += taken
        offset += taken
        if (this.rowFill < this.row.length) break
        unfilterRow(this.filter, this.row, this.above, this.stride)
        this.addRow()
        const finished = this.row
        this.row = this.above
        this.above = finished
        this.rowFill = 0
        this.filter = -1
        this.y += 1
      }
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    if (!this.header || this.y < this.header.height) {
      callback(new PngFormatError("PNG ended early"))
      return
    }
    this.flushRow()
    callback()
  }

  private addRow() {
    const header = this.header!
    const target = Math.floor((this.y * this.outHeight) / header.height)
    if (target !== this.outRow) {
      this.flushRow()
      this.outRow = target
    }
    const { row, sums, counts, columnOf } = this
    const { width, colorType, bitDepth } = header
    // 16-bit samples are big-endian; the high byte is the 8-bit value.
    const step = bitDepth === 16 ? 2 : 1
    const palette = this.parts.palette
    const paletteAlpha = this.parts.paletteAlpha
    const sampleMask = (1 << bitDepth) - 1
    for (let x = 0; x < width; x += 1) {
      let red: number
      let green: number
      let blue: number
      let alpha = 255
      if (colorType === 6) {
        const at = x * 4 * step
        red = row[at]!
        green = row[at + step]!
        blue = row[at + step * 2]!
        alpha = row[at + step * 3]!
      } else if (colorType === 2) {
        const at = x * 3 * step
        red = row[at]!
        green = row[at + step]!
        blue = row[at + step * 2]!
      } else if (colorType === 4) {
        const at = x * 2 * step
        red = green = blue = row[at]!
        alpha = row[at + step]!
      } else {
        // Grey or palette: one sample, possibly packed several to a byte.
        const sample = bitDepth >= 8
          ? row[x * step]!
          : (row[(x * bitDepth) >> 3]! >> (8 - bitDepth - ((x * bitDepth) & 7))) & sampleMask
        if (colorType === 3) {
          const at = sample * 3
          red = palette![at] ?? 0
          green = palette![at + 1] ?? 0
          blue = palette![at + 2] ?? 0
          alpha = paletteAlpha && sample < paletteAlpha.length ? paletteAlpha[sample]! : 255
        } else {
          red = green = blue = bitDepth >= 8 ? sample : Math.round((sample * 255) / sampleMask)
        }
      }
      const column = columnOf[x]!
      const at = column * 4
      sums[at] += red * alpha
      sums[at + 1] += green * alpha
      sums[at + 2] += blue * alpha
      sums[at + 3] += alpha
      counts[column] += 1
    }
  }

  private flushRow() {
    const { sums, counts, pixels, background } = this
    const base = this.outRow * this.outWidth * 4
    for (let column = 0; column < this.outWidth; column += 1) {
      const at = column * 4
      const alphaSum = sums[at + 3]!
      const count = counts[column]!
      if (count === 0) continue
      const alpha = alphaSum / count
      if (background) {
        // Over an opaque colour: the averaged colour weighs in by its alpha.
        const cover = alpha / 255
        for (let channel = 0; channel < 3; channel += 1) {
          const color = alphaSum > 0 ? sums[at + channel]! / alphaSum : 0
          pixels[base + at + channel] = Math.round(color * cover + background[channel]! * (1 - cover))
        }
        pixels[base + at + 3] = 255
      } else if (alphaSum > 0) {
        pixels[base + at] = Math.round(sums[at]! / alphaSum)
        pixels[base + at + 1] = Math.round(sums[at + 1]! / alphaSum)
        pixels[base + at + 2] = Math.round(sums[at + 2]! / alphaSum)
        pixels[base + at + 3] = Math.round(alpha)
      }
    }
    sums.fill(0)
    counts.fill(0)
  }
}

function pngChunk(type: string, payload: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), payload])
  const chunk = Buffer.alloc(body.length + 8)
  chunk.writeUInt32BE(payload.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body) >>> 0, body.length + 4)
  return chunk
}

/** An 8-bit RGBA PNG from raw pixels. */
export function encodePng(width: number, height: number, pixels: Uint8Array) {
  const rowBytes = width * 4
  const raw = Buffer.alloc((rowBytes + 1) * height)
  const noRow = new Uint8Array(rowBytes)
  const attempt = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes)
    const above = y > 0 ? pixels.subarray((y - 1) * rowBytes, y * rowBytes) : noRow
    // Each row takes whichever filter leaves the smallest residue, the usual
    // heuristic. An icon's gradients deflate to about half the size for it.
    let bestCost = Infinity
    for (const filter of [0, 1, 2, 4]) {
      let cost = 0
      for (let index = 0; index < rowBytes; index += 1) {
        const left = index >= 4 ? row[index - 4]! : 0
        const predicted = filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above[index]!
              : paeth(left, above[index]!, index >= 4 ? above[index - 4]! : 0)
        const residue = (row[index]! - predicted) & 0xff
        attempt[index] = residue
        cost += residue < 128 ? residue : 256 - residue
      }
      if (cost < bestCost) {
        bestCost = cost
        raw[y * (rowBytes + 1)] = filter
        raw.set(attempt, y * (rowBytes + 1) + 1)
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

/** An opaque colour to lay the image over, 0-255 per channel. */
export type Background = readonly [number, number, number]

/**
 * Writes `sourcePath` to `targetPath` scaled to fit `maxSize` pixels on its
 * longer side, over `background` when one is given. Never scales up. Fails
 * with `UnsupportedPngError` for a PNG this can't stream (interlaced, or
 * malformed).
 */
export const writePngThumbnail = Effect.fn("PngThumbnail.writePngThumbnail")(function* (
  sourcePath: string,
  targetPath: string,
  maxSize: number,
  background?: Background,
) {
  const fs = yield* FileSystem.FileSystem
  const parts: PngParts = { header: null, palette: null, paletteAlpha: null }
  const averager = new RowAverager(parts, maxSize, background ?? null)
  yield* Effect.tryPromise({
    // The file system's stream feeds zlib with bounded chunks; the Effect
    // signal closes the whole pipeline (and with it the file) on interruption.
    try: (signal) => pipeline(
      Readable.from(
        Stream.toAsyncIterable(fs.stream(sourcePath, { chunkSize: READ_CHUNK_BYTES }).pipe(
          Stream.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
        )),
        { objectMode: false },
      ),
      new ImageDataReader(parts),
      createInflate(),
      averager,
      { signal },
    ),
    // A zlib or read error is a broken file, which is the caller's "find
    // another way" too.
    catch: (error) => new UnsupportedPngError({
      filePath: sourcePath,
      reason: error instanceof Error ? error.message : String(error),
    }),
  })
  yield* fs.writeFile(targetPath, encodePng(averager.outWidth, averager.outHeight, averager.pixels)).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new PngFileError({ operation: "write", filePath: targetPath, cause }))),
  )
  return { width: averager.outWidth, height: averager.outHeight }
})

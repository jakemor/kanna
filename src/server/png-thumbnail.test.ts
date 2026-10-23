import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { crc32, deflateSync, inflateSync } from "node:zlib"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import { encodePng, readPngHeader, writePngThumbnail } from "./png-thumbnail"

const dir = await mkdtemp(path.join(tmpdir(), "kanna-png-"))
afterAll(() => rm(dir, { recursive: true, force: true }))

function chunk(type: string, payload: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), payload])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(payload.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body) >>> 0, body.length + 4)
  return out
}

/**
 * A PNG built by hand, so the reader is tested against filters and layouts
 * the encoder here never writes. `idatSize` splits the zlib stream across
 * IDAT chunks, as real encoders do.
 */
function buildPng(args: {
  width: number
  height: number
  bitDepth?: number
  colorType: number
  rows: Buffer[]
  filter?: number
  interlaced?: boolean
  palette?: Buffer
  paletteAlpha?: Buffer
  idatSize?: number
}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(args.width, 0)
  header.writeUInt32BE(args.height, 4)
  header[8] = args.bitDepth ?? 8
  header[9] = args.colorType
  header[12] = args.interlaced ? 1 : 0
  const stride = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[args.colorType]! * (args.bitDepth ?? 8)) >> 3)
  const filter = args.filter ?? 0
  const raw: Buffer[] = []
  let above: Buffer = Buffer.alloc(args.rows[0]!.length)
  for (const row of args.rows) {
    const filtered = Buffer.alloc(row.length)
    for (let index = 0; index < row.length; index += 1) {
      const left = index >= stride ? row[index - stride]! : 0
      const up = above[index]!
      const upLeft = index >= stride ? above[index - stride]! : 0
      const estimate = left + up - upLeft
      const paeth = Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
        ? left
        : Math.abs(estimate - up) <= Math.abs(estimate - upLeft) ? up : upLeft
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!
      filtered[index] = (row[index]! - predicted) & 0xff
    }
    raw.push(Buffer.from([filter]), filtered)
    above = row
  }
  const data = deflateSync(Buffer.concat(raw))
  const idats: Buffer[] = []
  const size = args.idatSize ?? data.length
  for (let offset = 0; offset < data.length; offset += size) idats.push(chunk("IDAT", data.subarray(offset, offset + size)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(args.palette ? [chunk("PLTE", args.palette)] : []),
    ...(args.paletteAlpha ? [chunk("tRNS", args.paletteAlpha)] : []),
    ...idats,
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Pixels of a PNG `encodePng` wrote. */
function decodeOwn(bytes: Buffer) {
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const length = bytes.readUInt32BE(33)
  const raw = inflateSync(bytes.subarray(41, 41 + length))
  const rowBytes = width * 4
  const pixels: number[][] = []
  let above = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)]!
    const row = new Uint8Array(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)))
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= 4 ? row[index - 4]! : 0
      const up = above[index]!
      const upLeft = index >= 4 ? above[index - 4]! : 0
      const estimate = left + up - upLeft
      const paeth = Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
        ? left
        : Math.abs(estimate - up) <= Math.abs(estimate - upLeft) ? up : upLeft
      row[index] = (row[index]! + [0, left, up, 0, paeth][filter]!) & 0xff
    }
    for (let x = 0; x < width; x += 1) pixels.push([...row.subarray(x * 4, x * 4 + 4)])
    above = row
  }
  return { width, height, pixels }
}

async function thumbnail(name: string, png: Buffer, maxSize: number) {
  const source = path.join(dir, `${name}.png`)
  const target = path.join(dir, `${name}.out.png`)
  await writeFile(source, png)
  await runTest(writePngThumbnail(source, target, maxSize))
  return decodeOwn(await readFile(target))
}

async function expectUnsupported(effect: ReturnType<typeof writePngThumbnail>) {
  const result = await runTest(Effect.result(effect))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("@kanna/server/png-thumbnail/UnsupportedPngError")
  }
}

/** Left half red, right half blue, top half opaque, bottom half clear. */
function quadrantRows(size: number) {
  return Array.from({ length: size }, (_, y) => {
    const row = Buffer.alloc(size * 4)
    for (let x = 0; x < size; x += 1) {
      row.set(x < size / 2 ? [200, 10, 10] : [10, 10, 200], x * 4)
      row[x * 4 + 3] = y < size / 2 ? 255 : 0
    }
    return row
  })
}

describe("writePngThumbnail", () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    test(`averages RGBA rows written with filter ${filter}`, async () => {
      const png = buildPng({ width: 64, height: 64, colorType: 6, rows: quadrantRows(64), filter, idatSize: 97 })
      const result = await thumbnail(`quad-${filter}`, png, 2)
      expect(result.width).toBe(2)
      expect(result.height).toBe(2)
      expect(result.pixels).toEqual([
        [200, 10, 10, 255],
        [10, 10, 200, 255],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ])
    })
  }

  test("weights colour by alpha, so a clear pixel doesn't tint its neighbour", async () => {
    const row = Buffer.from([255, 0, 0, 255, 0, 255, 0, 0])
    const result = await thumbnail("alpha", buildPng({ width: 2, height: 1, colorType: 6, rows: [row] }), 1)
    expect(result.pixels).toEqual([[255, 0, 0, 128]])
  })

  test("draws over a background when given one", async () => {
    const source = path.join(dir, "over.png")
    const target = path.join(dir, "over.out.png")
    await writeFile(source, buildPng({ width: 64, height: 64, colorType: 6, rows: quadrantRows(64) }))
    await runTest(writePngThumbnail(source, target, 2, [0, 100, 0]))
    expect(decodeOwn(await readFile(target)).pixels).toEqual([
      [200, 10, 10, 255],
      [10, 10, 200, 255],
      [0, 100, 0, 255],
      [0, 100, 0, 255],
    ])
  })

  test("keeps the aspect ratio and never scales up", async () => {
    const rows = Array.from({ length: 10 }, () => Buffer.alloc(40 * 3, 90))
    const wide = await thumbnail("wide", buildPng({ width: 40, height: 10, colorType: 2, rows }), 20)
    expect([wide.width, wide.height]).toEqual([20, 5])
    expect(wide.pixels[0]).toEqual([90, 90, 90, 255])
    const small = await thumbnail("small", buildPng({ width: 40, height: 10, colorType: 2, rows }), 96)
    expect([small.width, small.height]).toEqual([40, 10])
  })

  test("reads palette, packed grey and 16-bit samples", async () => {
    const palette = await thumbnail("palette", buildPng({
      width: 2,
      height: 1,
      colorType: 3,
      rows: [Buffer.from([1, 0])],
      palette: Buffer.from([0, 0, 0, 30, 60, 90]),
      paletteAlpha: Buffer.from([0]),
    }), 2)
    expect(palette.pixels).toEqual([[30, 60, 90, 255], [0, 0, 0, 0]])

    // Eight 1-bit pixels in one byte: white, black, white, black...
    const grey = await thumbnail("grey", buildPng({ width: 8, height: 1, bitDepth: 1, colorType: 0, rows: [Buffer.from([0b10101010])] }), 8)
    expect(grey.pixels.map((pixel) => pixel[0])).toEqual([255, 0, 255, 0, 255, 0, 255, 0])

    const deep = await thumbnail("deep", buildPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 6,
      rows: [Buffer.from([0x12, 0xff, 0x34, 0xff, 0x56, 0xff, 0xff, 0xff])],
    }), 1)
    expect(deep.pixels).toEqual([[0x12, 0x34, 0x56, 255]])
  })

  test("shrinks a 1024px icon to a few kilobytes", async () => {
    const rows = Array.from({ length: 1024 }, (_, y) => {
      const row = Buffer.alloc(1024 * 4)
      for (let x = 0; x < 1024; x += 1) row.set([x >> 2, y >> 2, 128, 255], x * 4)
      return row
    })
    const source = path.join(dir, "big.png")
    const target = path.join(dir, "big.out.png")
    await writeFile(source, buildPng({ width: 1024, height: 1024, colorType: 6, rows, filter: 4, idatSize: 8192 }))
    expect(await runTest(writePngThumbnail(source, target, 96))).toEqual({ width: 96, height: 96 })
    const output = await readFile(target)
    expect(output.length).toBeLessThan(20_000)
    expect(await runTest(readPngHeader(target))).toMatchObject({ width: 96, height: 96, colorType: 6 })
  })

  test("refuses interlaced and broken files", async () => {
    const interlaced = path.join(dir, "interlaced.png")
    await writeFile(interlaced, buildPng({ width: 2, height: 1, colorType: 6, rows: [Buffer.alloc(8)], interlaced: true }))
    await expectUnsupported(writePngThumbnail(interlaced, path.join(dir, "x.png"), 1))

    const truncated = path.join(dir, "truncated.png")
    await writeFile(truncated, buildPng({ width: 64, height: 64, colorType: 6, rows: quadrantRows(64) }).subarray(0, 120))
    await expectUnsupported(writePngThumbnail(truncated, path.join(dir, "y.png"), 8))

    const text = path.join(dir, "text.png")
    await writeFile(text, "not a png at all, just some text")
    await expectUnsupported(writePngThumbnail(text, path.join(dir, "z.png"), 8))
    expect(await runTest(readPngHeader(text))).toBeNull()

    // A missing source is a file this can't stream, like a broken one.
    await expectUnsupported(writePngThumbnail(path.join(dir, "missing.png"), path.join(dir, "w.png"), 8))
  })

  test("reading the header of a missing file fails with its path", async () => {
    const missing = path.join(dir, "no-such.png")
    const result = await runTest(Effect.result(readPngHeader(missing)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/png-thumbnail/PngFileError")
      expect(result.failure.filePath).toBe(missing)
    }
  })

  test("an empty file has no PNG header", async () => {
    const empty = path.join(dir, "empty.png")
    await writeFile(empty, "")
    expect(await runTest(readPngHeader(empty))).toBeNull()
  })

  test("encodePng round-trips", () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(decodeOwn(encodePng(2, 1, pixels)).pixels).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]])
  })
})

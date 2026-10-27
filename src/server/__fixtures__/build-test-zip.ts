import { deflateRawSync } from "node:zlib"

/**
 * A zip written by hand, for tests that need archives a real tool won't
 * make: zip64 records on a small file, a flag set with no encryption behind
 * it, an entry that lies about its size.
 */
export interface TestZipEntry {
  name: string
  data?: Uint8Array | string
  /** 8 (deflate, the default) or 0 (stored). */
  method?: number
  flags?: number
  /** What the directory says it unpacks to, when that isn't the truth. */
  declaredSize?: number
  /** A DOS date, as `[year, month, day, hour, minute, second]`. */
  modified?: [number, number, number, number, number, number]
  extra?: Uint8Array
}

export function buildTestZip(entries: TestZipEntry[], options: { zip64?: boolean; comment?: string; declaredCount?: number } = {}): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data ?? new Uint8Array()
    const method = entry.method ?? 8
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw
    const crc = Bun.hash.crc32(raw) >>> 0
    const size = entry.declaredSize ?? raw.length
    const [year, month, day, hour, minute, second] = entry.modified ?? [2024, 3, 15, 10, 30, 20]
    const dosDate = ((year - 1980) << 9) | (month << 5) | day
    const dosTime = (hour << 11) | (minute << 5) | (second / 2)
    const flags = (entry.flags ?? 0) | 0x0800

    const local = new Uint8Array(30 + name.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, flags, true)
    localView.setUint16(8, method, true)
    localView.setUint16(10, dosTime, true)
    localView.setUint16(12, dosDate, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, size, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    locals.push(local, data)

    let extra = entry.extra ?? new Uint8Array()
    if (options.zip64) {
      const zip64 = new Uint8Array(4 + 24)
      const zip64View = new DataView(zip64.buffer)
      zip64View.setUint16(0, 0x0001, true)
      zip64View.setUint16(2, 24, true)
      zip64View.setBigUint64(4, BigInt(size), true)
      zip64View.setBigUint64(12, BigInt(data.length), true)
      zip64View.setBigUint64(20, BigInt(offset), true)
      extra = concat([zip64, extra])
    }
    const central = new Uint8Array(46 + name.length + extra.length)
    const view = new DataView(central.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 0x031e, true)
    view.setUint16(6, options.zip64 ? 45 : 20, true)
    view.setUint16(8, flags, true)
    view.setUint16(10, method, true)
    view.setUint16(12, dosTime, true)
    view.setUint16(14, dosDate, true)
    view.setUint32(16, crc, true)
    view.setUint32(20, options.zip64 ? 0xffffffff : data.length, true)
    view.setUint32(24, options.zip64 ? 0xffffffff : size, true)
    view.setUint16(28, name.length, true)
    view.setUint16(30, extra.length, true)
    view.setUint32(42, options.zip64 ? 0xffffffff : offset, true)
    central.set(name, 46)
    central.set(extra, 46 + name.length)
    centrals.push(central)

    offset += local.length + data.length
  }

  const directory = concat(centrals)
  const directoryOffset = offset
  const count = options.declaredCount ?? entries.length
  const tail: Uint8Array[] = []
  if (options.zip64) {
    const record = new Uint8Array(56)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x06064b50, true)
    recordView.setBigUint64(4, 44n, true)
    recordView.setUint16(12, 45, true)
    recordView.setUint16(14, 45, true)
    recordView.setBigUint64(24, BigInt(count), true)
    recordView.setBigUint64(32, BigInt(count), true)
    recordView.setBigUint64(40, BigInt(directory.length), true)
    recordView.setBigUint64(48, BigInt(directoryOffset), true)
    const locator = new Uint8Array(20)
    const locatorView = new DataView(locator.buffer)
    locatorView.setUint32(0, 0x07064b50, true)
    locatorView.setBigUint64(8, BigInt(directoryOffset + directory.length), true)
    locatorView.setUint32(16, 1, true)
    tail.push(record, locator)
  }
  const comment = encoder.encode(options.comment ?? "")
  const end = new Uint8Array(22 + comment.length)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, options.zip64 ? 0xffff : count, true)
  endView.setUint16(10, options.zip64 ? 0xffff : count, true)
  endView.setUint32(12, options.zip64 ? 0xffffffff : directory.length, true)
  endView.setUint32(16, options.zip64 ? 0xffffffff : directoryOffset, true)
  endView.setUint16(20, comment.length, true)
  end.set(comment, 22)
  tail.push(end)

  return concat([...locals, directory, ...tail])
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

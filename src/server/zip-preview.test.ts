import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { ZIP_PREVIEW_LIMITS, zipEntryUrl, zipListingUrl } from "../shared/zip-preview"
import { buildTestZip } from "./__fixtures__/build-test-zip"
import { startTestServer } from "./__fixtures__/test-server"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import { persistProjectUpload } from "./uploads"
import { bytesZipSource, normalizeEntryPath, readZipEntry, readZipListing, ZipPreviewError } from "./zip-preview"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function expectZipError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ZipPreviewError)
  expect((error as ZipPreviewError).status).toBe(status)
  if (message) expect((error as ZipPreviewError).message).toMatch(message)
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe("readZipListing", () => {
  test("lists files and folders with their sizes and dates", async () => {
    const zip = buildTestZip([
      { name: "docs/" , method: 0 },
      { name: "docs/readme.md", data: "# Hello\n" },
      { name: "docs/deep/nested/notes.txt", data: "a".repeat(5_000), modified: [2023, 12, 31, 23, 59, 58] },
      { name: "logo.png", data: new Uint8Array([1, 2, 3, 4]), method: 0 },
    ])
    const listing = await readZipListing(bytesZipSource(zip))
    expect(listing.fileCount).toBe(3)
    expect(listing.totalSize).toBe(8 + 5_000 + 4)
    expect(listing.unsafeEntries).toBe(0)
    expect(listing.entries.map((entry) => [entry.path, entry.directory])).toEqual([
      ["docs", true],
      ["docs/readme.md", false],
      ["docs/deep/nested/notes.txt", false],
      ["logo.png", false],
    ])
    const notes = listing.entries[2]!
    expect(notes.size).toBe(5_000)
    expect(notes.compressedSize).toBeLessThan(100)
    expect(notes.modifiedAt).toBe("2023-12-31T23:59:58")
    expect(notes.encrypted).toBe(false)
  })

  test("finds the end record behind an archive comment", async () => {
    const zip = buildTestZip([{ name: "a.txt", data: "hi" }], { comment: "made by a test, PK\u0005\u0006 inside" })
    const listing = await readZipListing(bytesZipSource(zip))
    expect(listing.entries.map((entry) => entry.path)).toEqual(["a.txt"])
  })

  test("reads zip64 records and extra fields", async () => {
    const zip = buildTestZip([
      { name: "big/one.txt", data: "first" },
      { name: "big/two.json", data: "{\"a\":1}", method: 0 },
    ], { zip64: true })
    const source = bytesZipSource(zip)
    const listing = await readZipListing(source)
    expect(listing.entries.map((entry) => [entry.path, entry.size])).toEqual([["big/one.txt", 5], ["big/two.json", 7]])
    expect(text(await readZipEntry(source, "big/two.json"))).toBe("{\"a\":1}")
    expect(text(await readZipEntry(source, "big/one.txt"))).toBe("first")
  })

  test("prefers the extended timestamp, which is UTC", async () => {
    const extra = new Uint8Array(9)
    const view = new DataView(extra.buffer)
    view.setUint16(0, 0x5455, true)
    view.setUint16(2, 5, true)
    view.setUint8(4, 1)
    view.setUint32(5, Date.UTC(2025, 0, 2, 3, 4, 5) / 1000, true)
    const listing = await readZipListing(bytesZipSource(buildTestZip([{ name: "a.txt", data: "x", extra }])))
    expect(listing.entries[0]!.modifiedAt).toBe("2025-01-02T03:04:05.000Z")
  })

  test("marks encrypted entries", async () => {
    const zip = buildTestZip([{ name: "secret.txt", data: "hidden", flags: 0x0001 }])
    const source = bytesZipSource(zip)
    const listing = await readZipListing(source)
    expect(listing.entries[0]!.encrypted).toBe(true)
    await expectZipError(readZipEntry(source, "secret.txt"), 422, /encrypted/)
  })

  test("leaves out entries that climb out of the archive or start at a root", async () => {
    const zip = buildTestZip([
      { name: "../evil.txt", data: "x" },
      { name: "a/../../evil.txt", data: "x" },
      { name: "/etc/passwd", data: "x" },
      { name: "C:\\Windows\\win.ini", data: "x" },
      { name: "./ok/./fine.txt", data: "ok" },
    ])
    const source = bytesZipSource(zip)
    const listing = await readZipListing(source)
    expect(listing.entries.map((entry) => entry.path)).toEqual(["ok/fine.txt"])
    expect(listing.unsafeEntries).toBe(4)
    await expectZipError(readZipEntry(source, "../evil.txt"), 400)
    await expectZipError(readZipEntry(source, "ok/../../evil.txt"), 400)
    expect(text(await readZipEntry(source, "ok/fine.txt"))).toBe("ok")
  })

  test("refuses a file that isn't a zip, or is cut short", async () => {
    await expectZipError(readZipListing(bytesZipSource(new TextEncoder().encode("just some text, long enough to search"))), 422, /isn't a zip/)
    await expectZipError(readZipListing(bytesZipSource(new Uint8Array(4))), 422, /isn't a zip/)

    const zip = buildTestZip([{ name: "a.txt", data: "hello" }, { name: "b.txt", data: "world" }])
    // The end record lost: nothing to find.
    await expectZipError(readZipListing(bytesZipSource(zip.subarray(0, zip.length - 10))), 422)
    // The front lost: the index points past where the file now starts.
    await expectZipError(readZipListing(bytesZipSource(zip.subarray(20))), 422, /damaged/)
  })

  test("refuses an index that says more entries than it holds", async () => {
    const zip = buildTestZip([{ name: "a.txt", data: "hello" }], { declaredCount: 3 })
    await expectZipError(readZipListing(bytesZipSource(zip)), 422, /cut short/)
  })

  test("refuses an archive with more entries than the cap", async () => {
    const zip = buildTestZip([{ name: "a.txt", data: "x" }], { declaredCount: ZIP_PREVIEW_LIMITS.entries + 1, zip64: true })
    await expectZipError(readZipListing(bytesZipSource(zip)), 413, /lists up to 10,000/)
  })

  test("reads an archive made by the zip tool", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-zip-tool-"))
    tempDirs.push(dir)
    await mkdir(path.join(dir, "src/sub"), { recursive: true })
    await writeFile(path.join(dir, "src/a.ts"), "export const a = 1\n")
    await writeFile(path.join(dir, "src/sub/b.txt"), "hello")
    const result = await Bun.$`zip -qr out.zip src`.cwd(dir).nothrow().quiet()
    if (result.exitCode !== 0) return // No zip tool here.
    const source = bytesZipSource(new Uint8Array(await readFile(path.join(dir, "out.zip"))))
    const listing = await readZipListing(source)
    expect(listing.entries.map((entry) => entry.path).sort()).toEqual(["src", "src/a.ts", "src/sub", "src/sub/b.txt"])
    expect(text(await readZipEntry(source, "src/a.ts"))).toBe("export const a = 1\n")
  })
})

describe("readZipEntry", () => {
  test("inflates a deflated or stored text entry", async () => {
    const source = bytesZipSource(buildTestZip([
      { name: "a/notes.md", data: "# Title\n\nbody\n" },
      { name: "a/plain.txt", data: "stored", method: 0 },
    ]))
    expect(text(await readZipEntry(source, "a/notes.md"))).toBe("# Title\n\nbody\n")
    expect(text(await readZipEntry(source, "a/plain.txt"))).toBe("stored")
  })

  test("only opens text entries, and only files", async () => {
    const source = bytesZipSource(buildTestZip([
      { name: "dir/", method: 0 },
      { name: "dir/image.png", data: new Uint8Array([137, 80, 78, 71]) },
    ]))
    await expectZipError(readZipEntry(source, "dir/image.png"), 415)
    await expectZipError(readZipEntry(source, "dir"), 404)
    await expectZipError(readZipEntry(source, "dir/missing.txt"), 404)
  })

  test("stops a zip bomb at the size it declared", async () => {
    // 10 MB of zeros deflates to about 10 KB, and says it is 100 bytes.
    const source = bytesZipSource(buildTestZip([{ name: "bomb.txt", data: new Uint8Array(10 * 1024 * 1024), declaredSize: 100 }]))
    await expectZipError(readZipEntry(source, "bomb.txt"), 422, /more than it declares/)
  })

  test("refuses an entry declared over the cap before reading it", async () => {
    const source = bytesZipSource(buildTestZip([{ name: "huge.txt", data: "small really", declaredSize: ZIP_PREVIEW_LIMITS.entryBytes + 1 }]))
    await expectZipError(readZipEntry(source, "huge.txt"), 413, /too large/)
  })

  test("catches an entry that inflates to less than it declared", async () => {
    const source = bytesZipSource(buildTestZip([{ name: "short.txt", data: "abc", declaredSize: 10 }]))
    await expectZipError(readZipEntry(source, "short.txt"), 422, /damaged/)
  })

  test("catches damaged entry data", async () => {
    const zip = buildTestZip([{ name: "a.txt", data: "hello world", method: 0 }])
    // The stored bytes start right after the 30-byte local header and the name.
    zip[30 + "a.txt".length] ^= 0xff
    await expectZipError(readZipEntry(bytesZipSource(zip), "a.txt"), 422, /checksum/)

    const garbage = buildTestZip([{ name: "b.txt", data: "hello", method: 8 }])
    garbage.fill(0xff, 30 + "b.txt".length, 30 + "b.txt".length + 4)
    await expectZipError(readZipEntry(bytesZipSource(garbage), "b.txt"), 422, /damaged/)
  })

  test("refuses compression it can't read", async () => {
    const source = bytesZipSource(buildTestZip([{ name: "a.txt", data: new Uint8Array(deflateRawSync("x")), method: 12 }]))
    await expectZipError(readZipEntry(source, "a.txt"), 415, /method 12/)
  })
})

describe("normalizeEntryPath", () => {
  test("cleans a name into a relative path", () => {
    expect(normalizeEntryPath("a\\b\\c.txt")).toEqual({ path: "a/b/c.txt", directory: false, unsafe: false })
    expect(normalizeEntryPath("a//b/./")).toEqual({ path: "a/b", directory: true, unsafe: false })
    expect(normalizeEntryPath("./")).toBeNull()
    expect(normalizeEntryPath("a/../b")?.unsafe).toBe(true)
    expect(normalizeEntryPath("/abs")?.unsafe).toBe(true)
    expect(normalizeEntryPath("d:x")?.unsafe).toBe(true)
  })

  test("decodes a legacy CP437 name", async () => {
    const zip = buildTestZip([{ name: "XX.txt", data: "x" }])
    // Swap the UTF-8 name for CP437 bytes ("Ä" is 0x8e there) and clear the UTF-8 flag.
    const patched = Buffer.from(zip)
    for (let index = 0; index + 1 < patched.length; index += 1) {
      if (patched[index] === 0x58 && patched[index + 1] === 0x58) patched[index] = 0x8e
    }
    const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength)
    for (let index = 0; index + 4 <= patched.length; index += 1) {
      const signature = view.getUint32(index, true)
      if (signature === 0x04034b50) view.setUint16(index + 6, 0, true)
      if (signature === 0x02014b50) view.setUint16(index + 8, 0, true)
    }
    const listing = await readZipListing(bytesZipSource(new Uint8Array(patched)))
    expect(listing.entries[0]!.path).toBe("ÄX.txt")
  })
})

describe("zip routes", () => {
  const archive = () => buildTestZip([
    { name: "bundle/README.md", data: "# Read me\n" },
    { name: "bundle/src/index.ts", data: "export {}\n" },
    { name: "bundle/logo.png", data: new Uint8Array([137, 80, 78, 71]), method: 0 },
  ])

  async function startServer(port: number, password?: string) {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-zip-project-"))
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-zip-data-"))
    tempDirs.push(projectDir, dataDir)
    const server = await startTestServer({ dataDir, port, strictPort: true, ...(password ? { password } : {}) })
    const project = await server.store.openProject(projectDir, "Project")
    const upload = await persistProjectUpload({
      projectId: project.id,
      localPath: projectDir,
      fileName: "bundle.zip",
      bytes: archive(),
      fallbackMimeType: "application/zip",
    })
    return { server, project, projectDir, base: `http://localhost:${server.port}`, uploadUrl: upload.contentUrl }
  }

  test("lists an upload and opens a text entry from it", async () => {
    const { server, base, uploadUrl } = await startServer(4341)
    try {
      const listing = await fetch(`${base}${zipListingUrl(uploadUrl)}`)
      expect(listing.status).toBe(200)
      const body = await listing.json() as { entries: Array<{ path: string }>; fileCount: number }
      expect(body.fileCount).toBe(3)
      expect(body.entries.map((entry) => entry.path)).toEqual(["bundle/README.md", "bundle/src/index.ts", "bundle/logo.png"])

      const entry = await fetch(`${base}${zipEntryUrl(uploadUrl, "bundle/README.md")}`)
      expect(entry.status).toBe(200)
      expect(entry.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(entry.headers.get("x-content-type-options")).toBe("nosniff")
      expect(entry.headers.get("content-security-policy")).toContain("sandbox")
      expect(await entry.text()).toBe("# Read me\n")

      // The file itself is still served as it was.
      const raw = await fetch(`${base}${uploadUrl}`)
      expect(Buffer.from(await raw.arrayBuffer()).equals(archive())).toBe(true)

      expect((await fetch(`${base}${zipEntryUrl(uploadUrl, "bundle/logo.png")}`)).status).toBe(415)
      expect((await fetch(`${base}${zipEntryUrl(uploadUrl, "../../etc/passwd.txt")}`)).status).toBe(400)
      expect((await fetch(`${base}${uploadUrl}?zip=entry`)).status).toBe(400)
      expect((await fetch(`${base}${uploadUrl}?zip=nonsense`)).status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test("keeps the route's own path checks", async () => {
    const { server, project, base } = await startServer(4342)
    try {
      // A stored name that climbs out of the uploads folder never reaches the zip reader.
      const climb = await fetch(`${base}/api/projects/${project.id}/uploads/..%2F..%2Fsecret.zip/content?zip=list`)
      expect(climb.status).toBe(400)
      expect((await fetch(`${base}/api/projects/${project.id}/uploads/missing.zip/content?zip=list`)).status).toBe(404)
      expect((await fetch(`${base}/api/projects/no-such-project/uploads/bundle.zip/content?zip=list`)).status).toBe(404)
      expect((await fetch(`${base}/api/chats/no-such-chat/media/bundle.zip?zip=list`)).status).toBe(404)
      expect((await fetch(`${base}/api/chats/no-such-chat/media/..%2Fbundle.zip?zip=list`)).status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("lists a zip an agent sent the chat", async () => {
    const { server, project, base } = await startServer(4343)
    try {
      const chat = await server.store.createChat(project.id)
      const mediaDir = getTranscriptMediaDir(server.store.dataDir, chat.id)
      await mkdir(mediaDir, { recursive: true })
      await writeFile(path.join(mediaDir, "sent.zip"), archive())
      const mediaUrl = buildTranscriptMediaUrl(chat.id, "sent.zip")

      const listing = await fetch(`${base}${zipListingUrl(mediaUrl)}`)
      expect(listing.status).toBe(200)
      expect(((await listing.json()) as { fileCount: number }).fileCount).toBe(3)
      const entry = await fetch(`${base}${zipEntryUrl(mediaUrl, "bundle/src/index.ts")}`)
      expect(await entry.text()).toBe("export {}\n")
      // Without the query, still the download it was.
      expect((await fetch(`${base}${mediaUrl}`)).headers.get("content-disposition")).toBe("attachment")
    } finally {
      await server.stop()
    }
  })

  test("needs the same sign-in as the file", async () => {
    const { server, base, uploadUrl } = await startServer(4344, "secret")
    try {
      expect((await fetch(`${base}${zipListingUrl(uploadUrl)}`)).status).toBe(401)
      expect((await fetch(`${base}${zipEntryUrl(uploadUrl, "bundle/README.md")}`)).status).toBe(401)

      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: { "Content-Type": "application/json", Origin: base },
      })
      const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!
      const listing = await fetch(`${base}${zipListingUrl(uploadUrl)}`, { headers: { Cookie: cookie } })
      expect(listing.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("refuses a file that isn't a zip with a clear error", async () => {
    const { server, project, projectDir, base } = await startServer(4345)
    try {
      const notZip = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("plain text, nothing zipped about it"),
        fallbackMimeType: "text/plain",
      })
      const response = await fetch(`${base}${zipListingUrl(notZip.contentUrl)}`)
      expect(response.status).toBe(422)
      expect(((await response.json()) as { error: string }).error).toMatch(/isn't a zip/)
    } finally {
      await server.stop()
    }
  })
})

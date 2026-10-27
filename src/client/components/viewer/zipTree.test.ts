import { describe, expect, test } from "bun:test"
import type { ZipListingEntry } from "../../../shared/zip-preview"
import { allZipFolders, buildZipTree, initialExpandedFolders, opensInZipViewer, visibleZipRows, zipEntryAttachment, type ZipTreeFolder } from "./zipTree"

const file = (path: string, size = 10, extra: Partial<ZipListingEntry> = {}): ZipListingEntry => ({
  path, directory: false, size, compressedSize: size, modifiedAt: null, encrypted: false, ...extra,
})
const folder = (path: string): ZipListingEntry => ({ path, directory: true, size: 0, compressedSize: 0, modifiedAt: null, encrypted: false })

const names = (node: ZipTreeFolder) => node.children.map((child) => `${child.kind === "folder" ? "+" : ""}${child.name}`)

describe("buildZipTree", () => {
  test("makes the folders files sit under, listed or not", () => {
    const root = buildZipTree([file("src/app/main.ts", 100), file("src/index.ts", 20), file("README.md", 5)])
    expect(names(root)).toEqual(["+src", "README.md"])
    const src = root.children[0] as ZipTreeFolder
    expect(src.path).toBe("src")
    expect(names(src)).toEqual(["+app", "index.ts"])
    expect((src.children[0] as ZipTreeFolder).path).toBe("src/app")
  })

  test("adds up sizes and file counts through the folders", () => {
    const root = buildZipTree([folder("a"), folder("a/empty"), file("a/b/one.txt", 100), file("a/b/two.txt", 50), file("a/three.txt", 7), file("top.txt", 1)])
    expect(root.size).toBe(158)
    expect(root.fileCount).toBe(4)
    const a = root.children[0] as ZipTreeFolder
    expect([a.size, a.fileCount]).toEqual([157, 3])
    expect(names(a)).toEqual(["+b", "+empty", "three.txt"])
    const empty = a.children[1] as ZipTreeFolder
    expect([empty.size, empty.fileCount, empty.children.length]).toEqual([0, 0, 0])
  })

  test("puts folders first, then names with numbers in order", () => {
    const root = buildZipTree([file("part 10.txt"), file("Part 2.txt"), file("zeta/x"), file("alpha/x"), file("part 1.txt")])
    expect(names(root)).toEqual(["+alpha", "+zeta", "part 1.txt", "Part 2.txt", "part 10.txt"])
  })

  test("shows a path listed twice once, as the first", () => {
    const root = buildZipTree([file("a.txt", 1), file("a.txt", 2)])
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.kind === "file" && root.children[0]!.entry.size).toBe(1)
    expect(root.fileCount).toBe(1)
  })

  test("keeps a folder listed after its files as the same folder", () => {
    const root = buildZipTree([file("docs/a.md"), folder("docs")])
    expect(names(root)).toEqual(["+docs"])
    expect(names(root.children[0] as ZipTreeFolder)).toEqual(["a.md"])
  })
})

describe("visibleZipRows", () => {
  const root = buildZipTree([file("a/b/c.txt"), file("a/d.txt"), file("e.txt")])

  test("shows the top level when nothing is open", () => {
    expect(visibleZipRows(root, new Set()).map((row) => [row.node.path, row.depth])).toEqual([["a", 0], ["e.txt", 0]])
  })

  test("shows inside open folders, one level deeper each", () => {
    expect(visibleZipRows(root, new Set(["a", "a/b"])).map((row) => [row.node.path, row.depth])).toEqual([
      ["a", 0], ["a/b", 1], ["a/b/c.txt", 2], ["a/d.txt", 1], ["e.txt", 0],
    ])
  })

  test("hides an open folder's contents when a folder above it closes", () => {
    expect(visibleZipRows(root, new Set(["a/b"])).map((row) => row.node.path)).toEqual(["a", "e.txt"])
  })
})

describe("initialExpandedFolders", () => {
  test("opens the folder a zip is wrapped in, down to the first choice", () => {
    expect([...initialExpandedFolders(buildZipTree([file("project/src/a.ts"), file("project/src/b.ts")]))]).toEqual(["project", "project/src"])
    expect([...initialExpandedFolders(buildZipTree([file("project/src/a.ts"), file("project/README.md")]))]).toEqual(["project"])
    expect([...initialExpandedFolders(buildZipTree([file("a/x"), file("b/x")]))]).toEqual([])
  })

  test("lists every folder for expand all", () => {
    expect(allZipFolders(buildZipTree([file("a/b/c.txt"), file("d/e.txt")]))).toEqual(["a", "a/b", "d"])
  })
})

describe("zip entries in the viewer", () => {
  test("opens text entries only", () => {
    expect(opensInZipViewer(file("notes.md"))).toBe(true)
    expect(opensInZipViewer(file("src/main.py"))).toBe(true)
    expect(opensInZipViewer(file("LICENSE"))).toBe(true)
    expect(opensInZipViewer(file("logo.png"))).toBe(false)
    expect(opensInZipViewer(file("secret.txt", 10, { encrypted: true }))).toBe(false)
    expect(opensInZipViewer(folder("docs.txt"))).toBe(false)
  })

  test("gives an entry the type its name reads as, at its own address", () => {
    const zip = { url: "/api/projects/p1/uploads/bundle.zip/content" }
    expect(zipEntryAttachment(zip, file("docs/read me.md", 12))).toEqual({
      url: "/api/projects/p1/uploads/bundle.zip/content?zip=entry&path=docs%2Fread+me.md",
      name: "read me.md",
      mimeType: "text/markdown",
      size: 12,
    })
    expect(zipEntryAttachment(zip, file("rows.tsv")).mimeType).toBe("text/tab-separated-values")
    expect(zipEntryAttachment(zip, file("data.json", 1_000)).mimeType).toBe("application/json")
    expect(zipEntryAttachment(zip, file("data.json", 10_000_000)).mimeType).toBe("text/plain")
    expect(zipEntryAttachment(zip, file("a/b.ts")).mimeType).toBe("text/plain")
  })
})

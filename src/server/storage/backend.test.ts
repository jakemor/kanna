import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { StorageBackend } from "./backend"
import { FsStorageBackend } from "./fs-storage"
import { InMemoryStorageBackend } from "./in-memory-storage"

interface Harness {
  backend: StorageBackend
  root: string
  cleanup: () => Promise<void>
}

function fsHarness(): () => Promise<Harness> {
  return async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-storage-parity-"))
    return {
      backend: new FsStorageBackend(),
      root,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true })
      },
    }
  }
}

function memHarness(): () => Promise<Harness> {
  return async () => {
    return {
      backend: new InMemoryStorageBackend(),
      root: "/virtual",
      cleanup: async () => {},
    }
  }
}

const variants: Array<{ name: string; create: () => Promise<Harness> }> = [
  { name: "FsStorageBackend", create: fsHarness() },
  { name: "InMemoryStorageBackend", create: memHarness() },
]

for (const variant of variants) {
  describe(`StorageBackend parity — ${variant.name}`, () => {
    let h: Harness
    beforeEach(async () => {
      h = await variant.create()
    })
    afterEach(async () => {
      await h.cleanup()
    })

    test("mkdir is idempotent and recursive", async () => {
      const dir = path.join(h.root, "a", "b", "c")
      await h.backend.mkdir(dir)
      await h.backend.mkdir(dir)
      const file = path.join(dir, "x.txt")
      await h.backend.writeText(file, "hello")
      expect(await h.backend.readText(file)).toBe("hello")
    })

    test("exists reports false then true after writeText", async () => {
      const file = path.join(h.root, "file.txt")
      expect(await h.backend.exists(file)).toBe(false)
      await h.backend.mkdir(h.root)
      await h.backend.writeText(file, "data")
      expect(await h.backend.exists(file)).toBe(true)
    })

    test("existsSync matches exists for files", async () => {
      const file = path.join(h.root, "file.txt")
      await h.backend.mkdir(h.root)
      await h.backend.writeText(file, "data")
      expect(h.backend.existsSync(file)).toBe(true)
      const missing = path.join(h.root, "missing.txt")
      expect(h.backend.existsSync(missing)).toBe(false)
    })

    test("size returns 0 for missing, byte length for present", async () => {
      const file = path.join(h.root, "file.txt")
      expect(await h.backend.size(file)).toBe(0)
      await h.backend.mkdir(h.root)
      await h.backend.writeText(file, "hello")
      expect(await h.backend.size(file)).toBe(5)
    })

    test("readText after writeText roundtrip", async () => {
      const file = path.join(h.root, "rw.txt")
      await h.backend.mkdir(h.root)
      await h.backend.writeText(file, "line1\nline2\n")
      expect(await h.backend.readText(file)).toBe("line1\nline2\n")
      expect(h.backend.readTextSync(file)).toBe("line1\nline2\n")
    })

    test("writeText overwrites existing content", async () => {
      const file = path.join(h.root, "ow.txt")
      await h.backend.mkdir(h.root)
      await h.backend.writeText(file, "first")
      await h.backend.writeText(file, "second")
      expect(await h.backend.readText(file)).toBe("second")
    })

    test("appendText appends and creates file when missing", async () => {
      const file = path.join(h.root, "ap.txt")
      await h.backend.mkdir(h.root)
      await h.backend.appendText(file, "a")
      await h.backend.appendText(file, "b")
      await h.backend.appendText(file, "c")
      expect(await h.backend.readText(file)).toBe("abc")
    })

    test("rename moves file content", async () => {
      const from = path.join(h.root, "from.txt")
      const to = path.join(h.root, "to.txt")
      await h.backend.mkdir(h.root)
      await h.backend.writeText(from, "payload")
      await h.backend.rename(from, to)
      expect(await h.backend.exists(from)).toBe(false)
      expect(await h.backend.readText(to)).toBe("payload")
    })

    test("remove file is no-op on missing path", async () => {
      const missing = path.join(h.root, "missing.txt")
      await h.backend.remove(missing)
      expect(await h.backend.exists(missing)).toBe(false)
    })

    test("remove file deletes existing file", async () => {
      const file = path.join(h.root, "del.txt")
      await h.backend.mkdir(h.root)
      await h.backend.writeText(file, "x")
      await h.backend.remove(file)
      expect(await h.backend.exists(file)).toBe(false)
    })

    test("remove recursive clears directory tree", async () => {
      const dir = path.join(h.root, "sub")
      const a = path.join(dir, "a.txt")
      const b = path.join(dir, "deep", "b.txt")
      await h.backend.mkdir(path.join(dir, "deep"))
      await h.backend.writeText(a, "1")
      await h.backend.writeText(b, "2")
      await h.backend.remove(dir, { recursive: true })
      expect(await h.backend.exists(a)).toBe(false)
      expect(await h.backend.exists(b)).toBe(false)
    })
  })
}

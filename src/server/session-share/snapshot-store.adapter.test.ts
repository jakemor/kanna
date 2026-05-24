import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotStore } from "./snapshot-store.adapter"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kanna-share-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const sample: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
  messages: [],
  attachmentsManifest: [],
}

describe("SnapshotStore", () => {
  test("write then read round-trips, file mode 0600", async () => {
    const store = new SnapshotStore(dir)
    await store.writeSnapshot("tok1", sample)
    const got = await store.readSnapshot("tok1")
    expect(got).toEqual(sample)
    const mode = statSync(join(dir, "tok1.json")).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("readSnapshot returns null when missing", async () => {
    const store = new SnapshotStore(dir)
    expect(await store.readSnapshot("missing")).toBeNull()
  })

  test("deleteSnapshot is idempotent", async () => {
    const store = new SnapshotStore(dir)
    await store.writeSnapshot("tok1", sample)
    await store.deleteSnapshot("tok1")
    await store.deleteSnapshot("tok1")
    expect(await store.readSnapshot("tok1")).toBeNull()
  })

  test("totalBytes sums file sizes", async () => {
    const store = new SnapshotStore(dir)
    await store.writeSnapshot("a", sample)
    await store.writeSnapshot("b", sample)
    const total = await store.totalBytes()
    const expected = statSync(join(dir, "a.json")).size + statSync(join(dir, "b.json")).size
    expect(total).toBe(expected)
  })

  test("rejects tokenIds containing path separators", async () => {
    const store = new SnapshotStore(dir)
    await expect(store.writeSnapshot("../escape", sample)).rejects.toThrow()
  })
})

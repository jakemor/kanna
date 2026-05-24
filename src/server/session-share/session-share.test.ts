import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionShareService, type ShareEventSink } from "./index"
import type { ShareEvent } from "./share-projection"
import { SnapshotStore } from "./snapshot-store.adapter"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"

class FakeEventStore implements ShareEventSink {
  events: ShareEvent[] = []
  async appendShareEvent(e: ShareEvent) { this.events.push(e) }
  getShareEvents() { return this.events.slice() }
}

const snapshot: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
  messages: [],
  attachmentsManifest: [],
}

let dir: string
let store: SnapshotStore
let events: FakeEventStore
let service: SessionShareService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "share-svc-"))
  store = new SnapshotStore(dir)
  events = new FakeEventStore()
  service = new SessionShareService({
    events,
    snapshotStore: store,
    buildSnapshot: () => snapshot,
    getTunnelBaseUrl: () => "https://x.trycloudflare.com",
    getDefaultTtlHours: () => 24,
    now: () => 1_000_000,
    owner: () => "owner",
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("SessionShareService", () => {
  test("mintToken returns NO_TUNNEL when base URL missing", async () => {
    service = new SessionShareService({
      events, snapshotStore: store, buildSnapshot: () => snapshot,
      getTunnelBaseUrl: () => null, getDefaultTtlHours: () => 24,
      now: () => 1, owner: () => "owner",
    })
    const r = await service.mintToken({ chatId: "c1" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("no_tunnel")
  })

  test("mintToken success appends event and writes snapshot", async () => {
    const r = await service.mintToken({ chatId: "c1" })
    expect(r.ok).toBe(true)
    expect(events.events.length).toBe(1)
    if (r.ok) {
      const minted = events.events[0]
      if (!minted || minted.kind !== "share.token_minted") throw new Error("expected mint event")
      expect(r.data.summary.url).toContain("/share/")
      const read = await store.readSnapshot(minted.tokenId)
      expect(read).toEqual(snapshot)
    }
  })

  test("revokeToken appends event and deletes file", async () => {
    const mint = await service.mintToken({ chatId: "c1" })
    if (!mint.ok) throw new Error("expected mint to succeed")
    const r = await service.revokeToken({ tokenId: mint.data.summary.tokenId })
    expect(r.ok).toBe(true)
    expect(await store.readSnapshot(mint.data.summary.tokenId)).toBeNull()
  })

  test("revokeToken on unknown token returns not_found", async () => {
    const r = await service.revokeToken({ tokenId: "ghost" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not_found")
  })

  test("getShare returns expired when past expiresAt", async () => {
    const mint = await service.mintToken({ chatId: "c1", ttlHours: 0 })
    expect(mint.ok).toBe(true)
    if (!mint.ok) throw new Error("expected mint to succeed")
    const r = await service.getShare(mint.data.summary.tokenId, 1_000_000 + 60_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("expired")
  })

  test("getShare returns not_found for unknown token", async () => {
    const r = await service.getShare("unknown", 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not_found")
  })

  test("getShare hit returns snapshot", async () => {
    const mint = await service.mintToken({ chatId: "c1" })
    if (!mint.ok) throw new Error("mint failed")
    const r = await service.getShare(mint.data.summary.tokenId, 1_000_001)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.snapshot).toEqual(snapshot)
  })

  test("listSharesForChat surfaces active + revoked", async () => {
    const m1 = await service.mintToken({ chatId: "c1" })
    const m2 = await service.mintToken({ chatId: "c1" })
    expect(m1.ok && m2.ok).toBe(true)
    if (!m1.ok || !m2.ok) return
    await service.revokeToken({ tokenId: m1.data.summary.tokenId })
    const list = service.listSharesForChat("c1")
    expect(list.length).toBe(2)
    expect(list.find(s => s.tokenId === m1.data.summary.tokenId)?.revoked).toBe(true)
    expect(list.find(s => s.tokenId === m2.data.summary.tokenId)?.revoked).toBe(false)
  })

  test("runSweep deletes snapshots whose tokens expired", async () => {
    const m = await service.mintToken({ chatId: "c1", ttlHours: 0 })
    if (!m.ok) throw new Error("mint failed")
    const removed = await service.runSweep(1_000_000 + 60_000)
    expect(removed).toBe(1)
    expect(await store.readSnapshot(m.data.summary.tokenId)).toBeNull()
  })

  test("mintToken rejects snapshots over hard cap", async () => {
    const huge: ChatSnapshot = {
      version: CHAT_SNAPSHOT_VERSION,
      chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
      messages: [{ kind: "assistant_text", id: "m1", createdAt: 0, text: "x".repeat(60 * 1024 * 1024) }],
      attachmentsManifest: [],
    }
    service = new SessionShareService({
      events, snapshotStore: store, buildSnapshot: () => huge,
      getTunnelBaseUrl: () => "https://x", getDefaultTtlHours: () => 24,
      now: () => 1, owner: () => "owner",
    })
    const r = await service.mintToken({ chatId: "c1" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("snapshot_too_large")
  })
})

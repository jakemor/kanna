import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionShareService, type ShareEventSink } from "./index"
import type { ShareEvent } from "./share-projection"
import { SnapshotStore } from "./snapshot-store.adapter"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"
import { handleShareRequest } from "./http-routes"

class FakeStore implements ShareEventSink {
  events: ShareEvent[] = []
  async appendShareEvent(e: ShareEvent) { this.events.push(e) }
  getShareEvents() { return this.events.slice() }
}

const snap: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "T", model: "m", createdAt: 0 },
  messages: [
    { kind: "user_prompt", id: "m1", createdAt: 1, text: "hi" },
    { kind: "assistant_text", id: "m2", createdAt: 2, text: "hello" },
  ],
  attachmentsManifest: [],
}

describe("mint → GET /share/<token> integration", () => {
  test("full round-trip returns HTML 200 containing the snapshot JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "share-int-"))
    try {
      const store = new SnapshotStore(dir)
      const svc = new SessionShareService({
        events: new FakeStore(),
        snapshotStore: store,
        buildSnapshot: () => snap,
        getTunnelBaseUrl: () => "https://tunnel.example",
        getDefaultTtlHours: () => 24,
        now: () => 1_000,
        owner: () => "o",
      })
      const mint = await svc.mintToken({ chatId: "c1" })
      expect(mint.ok).toBe(true)
      if (!mint.ok) throw new Error("mint failed")
      const res = await handleShareRequest(
        new Request(`http://x/share/${mint.data.summary.tokenId}`),
        svc,
      )
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain(`"title":"T"`)
      expect(body).toContain(`"text":"hi"`)
      expect(body).toContain(`"text":"hello"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("revoke before view yields 410", async () => {
    const dir = mkdtempSync(join(tmpdir(), "share-int-"))
    try {
      const store = new SnapshotStore(dir)
      const svc = new SessionShareService({
        events: new FakeStore(),
        snapshotStore: store,
        buildSnapshot: () => snap,
        getTunnelBaseUrl: () => "https://tunnel.example",
        getDefaultTtlHours: () => 24,
        now: () => 1_000,
        owner: () => "o",
      })
      const mint = await svc.mintToken({ chatId: "c1" })
      if (!mint.ok) throw new Error("mint failed")
      const revoke = await svc.revokeToken({ tokenId: mint.data.summary.tokenId })
      expect(revoke.ok).toBe(true)
      const res = await handleShareRequest(
        new Request(`http://x/share/${mint.data.summary.tokenId}`),
        svc,
      )
      expect(res.status).toBe(410)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

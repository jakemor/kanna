import { describe, expect, test } from "bun:test"
import { handleShareRequest } from "./http-routes"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../shared/session-share/types"
import type { Result } from "./index"

const snap: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
  messages: [], attachmentsManifest: [],
}

function service(impl: (tokenId: string) => Promise<Result<{ snapshot: ChatSnapshot }>>) {
  return { getShare: impl } as Parameters<typeof handleShareRequest>[1]
}

describe("handleShareRequest", () => {
  test("200 returns inline HTML containing the snapshot JSON", async () => {
    const r = await handleShareRequest(new Request("http://x/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), service(async () => ({ ok: true, data: { snapshot: snap } })))
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toMatch(/text\/html/)
    const body = await r.text()
    expect(body).toContain("\"version\":1")
    expect(body).toContain("share-view")
  })

  test("404 on not_found", async () => {
    const r = await handleShareRequest(new Request("http://x/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), service(async () => ({ ok: false, error: { kind: "not_found" } })))
    expect(r.status).toBe(404)
  })

  test("410 on revoked + expired", async () => {
    const r1 = await handleShareRequest(new Request("http://x/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), service(async () => ({ ok: false, error: { kind: "revoked" } })))
    const r2 = await handleShareRequest(new Request("http://x/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), service(async () => ({ ok: false, error: { kind: "expired", expiredAt: 1 } })))
    expect(r1.status).toBe(410)
    expect(r2.status).toBe(410)
  })

  test("500 on snapshot_read_failed", async () => {
    const r = await handleShareRequest(new Request("http://x/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), service(async () => ({ ok: false, error: { kind: "snapshot_read_failed", message: "boom" } })))
    expect(r.status).toBe(500)
  })

  test("404 when path doesn't match /share/:token", async () => {
    const r = await handleShareRequest(new Request("http://x/share/"), service(async () => ({ ok: true, data: { snapshot: snap } })))
    expect(r.status).toBe(404)
  })
})

import { describe, expect, test } from "bun:test"
import { applyShareEvent, buildShareProjection, classifyShare, type ShareEvent } from "./share-projection"

const minted: ShareEvent = {
  v: 1,
  kind: "share.token_minted",
  tokenId: "t1",
  chatId: "c1",
  expiresAt: 2000,
  createdAt: 1000,
  createdBy: "u",
}
const revoked: ShareEvent = { v: 1, kind: "share.token_revoked", tokenId: "t1", revokedAt: 1500 }

describe("share-projection", () => {
  test("replays mint then revoke", () => {
    const proj = buildShareProjection([minted, revoked])
    expect(proj.get("t1")?.revoked).toBe(true)
  })

  test("classifyShare returns expired vs ok vs revoked", () => {
    const proj = buildShareProjection([minted])
    const rec = proj.get("t1")!
    expect(rec.revoked).toBe(false)
    expect(rec.expiresAt).toBe(2000)
    expect(classifyShare(proj, "t1", 500).kind).toBe("ok")
    expect(classifyShare(proj, "t1", 3000).kind).toBe("expired")
    expect(classifyShare(proj, "missing", 0).kind).toBe("not_found")
    const proj2 = buildShareProjection([minted, revoked])
    expect(classifyShare(proj2, "t1", 500).kind).toBe("revoked")
  })

  test("applyShareEvent on a fresh map matches buildShareProjection", () => {
    const map = new Map()
    applyShareEvent(map, minted)
    applyShareEvent(map, revoked)
    expect(map.get("t1")?.revoked).toBe(true)
  })

  test("revoke without prior mint is a no-op", () => {
    const proj = buildShareProjection([revoked])
    expect(proj.size).toBe(0)
  })
})

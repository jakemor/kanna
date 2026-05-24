import { describe, expect, test } from "bun:test"
import { CHAT_SNAPSHOT_VERSION, isShareError, type ChatSnapshot, type ShareError } from "./types"

describe("session-share types", () => {
  test("CHAT_SNAPSHOT_VERSION is 1", () => {
    expect(CHAT_SNAPSHOT_VERSION).toBe(1)
  })

  test("isShareError narrows discriminated union", () => {
    const err: ShareError = { kind: "expired", expiredAt: 1 }
    expect(isShareError(err)).toBe(true)
    expect(isShareError({ kind: "ok" } as unknown as ShareError)).toBe(false)
  })

  test("ChatSnapshot is structurally typed", () => {
    const snap: ChatSnapshot = {
      version: CHAT_SNAPSHOT_VERSION,
      chatMeta: { id: "c1", title: "t", model: "m", createdAt: 0 },
      messages: [],
      attachmentsManifest: [],
    }
    expect(snap.version).toBe(1)
  })
})

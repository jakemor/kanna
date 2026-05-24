import { describe, expect, test, beforeEach } from "bun:test"
import { useShareStore } from "./share-store"

describe("share-store", () => {
  beforeEach(() => {
    useShareStore.setState({ sharesByChat: {} })
  })

  test("starts empty and exposes a stable EMPTY array", () => {
    const s1 = useShareStore.getState().listForChat("c1")
    const s2 = useShareStore.getState().listForChat("c1")
    expect(s1).toBe(s2)
    expect(s1.length).toBe(0)
  })

  test("setShares replaces the list for a chat", () => {
    useShareStore.getState().setShares("c1", [{ tokenId: "t", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false }])
    const first = useShareStore.getState().listForChat("c1")[0]
    expect(first?.tokenId).toBe("t")
  })

  test("addShare appends", () => {
    useShareStore.getState().setShares("c1", [])
    useShareStore.getState().addShare("c1", { tokenId: "t1", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false })
    useShareStore.getState().addShare("c1", { tokenId: "t2", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false })
    expect(useShareStore.getState().listForChat("c1").length).toBe(2)
  })

  test("removeShare drops by tokenId", () => {
    useShareStore.getState().setShares("c1", [
      { tokenId: "t1", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false },
      { tokenId: "t2", chatId: "c1", url: "u", expiresAt: 1, createdAt: 0, revoked: false },
    ])
    useShareStore.getState().removeShare("c1", "t1")
    expect(useShareStore.getState().listForChat("c1").length).toBe(1)
    expect(useShareStore.getState().listForChat("c1")[0]?.tokenId).toBe("t2")
  })
})

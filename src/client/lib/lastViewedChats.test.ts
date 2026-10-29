import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getViewedChatIds, recordChatViewed } from "./lastViewedChats"

describe("the chats viewed in this browser, per project", () => {
  const original = globalThis.localStorage
  let stored: Map<string, string>

  beforeEach(() => {
    stored = new Map()
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    } })
  })
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original })
  })

  test("most recent first, once each, and kept per project", () => {
    recordChatViewed("p1", "a")
    recordChatViewed("p1", "b")
    recordChatViewed("p2", "x")
    recordChatViewed("p1", "a")
    expect(getViewedChatIds("p1")).toEqual(["a", "b"])
    expect(getViewedChatIds("p2")).toEqual(["x"])
    expect(getViewedChatIds("p3")).toEqual([])
  })

  test("keeps a short history, and reads junk as nothing", () => {
    for (let index = 0; index < 30; index += 1) recordChatViewed("p1", `chat-${index}`)
    expect(getViewedChatIds("p1")).toHaveLength(20)
    expect(getViewedChatIds("p1")[0]).toBe("chat-29")
    stored.set("kanna:last-viewed-chats", "not json")
    expect(getViewedChatIds("p1")).toEqual([])
  })
})

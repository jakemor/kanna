import { describe, expect, test } from "bun:test"
import { parseStoredSidebarView } from "./sidebarViewStore"

describe("parseStoredSidebarView", () => {
  test("nothing stored opens on Channels", () => {
    expect(parseStoredSidebarView(null)).toBe("channels")
  })

  test("a stored choice wins, Recents included", () => {
    expect(parseStoredSidebarView("recents")).toBe("recents")
    expect(parseStoredSidebarView("projects")).toBe("projects")
    expect(parseStoredSidebarView("channels")).toBe("channels")
  })

  test("Archived and unknown values fall back to Channels", () => {
    expect(parseStoredSidebarView("archived")).toBe("channels")
    expect(parseStoredSidebarView("bogus")).toBe("channels")
  })
})

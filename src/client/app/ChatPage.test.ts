import { describe, expect, test } from "bun:test"
import { hasFileDragTypes } from "./ChatPage"

describe("hasFileDragTypes", () => {
  test("returns true when file drags are present", () => {
    expect(hasFileDragTypes(["text/plain", "Files"])).toBe(true)
  })

  test("returns false for non-file drags", () => {
    expect(hasFileDragTypes(["text/plain", "text/uri-list"])).toBe(false)
  })
})

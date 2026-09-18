import { describe, expect, test } from "bun:test"
import { parseChatLink } from "./chat-links"

describe("parseChatLink", () => {
  test("recognizes relative and same-origin chat routes", () => {
    expect(parseChatLink("/chat/abc-123")).toBe("/chat/abc-123")
    expect(parseChatLink("https://kanna.example/chat/abc-123?x=1#reply", "https://kanna.example"))
      .toBe("/chat/abc-123?x=1#reply")
  })
  test("leaves files, external URLs, and invalid routes alone", () => {
    for (const href of [undefined, "/Users/brian/chat.jsonl", "/chat/", "/chat/a/file", "//evil.example/chat/a", "javascript:alert(1)", "https://other.example/chat/a"]) {
      expect(parseChatLink(href, "https://kanna.example")).toBeNull()
    }
  })
})

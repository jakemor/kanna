import { describe, expect, test } from "bun:test"
import { decodeAttachmentRelativePath } from "./server"

describe("decodeAttachmentRelativePath", () => {
  test("decodes each path segment independently", () => {
    expect(decodeAttachmentRelativePath("chat-1/message%201/0.png")).toBe("chat-1/message 1/0.png")
    expect(decodeAttachmentRelativePath("chat%2F1/message-1/0.png")).toBe("chat/1/message-1/0.png")
  })

  test("returns null for malformed percent-encoding", () => {
    expect(decodeAttachmentRelativePath("chat-1/invalid%ZZ/0.png")).toBeNull()
    expect(decodeAttachmentRelativePath("chat-1/invalid%/0.png")).toBeNull()
  })
})

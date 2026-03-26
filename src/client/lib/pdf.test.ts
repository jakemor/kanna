import { describe, expect, test } from "bun:test"
import { buildChatPdfFilename } from "./pdf"

describe("buildChatPdfFilename", () => {
  const exportedAt = new Date(Date.UTC(2026, 2, 26, 12, 0, 0))
  })

  test("falls back to the project folder name", () => {
    expect(buildChatPdfFilename({ localPath: "/Users/brian/superwall/kanna", exportedAt })).toBe("kanna-2026-03-26.pdf")
  })

  test("falls back to a generic label when no title or path is available", () => {
    expect(buildChatPdfFilename({ exportedAt })).toBe("chat-history-2026-03-26.pdf")
  })
})

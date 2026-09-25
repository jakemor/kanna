import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { QueuedChatMessage } from "../../../shared/types"
import { QueuedUserMessage } from "./QueuedUserMessage"

describe("QueuedUserMessage", () => {
  test("renders queued message content left aligned inside the bubble", () => {
    const message: QueuedChatMessage = {
      id: "queued-1",
      content: "Queued follow-up",
      attachments: [],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued follow-up")
    expect(html).toContain("text-left")
    expect(html).not.toContain("text-right")
  })

  test("attachment-only messages still have Send now and Remove controls", () => {
    const message: QueuedChatMessage = {
      id: "queued-2",
      content: "",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        displayName: "screenshot.png",
        absolutePath: "/tmp/screenshot.png",
        relativePath: "screenshot.png",
        contentUrl: "/media/screenshot.png",
        mimeType: "image/png",
        size: 1024,
      }],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued")
    expect(html).toContain('aria-label="Send now"')
    expect(html).toContain('aria-label="Cancel message"')
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test("shows controls at rest without hover gating and labels both", () => {
    const message: QueuedChatMessage = {
      id: "queued-3",
      content: "Another follow-up",
      attachments: [],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain('aria-label="Cancel message"')
    expect(html).toContain('aria-label="Send now"')
    expect(html).not.toContain("opacity-0")
    expect(html).not.toContain("scale-[0.1]")
  })
})

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

  test("shows the cancel control at rest with no hover gating, and both controls are labeled", () => {
    const message: QueuedChatMessage = {
      id: "queued-2",
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

    // No hover event is ever dispatched against static markup, so a control
    // that still appears here is reachable without one - the regression this
    // guards against is the control only existing behind `group-hover`.
    expect(html).toContain('aria-label="Cancel message"')
    expect(html).toContain('aria-label="Send now"')
    expect(html).not.toContain("opacity-0")
    expect(html).not.toContain("scale-[0.1]")
  })
})

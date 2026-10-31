import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueuePausedNotice } from "./QueuePausedNotice"

describe("QueuePausedNotice", () => {
  test("says the queue is held and offers the way on", () => {
    const html = renderToStaticMarkup(<QueuePausedNotice onResume={() => {}} />)
    expect(html).toContain("Queue paused after the stop.")
    expect(html).toContain(">Resume</button>")
  })
})

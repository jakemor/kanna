import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ChannelRowTrailing } from "./ChannelList"

function render(attentionCount: number) {
  return renderToStaticMarkup(<div>{ChannelRowTrailing({ attentionCount })}</div>)
}

describe("ChannelRowTrailing", () => {
  test("the count of chats that want you, and no +/− line counts", () => {
    const html = render(2)
    expect(html).toContain("data-channel-badge")
    expect(html).toContain(">2<")
    expect(html).not.toContain("data-channel-changes")
  })

  test("nothing when no chat wants you", () => {
    expect(render(0)).toBe("<div></div>")
  })
})

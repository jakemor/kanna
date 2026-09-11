import { describe, expect, test } from "bun:test"
import { buildBrowserAccessNotice } from "./browser-context"

describe("buildBrowserAccessNotice", () => {
  test("describes same-machine browsing without changing the user's visible text", () => {
    const notice = buildBrowserAccessNotice("http://localhost:5174")
    expect(notice).toContain("same-machine access")
    expect(notice).toContain("localhost URL is appropriate")
  })

  test("tells remote agents which hostname makes server links useful", () => {
    const notice = buildBrowserAccessNotice("https://jane.tailnet.ts.net/chat/one?ignored=yes")
    expect(notice).toContain("viewed over the network")
    expect(notice).toContain("jane.tailnet.ts.net instead of localhost")
    expect(notice).toContain("Preserve the started server's protocol and port")
  })

  test("rejects non-http context", () => {
    expect(buildBrowserAccessNotice("file:///tmp/kanna")).toBeNull()
  })
})

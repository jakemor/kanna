import { describe, expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RightSidebar } from "./RightSidebar"

describe("RightSidebar", () => {
  test("renders the placeholder copy", () => {
    const markup = renderToStaticMarkup(RightSidebar({ onClose: () => {} }))

    expect(markup).toContain("diffs coming soon")
  })

  test("renders the close affordance", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(RightSidebar({ onClose }))

    expect(markup).toContain("Close right sidebar")
  })
})

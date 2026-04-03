import { describe, expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RightSidebar } from "./RightSidebar"

describe("RightSidebar", () => {
  test("renders the empty-state copy when no diffs are loaded", () => {
    const markup = renderToStaticMarkup(RightSidebar({ onClose: () => {} }))

    expect(markup).toContain("No diffs to display")
  })

  test("renders the close affordance", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(RightSidebar({ onClose }))

    expect(markup).toContain("Close right sidebar")
  })
})

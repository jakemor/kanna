import "../../lib/testing/setupHappyDom"
import { describe, expect, test, afterEach } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MermaidZoomModal } from "./MermaidZoomModal"

let root: Root | null = null
let container: HTMLDivElement | null = null
afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  root = null; container = null
})

async function render(node: React.ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container!); root.render(node) })
}

describe("MermaidZoomModal", () => {
  test("renders the svg and a close control when open", async () => {
    let closed = false
    await render(
      <MermaidZoomModal svg={'<svg data-mermaid="1">X</svg>'} onClose={() => { closed = true }} />
    )
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute("aria-label")).toBe("Diagram zoom view")
    expect(dialog.innerHTML).toContain("data-mermaid")
    const close = document.querySelector('[aria-label="Close"]') as HTMLButtonElement
    expect(close).not.toBeNull()
    await act(async () => { close.click() })
    expect(closed).toBe(true)
  })

  test("zoom-in button increases scale (svg wrapper transform changes)", async () => {
    await render(<MermaidZoomModal svg={'<svg data-mermaid="1">X</svg>'} onClose={() => {}} />)
    const stage = document.querySelector('[data-mermaid-stage]') as HTMLElement
    expect(stage).not.toBeNull()
    const before = stage.style.transform
    const zoomIn = document.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement
    await act(async () => { zoomIn.click() })
    expect(stage.style.transform).not.toBe(before)
  })
})

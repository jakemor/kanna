import { describe, expect, test } from "bun:test"
import { viewerNavigationStep, type ViewerNavigation } from "./ViewerSurface"

const navigation: ViewerNavigation = { index: 1, count: 3, onPrevious: () => {}, onNext: () => {} }
const key = (value: string, extra: Partial<{ defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: value, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra,
})

describe("viewerNavigationStep", () => {
  test("j and ] step on, k and [ step back", () => {
    expect(viewerNavigationStep(key("j"), { navigation, typing: false })).toBe("next")
    expect(viewerNavigationStep(key("]"), { navigation, typing: false })).toBe("next")
    expect(viewerNavigationStep(key("k"), { navigation, typing: false })).toBe("previous")
    expect(viewerNavigationStep(key("["), { navigation, typing: false })).toBe("previous")
  })

  test("leaves a key typed in a field to the field", () => {
    expect(viewerNavigationStep(key("j"), { navigation, typing: true })).toBeNull()
    expect(viewerNavigationStep(key("k"), { navigation, typing: true })).toBeNull()
  })

  test("leaves a key with a modifier, or one a menu already took, alone", () => {
    expect(viewerNavigationStep(key("j", { metaKey: true }), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j", { ctrlKey: true }), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j", { altKey: true }), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j", { defaultPrevented: true }), { navigation, typing: false })).toBeNull()
  })

  test("does nothing at an end, or with one item, or none", () => {
    expect(viewerNavigationStep(key("j"), { navigation: { ...navigation, hasNext: false }, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("k"), { navigation: { ...navigation, hasPrevious: false }, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j"), { navigation: { ...navigation, count: 1 }, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j"), { navigation: undefined, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("x"), { navigation, typing: false })).toBeNull()
  })

  test("the arrows step only through items that run sideways", () => {
    const sideways = { ...navigation, horizontal: true }
    expect(viewerNavigationStep(key("ArrowRight"), { navigation: sideways, typing: false })).toBe("next")
    expect(viewerNavigationStep(key("ArrowLeft"), { navigation: sideways, typing: false })).toBe("previous")
    expect(viewerNavigationStep(key("j"), { navigation: sideways, typing: false })).toBe("next")
    expect(viewerNavigationStep(key("ArrowRight"), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("ArrowLeft"), { navigation, typing: false })).toBeNull()
  })

  test("leaves an arrow to a field, a focused video, or one held with a modifier", () => {
    const sideways = { ...navigation, horizontal: true }
    expect(viewerNavigationStep(key("ArrowRight"), { navigation: sideways, typing: true })).toBeNull()
    expect(viewerNavigationStep(key("ArrowRight"), { navigation: sideways, typing: false, arrowsTaken: true })).toBeNull()
    expect(viewerNavigationStep(key("j"), { navigation: sideways, typing: false, arrowsTaken: true })).toBe("next")
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(viewerNavigationStep(key("ArrowLeft", { [modifier]: true }), { navigation: sideways, typing: false })).toBeNull()
    }
  })
})

describe("the navigation's buttons", () => {
  test("carry their labels, and are disabled at the ends", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { ViewerSurface } = await import("./ViewerSurface")
    const { TooltipProvider } = await import("../ui/tooltip")
    const html = renderToStaticMarkup(
      <TooltipProvider>
      <ViewerSurface
        label="Diff"
        title="Changes"
        onClose={() => {}}
        navigation={{ ...navigation, index: 0, previousLabel: "Previous file · K", nextLabel: "Next file · J", hasPrevious: false, hasNext: true }}
      >
        body
      </ViewerSurface>
      </TooltipProvider>,
    )
    expect(html).toMatch(/aria-label="Previous file · K" aria-disabled="true"/)
    expect(html).toContain('aria-label="Next file · J"')
    expect(html).not.toMatch(/aria-label="Next file · J" aria-disabled/)
  })
})

describe("an attachment's steps in the header", () => {
  async function render(index: number) {
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { ViewerSurface } = await import("./ViewerSurface")
    const { TooltipProvider } = await import("../ui/tooltip")
    const { attachmentNavigation } = await import("./attachmentSequence")
    const sequence = Array.from({ length: 6 }, (_, item) => ({ url: `/a/${item}.png`, name: `${item}.png`, mimeType: "image/png", size: 1 }))
    return renderToStaticMarkup(
      <TooltipProvider>
      <ViewerSurface label={`Preview ${index}.png`} title={`${index}.png`} onClose={() => {}} navigation={attachmentNavigation(sequence, sequence[index]!, () => {})}>
        body
      </ViewerSurface>
      </TooltipProvider>,
    )
  }

  test("say where you are, and point sideways", async () => {
    const html = await render(2)
    expect(html).toContain(">3 of 6<")
    expect(html).toContain("lucide-chevron-left")
    expect(html).toContain("lucide-chevron-right")
    expect(html).not.toContain("aria-disabled")
  })

  test("dim Next on the last and Previous on the first", async () => {
    const last = await render(5)
    expect(last).toContain(">6 of 6<")
    expect(last).toMatch(/aria-label="Next attachment \(j\)" aria-disabled="true"/)
    expect(last).not.toMatch(/aria-label="Previous attachment \(k\)" aria-disabled/)
    const first = await render(0)
    expect(first).toContain(">1 of 6<")
    expect(first).toMatch(/aria-label="Previous attachment \(k\)" aria-disabled="true"/)
    expect(first).not.toMatch(/aria-label="Next attachment \(j\)" aria-disabled/)
  })
})

describe("viewerNavigationPress", () => {
  test("a press past an end is kept, as blocked, for a list that answers it", async () => {
    const { viewerNavigationPress } = await import("./ViewerSurface")
    const atLast = { ...navigation, index: 2, hasNext: false, horizontal: true }
    expect(viewerNavigationPress(key("ArrowRight"), { navigation: atLast, typing: false })).toEqual({ direction: "next", blocked: true })
    expect(viewerNavigationPress(key("j"), { navigation: atLast, typing: false })).toEqual({ direction: "next", blocked: true })
    expect(viewerNavigationPress(key("ArrowLeft"), { navigation: atLast, typing: false })).toEqual({ direction: "previous", blocked: false })
    expect(viewerNavigationStep(key("ArrowRight"), { navigation: atLast, typing: false })).toBeNull()
    expect(viewerNavigationPress(key("ArrowRight"), { navigation: atLast, typing: true })).toBeNull()
  })
})

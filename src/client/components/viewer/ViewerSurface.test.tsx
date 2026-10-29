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
  test("say where you are, point sideways, and are never disabled", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { ViewerSurface } = await import("./ViewerSurface")
    const { TooltipProvider } = await import("../ui/tooltip")
    const { attachmentNavigation } = await import("./attachmentSequence")
    const sequence = Array.from({ length: 6 }, (_, index) => ({ url: `/a/${index}.png`, name: `${index}.png`, mimeType: "image/png", size: 1 }))
    const html = renderToStaticMarkup(
      <TooltipProvider>
      <ViewerSurface label="Preview 5.png" title="5.png" onClose={() => {}} navigation={attachmentNavigation(sequence, sequence[5]!, () => {})}>
        body
      </ViewerSurface>
      </TooltipProvider>,
    )
    expect(html).toContain(">6 of 6<")
    expect(html).toContain('aria-label="Previous attachment (k)"')
    expect(html).toContain('aria-label="Next attachment (j)"')
    expect(html).not.toContain("aria-disabled")
    expect(html).toContain("lucide-chevron-left")
    expect(html).toContain("lucide-chevron-right")
  })
})

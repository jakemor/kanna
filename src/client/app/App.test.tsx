import { describe, expect, test } from "bun:test"
import { shouldRedirectToChangelog, shouldToggleProjectsSidebar } from "./App"

describe("shouldRedirectToChangelog", () => {
  test("redirects only from the root route when the version is unseen", () => {
    expect(shouldRedirectToChangelog("/", "0.12.0", null)).toBe(true)
    expect(shouldRedirectToChangelog("/", "0.12.0", "0.11.0")).toBe(true)
    expect(shouldRedirectToChangelog("/settings/general", "0.12.0", "0.11.0")).toBe(false)
    expect(shouldRedirectToChangelog("/chat/1", "0.12.0", "0.11.0")).toBe(false)
    expect(shouldRedirectToChangelog("/", "0.12.0", "0.12.0")).toBe(false)
  })
})

describe("shouldToggleProjectsSidebar", () => {
  test("allows the hotkey on non-editable surfaces", () => {
    const event = {
      defaultPrevented: false,
      isComposing: false,
      target: { tagName: "DIV", closest: () => null },
    } as unknown as KeyboardEvent
    expect(shouldToggleProjectsSidebar(event, true)).toBe(true)
  })

  test("blocks the hotkey in editable elements", () => {
    const event = {
      defaultPrevented: false,
      isComposing: false,
      target: { tagName: "INPUT" },
    } as unknown as KeyboardEvent

    expect(shouldToggleProjectsSidebar(event, true)).toBe(false)
  })

  test("blocks unmatched actions", () => {
    const event = {
      defaultPrevented: false,
      isComposing: false,
      target: null,
    } as unknown as KeyboardEvent
    expect(shouldToggleProjectsSidebar(event, false)).toBe(false)
  })
})

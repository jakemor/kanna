import { describe, expect, test } from "bun:test"
import {
  HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
  HOTKEY_TOOLTIP_TEXT_CLASSNAME,
  formatHotkeyLabel,
} from "./tooltip"

describe("formatHotkeyLabel", () => {
  test("renders hotkey labels in uppercase", () => {
    expect(formatHotkeyLabel("Cmd+J")).toBe("CMD+J")
    expect(formatHotkeyLabel("Ctrl+`")).toBe("CTRL+`")
  })
})

describe("HOTKEY_TOOLTIP_CONTENT_CLASSNAME", () => {
  test("includes uppercase and monospace styling hooks", () => {
    expect(HOTKEY_TOOLTIP_CONTENT_CLASSNAME).toContain("uppercase")
    expect(HOTKEY_TOOLTIP_TEXT_CLASSNAME).toContain("font-mono")
  })
})

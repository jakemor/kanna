import { describe, expect, test } from "bun:test"
import {
  HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
  formatHotkeyLabel,
} from "./tooltip"

describe("formatHotkeyLabel", () => {
  test("renders hotkey labels in uppercase", () => {
    expect(formatHotkeyLabel("Cmd+J")).toBe("CMD+J")
    expect(formatHotkeyLabel("Ctrl+`")).toBe("CTRL+`")
  })
})

describe("HOTKEY_TOOLTIP_CONTENT_CLASSNAME", () => {
  test("includes expected styling hooks", () => {
    expect(HOTKEY_TOOLTIP_CONTENT_CLASSNAME).toContain("border-border")
    expect(HOTKEY_TOOLTIP_CONTENT_CLASSNAME).toContain("backdrop-blur-md")
  })
})

import { describe, expect, test } from "bun:test"
import {
  getDesktopSidebarStyle,
  shouldCloseSidebarOnChatSelect,
  shouldRenderDesktopSidebarResizeHandle,
} from "./KannaSidebar"

describe("shouldCloseSidebarOnChatSelect", () => {
  test("closes the sidebar when it is open as the mobile overlay", () => {
    expect(shouldCloseSidebarOnChatSelect(true)).toBe(true)
  })

  test("keeps the desktop sidebar open when it is not in mobile overlay mode", () => {
    expect(shouldCloseSidebarOnChatSelect(false)).toBe(false)
  })
})

describe("desktop sidebar resize helpers", () => {
  test("uses the persisted desktop width on desktop", () => {
    expect(getDesktopSidebarStyle(true, false, 360)).toEqual({ width: "360px" })
  })

  test("does not apply desktop width styling on mobile", () => {
    expect(getDesktopSidebarStyle(false, false, 360)).toBeUndefined()
  })

  test("does not render a desktop resize affordance while collapsed", () => {
    expect(shouldRenderDesktopSidebarResizeHandle(true, true)).toBe(false)
  })

  test("uses the draft width while dragging", () => {
    expect(getDesktopSidebarStyle(true, false, 412)).toEqual({ width: "412px" })
  })
})

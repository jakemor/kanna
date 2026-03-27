import { describe, expect, test } from "bun:test"
import {
  getDefaultTerminalMainSizes,
  getTerminalHeightFromContainer,
  shouldCloseTerminalPane,
  TERMINAL_CLOSE_HEIGHT_THRESHOLD_PX,
} from "./terminalLayoutResize"

describe("terminalLayoutResize", () => {
  test("computes terminal height from the container and split percentage", () => {
    expect(getTerminalHeightFromContainer(800, 32)).toBe(256)
    expect(getTerminalHeightFromContainer(0, 32)).toBe(0)
    expect(getTerminalHeightFromContainer(800, 0)).toBe(0)
  })

  test("closes the terminal only when its height drops below the threshold", () => {
    expect(shouldCloseTerminalPane(1000, 3.4)).toBe(true)
    expect(shouldCloseTerminalPane(1000, 3.5)).toBe(false)
    expect(shouldCloseTerminalPane(1000, 0)).toBe(true)
  })

  test("returns a fresh copy of the default main sizes", () => {
    const sizes = getDefaultTerminalMainSizes()
    expect(sizes).toEqual([68, 32])

    sizes[0] = 100
    expect(getDefaultTerminalMainSizes()).toEqual([68, 32])
  })

  test("exports the agreed close threshold", () => {
    expect(TERMINAL_CLOSE_HEIGHT_THRESHOLD_PX).toBe(35)
  })
})

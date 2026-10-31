import { describe, expect, test } from "bun:test"
import { pageChrome } from "./page-chrome"

// macOS 26's unified toolbar (native-window.ts FALLBACK_SHAPE), written out
// so the test doesn't load koffi.
const shape = { trafficLightsInset: 91, trafficLightsCenter: 26, cornerRadius: 26, trafficLights: { x: 19, y: 19 } }
// Every zoom ⌘+ / ⌘− can reach (window.ts setZoom).
const zooms = Array.from({ length: 16 }, (_, step) => Math.round((0.5 + step / 10) * 10) / 10)
const pixels = (value: string | undefined) => Number(value?.replace(/px$/, ""))

describe("pageChrome", () => {
  test.each(zooms)("at %p zoom the page's values land on the window's points", (zoom) => {
    const { fullScreen, vars } = pageChrome(shape, { fullScreen: false, zoom })
    expect(fullScreen).toBe(false)
    // Rounded to a hundredth of a CSS pixel, so within 0.01pt at 2x.
    expect(pixels(vars["--mac-traffic-lights-inset"]) * zoom).toBeCloseTo(shape.trafficLightsInset, 1)
    expect(pixels(vars["--mac-traffic-lights-center"]) * zoom).toBeCloseTo(shape.trafficLightsCenter, 1)
    expect(pixels(vars["--mac-window-radius"]) * zoom).toBeCloseTo(shape.cornerRadius, 1)
  })

  test("at actual size the values are the points themselves", () => {
    expect(pageChrome(shape, { fullScreen: false, zoom: 1 }).vars).toEqual({
      "--mac-traffic-lights-inset": "91px",
      "--mac-traffic-lights-center": "26px",
      "--mac-window-radius": "26px",
    })
  })

  test("the Air's 90%: the row centers 26pt down, not 23.4pt", () => {
    const { vars } = pageChrome(shape, { fullScreen: false, zoom: 0.9 })
    expect(vars["--mac-traffic-lights-center"]).toBe("28.89px")
    expect(vars["--mac-traffic-lights-inset"]).toBe("101.11px")
  })

  test.each(zooms)("full screen at %p zoom keeps the page's own inset and radius", (zoom) => {
    const { fullScreen, vars } = pageChrome(shape, { fullScreen: true, zoom })
    expect(fullScreen).toBe(true)
    expect(vars["--mac-traffic-lights-inset"]).toBe("20px")
    expect(vars["--mac-window-radius"]).toBe("24px")
    expect(pixels(vars["--mac-traffic-lights-center"]) * zoom).toBeCloseTo(shape.trafficLightsCenter, 1)
  })
})

import { describe, expect, test } from "bun:test"
import { detectClientContext, detectCurrentUserDevice } from "./current-user-device"

describe("current-user-device", () => {
  test("detects Pixel Android devices", () => {
    expect(detectCurrentUserDevice({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    } as Navigator)).toBe("pixel")
  })

  test("detects macOS devices", () => {
    expect(detectCurrentUserDevice({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    } as Navigator)).toBe("macbook")
  })

  test("returns a matching client context label", () => {
    expect(detectClientContext({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    } as Navigator)).toEqual({
      currentUserDevice: "pixel",
      currentUserDeviceLabel: "pixel",
    })
  })
})

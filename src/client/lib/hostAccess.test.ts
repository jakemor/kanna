import { describe, expect, test } from "bun:test"
import { canOpenNativeAppsForHostname } from "./hostAccess"

describe("canOpenNativeAppsForHostname", () => {
  test("allows localhost hosts", () => {
    expect(canOpenNativeAppsForHostname("localhost")).toBe(true)
    expect(canOpenNativeAppsForHostname("127.0.0.1")).toBe(true)
    expect(canOpenNativeAppsForHostname("::1")).toBe(true)
  })

  test("disables native app access for remote hosts", () => {
    expect(canOpenNativeAppsForHostname("192.168.1.2")).toBe(false)
    expect(canOpenNativeAppsForHostname("example.com")).toBe(false)
  })
})

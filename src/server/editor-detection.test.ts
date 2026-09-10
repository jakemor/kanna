import { describe, expect, test } from "bun:test"
import { detectInstalledEditors } from "./editor-detection"

describe("detectInstalledEditors", () => {
  test("always reports custom, and never Xcode off macOS", async () => {
    const editors = await detectInstalledEditors({ force: true, platform: "linux" })

    expect(editors).toContain("custom")
    expect(editors).not.toContain("xcode")
  })

  test("caches, so a menu opening repeatedly doesn't re-probe the machine", async () => {
    const first = await detectInstalledEditors({ force: true })
    const second = await detectInstalledEditors()

    // Same array instance: the second call never reached the probes.
    expect(second).toBe(first)
  })
})

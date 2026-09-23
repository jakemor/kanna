import { describe, expect, test } from "bun:test"
import { parseAppLink } from "./app-links"

const origin = "https://kanna.example:8443"

describe("parseAppLink", () => {
  test("routes settings links on the current remote origin, preserving query and hash", () => {
    expect(parseAppLink("/settings")).toBe("/settings")
    expect(parseAppLink("/settings/backups")).toBe("/settings/backups")
    expect(parseAppLink(`${origin}/settings/backups?source=chat#status`, origin))
      .toBe("/settings/backups?source=chat#status")
  })
  test("leaves other hosts, ports, and file paths alone", () => {
    for (const href of [undefined, "/settings/config.ts", "/settings/backups/file.txt", "/Users/test/settings/backups", "//example.com/settings/backups", "https://example.com/settings/backups", "https://kanna.example/settings/backups", "http://kanna.example:8443/settings/backups"]) {
      expect(parseAppLink(href, origin)).toBeNull()
    }
  })
})

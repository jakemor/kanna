import { describe, expect, test } from "bun:test"
import { formatLocal, parseLocal } from "./autoContinueTime"

describe("formatLocal / parseLocal", () => {
  test("formatLocal in UTC produces dd/mm/yyyy hh:mm", () => {
    const result = formatLocal(Date.UTC(2026, 3, 22, 17, 5), "UTC")
    expect(result).toBe("22/04/2026 17:05")
  })

  test("formatLocal with Asia/Saigon shifts to +07:00", () => {
    const result = formatLocal(Date.UTC(2026, 3, 22, 17, 0), "Asia/Saigon")
    expect(result).toBe("23/04/2026 00:00")
  })

  test("formatLocal with tz=system uses runtime zone (smoke test)", () => {
    const result = formatLocal(Date.UTC(2026, 3, 22, 12, 0), "system")
    expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
  })

  test("parseLocal accepts well-formed dd/mm/yyyy hh:mm", () => {
    const millis = parseLocal("23/04/2026 00:00", "Asia/Saigon")
    expect(millis).toBe(Date.UTC(2026, 3, 22, 17, 0))
  })

  test("parseLocal rejects malformed input", () => {
    expect(parseLocal("22-04-2026 17:05", "UTC")).toBeNull()
    expect(parseLocal("32/04/2026 17:05", "UTC")).toBeNull()
    expect(parseLocal("22/04/2026", "UTC")).toBeNull()
  })
})

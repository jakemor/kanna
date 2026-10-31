import { describe, expect, test } from "bun:test"
import { formatToolDuration, toolCallDurationMs } from "./tool-duration"

const start = Date.parse("2026-10-24T12:00:00.000Z")
const at = (offsetMs: number) => new Date(start + offsetMs).toISOString()

describe("toolCallDurationMs", () => {
  test("a finished call is its result's stamp less its own", () => {
    const call = { timestamp: at(0), resultEntryId: "r", resultTimestamp: at(3_200) }
    expect(toolCallDurationMs(call, { running: false, now: start + 60_000 })).toBe(3_200)
  })

  test("a running call counts up to now", () => {
    const call = { timestamp: at(0) }
    expect(toolCallDurationMs(call, { running: true, now: start + 12_400 })).toBe(12_400)
  })

  test("an unanswered call in a chat at rest has no duration", () => {
    expect(toolCallDurationMs({ timestamp: at(0) }, { running: false, now: start + 5_000 })).toBeNull()
  })

  test("a result with no stamp has no duration, rather than a running one", () => {
    const call = { timestamp: at(0), resultEntryId: "r" }
    expect(toolCallDurationMs(call, { running: true, now: start + 5_000 })).toBeNull()
  })

  test("never negative", () => {
    const call = { timestamp: at(500), resultEntryId: "r", resultTimestamp: at(0) }
    expect(toolCallDurationMs(call, { running: false, now: start })).toBe(0)
  })
})

describe("formatToolDuration", () => {
  test("a finished call under ten seconds keeps a tenth", () => {
    expect(formatToolDuration(0, { finished: true })).toBe("0.0s")
    expect(formatToolDuration(400, { finished: true })).toBe("0.4s")
    expect(formatToolDuration(3_240, { finished: true })).toBe("3.2s")
    expect(formatToolDuration(9_940, { finished: true })).toBe("9.9s")
    expect(formatToolDuration(9_960, { finished: true })).toBe("10s")
  })

  test("a running call counts whole seconds", () => {
    expect(formatToolDuration(400, { finished: false })).toBe("0s")
    expect(formatToolDuration(3_600, { finished: false })).toBe("4s")
  })

  test("longer ones read as the Tasks widget's do", () => {
    expect(formatToolDuration(12_000, { finished: true })).toBe("12s")
    expect(formatToolDuration(64_000, { finished: true })).toBe("1m 4s")
    expect(formatToolDuration(64_000, { finished: false })).toBe("1m 4s")
    expect(formatToolDuration(3_720_000, { finished: true })).toBe("1h 2m")
  })
})

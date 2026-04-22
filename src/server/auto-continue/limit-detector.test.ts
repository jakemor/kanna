import { describe, expect, test } from "bun:test"
import { ClaudeLimitDetector } from "./limit-detector"

const detector = new ClaudeLimitDetector()

function anthropicError(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const error = new Error(JSON.stringify(body)) as Error & { status?: number; headers?: Record<string, string> }
  error.status = 429
  error.headers = headers
  return error
}

describe("ClaudeLimitDetector", () => {
  test("returns null for non-rate-limit errors", () => {
    const err = new Error("Something unrelated went wrong")
    expect(detector.detect("c1", err)).toBeNull()
  })

  test("detects rate limit with ISO reset timestamp in headers", () => {
    const resetIso = "2026-04-23T00:00:00+07:00"
    const err = anthropicError(
      { type: "error", error: { type: "rate_limit_error", message: "You've hit your limit · resets 12am (Asia/Saigon)" } },
      { "anthropic-ratelimit-unified-reset": resetIso, "x-anthropic-timezone": "Asia/Saigon" }
    )
    const detection = detector.detect("c1", err)
    expect(detection).not.toBeNull()
    expect(detection!.chatId).toBe("c1")
    expect(detection!.resetAt).toBe(new Date(resetIso).getTime())
    expect(detection!.tz).toBe("Asia/Saigon")
  })

  test("falls back to tz=system when no timezone header is present", () => {
    const resetIso = "2026-04-23T05:00:00Z"
    const err = anthropicError(
      { type: "error", error: { type: "rate_limit_error" } },
      { "anthropic-ratelimit-unified-reset": resetIso }
    )
    const detection = detector.detect("c1", err)
    expect(detection!.tz).toBe("system")
  })

  test("returns null when the payload is rate-limit but no reset timestamp can be parsed", () => {
    const err = anthropicError({ type: "error", error: { type: "rate_limit_error" } })
    expect(detector.detect("c1", err)).toBeNull()
  })

  test("parses resetAt from the message body when headers are absent", () => {
    const resetIso = "2026-04-23T00:00:00+07:00"
    const err = new Error(JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        resets_at: resetIso,
        timezone: "Asia/Saigon",
      },
    }))
    const detection = detector.detect("c1", err)
    expect(detection!.resetAt).toBe(new Date(resetIso).getTime())
    expect(detection!.tz).toBe("Asia/Saigon")
  })

  test("does not match on status-only errors (400, 500, etc.)", () => {
    const err = anthropicError({ type: "error", error: { type: "overloaded_error" } })
    expect(detector.detect("c1", err)).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { createConnectTokenManager } from "./connect-token"

describe("connect tokens", () => {
  test("minted tokens validate until the TTL, then expire", () => {
    let currentTime = 1_000
    const manager = createConnectTokenManager({ now: () => currentTime, ttlMs: 60_000 })

    const { token, expiresInMs } = manager.mint()
    expect(expiresInMs).toBe(60_000)

    currentTime += 59_999
    expect(manager.validate(token)).toBe(true)

    const late = manager.mint().token
    currentTime += 60_001
    expect(manager.validate(late)).toBe(false)
  })

  test("a token opens one socket: the second use is refused", () => {
    const manager = createConnectTokenManager()
    const { token } = manager.mint()
    expect(manager.validate(token)).toBe(true)
    expect(manager.validate(token)).toBe(false)
    // Spending one leaves the others.
    const other = manager.mint().token
    expect(manager.validate(other)).toBe(true)
  })

  test("unknown and empty tokens are rejected", () => {
    const manager = createConnectTokenManager()
    manager.mint()
    expect(manager.validate("not-a-token")).toBe(false)
    expect(manager.validate("")).toBe(false)
  })

  test("multiple live tokens all validate", () => {
    const manager = createConnectTokenManager()
    const first = manager.mint().token
    const second = manager.mint().token
    expect(manager.validate(first)).toBe(true)
    expect(manager.validate(second)).toBe(true)
    expect(first).not.toBe(second)
  })
})

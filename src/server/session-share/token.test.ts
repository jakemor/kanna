import { describe, expect, test } from "bun:test"
import { generateShareToken, hashToken } from "./token"

describe("token", () => {
  test("generateShareToken produces 43-char base64url (32 raw bytes)", () => {
    const t = generateShareToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("two generations differ", () => {
    expect(generateShareToken()).not.toBe(generateShareToken())
  })

  test("hashToken is stable, 32 chars, never returns the input", () => {
    const t = generateShareToken()
    const h = hashToken(t)
    expect(h).toMatch(/^[a-f0-9]{32}$/)
    expect(h).not.toBe(t)
    expect(hashToken(t)).toBe(h)
  })
})

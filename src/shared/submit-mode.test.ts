import { describe, expect, test } from "bun:test"
import { shouldSteerSubmit } from "./submit-mode"

describe("shouldSteerSubmit", () => {
  test("queues on a bare Enter and steers with the modifier", () => {
    expect(shouldSteerSubmit("queue", false)).toBe(false)
    expect(shouldSteerSubmit("queue", true)).toBe(true)
  })

  test("inverts once the default is steer", () => {
    // The point of the setting: whichever action you use most is the bare
    // keystroke, and the other stays reachable rather than disappearing.
    expect(shouldSteerSubmit("steer", false)).toBe(true)
    expect(shouldSteerSubmit("steer", true)).toBe(false)
  })
})

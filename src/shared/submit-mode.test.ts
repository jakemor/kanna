import { describe, expect, test } from "bun:test"
import { resolveModifiedEnter, shouldSteerSubmit } from "./submit-mode"

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

describe("resolveModifiedEnter", () => {
  const empty = { text: "", attachmentCount: 0 }

  test("an empty composer with a queue sends the oldest queued message", () => {
    expect(resolveModifiedEnter(empty, true)).toBe("send-oldest-queued")
  })

  test("text in the composer keeps sending the composer, queue or not", () => {
    expect(resolveModifiedEnter({ text: "hi", attachmentCount: 0 }, true)).toBe("composer")
    expect(resolveModifiedEnter({ text: "hi", attachmentCount: 0 }, false)).toBe("composer")
  })

  test("an empty composer with no queue does nothing", () => {
    expect(resolveModifiedEnter(empty, false)).toBe("none")
  })

  test("whitespace counts as empty", () => {
    expect(resolveModifiedEnter({ text: "  \n\t ", attachmentCount: 0 }, true)).toBe("send-oldest-queued")
    expect(resolveModifiedEnter({ text: "  \n\t ", attachmentCount: 0 }, false)).toBe("none")
  })

  test("an attachment is not empty", () => {
    expect(resolveModifiedEnter({ text: "", attachmentCount: 1 }, true)).toBe("composer")
    expect(resolveModifiedEnter({ text: " ", attachmentCount: 2 }, true)).toBe("composer")
  })
})

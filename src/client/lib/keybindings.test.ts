import { describe, expect, test } from "bun:test"
import { bindingMatchesEvent, parseKeybindingInput } from "./keybindings"

describe("parseKeybindingInput", () => {
  test("splits comma-separated values, trims whitespace, and lowercases", () => {
    expect(parseKeybindingInput(" Cmd+J, Ctrl+` ,  ")).toEqual(["cmd+j", "ctrl+`"])
  })
})

describe("bindingMatchesEvent", () => {
  test("matches modifier bindings case-insensitively", () => {
    const event = { key: "j", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent
    expect(bindingMatchesEvent("Cmd+J", event)).toBe(true)
  })

  test("does not match when modifiers differ", () => {
    const event = { key: "b", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true } as KeyboardEvent
    expect(bindingMatchesEvent("Ctrl+B", event)).toBe(false)
  })
})

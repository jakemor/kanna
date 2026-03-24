import { describe, expect, test } from "bun:test"
import { actionMatchesEvent, bindingMatchesEvent, getResolvedKeybindings, parseKeybindingInput } from "./keybindings"
import type { KeybindingsSnapshot } from "../../shared/types"

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

  test("matches shift+enter", () => {
    const event = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true } as KeyboardEvent
    expect(bindingMatchesEvent("Shift+Enter", event)).toBe(true)
  })
})

describe("actionMatchesEvent", () => {
  test("uses the configured submit chat binding", () => {
    const snapshot: KeybindingsSnapshot = {
      bindings: getResolvedKeybindings(null).bindings,
      warning: null,
      filePathDisplay: "",
    }
    snapshot.bindings.submitChatMessage = ["shift+enter"]

    const shiftEnterEvent = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true } as KeyboardEvent
    const enterEvent = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent

    expect(actionMatchesEvent(snapshot, "submitChatMessage", shiftEnterEvent)).toBe(true)
    expect(actionMatchesEvent(snapshot, "submitChatMessage", enterEvent)).toBe(false)
  })

  test("falls back to the default submit chat binding when missing from the snapshot", () => {
    const snapshot = {
      bindings: {
        toggleEmbeddedTerminal: ["cmd+j"],
        toggleRightSidebar: ["cmd+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+/"],
      },
      warning: null,
      filePathDisplay: "",
    } as KeybindingsSnapshot
    const event = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent

    expect(actionMatchesEvent(snapshot, "submitChatMessage", event)).toBe(true)
  })
})

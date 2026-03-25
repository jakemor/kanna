import { describe, expect, test } from "bun:test"
import { getCompactComposerLabels, shouldSubmitChatInput } from "./ChatInput"
import { getResolvedKeybindings } from "../../lib/keybindings"

describe("getCompactComposerLabels", () => {
  test("hides the Codex provider text in compact mode", () => {
    expect(getCompactComposerLabels({
      selectedProvider: "codex",
      codexFastMode: false,
      planMode: false,
    }).providerText).toBeNull()
  })

  test("keeps the Claude provider text in compact mode", () => {
    expect(getCompactComposerLabels({
      selectedProvider: "claude",
      codexFastMode: false,
      planMode: false,
    }).providerText).toBe("claude")
  })

  test("returns aggressive compact labels for codex mode and plan mode", () => {
    expect(getCompactComposerLabels({
      selectedProvider: "codex",
      codexFastMode: true,
      planMode: true,
    })).toEqual({
      providerText: null,
      codexModeText: "Fast",
      planModeText: "Plan",
    })

    expect(getCompactComposerLabels({
      selectedProvider: "codex",
      codexFastMode: false,
      planMode: false,
    })).toEqual({
      providerText: null,
      codexModeText: "Std",
      planModeText: "Implement",
    })
  })
})

describe("shouldSubmitChatInput", () => {
  test("submits when the configured keybinding matches", () => {
    const keybindings = getResolvedKeybindings(null)
    keybindings.bindings.submitChatMessage = ["shift+enter"]
    const event = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, isComposing: false } as KeyboardEvent

    expect(shouldSubmitChatInput(event, keybindings, false)).toBe(true)
  })

  test("does not submit on plain enter when the binding is changed to shift+enter", () => {
    const keybindings = getResolvedKeybindings(null)
    keybindings.bindings.submitChatMessage = ["shift+enter"]
    const event = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false } as KeyboardEvent

    expect(shouldSubmitChatInput(event, keybindings, false)).toBe(false)
  })

  test("does not submit while cancel is active", () => {
    const keybindings = getResolvedKeybindings(null)
    const event = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false } as KeyboardEvent

    expect(shouldSubmitChatInput(event, keybindings, true)).toBe(false)
  })

  test("does not submit while IME composition is active", () => {
    const keybindings = getResolvedKeybindings(null)
    const event = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: true } as KeyboardEvent

    expect(shouldSubmitChatInput(event, keybindings, false)).toBe(false)
  })
})

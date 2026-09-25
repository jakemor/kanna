import { describe, expect, test } from "bun:test"
import {
  ALLOW_FOCUS_RETAIN_ATTRIBUTE,
  CHAT_INPUT_ATTRIBUTE,
  CHAT_SELECTION_ZONE_ATTRIBUTE,
  FOCUS_FALLBACK_IGNORE_ATTRIBUTE,
  focusNextChatInput,
  hasActiveFocusOverlay,
  hasActiveTextSelection,
  isTextEntryTarget,
  resolveChatFocusAction,
} from "./chatFocusPolicy"

class FakeElement {
  parent: FakeElement | null
  attributes = new Map<string, string>()
  tagName: string
  tabIndex: number
  isContentEditable = false

  constructor(tagName: string, options?: { parent?: FakeElement | null; tabIndex?: number; attributes?: Record<string, string> }) {
    this.tagName = tagName.toLowerCase()
    this.parent = options?.parent ?? null
    this.tabIndex = options?.tabIndex ?? -1
    for (const [key, value] of Object.entries(options?.attributes ?? {})) {
      this.attributes.set(key, value)
    }
  }

  closest(selector: string) {
    const attributeMatch = selector.match(/^\[(.+)\]$/)
    if (!attributeMatch) return null
    const attribute = attributeMatch[1]
    let current: FakeElement | null = this
    while (current) {
      if (current.attributes.has(attribute)) return current as unknown as Element
      current = current.parent
    }
    return null
  }

  matches(selector: string) {
    if (selector === "button, a[href], summary") {
      if (this.tagName === "button" || this.tagName === "summary") return true
      return this.tagName === "a" && this.attributes.has("href")
    }
    if (selector === "input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']), textarea, select") {
      if (this.tagName === "textarea" || this.tagName === "select") return true
      if (this.tagName !== "input") return false
      const type = this.attributes.get("type") ?? "text"
      return !["checkbox", "radio", "button", "submit", "reset"].includes(type)
    }
    return false
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
}

function createTree() {
  const root = new FakeElement("div")
  const chat = new FakeElement("textarea", { parent: root })
  const button = new FakeElement("button", { parent: root, tabIndex: 0 })
  const random = new FakeElement("div", { parent: root })
  const transcript = new FakeElement("div", { parent: root, attributes: { [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" } })
  const transcriptText = new FakeElement("div", { parent: transcript })
  const otherInput = new FakeElement("input", { parent: root })
  const custom = new FakeElement("div", { parent: root, attributes: { [ALLOW_FOCUS_RETAIN_ATTRIBUTE]: "" } })
  const overlay = new FakeElement("div", { attributes: { [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "", "data-state": "open" } })

  return {
    root: {
      contains: (other: Node | null) => [chat, button, random, transcript, transcriptText, otherInput, custom].includes(other as unknown as FakeElement),
    },
    chat: chat as unknown as HTMLTextAreaElement,
    button: button as unknown as Element,
    random: random as unknown as Element,
    transcript: transcript as unknown as Element,
    transcriptText: transcriptText as unknown as Element,
    otherInput: otherInput as unknown as Element,
    custom: custom as unknown as Element,
    overlay,
  }
}

describe("chatFocusPolicy", () => {
  test("focusNextChatInput keeps focus on the current input when it is the only chat input", () => {
    let focusedElement: unknown = null
    const current = {
      disabled: false,
      focus: () => {
        focusedElement = current
      },
    } as HTMLTextAreaElement
    const document = {
      querySelectorAll: () => [current],
    } as unknown as Document

    expect(focusNextChatInput(current, document)).toBe(true)
    expect(focusedElement).toBe(current)
  })

  test("focusNextChatInput cycles to the next chat input", () => {
    let focusedElement: unknown = null
    const first = {
      disabled: false,
      focus: () => {
        focusedElement = first
      },
    } as HTMLTextAreaElement
    const second = {
      disabled: false,
      focus: () => {
        focusedElement = second
      },
    } as HTMLTextAreaElement
    const document = {
      querySelectorAll: (selector: string) =>
        selector === `textarea[${CHAT_INPUT_ATTRIBUTE}]` ? [first, second] : [],
    } as unknown as Document

    expect(focusNextChatInput(first, document)).toBe(true)
    expect(focusedElement).toBe(second)
  })

  test("detects text entry targets and explicit retain targets", () => {
    const { otherInput, custom, random } = createTree()

    expect(isTextEntryTarget(otherInput)).toBe(true)
    expect(isTextEntryTarget(custom)).toBe(true)
    expect(isTextEntryTarget(random)).toBe(false)
  })

  test("detects active text selections", () => {
    expect(hasActiveTextSelection({ isCollapsed: false, toString: () => "selected text" } as Selection)).toBe(true)
    expect(hasActiveTextSelection({ isCollapsed: true, toString: () => "selected text" } as Selection)).toBe(false)
    expect(hasActiveTextSelection({ isCollapsed: false, toString: () => "   " } as Selection)).toBe(false)
  })

  test("restores chat input after clicking a random non-focusable area", () => {
    const { root, chat, random } = createTree()

    expect(resolveChatFocusAction({
      trigger: "pointer",
      activeElement: null,
      pointerStartTarget: random,
      pointerEndTarget: random,
      root,
      fallback: chat,
      hasActiveOverlay: false,
      hasActiveSelection: false,
    })).toBe("restore")
  })

  test("restores chat input after clicking a button that took focus", () => {
    const { root, chat, button } = createTree()

    expect(resolveChatFocusAction({
      trigger: "pointer",
      activeElement: button,
      pointerStartTarget: button,
      pointerEndTarget: button,
      root,
      fallback: chat,
      hasActiveOverlay: false,
      hasActiveSelection: false,
    })).toBe("restore")
  })

  test("does not restore when another input owns focus", () => {
    const { root, chat, random, otherInput } = createTree()

    expect(resolveChatFocusAction({
      trigger: "pointer",
      activeElement: otherInput,
      pointerStartTarget: random,
      pointerEndTarget: random,
      root,
      fallback: chat,
      hasActiveOverlay: false,
      hasActiveSelection: false,
    })).toBe("none")
  })

  test("does not restore when transcript text is being selected", () => {
    const { root, chat, transcriptText } = createTree()

    expect(resolveChatFocusAction({
      trigger: "pointer",
      activeElement: null,
      pointerStartTarget: transcriptText,
      pointerEndTarget: transcriptText,
      root,
      fallback: chat,
      hasActiveOverlay: false,
      hasActiveSelection: true,
    })).toBe("none")
  })

  test("detects active overlays from the document and skips restore while open", () => {
    const { root, chat, random, overlay } = createTree()
    const document = {
      querySelector: (selector: string) =>
        selector === `[${FOCUS_FALLBACK_IGNORE_ATTRIBUTE}][data-state='open']` ? overlay : null,
    } as Document

    expect(hasActiveFocusOverlay(document)).toBe(true)
    expect(resolveChatFocusAction({
      trigger: "pointer",
      activeElement: null,
      pointerStartTarget: random,
      pointerEndTarget: random,
      root,
      fallback: chat,
      hasActiveOverlay: hasActiveFocusOverlay(document),
      hasActiveSelection: false,
    })).toBe("none")
  })

  test("focuses chat input on escape when composer is unfocused and idle", () => {
    const { chat, random } = createTree()

    expect(resolveChatFocusAction({
      trigger: "escape",
      activeElement: random,
      fallback: chat,
      hasActiveOverlay: false,
      canCancel: false,
      defaultPrevented: false,
    })).toBe("escape-focus")
  })

  test("does not focus chat input on escape when composer is already focused", () => {
    const { chat } = createTree()
    ;(chat as unknown as FakeElement).attributes.set(CHAT_INPUT_ATTRIBUTE, "")

    expect(resolveChatFocusAction({
      trigger: "escape",
      activeElement: chat,
      fallback: chat,
      hasActiveOverlay: false,
      canCancel: false,
      defaultPrevented: false,
    })).toBe("none")
  })

  test("does not focus chat input on escape while a turn is cancelable", () => {
    const { chat, random } = createTree()

    expect(resolveChatFocusAction({
      trigger: "escape",
      activeElement: random,
      fallback: chat,
      hasActiveOverlay: false,
      canCancel: true,
      defaultPrevented: false,
    })).toBe("none")
  })

  test("leaves escape to a region that keeps its own focus, like the viewer's pane", () => {
    const { chat } = createTree()
    const pane = new FakeElement("div", { attributes: { [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" } })
    const paneButton = new FakeElement("button", { parent: pane, tabIndex: 0 })

    expect(resolveChatFocusAction({
      trigger: "escape",
      activeElement: paneButton as unknown as Element,
      fallback: chat,
      hasActiveOverlay: false,
      canCancel: false,
      defaultPrevented: false,
    })).toBe("none")
  })

  test("does not focus chat input on escape when an overlay is open", () => {
    const { chat, random } = createTree()

    expect(resolveChatFocusAction({
      trigger: "escape",
      activeElement: random,
      fallback: chat,
      hasActiveOverlay: true,
      canCancel: false,
      defaultPrevented: false,
    })).toBe("none")
  })

  test("does not focus chat input on escape when the event was already handled", () => {
    const { chat, random } = createTree()

    expect(resolveChatFocusAction({
      trigger: "escape",
      activeElement: random,
      fallback: chat,
      hasActiveOverlay: false,
      canCancel: false,
      defaultPrevented: true,
    })).toBe("none")
  })
})

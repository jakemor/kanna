import "../../lib/testing/setupHappyDom"
import { afterEach, describe, expect, test } from "bun:test"
import { Profiler, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  ChatInput,
  isTouchDeviceEnvironment,
  shouldRefreshPickerOnSelection,
} from "./ChatInput"
import { PROVIDERS } from "../../../shared/types"

function setTouchDevice(on: boolean) {
  if (on) {
    Object.defineProperty(window, "ontouchstart", { configurable: true, value: null })
  } else if ("ontouchstart" in window) {
    delete (window as unknown as { ontouchstart?: unknown }).ontouchstart
  }
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: on ? 5 : 0,
  })
}

describe("shouldRefreshPickerOnSelection", () => {
  test("desktop -> picker refreshes on caret moves (Arrow keys, mouse clicks)", () => {
    expect(shouldRefreshPickerOnSelection(false)).toBe(true)
  })

  test("touch device -> picker does NOT refresh on `select` events (iOS hold-space cursor-drag safety)", () => {
    // Regression guard: re-rendering a controlled <textarea> on every
    // selection event causes the iOS Safari trackpad gesture to jump the
    // caret mid-drag. The component must skip the caret-version bump on
    // touch devices to keep the gesture smooth.
    expect(shouldRefreshPickerOnSelection(true)).toBe(false)
  })
})

describe("isTouchDeviceEnvironment", () => {
  afterEach(() => setTouchDevice(false))

  test("false when neither ontouchstart nor maxTouchPoints", () => {
    setTouchDevice(false)
    expect(isTouchDeviceEnvironment()).toBe(false)
  })

  test("true when ontouchstart present (mobile Safari)", () => {
    Object.defineProperty(window, "ontouchstart", { configurable: true, value: null })
    expect(isTouchDeviceEnvironment()).toBe(true)
  })

  test("true when maxTouchPoints > 0 (touch laptop, iPad)", () => {
    if ("ontouchstart" in window) {
      delete (window as unknown as { ontouchstart?: unknown }).ontouchstart
    }
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 })
    expect(isTouchDeviceEnvironment()).toBe(true)
  })
})

describe("ChatInput onSelect wiring", () => {
  let container: HTMLDivElement
  let root: Root | null = null

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
      root = null
    }
    container?.remove()
    setTouchDevice(false)
  })

  test("touch device: `select` events on the textarea do not produce any extra render commits (no caret-version bump => no controlled-textarea reconciliation mid-gesture)", async () => {
    setTouchDevice(true)

    container = document.createElement("div")
    document.body.appendChild(container)

    let commitCount = 0
    const onRender = () => {
      commitCount++
    }

    await act(async () => {
      root = createRoot(container)
      root.render(
        <Profiler id="chat-input" onRender={onRender}>
          <ChatInput
            onSubmit={async () => {}}
            disabled={false}
            chatId="touch-chat"
            projectId={null}
            activeProvider="claude"
            availableProviders={PROVIDERS}
          />
        </Profiler>,
      )
    })

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    expect(textarea).toBeTruthy()

    const baseline = commitCount

    // React 19 routes the `select` synthetic event through a document-level
    // `selectionchange` listener and only forwards it when the source element
    // is focused. Mimic that exact path here so we're testing the same code
    // path iOS Safari hits during the hold-space cursor-drag gesture.
    textarea.focus()
    await act(async () => {
      for (let pos = 0; pos < 5; pos++) {
        textarea.setSelectionRange(pos, pos)
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }))
        textarea.dispatchEvent(new Event("select", { bubbles: true }))
      }
    })

    // On a touch device the gate must short-circuit `setCaretVersion`. If a
    // regression re-introduces the unconditional bump, each `select` event
    // schedules a state update and React commits an extra render that the
    // Profiler observes.
    expect(commitCount).toBe(baseline)
  })
})

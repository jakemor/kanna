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

describe("ChatInput selection clamp guard (iOS keyboard-trackpad caret-escape)", () => {
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

  test("on touch devices, a Selection that drifts onto sibling content while the textarea is still focused is collapsed back into the textarea", async () => {
    setTouchDevice(true)

    container = document.createElement("div")
    document.body.appendChild(container)

    // Sibling content simulates the chat-message transcript above the
    // composer. iOS lets the hold-space cursor land on this text if the
    // user drags past the textarea boundary.
    const chatContent = document.createElement("div")
    chatContent.append(document.createTextNode("previous assistant reply text"))
    container.appendChild(chatContent)

    const inputHost = document.createElement("div")
    container.appendChild(inputHost)

    await act(async () => {
      root = createRoot(inputHost)
      root.render(
        <ChatInput
          onSubmit={async () => {}}
          disabled={false}
          chatId="clamp-chat"
          projectId={null}
          activeProvider="claude"
          availableProviders={PROVIDERS}
        />,
      )
    })

    const textarea = inputHost.querySelector("textarea") as HTMLTextAreaElement
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    // Point the document Selection at sibling chat-content text — mirrors
    // what iOS does when the keyboard-trackpad caret crosses the textarea
    // boundary. The textarea remains focused throughout. (The guard's
    // selectionchange listener fires synchronously whether we dispatch the
    // event manually or it fires from the addRange call, so we just check
    // the steady-state result after both: the selection must not point
    // outside the textarea while the textarea is the active element.)
    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(chatContent.firstChild as Node, 0)
    range.setEnd(chatContent.firstChild as Node, 0)
    selection?.removeAllRanges()
    await act(async () => {
      selection?.addRange(range)
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }))
    })

    const after = window.getSelection()
    const focusNode = after?.focusNode ?? null
    expect((after?.rangeCount ?? 0) === 0 || textarea.contains(focusNode)).toBe(true)
  })

  test("desktop (non-touch): the guard is inactive — Selection on sibling content stays put", async () => {
    setTouchDevice(false)

    container = document.createElement("div")
    document.body.appendChild(container)

    const chatContent = document.createElement("div")
    chatContent.append(document.createTextNode("previous assistant reply text"))
    container.appendChild(chatContent)

    const inputHost = document.createElement("div")
    container.appendChild(inputHost)

    await act(async () => {
      root = createRoot(inputHost)
      root.render(
        <ChatInput
          onSubmit={async () => {}}
          disabled={false}
          chatId="clamp-desktop-chat"
          projectId={null}
          activeProvider="claude"
          availableProviders={PROVIDERS}
        />,
      )
    })

    const textarea = inputHost.querySelector("textarea") as HTMLTextAreaElement
    textarea.focus()

    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(chatContent.firstChild as Node, 0)
    range.setEnd(chatContent.firstChild as Node, 0)
    selection?.removeAllRanges()
    selection?.addRange(range)

    await act(async () => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }))
    })

    const after = window.getSelection()
    expect(after?.focusNode).toBe(chatContent.firstChild)
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

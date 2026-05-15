import { afterEach, describe, expect, test } from "bun:test"
import {
  createChatBrowserNotificationPayload,
  showChatBrowserNotification,
  shouldShowChatBrowserNotification,
  truncateChatBrowserNotificationMessage,
} from "./chatBrowserNotifications"

const originalNotification = globalThis.Notification

afterEach(() => {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: originalNotification,
  })
})

describe("chat browser notifications", () => {
  test("applies browser notification preference gates", () => {
    const focusedDoc = { visibilityState: "visible" as const, hasFocus: () => true }
    const hiddenDoc = { visibilityState: "hidden" as const, hasFocus: () => false }

    expect(shouldShowChatBrowserNotification("never", hiddenDoc)).toBe(false)
    expect(shouldShowChatBrowserNotification("always", focusedDoc)).toBe(true)
    expect(shouldShowChatBrowserNotification("unfocused", hiddenDoc)).toBe(true)
    expect(shouldShowChatBrowserNotification("unfocused", focusedDoc)).toBe(false)
  })

  test("creates title from project and chat and truncates message text", () => {
    const payload = createChatBrowserNotificationPayload({
      projectTitle: "Project",
      chatTitle: "Chat",
      message: `First line\n\n${"A".repeat(220)}`,
    })

    expect(payload.title).toBe("Project - Chat")
    expect(payload.body).toBe(`First line ${"A".repeat(166)}...`)
  })

  test("uses a fallback body when the response text is missing", () => {
    expect(truncateChatBrowserNotificationMessage(" \n ")).toBe("New chat activity.")
  })

  test("constructs a browser notification when permission is granted", () => {
    const created: Array<{ title: string; options?: NotificationOptions; onclick: ((event: Event) => void) | null; close: () => void }> = []
    class FakeNotification {
      static permission: NotificationPermission = "granted"
      onclick: ((event: Event) => void) | null = null
      close = () => {}

      constructor(title: string, options?: NotificationOptions) {
        created.push(this as never)
        Object.assign(this, { title, options })
      }
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: FakeNotification,
    })

    expect(showChatBrowserNotification({
      projectTitle: "Project",
      chatTitle: "Chat",
      message: "Done.",
    })).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      title: "Project - Chat",
      options: { body: "Done." },
    })
  })

  test("runs the click handler and closes the notification when clicked", () => {
    let clicked = 0
    let closed = 0
    const created: Array<{ onclick: ((event: Event) => void) | null }> = []
    class FakeNotification {
      static permission: NotificationPermission = "granted"
      onclick: ((event: Event) => void) | null = null
      close = () => {
        closed += 1
      }

      constructor() {
        created.push(this)
      }
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: FakeNotification,
    })

    expect(showChatBrowserNotification({
      projectTitle: "Project",
      chatTitle: "Chat",
      message: "Done.",
      onClick: () => {
        clicked += 1
      },
    })).toBe(true)

    created[0]?.onclick?.(new Event("click"))

    expect(clicked).toBe(1)
    expect(closed).toBe(1)
  })

  test("does not construct a browser notification without permission", () => {
    class FakeNotification {
      static permission: NotificationPermission = "denied"
    }
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      writable: true,
      value: FakeNotification,
    })

    expect(showChatBrowserNotification({
      projectTitle: "Project",
      chatTitle: "Chat",
      message: "Done.",
    })).toBe(false)
  })
})

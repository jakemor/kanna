import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import "../../lib/testing/setupHappyDom"
import { ShareViewPage } from "./ShareViewPage"
import { CHAT_SNAPSHOT_VERSION, type ChatSnapshot } from "../../../shared/session-share/types"

const snap: ChatSnapshot = {
  version: CHAT_SNAPSHOT_VERSION,
  chatMeta: { id: "c1", title: "Public chat", model: "claude", createdAt: 0 },
  messages: [
    { kind: "user_prompt", id: "m1", createdAt: 0, text: "hi" },
    { kind: "assistant_text", id: "m2", createdAt: 1, text: "hello" },
  ],
  attachmentsManifest: [],
}

async function mountShareViewPage(
  snapshot: ChatSnapshot,
): Promise<{ container: HTMLDivElement; cleanup: () => void }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => {
    const root = createRoot(container)
    root.render(createElement(ShareViewPage, { snapshot }))
  })
  return {
    container,
    cleanup: () => {
      container.remove()
    },
  }
}

describe("ShareViewPage", () => {
  test("renders chat title and messages from snapshot", async () => {
    const { container, cleanup } = await mountShareViewPage(snap)
    try {
      const html = container.innerHTML
      expect(html).toContain("Public chat")
      expect(html).toContain("hi")
      expect(html).toContain("hello")
    } finally {
      cleanup()
    }
  })

  test("composer is absent (no textarea, no input)", async () => {
    const { container, cleanup } = await mountShareViewPage(snap)
    try {
      expect(container.querySelector("textarea")).toBeNull()
      expect(container.querySelector("input")).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("renders omitted placeholder for omitted messages", async () => {
    const omittedSnap: ChatSnapshot = {
      ...snap,
      messages: [{ kind: "omitted", id: "m1", createdAt: 0, reason: "too_large" }],
    }
    const { container, cleanup } = await mountShareViewPage(omittedSnap)
    try {
      const html = container.innerHTML
      expect(html).toContain("omitted")
      expect(html).toContain("too_large")
    } finally {
      cleanup()
    }
  })
})

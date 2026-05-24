import { beforeEach, describe, expect, test } from "bun:test"
import { createElement } from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import "../../lib/testing/setupHappyDom"
import { SharePopoverBody } from "./SharePopover"
import type { ShareSummary } from "../../../shared/session-share/types"

const FIXED_NOW = 1_700_000_000_000

const MOCK_SUMMARY: ShareSummary = {
  tokenId: "tok-1",
  chatId: "c1",
  url: "https://example.com/share/tok-1",
  expiresAt: FIXED_NOW + 3_600_000 * 24,
  createdAt: FIXED_NOW,
  revoked: false,
}

async function mountBody(props: {
  chatId: string
  tunnelUp: boolean
  shares: readonly ShareSummary[]
  onMint?: (chatId: string) => Promise<void>
  onRevoke?: (tokenId: string) => Promise<void>
}): Promise<{ container: HTMLDivElement; cleanup: () => void }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => {
    const root = createRoot(container)
    root.render(
      createElement(SharePopoverBody, {
        chatId: props.chatId,
        tunnelUp: props.tunnelUp,
        shares: props.shares,
        now: FIXED_NOW,
        onMint: props.onMint ?? (async () => { /* noop */ }),
        onRevoke: props.onRevoke ?? (async () => { /* noop */ }),
      }),
    )
  })
  return {
    container,
    cleanup: () => { container.remove() },
  }
}

describe("SharePopoverBody", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  test("shows NO_TUNNEL CTA when tunnel is down", async () => {
    const { container, cleanup } = await mountBody({ chatId: "c1", tunnelUp: false, shares: [] })
    try {
      const html = container.innerHTML
      expect(html).toContain("tunnel")
      expect(html).not.toContain("Create share link")
    } finally {
      cleanup()
    }
  })

  test("Mint click calls onMint with chatId", async () => {
    const calls: string[] = []
    const { container, cleanup } = await mountBody({
      chatId: "c1",
      tunnelUp: true,
      shares: [],
      onMint: async (chatId: string) => { calls.push(chatId) },
    })
    try {
      const btn = container.querySelector("button[data-share-mint]") as HTMLButtonElement | null
      expect(btn).not.toBeNull()
      await act(async () => {
        btn!.click()
      })
      expect(calls).toEqual(["c1"])
    } finally {
      cleanup()
    }
  })

  test("Renders active share with copy + revoke + expiry text", async () => {
    const { container, cleanup } = await mountBody({
      chatId: "c1",
      tunnelUp: true,
      shares: [MOCK_SUMMARY],
    })
    try {
      const html = container.innerHTML
      expect(html).toContain("https://example.com/share/tok-1")
      expect(html).toContain("Copy")
      expect(html).toContain("Revoke")
      expect(html).toContain("Expires in")
    } finally {
      cleanup()
    }
  })

  test("Revoke click calls onRevoke with tokenId", async () => {
    const calls: string[] = []
    const { container, cleanup } = await mountBody({
      chatId: "c1",
      tunnelUp: true,
      shares: [MOCK_SUMMARY],
      onRevoke: async (tokenId: string) => { calls.push(tokenId) },
    })
    try {
      const btn = container.querySelector("button[data-share-revoke]") as HTMLButtonElement | null
      expect(btn).not.toBeNull()
      await act(async () => {
        btn!.click()
      })
      expect(calls).toEqual(["tok-1"])
    } finally {
      cleanup()
    }
  })
})

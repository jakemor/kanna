import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CloudflareTunnelCard } from "./CloudflareTunnelCard"
import type { CloudflareTunnelRecord } from "../../../shared/types"

const baseRecord: CloudflareTunnelRecord = {
  tunnelId: "t1",
  chatId: "c1",
  port: 5173,
  state: "proposed",
  url: null,
  error: null,
  proposedAt: 1,
  activatedAt: null,
  stoppedAt: null,
}

describe("CloudflareTunnelCard", () => {
  test("proposed state shows port + Expose/Dismiss buttons", () => {
    const html = renderToStaticMarkup(
      <CloudflareTunnelCard
        record={baseRecord}
        onAccept={() => {}}
        onStop={() => {}}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain("Port 5173")
    expect(html).toContain("Expose")
    expect(html).toContain("Dismiss")
  })

  test("active state renders URL + Copy/Stop", () => {
    const html = renderToStaticMarkup(
      <CloudflareTunnelCard
        record={{ ...baseRecord, state: "active", url: "https://abc.trycloudflare.com", activatedAt: 2 }}
        onAccept={() => {}}
        onStop={() => {}}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain("Tunnel live")
    expect(html).toContain("https://abc.trycloudflare.com")
    expect(html).toContain("Copy")
    expect(html).toContain("Stop")
  })

  test("stopped state shows 'Tunnel stopped'", () => {
    const html = renderToStaticMarkup(
      <CloudflareTunnelCard
        record={{ ...baseRecord, state: "stopped", stoppedAt: 3 }}
        onAccept={() => {}}
        onStop={() => {}}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain("Tunnel stopped")
  })

  test("failed state shows error + Retry/Dismiss", () => {
    const html = renderToStaticMarkup(
      <CloudflareTunnelCard
        record={{ ...baseRecord, state: "failed", error: "cloudflared not found" }}
        onAccept={() => {}}
        onStop={() => {}}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain("Tunnel failed")
    expect(html).toContain("cloudflared not found")
    expect(html).toContain("Retry")
  })
})

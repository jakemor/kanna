import { describe, expect, test } from "bun:test"
import { deriveChatTunnels } from "./read-model"
import type { CloudflareTunnelEvent } from "./events"

const base = { v: 1 as const, chatId: "c1", tunnelId: "t1" }

describe("deriveChatTunnels", () => {
  test("empty events → empty projection", () => {
    expect(deriveChatTunnels([], "c1")).toEqual({ tunnels: {}, liveTunnelId: null })
  })

  test("proposed → active → stopped flow", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: 123 },
      { ...base, kind: "tunnel_accepted", timestamp: 2, source: "user" },
      { ...base, kind: "tunnel_active", timestamp: 3, url: "https://abc.trycloudflare.com" },
      { ...base, kind: "tunnel_stopped", timestamp: 4, reason: "user" },
    ]
    const proj = deriveChatTunnels(events, "c1")
    expect(proj.tunnels.t1.state).toBe("stopped")
    expect(proj.tunnels.t1.url).toBe("https://abc.trycloudflare.com")
    expect(proj.liveTunnelId).toBeNull()
  })

  test("liveTunnelId tracks proposed/active", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
    ]
    expect(deriveChatTunnels(events, "c1").liveTunnelId).toBe("t1")
  })

  test("failed state preserves error", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
      { ...base, kind: "tunnel_failed", timestamp: 2, error: "cloudflared not found" },
    ]
    const proj = deriveChatTunnels(events, "c1")
    expect(proj.tunnels.t1.state).toBe("failed")
    expect(proj.tunnels.t1.error).toBe("cloudflared not found")
  })

  test("filters by chatId", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, chatId: "c2", kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
    ]
    expect(deriveChatTunnels(events, "c1")).toEqual({ tunnels: {}, liveTunnelId: null })
  })

  test("tunnel_accepted does not allocate a fresh record (no-op semantics)", () => {
    // We can't directly observe object identity across calls (each call rebuilds map),
    // but we can confirm tunnel_accepted doesn't change observable state.
    const proposedOnly: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_proposed", timestamp: 1, port: 5173, sourcePid: null },
    ]
    const proposedThenAccepted: CloudflareTunnelEvent[] = [
      ...proposedOnly,
      { ...base, kind: "tunnel_accepted", timestamp: 2, source: "user" },
    ]
    expect(deriveChatTunnels(proposedThenAccepted, "c1").tunnels.t1)
      .toEqual(deriveChatTunnels(proposedOnly, "c1").tunnels.t1)
  })

  test("orphan tunnel_active without prior tunnel_proposed yields empty projection", () => {
    const events: CloudflareTunnelEvent[] = [
      { ...base, kind: "tunnel_active", timestamp: 1, url: "https://x.trycloudflare.com" },
    ]
    expect(deriveChatTunnels(events, "c1")).toEqual({ tunnels: {}, liveTunnelId: null })
  })
})

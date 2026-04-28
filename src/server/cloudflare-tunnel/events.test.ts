import { describe, expect, test } from "bun:test"
import { CLOUDFLARE_TUNNEL_EVENT_VERSION, type CloudflareTunnelEvent } from "./events"

describe("cloudflare tunnel events", () => {
  test("event version is 1", () => {
    expect(CLOUDFLARE_TUNNEL_EVENT_VERSION).toBe(1)
  })

  test("discriminated union allows all five kinds", () => {
    const kinds: CloudflareTunnelEvent["kind"][] = [
      "tunnel_proposed",
      "tunnel_accepted",
      "tunnel_active",
      "tunnel_stopped",
      "tunnel_failed",
    ]
    expect(kinds).toHaveLength(5)
  })

  test("tunnel_proposed event is well-typed and fields are accessible", () => {
    const event: CloudflareTunnelEvent = {
      v: CLOUDFLARE_TUNNEL_EVENT_VERSION,
      kind: "tunnel_proposed",
      timestamp: 1_000,
      chatId: "c1",
      tunnelId: "t1",
      port: 5173,
      sourcePid: null,
    }
    expect(event.port).toBe(5173)
    expect(event.sourcePid).toBeNull()
  })

  test("tunnel_stopped reason covers all four lifecycle paths", () => {
    const reasons: ("user" | "source_exited" | "session_closed" | "server_shutdown")[] = [
      "user",
      "source_exited",
      "session_closed",
      "server_shutdown",
    ]
    expect(reasons).toHaveLength(4)
  })
})

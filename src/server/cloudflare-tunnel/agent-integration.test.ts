import { describe, expect, test } from "bun:test"
import { handleBashToolResult } from "./agent-integration"
import type { CloudflareTunnelEvent } from "./events"
import type { CloudflareTunnelSettings } from "../../shared/types"

const baseSettings: CloudflareTunnelSettings = {
  enabled: true,
  cloudflaredPath: "cloudflared",
  mode: "always-ask",
}

describe("handleBashToolResult", () => {
  test("emits one tunnel_proposed per detected port", async () => {
    const events: CloudflareTunnelEvent[] = []
    let autoCalls = 0
    await handleBashToolResult({
      command: "bun run dev",
      stdout: "Local: http://localhost:5173\nNetwork: http://127.0.0.1:5174",
      chatId: "c1",
      sourcePid: 100,
      settings: baseSettings,
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
      autoStart: async () => { autoCalls++ },
    })
    const proposed = events.filter((e: CloudflareTunnelEvent) => e.kind === "tunnel_proposed")
    expect(proposed).toHaveLength(2)
    const ports = proposed.map((e) => (e.kind === "tunnel_proposed" ? e.port : 0)).sort((a, b) => a - b)
    expect(ports).toEqual([5173, 5174])
    expect(autoCalls).toBe(0)
  })

  test("skips when feature disabled", async () => {
    const events: CloudflareTunnelEvent[] = []
    await handleBashToolResult({
      command: "bun run dev",
      stdout: "Local: http://localhost:5173",
      chatId: "c1",
      sourcePid: 100,
      settings: { ...baseSettings, enabled: false },
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
      autoStart: async () => {},
    })
    expect(events).toEqual([])
  })

  test("auto-expose mode emits accepted + triggers autoStart per port", async () => {
    const events: CloudflareTunnelEvent[] = []
    let startCalls = 0
    await handleBashToolResult({
      command: "bun run dev",
      stdout: "Local: http://localhost:5173",
      chatId: "c1",
      sourcePid: 100,
      settings: { ...baseSettings, mode: "auto-expose" },
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
      autoStart: async () => { startCalls++ },
    })
    expect(startCalls).toBe(1)
    expect(events.some((e) => e.kind === "tunnel_proposed")).toBe(true)
    expect(events.some((e) => e.kind === "tunnel_accepted")).toBe(true)
  })

  test("no events when detector reports no server", async () => {
    const events: CloudflareTunnelEvent[] = []
    await handleBashToolResult({
      command: "ls",
      stdout: "a b c",
      chatId: "c1",
      sourcePid: null,
      settings: baseSettings,
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
      autoStart: async () => {},
    })
    expect(events).toEqual([])
  })
})

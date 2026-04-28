import { describe, expect, mock, test } from "bun:test"
import { TunnelManager, type SpawnFn, type ChildHandle } from "./tunnel-manager"
import type { CloudflareTunnelEvent } from "./events"

interface FakeChild extends ChildHandle {
  emitStdout: (chunk: string) => void
  emitExit: (code: number) => void
}

function fakeChild(): FakeChild {
  const stdoutListeners: Array<(c: string) => void> = []
  const exitListeners: Array<(c: number) => void> = []
  let killed = false
  const child: FakeChild = {
    pid: 9999,
    kill: () => { killed = true; for (const l of exitListeners) l(0) },
    onStdout: (l: (chunk: string) => void) => { stdoutListeners.push(l) },
    onStderr: () => {},
    onExit: (l: (code: number) => void) => { exitListeners.push(l) },
    isKilled: () => killed,
    emitStdout: (chunk: string) => { for (const l of stdoutListeners) l(chunk) },
    emitExit: (code: number) => { for (const l of exitListeners) l(code) },
  }
  return child
}

describe("TunnelManager", () => {
  test("spawns cloudflared with --url and parses tunnel URL from stdout", async () => {
    const child = fakeChild()
    const spawn: SpawnFn = mock(() => child)
    const events: CloudflareTunnelEvent[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
    })

    const tunnelId = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })

    expect(spawn).toHaveBeenCalledWith("cloudflared", ["tunnel", "--url", "http://localhost:5173"])
    child.emitStdout("INF Your quick Tunnel has been created! Visit https://abc-def.trycloudflare.com\n")
    await new Promise((r) => setTimeout(r, 0))

    const active = events.find((e) => e.kind === "tunnel_active")
    expect(active).toBeDefined()
    if (active && active.kind === "tunnel_active") {
      expect(active.tunnelId).toBe(tunnelId)
      expect(active.url).toBe("https://abc-def.trycloudflare.com")
    }
  })

  test("reuses existing tunnel when same port requested twice", async () => {
    const child = fakeChild()
    const spawn = mock(() => child)
    const mgr = new TunnelManager({ spawn, cloudflaredPath: "cloudflared", onEvent: () => {} })

    const a = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    const b = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    expect(a).toBe(b)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test("emits tunnel_failed when spawn throws ENOENT", async () => {
    const spawn: SpawnFn = () => {
      const e = new Error("ENOENT")
      ;(e as NodeJS.ErrnoException).code = "ENOENT"
      throw e
    }
    const events: CloudflareTunnelEvent[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
    })
    await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    const failed = events.find((e) => e.kind === "tunnel_failed")
    expect(failed).toBeDefined()
    if (failed && failed.kind === "tunnel_failed") {
      expect(failed.error).toContain("cloudflared")
    }
  })

  test("stop() kills child and emits tunnel_stopped reason=user", async () => {
    const child = fakeChild()
    const spawn = mock(() => child)
    const events: CloudflareTunnelEvent[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
    })

    const id = await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    await mgr.stop(id, "user")

    const stopped = events.find((e) => e.kind === "tunnel_stopped")
    expect(stopped).toBeDefined()
    if (stopped && stopped.kind === "tunnel_stopped") {
      expect(stopped.reason).toBe("user")
    }
  })

  test("emits tunnel_failed when child exits non-zero before URL parsed", async () => {
    const child = fakeChild()
    const spawn = mock(() => child)
    const events: CloudflareTunnelEvent[] = []
    const mgr = new TunnelManager({
      spawn,
      cloudflaredPath: "cloudflared",
      onEvent: (e: CloudflareTunnelEvent) => events.push(e),
    })
    await mgr.start({ chatId: "c1", port: 5173, sourcePid: 100 })
    child.emitExit(1)
    expect(events.some((e) => e.kind === "tunnel_failed")).toBe(true)
  })
})

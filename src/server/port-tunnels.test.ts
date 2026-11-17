import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PortTunnelManager } from "./port-tunnels"
import type { StartedShareTunnel } from "./share"

function createFakeTunnel(publicUrl: string | null) {
  let resolveExit: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  let stopCalls = 0
  const tunnel: StartedShareTunnel = {
    publicUrl,
    stop: () => {
      stopCalls += 1
      resolveExit()
    },
    exited,
  }
  return {
    tunnel,
    exit: resolveExit,
    get stopCalls() {
      return stopCalls
    },
  }
}

describe("PortTunnelManager", () => {
  test("exposes a port once and reuses the running tunnel", async () => {
    const starts: string[] = []
    const fake = createFakeTunnel("https://one.trycloudflare.com")
    const manager = new PortTunnelManager({
      startTunnel: async (localUrl) => {
        starts.push(localUrl)
        return fake.tunnel
      },
    })

    const first = await manager.expose(5000)
    const second = await manager.expose(5000)

    expect(first).toEqual({ port: 5000, publicUrl: "https://one.trycloudflare.com" })
    expect(second).toEqual(first)
    expect(starts).toEqual(["http://localhost:5000"])
    expect(manager.getPublicUrl(5000)).toBe("https://one.trycloudflare.com")
    expect(manager.list()).toEqual([{ port: 5000, publicUrl: "https://one.trycloudflare.com" }])
  })

  test("shares one attempt between concurrent expose calls", async () => {
    let starts = 0
    const fake = createFakeTunnel("https://one.trycloudflare.com")
    const manager = new PortTunnelManager({
      startTunnel: async () => {
        starts += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return fake.tunnel
      },
    })

    const [a, b] = await Promise.all([manager.expose(5000), manager.expose(5000)])

    expect(a).toEqual(b)
    expect(starts).toBe(1)
  })

  test("unexpose stops the tunnel and forgets the URL", async () => {
    const fake = createFakeTunnel("https://one.trycloudflare.com")
    const manager = new PortTunnelManager({ startTunnel: async () => fake.tunnel })

    await manager.expose(5000)
    expect(manager.unexpose(5000)).toEqual({ ok: true, port: 5000 })

    expect(fake.stopCalls).toBe(1)
    expect(manager.getPublicUrl(5000)).toBeUndefined()
    expect(manager.unexpose(5000)).toEqual({ ok: true, port: 5000 })
    expect(fake.stopCalls).toBe(1)
  })

  test("forgets a tunnel whose process exits on its own", async () => {
    const fake = createFakeTunnel("https://one.trycloudflare.com")
    const manager = new PortTunnelManager({ startTunnel: async () => fake.tunnel })

    await manager.expose(5000)
    fake.exit()
    await fake.tunnel.exited

    expect(manager.getPublicUrl(5000)).toBeUndefined()
  })

  test("rejects a tunnel that comes up without a URL", async () => {
    const fake = createFakeTunnel(null)
    const manager = new PortTunnelManager({ startTunnel: async () => fake.tunnel })

    await expect(manager.expose(5000)).rejects.toThrow("without a public URL")
    expect(fake.stopCalls).toBe(1)
    expect(manager.getPublicUrl(5000)).toBeUndefined()
  })

  test("rejects invalid ports", async () => {
    const manager = new PortTunnelManager({ startTunnel: async () => createFakeTunnel("https://x").tunnel })

    await expect(manager.expose(0)).rejects.toThrow("Port is invalid.")
    expect(() => manager.unexpose(70000)).toThrow("Port is invalid.")
  })

  test("stopAll stops every tunnel", async () => {
    const a = createFakeTunnel("https://a.trycloudflare.com")
    const b = createFakeTunnel("https://b.trycloudflare.com")
    const manager = new PortTunnelManager({
      startTunnel: async (localUrl) => (localUrl.endsWith(":5000") ? a.tunnel : b.tunnel),
    })

    await manager.expose(5000)
    await manager.expose(5001)
    manager.stopAll()

    expect(a.stopCalls).toBe(1)
    expect(b.stopCalls).toBe(1)
    expect(manager.list()).toEqual([])
  })

  test("a tunnel the last server left running is stopped when the next one starts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-port-tunnels-"))
    try {
      const stateFile = path.join(dir, "port-tunnels.json")
      // 4242 is still cloudflared; 4343's pid now belongs to something else.
      await writeFile(stateFile, JSON.stringify([{ port: 5173, pid: 4242 }, { port: 3000, pid: 4343 }]))
      const killed: number[] = []
      const manager = new PortTunnelManager({
        startTunnel: async () => createFakeTunnel("https://one.trycloudflare.com").tunnel,
        stateFile,
        isTunnelProcess: async (pid) => pid === 4242,
        killProcess: (pid) => {
          killed.push(pid)
        },
      })

      await manager.reapOrphans()

      expect(killed).toEqual([4242])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

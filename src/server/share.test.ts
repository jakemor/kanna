import { describe, expect, test } from "bun:test"
import { ensureCloudflaredInstalled, logShareDetails, renderTerminalQr, startShareTunnel } from "./share"

describe("ensureCloudflaredInstalled", () => {
  test("returns immediately when the binary already exists", async () => {
    const installCalls: string[] = []

    const result = await ensureCloudflaredInstalled({
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => true,
      installCloudflared: async (to) => {
        installCalls.push(to)
        return to
      },
    })

    expect(result).toBe("/tmp/cloudflared")
    expect(installCalls).toEqual([])
  })

  test("installs the binary on demand when it is missing", async () => {
    const installCalls: string[] = []
    const logLines: string[] = []

    const result = await ensureCloudflaredInstalled({
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => false,
      installCloudflared: async (to) => {
        installCalls.push(to)
        return to
      },
      log: (message) => {
        logLines.push(message)
      },
    })

    expect(result).toBe("/tmp/cloudflared")
    expect(installCalls).toEqual(["/tmp/cloudflared"])
    expect(logLines).toEqual(["installing cloudflared binary"])
  })
})

describe("startShareTunnel", () => {
  test("starts a quick tunnel after ensuring the binary exists", async () => {
    const installCalls: string[] = []
    const quickTunnelUrls: string[] = []
    let stopCalls = 0

    const shareTunnel = await startShareTunnel("http://localhost:3333", "quick", {
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => false,
      installCloudflared: async (to) => {
        installCalls.push(to)
        return to
      },
      createQuickTunnel: (localUrl) => {
        quickTunnelUrls.push(localUrl)
        return {
          once(event: "url" | "connected" | "error" | "exit", listener: ((url: string) => void) | (() => void) | ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) {
            if (event === "url") {
              queueMicrotask(() => (listener as (url: string) => void)("https://kanna.trycloudflare.com"))
            }
            return this
          },
          off(_event: "url" | "connected" | "error" | "exit", _listener: ((url: string) => void) | (() => void) | ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) {
            return this
          },
          stop() {
            stopCalls += 1
            return true
          },
        }
      },
    })

    expect(installCalls).toEqual(["/tmp/cloudflared"])
    expect(quickTunnelUrls).toEqual(["http://localhost:3333"])
    expect(shareTunnel.publicUrl).toBe("https://kanna.trycloudflare.com")
    shareTunnel.stop()
    expect(stopCalls).toBe(1)
  })

  test("starts a named tunnel with token and accepts missing hostname discovery", async () => {
    const installCalls: string[] = []
    const namedTunnelCalls: Array<{ token: string; localUrl: string }> = []
    let stopCalls = 0

    const shareTunnel = await startShareTunnel("http://localhost:3333", { kind: "token", token: "secret-token" }, {
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => false,
      installCloudflared: async (to: string) => {
        installCalls.push(to)
        return to
      },
      createNamedTunnel: (token: string, localUrl: string) => {
        namedTunnelCalls.push({ token, localUrl })
        return {
          once(event: "url" | "connected" | "error" | "exit", listener: ((url: string) => void) | (() => void) | ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) {
            if (event === "connected") {
              queueMicrotask(() => (listener as () => void)())
            }
            return this
          },
          off(_event: "url" | "connected" | "error" | "exit", _listener: ((url: string) => void) | (() => void) | ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) {
            return this
          },
          stop() {
            stopCalls += 1
            return true
          },
        }
      },
    })

    expect(installCalls).toEqual(["/tmp/cloudflared"])
    expect(namedTunnelCalls).toEqual([{ token: "secret-token", localUrl: "http://localhost:3333" }])
    expect(shareTunnel.publicUrl).toBeNull()
    shareTunnel.stop()
    expect(stopCalls).toBe(1)
  })

  test("normalizes a discovered named tunnel hostname into https", async () => {
    const shareTunnel = await startShareTunnel("http://localhost:3333", { kind: "token", token: "secret-token" }, {
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => true,
      createNamedTunnel: () => ({
        once(event: "url" | "connected" | "error" | "exit", listener: ((url: string) => void) | (() => void) | ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) {
          if (event === "url") {
            queueMicrotask(() => (listener as (url: string) => void)("app.example.com"))
          }
          return this
        },
        off(_event: "url" | "connected" | "error" | "exit", _listener: ((url: string) => void) | (() => void) | ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)) {
          return this
        },
        stop() {
          return true
        },
      }),
    })

    expect(shareTunnel.publicUrl).toBe("https://app.example.com")
  })
})

describe("logShareDetails", () => {
  test("prints qr, public url, and local url in the expected order", async () => {
    const logLines: string[] = []

    await logShareDetails(
      (message) => {
        logLines.push(message)
      },
      "https://kanna.trycloudflare.com",
      "http://localhost:3333",
      async (url) => `[qr:${url}]\n`,
    )

    expect(logLines).toEqual([
      "QR Code:",
      "[qr:https://kanna.trycloudflare.com]",
      "",
      "Public URL:",
      "https://kanna.trycloudflare.com",
      "",
      "Local URL:",
      "http://localhost:3333",
    ])
  })
})

describe("renderTerminalQr", () => {
  test("renders an ANSI qr string", async () => {
    const result = await renderTerminalQr("https://kanna.trycloudflare.com")

    expect(result).toContain("\x1b[47m")
    expect(result).toContain("\n")
    expect(result.length).toBeGreaterThan(0)
  })
})

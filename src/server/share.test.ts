import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Result } from "effect"
import { runTest } from "./effect/testing"
import { ensureCloudflaredInstalled, logShareDetails, renderTerminalQr, startShareTunnel, type ShareTunnelProcess } from "./share"

type Listener = (...args: never[]) => void

/** A cloudflared stand-in: records listeners, so a test can fire events at it. */
function createFakeProcess() {
  const listeners = new Map<string, Listener[]>()
  let stopCalls = 0
  const fake = {
    once(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return fake
    },
    off(event: string, listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener))
      return fake
    },
    stop() {
      stopCalls += 1
      return true
    },
  }
  return {
    process: fake as unknown as ShareTunnelProcess,
    fire(event: string, ...args: unknown[]) {
      const current = listeners.get(event) ?? []
      listeners.set(event, [])
      for (const listener of current) (listener as (...values: unknown[]) => void)(...args)
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    get stopCalls() {
      return stopCalls
    },
  }
}

describe("ensureCloudflaredInstalled", () => {
  test("returns immediately when the binary already exists", async () => {
    const installCalls: string[] = []

    const result = await runTest(ensureCloudflaredInstalled({
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => true,
      installCloudflared: async (to) => {
        installCalls.push(to)
        return to
      },
    }))

    expect(result).toBe("/tmp/cloudflared")
    expect(installCalls).toEqual([])
  })

  test("installs the binary on demand when it is missing", async () => {
    const installCalls: string[] = []
    const logLines: string[] = []

    const result = await runTest(ensureCloudflaredInstalled({
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => false,
      installCloudflared: async (to) => {
        installCalls.push(to)
        return to
      },
      log: (message) => {
        logLines.push(message)
      },
    }))

    expect(result).toBe("/tmp/cloudflared")
    expect(installCalls).toEqual(["/tmp/cloudflared"])
    expect(logLines).toEqual(["installing cloudflared binary"])
  })

  test("fails with the install error when the download fails", async () => {
    const result = await runTest(Effect.result(ensureCloudflaredInstalled({
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => false,
      installCloudflared: async () => {
        throw new Error("network down")
      },
    })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/share/CloudflaredInstallError")
      expect(result.failure.message).toBe("network down")
    }
  })
})

describe("startShareTunnel", () => {
  test("starts a quick tunnel after ensuring the binary exists", async () => {
    const installCalls: string[] = []
    const quickTunnelUrls: string[] = []
    let stopCalls = 0

    const shareTunnel = await runTest(startShareTunnel("http://localhost:3333", "quick", {
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
    }))

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

    const shareTunnel = await runTest(startShareTunnel("http://localhost:3333", { kind: "token", token: "secret-token" }, {
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
    }))

    expect(installCalls).toEqual(["/tmp/cloudflared"])
    expect(namedTunnelCalls).toEqual([{ token: "secret-token", localUrl: "http://localhost:3333" }])
    expect(shareTunnel.publicUrl).toBeNull()
    shareTunnel.stop()
    expect(stopCalls).toBe(1)
  })

  test("normalizes a discovered named tunnel hostname into https", async () => {
    const shareTunnel = await runTest(startShareTunnel("http://localhost:3333", { kind: "token", token: "secret-token" }, {
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
    }))

    expect(shareTunnel.publicUrl).toBe("https://app.example.com")
  })

  const startWith = (fake: ReturnType<typeof createFakeProcess>) =>
    startShareTunnel("http://localhost:3333", "quick", {
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => true,
      createQuickTunnel: () => fake.process,
    })

  test("fails when cloudflared exits before a URL, and stops listening", async () => {
    const fake = createFakeProcess()
    const result = await runTest(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(startWith(fake)), { startImmediately: true })
      fake.fire("exit", 1, null)
      return yield* Fiber.join(fiber)
    }))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/share/ShareTunnelExitedError")
      expect(result.failure.message).toBe("Cloudflare tunnel exited before a public URL was ready (code: 1, signal: null)")
    }
    expect(fake.listenerCount("url")).toBe(0)
    expect(fake.listenerCount("error")).toBe(0)
  })

  test("fails with cloudflared's own error", async () => {
    const fake = createFakeProcess()
    const result = await runTest(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(startWith(fake)), { startImmediately: true })
      fake.fire("error", new Error("spawn failed"))
      return yield* Fiber.join(fiber)
    }))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/share/ShareTunnelError")
      expect(result.failure.message).toBe("spawn failed")
    }
  })

  test("stops cloudflared when interrupted before it is ready", async () => {
    const fake = createFakeProcess()
    await runTest(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(startWith(fake), { startImmediately: true })
      yield* Fiber.interrupt(fiber)
    }))

    expect(fake.stopCalls).toBe(1)
    expect(fake.listenerCount("url")).toBe(0)
  })

  test("exited completes when the process exits after it was ready", async () => {
    const fake = createFakeProcess()
    const exited = await runTest(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(startWith(fake), { startImmediately: true })
      fake.fire("url", "https://kanna.trycloudflare.com")
      const tunnel = yield* Fiber.join(fiber)
      fake.fire("exit", 0, null)
      yield* tunnel.exited!.pipe(Effect.timeout("1 second"))
      return true
    }))

    expect(exited).toBe(true)
  })
})

describe("logShareDetails", () => {
  test("prints qr, public url, and local url in the expected order", () => {
    const logLines: string[] = []

    logShareDetails(
      (message) => {
        logLines.push(message)
      },
      "https://kanna.trycloudflare.com",
      "http://localhost:3333",
      (url) => `[qr:${url}]\n`,
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
  test("renders an ANSI qr string", () => {
    const result = renderTerminalQr("https://kanna.trycloudflare.com")

    expect(result).toContain("\x1b[47m")
    expect(result).toContain("\n")
    expect(result.length).toBeGreaterThan(0)
  })
})

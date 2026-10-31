import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { ensureCloudflaredInstalled, logShareDetails, NamedTunnelProcess, renderTerminalQr, startShareTunnel } from "./share"

describe("ensureCloudflaredInstalled", () => {
  test("returns immediately when the binary already exists", async () => {
    const installCalls: string[] = []

    const result = await ensureCloudflaredInstalled({
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => true,
      ensureMinimum: async () => null,
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
      ensureMinimum: async () => null,
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

/** A cloudflared stand-in driven by the test: emit events, record signals. */
function createFakeProcess() {
  const emitter = new EventEmitter()
  const signals: string[] = []
  const fake = {
    once(event: string, listener: (...args: any[]) => void) {
      emitter.once(event, listener)
      return fake
    },
    off(event: string, listener: (...args: any[]) => void) {
      emitter.off(event, listener)
      return fake
    },
    stop() {
      signals.push("SIGINT")
      return true
    },
    process: {
      kill(signal?: NodeJS.Signals) {
        signals.push(signal ?? "SIGTERM")
        return true
      },
    },
    emit(event: string, ...args: unknown[]) {
      emitter.emit(event, ...args)
    },
    listenerCount(event: string) {
      return emitter.listenerCount(event)
    },
  }
  return { fake, signals }
}

/** Reports "connected" right after spawn, once startShareTunnel is listening. */
function readyOnSpawn(fake: ReturnType<typeof createFakeProcess>["fake"]) {
  queueMicrotask(() => fake.emit("connected"))
  return fake as never
}

describe("startShareTunnel cancellation", () => {
  const NAMED = { kind: "token", token: "secret-token" } as const

  test("readiness that never arrives rejects when the signal aborts, and the process is stopped", async () => {
    const { fake, signals } = createFakeProcess()
    const started = Date.now()

    await expect(startShareTunnel("http://localhost:3333", NAMED, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: () => fake as never,
    }, { signal: AbortSignal.timeout(30) })).rejects.toThrow()

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(signals).toEqual(["SIGINT"])
  })

  test("an already-aborted signal starts no process", async () => {
    let created = 0
    const controller = new AbortController()
    controller.abort(new Error("supervisor stopped"))

    await expect(startShareTunnel("http://localhost:3333", NAMED, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: () => {
        created += 1
        return createFakeProcess().fake as never
      },
    }, { signal: controller.signal })).rejects.toThrow("supervisor stopped")
    expect(created).toBe(0)
  })

  test("exited resolves when the connector dies after becoming ready", async () => {
    const { fake } = createFakeProcess()
    const tunnel = await startShareTunnel("http://localhost:3333", NAMED, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: () => readyOnSpawn(fake),
    })

    let exited = false
    void tunnel.exited?.then(() => {
      exited = true
    })
    fake.emit("exit", 1, null)
    await Bun.sleep(1)
    expect(exited).toBe(true)
  })

  test("a late cloudflared error is logged, not thrown", async () => {
    const { fake } = createFakeProcess()
    const logs: string[] = []
    await startShareTunnel("http://localhost:3333", NAMED, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: () => readyOnSpawn(fake),
      log: (message) => logs.push(message),
    })

    fake.emit("error", new Error("bad config line"))
    fake.emit("error", new Error("another"))
    expect(logs).toEqual(["cloudflared error: bad config line", "cloudflared error: another"])
  })

  test("stop() sends SIGINT once and escalates to SIGKILL if the connector outlives the grace period", async () => {
    const { fake, signals } = createFakeProcess()
    const tunnel = await startShareTunnel("http://localhost:3333", NAMED, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: () => readyOnSpawn(fake),
      stopGraceMs: 20,
    })

    tunnel.stop()
    tunnel.stop()
    await Bun.sleep(60)
    expect(signals).toEqual(["SIGINT", "SIGKILL"])
  })

  test("stop() does not escalate once the connector has exited", async () => {
    const { fake, signals } = createFakeProcess()
    const tunnel = await startShareTunnel("http://localhost:3333", NAMED, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: () => readyOnSpawn(fake),
      stopGraceMs: 20,
    })

    tunnel.stop()
    fake.emit("exit", 0, null)
    await Bun.sleep(60)
    expect(signals).toEqual(["SIGINT"])
  })
})

/** Records how cloudflared was spawned and lets the test write its output. */
function createFakeSpawn() {
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: [] as Array<string | undefined>,
    kill(signal?: NodeJS.Signals) {
      child.killed.push(signal)
      return true
    },
  })
  const spawnImpl = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawned.push({ command, args, env: options.env })
    return child as unknown as ChildProcess
  }
  return { spawnImpl, spawned, child }
}

const REGISTERED_LINE = "2026-10-26T01:10:41Z INF Registered tunnel connection connIndex=0 "
  + "connection=1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d event=0 ip=198.41.192.7 location=ewr08 protocol=quic\n"

describe("NamedTunnelProcess", () => {
  test("passes the token in the child's TUNNEL_TOKEN, never in argv or this process's env", () => {
    const { spawnImpl, spawned } = createFakeSpawn()
    new NamedTunnelProcess("secret-token", "http://localhost:3210", { cloudflaredBin: "/tmp/cloudflared", spawnImpl })

    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe("/tmp/cloudflared")
    expect(spawned[0].args).toEqual(["tunnel", "run", "--url", "http://localhost:3210"])
    expect(spawned[0].args.some((arg) => arg.includes("secret-token"))).toBe(false)
    expect(spawned[0].env.TUNNEL_TOKEN).toBe("secret-token")
    expect(spawned[0].env.PATH).toBe(process.env.PATH)
    expect(process.env.TUNNEL_TOKEN).toBeUndefined()
  })

  test("a registered-connection line makes startShareTunnel ready; stop() sends SIGINT", async () => {
    const { spawnImpl, child } = createFakeSpawn()
    const tunnel = await startShareTunnel("http://localhost:3210", { kind: "token", token: "secret-token" }, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: (token, localUrl) => {
        const named = new NamedTunnelProcess(token, localUrl, { spawnImpl })
        queueMicrotask(() => child.stderr.emit("data", Buffer.from(REGISTERED_LINE)))
        return named
      },
    })

    expect(tunnel.publicUrl).toBeNull()
    tunnel.stop()
    expect(child.killed).toEqual(["SIGINT"])
  })

  test("the child's exit reaches exited", async () => {
    const { spawnImpl, child } = createFakeSpawn()
    const tunnel = await startShareTunnel("http://localhost:3210", { kind: "token", token: "secret-token" }, {
      existsSync: () => true,
      ensureMinimum: async () => null,
      createNamedTunnel: (token, localUrl) => {
        const named = new NamedTunnelProcess(token, localUrl, { spawnImpl })
        queueMicrotask(() => child.stderr.emit("data", Buffer.from(REGISTERED_LINE)))
        return named
      },
    })

    let exited = false
    void tunnel.exited?.then(() => {
      exited = true
    })
    child.emit("exit", 1, null)
    await Bun.sleep(1)
    expect(exited).toBe(true)
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

describe("startShareTunnel and the cloudflared security minimum", () => {
  test("an existing binary goes through the minimum check before the connector starts", async () => {
    const order: string[] = []
    const { fake } = createFakeProcess()

    const tunnel = await startShareTunnel("http://localhost:3333", { kind: "token", token: "secret-token" }, {
      cloudflaredBin: "/tmp/cloudflared",
      existsSync: () => true,
      ensureMinimum: async (bin) => {
        order.push(`ensureMinimum ${bin}`)
        await Bun.sleep(5)
        return "2026.10.4"
      },
      createNamedTunnel: () => {
        order.push("spawn")
        return readyOnSpawn(fake)
      },
    })

    expect(order).toEqual(["ensureMinimum /tmp/cloudflared", "spawn"])
    expect(tunnel.binaryVersion).toBe("2026.10.4")
    tunnel.stop()
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Result, Scope } from "effect"
import {
  compareVersions,
  classifyInstallVersionFailure,
  parseArgs,
  PackageRegistryError,
  runCli,
  type CliRuntimeDeps,
  type CliServerOptions,
  type UpdateInstallAttemptResult,
} from "./cli-runtime"
import { CLI_SUPPRESS_OPEN_ONCE_ENV_VAR } from "./restart"
import { runTest } from "./effect/testing"
import { ShareTunnelError } from "./share"
import type { AttachedServer } from "./instance-socket"
import type { CloudRuntime } from "./cloud"
import type { CloudIdentity } from "./cloud/identity"
import { makeFakeUpdateManager } from "./update-manager.fake"
import type { UpdateSnapshot } from "../shared/types"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const originalSuppressOpen = process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
const originalDisableSelfUpdate = process.env.KANNA_DISABLE_SELF_UPDATE

beforeEach(() => {
  // Every test assumes the open-once suppression flag is unset; the parent
  // process may have exported it (e.g. when this suite runs inside a
  // Kanna-managed terminal after a self-restart). Tests that need it set it
  // themselves; afterEach restores the inherited value for other suites.
  delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
  // Likewise for the self-update opt-out: anyone running Kanna from a checkout
  // exports it in their shell, and leaving it set would silently skip the
  // update path these tests are here to cover.
  delete process.env.KANNA_DISABLE_SELF_UPDATE
})

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }
  if (originalDisableSelfUpdate === undefined) {
    delete process.env.KANNA_DISABLE_SELF_UPDATE
  } else {
    process.env.KANNA_DISABLE_SELF_UPDATE = originalDisableSelfUpdate
  }
  if (originalSuppressOpen === undefined) {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
  } else {
    process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] = originalSuppressOpen
  }
})

const installed = (): UpdateInstallAttemptResult => ({ ok: true, errorCode: null, userTitle: null, userMessage: null })

/** Typed Effect fakes for every seam `runCli` has, recording what it asked for. */
function createDeps(overrides: Partial<CliRuntimeDeps> = {}) {
  const calls = {
    startServer: [] as CliServerOptions[],
    serverStops: 0,
    fetchLatestVersion: [] as string[],
    installVersion: [] as Array<{ packageName: string; version: string }>,
    openUrl: [] as string[],
    log: [] as string[],
    warn: [] as string[],
    shareTunnel: [] as Array<{ localUrl: string; shareMode: "quick" | { kind: "token"; token: string } }>,
    renderShareQr: [] as string[],
    shareTunnelStops: 0,
    attached: [] as AttachedServer[],
  }

  const deps: CliRuntimeDeps = {
    version: "0.3.0",
    bunVersion: "1.3.10",
    startServer: (options) => Effect.sync(() => {
      calls.startServer.push(options)
      return {
        port: options.port,
        stop: Effect.sync(() => {
          calls.serverStops += 1
        }),
      }
    }),
    fetchLatestVersion: (packageName) => Effect.sync(() => {
      calls.fetchLatestVersion.push(packageName)
      return "0.3.0"
    }),
    installVersion: (packageName, version) => Effect.sync(() => {
      calls.installVersion.push({ packageName, version })
      return installed()
    }),
    openUrl: (url) => Effect.sync(() => {
      calls.openUrl.push(url)
    }),
    log: (message) => {
      calls.log.push(message)
    },
    warn: (message) => {
      calls.warn.push(message)
    },
    renderShareQr: (url) => {
      calls.renderShareQr.push(url)
      return `[qr:${url}]`
    },
    startShareTunnel: (localUrl, shareMode) => Effect.sync(() => {
      calls.shareTunnel.push({ localUrl, shareMode })
      return {
        publicUrl: "https://kanna.trycloudflare.com",
        stop: () => {
          calls.shareTunnelStops += 1
        },
      }
    }),
    // Hermetic defaults: never touch the real ~/.kanna/cloud.json or probe
    // real local ports in tests.
    readCloudIdentityImpl: () => Effect.succeed(null),
    probeExistingInstanceImpl: () => Effect.succeed(null),
    claimInstanceImpl: Effect.succeed({
      kind: "ours",
      attach: (server) => Effect.sync(() => {
        calls.attached.push(server)
      }),
      releasedFromParent: () => false,
    }),
    instanceStatusImpl: Effect.succeed(null),
    ...overrides,
  }

  return { calls, deps }
}

/**
 * Runs `kanna <argv>` in a scope of its own, as cli.ts does. `stop` closes
 * the scope, which is how the CLI stops the server at shutdown.
 */
async function run(argv: string[], deps: CliRuntimeDeps) {
  const scope = Effect.runSync(Scope.make())
  const result = await runTest(runCli(argv, deps).pipe(Scope.provide(scope)))
  return { result, stop: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

const CLOUD_IDENTITY: CloudIdentity = {
  controlUrl: "https://kanna.sh/api/cloud",
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}

function createFakeCloudRuntime() {
  const calls = { starts: [] as Array<{ localUrl: string }>, stops: 0 }
  const runtime: CloudRuntime = {
    identity: CLOUD_IDENTITY,
    connectTokens: { mint: () => ({ token: "t", expiresInMs: 60_000 }), validate: () => false },
    start: (args) => Effect.sync(() => {
      calls.starts.push({ localUrl: args.localUrl })
    }),
    stop: Effect.sync(() => {
      calls.stops += 1
    }),
  }
  return { runtime, calls }
}

describe("parseArgs", () => {
  test("parses runtime options", () => {
    expect(parseArgs(["--port", "4000", "--no-open"])).toEqual({
      kind: "run",
      options: {
        port: 4000,
        host: "127.0.0.1",
        openBrowser: false,
        share: false,
        password: null,
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("parses strict port mode", () => {
    expect(parseArgs(["--strict-port"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "127.0.0.1",
        openBrowser: true,
        share: false,
        password: null,
        strictPort: true,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--remote without value binds all interfaces", () => {
    expect(parseArgs(["--remote"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "0.0.0.0",
        openBrowser: true,
        share: false,
        password: null,
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--share enables public sharing", () => {
    expect(parseArgs(["--share"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "127.0.0.1",
        openBrowser: true,
        share: "quick",
        password: null,
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--cloudflared accepts a token", () => {
    expect(parseArgs(["--cloudflared", "secret-token"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "127.0.0.1",
        openBrowser: true,
        share: { kind: "token", token: "secret-token" },
        password: null,
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--password accepts a secret", () => {
    expect(parseArgs(["--password", "secret"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "127.0.0.1",
        openBrowser: true,
        share: false,
        password: "secret",
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--password without a value throws", () => {
    expect(() => parseArgs(["--password"])).toThrow("Missing value for --password")
    expect(() => parseArgs(["--password", "--no-open"])).toThrow("Missing value for --password")
  })

  test("--cloudflared without a token throws", () => {
    expect(() => parseArgs(["--cloudflared"])).toThrow("Missing value for --cloudflared")
    expect(() => parseArgs(["--cloudflared", "--no-open"])).toThrow("Missing value for --cloudflared")
  })

  test("--host with IP binds to that address", () => {
    expect(parseArgs(["--host", "100.64.0.1"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "100.64.0.1",
        openBrowser: true,
        share: false,
        password: null,
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--host with hostname binds to that name", () => {
    expect(parseArgs(["--host", "dev-box"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "dev-box",
        openBrowser: true,
        share: false,
        password: null,
        strictPort: false,
        noCloud: false,
        directCloud: false,
      },
    })
  })

  test("--host without a value throws", () => {
    expect(() => parseArgs(["--host"])).toThrow("Missing value for --host")
    expect(() => parseArgs(["--host", "--no-open"])).toThrow("Missing value for --host")
  })

  test("--share is incompatible with --host and --remote", () => {
    expect(() => parseArgs(["--share", "--host", "dev-box"])).toThrow("--share cannot be used with --host")
    expect(() => parseArgs(["--host", "dev-box", "--share"])).toThrow("--share cannot be used with --host")
    expect(() => parseArgs(["--share", "--remote"])).toThrow("--share cannot be used with --remote")
    expect(() => parseArgs(["--remote", "--share"])).toThrow("--share cannot be used with --remote")
  })

  test("--cloudflared is incompatible with --host and --remote", () => {
    expect(() => parseArgs(["--cloudflared", "secret-token", "--host", "dev-box"])).toThrow("--cloudflared cannot be used with --host")
    expect(() => parseArgs(["--host", "dev-box", "--cloudflared", "secret-token"])).toThrow("--cloudflared cannot be used with --host")
    expect(() => parseArgs(["--cloudflared", "secret-token", "--remote"])).toThrow("--cloudflared cannot be used with --remote")
    expect(() => parseArgs(["--remote", "--cloudflared", "secret-token"])).toThrow("--cloudflared cannot be used with --remote")
  })

  test("returns version and help actions without running startup", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" })
    expect(parseArgs(["--help"])).toEqual({ kind: "help" })
  })
})

describe("compareVersions", () => {
  test("orders semver-like versions", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0)
    expect(compareVersions("0.3.0", "0.3.1")).toBe(-1)
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1)
  })
})

describe("classifyInstallVersionFailure", () => {
  test("maps version propagation failures to a user-facing retry message", () => {
    expect(classifyInstallVersionFailure('error: No version matching "0.13.3" found for specifier "kanna-code"')).toEqual({
      ok: false,
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
      userMessage: "This update is still propagating. Try again in a few minutes.",
    })
  })
})

describe("runCli", () => {
  test("skips update checks for --version", async () => {
    const { calls, deps } = createDeps()

    const { result } = await run(["--version"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.fetchLatestVersion).toEqual([])
    expect(calls.startServer).toEqual([])
    expect(calls.log).toEqual(["0.3.0"])
  })

  test("prints the help text for --help", async () => {
    const { calls, deps } = createDeps()

    const { result } = await run(["--help"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.log).toHaveLength(1)
    expect(calls.log[0]).toStartWith("Kanna — local-only project chat UI\n\nUsage:\n  kanna [options]\n")
    expect(calls.log[0]).toEndWith("  --help               Show this help message")
  })

  test("fails with a usage error for a malformed command line", async () => {
    const { calls, deps } = createDeps()

    const result = await runTest(Effect.result(runCli(["--port"], deps)))

    if (!Result.isFailure(result)) throw new Error("expected a usage error")
    expect(result.failure._tag).toBe("@kanna/server/cli-runtime/CliUsageError")
    expect(result.failure.message).toBe("Missing value for --port")
    expect(calls.startServer).toEqual([])
  })

  test("starts normally when no newer version exists", async () => {
    const { calls, deps } = createDeps()
    process.env.KANNA_RUNTIME_PROFILE = "prod"

    const { result, stop } = await run(["--port", "4000", "--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.fetchLatestVersion).toEqual(["kanna-code"])
    expect(calls.installVersion).toEqual([])
    expect(calls.startServer).toHaveLength(1)
    expect(calls.startServer[0]).toMatchObject({
      port: 4000,
      host: "127.0.0.1",
      openBrowser: false,
      share: false,
      password: null,
      strictPort: false,
      trustProxy: false,
      update: {
        version: "0.3.0",
        argv: ["--port", "4000", "--no-open"],
        command: "kanna",
      },
    })
    expect(calls.openUrl).toEqual([])
    expect(calls.log).toContain("[kanna] data dir: ~/.kanna/data")
    // The lock holder hears about the server once it listens.
    expect(calls.attached).toMatchObject([{ port: 4000, version: "0.3.0" }])

    expect(calls.serverStops).toBe(0)
    await stop()
    expect(calls.serverStops).toBe(1)
  })

  test("logs the dev data dir when the dev runtime profile is active", async () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"
    const { calls, deps } = createDeps()

    const { stop } = await run(["--port", "4000", "--no-open"], deps)

    expect(calls.log).toContain("[kanna] data dir: ~/.kanna-dev/data")
    await stop()
  })

  test("fails fast on unsupported Bun versions", async () => {
    const { calls, deps } = createDeps({
      bunVersion: "1.3.1",
    })

    const { result } = await run(["--no-open"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
    expect(calls.warn).toContain("[kanna] Bun 1.3.5+ is required for the embedded terminal. Current Bun: 1.3.1")
  })

  test("opens the root route in the browser", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    const { stop } = await run(["--port", "4000"], deps)

    expect(calls.openUrl).toEqual(["http://localhost:4000"])
    await stop()
  })

  test("opens browser at hostname when --host <host> is given", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    const { stop } = await run(["--host", "dev-box", "--port", "4000"], deps)

    expect(calls.openUrl).toEqual(["http://dev-box:4000"])
    await stop()
  })

  test("suppresses browser open for a ui-triggered restarted child", async () => {
    process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] = "1"
    const { calls, deps } = createDeps()

    const { stop } = await run(["--port", "4000"], deps)

    expect(calls.openUrl).toEqual([])
    await stop()
  })

  test("starts a share tunnel and prints qr/public/local urls", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    const { result, stop } = await run(["--share", "--port", "4000"], deps)

    expect(result.kind).toBe("started")
    expect(calls.openUrl).toEqual([])
    expect(calls.startServer[0]?.trustProxy).toBe(true)
    expect(calls.shareTunnel).toEqual([{ localUrl: "http://localhost:4000", shareMode: "quick" }])
    expect(calls.renderShareQr).toEqual(["https://kanna.trycloudflare.com"])
    expect(calls.log).toContain("QR Code:")
    expect(calls.log).toContain("[qr:https://kanna.trycloudflare.com]")
    expect(calls.log).toContain("Public URL:")
    expect(calls.log).toContain("https://kanna.trycloudflare.com")
    expect(calls.log).toContain("Local URL:")
    expect(calls.log).toContain("http://localhost:4000")

    await stop()
    expect(calls.shareTunnelStops).toBe(1)
    expect(calls.serverStops).toBe(1)
  })

  test("logs share setup progress from the default tunnel helper", async () => {
    const { calls, deps } = createDeps({
      renderShareQr: () => "[qr]",
    })

    let installLogged = false
    deps.startShareTunnel = () => Effect.sync(() => {
      deps.log("[kanna] installing cloudflared binary")
      installLogged = true
      return {
        publicUrl: "https://kanna.trycloudflare.com",
        stop: () => {},
      }
    })

    const { stop } = await run(["--share"], deps)

    expect(installLogged).toBe(true)
    expect(calls.log).toContain("[kanna] installing cloudflared binary")
    await stop()
  })

  test("uses the actual bound port for --share", async () => {
    const { calls, deps } = createDeps({
      startServer: (options) => Effect.sync(() => {
        calls.startServer.push(options)
        return {
          port: 4001,
          stop: Effect.void,
        }
      }),
    })

    const { result, stop } = await run(["--share", "--port", "4000"], deps)

    expect(result.kind).toBe("started")
    expect(calls.shareTunnel).toEqual([{ localUrl: "http://localhost:4001", shareMode: "quick" }])
    await stop()
  })

  test("fails cleanly when share tunnel startup fails", async () => {
    const order: string[] = []
    const { calls, deps } = createDeps({
      startServer: (options) => Effect.sync(() => {
        calls.startServer.push(options)
        return {
          port: options.port,
          stop: Effect.sync(() => {
            order.push("server stopped")
          }),
        }
      }),
      startShareTunnel: (localUrl) =>
        Effect.fail(new ShareTunnelError({ localUrl, cause: new Error("cloudflared unavailable") })),
      warn: (message) => {
        order.push(message)
        calls.warn.push(message)
      },
    })

    const { result, stop } = await run(["--share"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    // The server is stopped before the failure is reported, and only once.
    expect(order).toEqual([
      "server stopped",
      "[kanna] failed to start Cloudflare share tunnel",
      "[kanna] cloudflared unavailable",
    ])
    await stop()
    expect(order.filter((line) => line === "server stopped")).toHaveLength(1)
  })

  test("keeps running when a named tunnel starts without a detected hostname", async () => {
    const { calls, deps } = createDeps({
      startShareTunnel: (localUrl, shareMode) => Effect.sync(() => {
        calls.shareTunnel.push({ localUrl, shareMode })
        return {
          publicUrl: null,
          stop: () => {
            calls.shareTunnelStops += 1
          },
        }
      }),
    })

    const { result, stop } = await run(["--cloudflared", "secret-token"], deps)

    expect(result.kind).toBe("started")
    expect(calls.startServer[0]?.trustProxy).toBe(true)
    expect(calls.shareTunnel).toEqual([{
      localUrl: "http://localhost:3210",
      shareMode: { kind: "token", token: "secret-token" },
    }])
    expect(calls.warn).toContain("[kanna] named tunnel started but no public hostname was detected")
    expect(calls.warn).toContain("[kanna] use the hostname configured for the provided Cloudflare tunnel token")
    expect(calls.log).toContain("Local URL:")
    expect(calls.log).toContain("http://localhost:3210")
    expect(calls.renderShareQr).toEqual([])
    await stop()
  })

  test("returns restarting when a newer version is available", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: (packageName) => Effect.sync(() => {
        calls.fetchLatestVersion.push(packageName)
        return "0.4.0"
      }),
    })

    const { result } = await run(["--port", "4000", "--no-open"], deps)

    expect(result).toEqual({ kind: "restarting", reason: "startup_update" })
    expect(calls.installVersion).toEqual([{ packageName: "kanna-code", version: "0.4.0" }])
    expect(calls.startServer).toEqual([])
  })

  test("falls back to current version when install fails", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: (packageName) => Effect.sync(() => {
        calls.fetchLatestVersion.push(packageName)
        return "0.4.0"
      }),
      installVersion: (packageName, version) => Effect.sync(() => {
        calls.installVersion.push({ packageName, version })
        return {
          ok: false,
          errorCode: "install_failed" as const,
          userTitle: "Update failed",
          userMessage: "Kanna could not install the update. Try again later.",
        }
      }),
    })

    const { result, stop } = await run(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.installVersion).toEqual([{ packageName: "kanna-code", version: "0.4.0" }])
    expect(calls.warn).toContain("[kanna] update failed, continuing current version")
    await stop()
  })

  test("falls back to current version when the registry check fails", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: (packageName) => Effect.suspend(() => {
        calls.fetchLatestVersion.push(packageName)
        return Effect.fail(new PackageRegistryError({ packageName, message: "network unavailable", cause: null }))
      }),
    })

    const { result, stop } = await run(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.installVersion).toEqual([])
    expect(calls.warn).toContain("[kanna] update check failed, continuing current version")
    expect(calls.warn).toContain("[kanna] network unavailable")
    await stop()
  })

  test("hands the server Effect-typed update hooks it can run as they are", async () => {
    const { calls, deps } = createDeps({
      installNightly: Effect.succeed({ ...installed(), version: "0.3.0-nightly.abc1234" }),
    })

    const { stop } = await run(["--no-open"], deps)

    const update = calls.startServer[0]!.update
    expect(await Effect.runPromise(update.fetchLatestVersion("kanna-code"))).toBe("0.3.0")
    expect(await Effect.runPromise(update.installNightly!)).toMatchObject({ ok: true, version: "0.3.0-nightly.abc1234" })
    await stop()
  })
})

describe("runCli restart requests", () => {
  const IDLE: UpdateSnapshot = {
    currentVersion: "0.3.0",
    latestVersion: null,
    status: "idle",
    updateAvailable: false,
    lastCheckedAt: null,
    error: null,
    installAction: "restart",
    reloadRequestedAt: null,
  }

  test("an update installed from the UI asks the CLI to restart", async () => {
    const fake = makeFakeUpdateManager(IDLE)
    const { deps } = createDeps({
      startServer: (options) => Effect.succeed({ port: options.port, stop: Effect.void, updateManager: fake.updateManager }),
    })

    const { result, stop } = await run(["--no-open"], deps)
    if (result.kind !== "started") throw new Error(`expected started result, got ${result.kind}`)

    const waiting = Effect.runFork(result.restartRequested)
    await Bun.sleep(0)
    expect(waiting.pollUnsafe()).toBeUndefined()
    await Effect.runPromise(fake.set({ ...IDLE, status: "restart_pending", reloadRequestedAt: 1 }))
    await Effect.runPromise(Fiber.join(waiting))
    await stop()
  })

  test("a restart already pending when the CLI starts waiting is not missed", async () => {
    const fake = makeFakeUpdateManager({ ...IDLE, status: "restart_pending", reloadRequestedAt: 1 })
    const { deps } = createDeps({
      startServer: (options) => Effect.succeed({ port: options.port, stop: Effect.void, updateManager: fake.updateManager }),
    })

    const { result, stop } = await run(["--no-open"], deps)
    if (result.kind !== "started") throw new Error(`expected started result, got ${result.kind}`)

    await Effect.runPromise(result.restartRequested)
    await stop()
  })
})

describe("parseArgs slim-transcripts subcommand", () => {
  test("parses the bare command and rejects arguments", () => {
    expect(parseArgs(["slim-transcripts"])).toEqual({ kind: "slim-transcripts" })
    expect(() => parseArgs(["slim-transcripts", "--force"])).toThrow("Unexpected argument")
  })
})

describe("parseArgs pair subcommand", () => {
  test("pair with a code", () => {
    expect(parseArgs(["pair", "ABC123XYZ"])).toEqual({
      kind: "pair",
      args: { action: "pair", pairingCode: "ABC123XYZ" },
    })
  })

  test("pair management flags", () => {
    expect(parseArgs(["pair", "--status"])).toEqual({ kind: "pair", args: { action: "status", pairingCode: null } })
    expect(parseArgs(["pair", "--disable"])).toEqual({ kind: "pair", args: { action: "disable", pairingCode: null } })
    expect(parseArgs(["pair", "--enable"])).toEqual({ kind: "pair", args: { action: "enable", pairingCode: null } })
    expect(parseArgs(["pair", "--remove"])).toEqual({ kind: "pair", args: { action: "remove", pairingCode: null } })
  })

  test("pair without a code runs the device flow (no code required)", () => {
    expect(parseArgs(["pair"])).toEqual({ kind: "pair", args: { action: "pair", pairingCode: null } })
  })

  test("pair rejects extra arguments", () => {
    expect(() => parseArgs(["pair", "CODE1", "CODE2"])).toThrow("Unexpected argument")
    expect(() => parseArgs(["pair", "--bogus"])).toThrow("Unexpected argument")
  })

  test("--no-cloud sets the one-shot flag", () => {
    const parsed = parseArgs(["--no-cloud"])
    expect(parsed.kind).toBe("run")
    if (parsed.kind === "run") {
      expect(parsed.options.noCloud).toBe(true)
    }
  })

  test("--cloud sets directCloud and binds 0.0.0.0", () => {
    const parsed = parseArgs(["--cloud", "--no-open"])
    expect(parsed.kind).toBe("run")
    if (parsed.kind === "run") {
      expect(parsed.options.directCloud).toBe(true)
      expect(parsed.options.host).toBe("0.0.0.0")
    }
  })

  test("--cloud conflicts with --no-cloud, share modes, and host overrides", () => {
    expect(() => parseArgs(["--cloud", "--no-cloud"])).toThrow("--no-cloud")
    expect(() => parseArgs(["--cloud", "--share"])).toThrow("--share")
    expect(() => parseArgs(["--cloud", "--cloudflared", "tok"])).toThrow("--cloudflared")
    expect(() => parseArgs(["--cloud", "--host", "10.0.0.5"])).toThrow("--host")
    expect(() => parseArgs(["--cloud", "--remote"])).toThrow("--remote")
  })
})

describe("runCli cloud", () => {
  test("successful pair flows straight into a normal run (machine comes online immediately)", async () => {
    const pairCalls: unknown[] = []
    const fake = createFakeCloudRuntime()
    const { calls, deps } = createDeps({
      runPairCommandImpl: (args) => Effect.sync(() => {
        pairCalls.push(args)
        return 0
      }),
      // After pairing, the identity exists — sticky cloud kicks in.
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
      createCloudRuntimeImpl: () => fake.runtime,
    })

    const { result, stop } = await run(["pair", "ABC123"], deps)

    expect(pairCalls).toEqual([{ action: "pair", pairingCode: "ABC123" }])
    expect(result.kind).toBe("started")
    expect(calls.startServer.length).toBe(1)
    expect(fake.calls.starts.length).toBe(1)
    expect(calls.log.some((line) => line.includes("starting kanna"))).toBe(true)
    await stop()
  })

  test("failed pair exits without starting a server", async () => {
    const { calls, deps } = createDeps({
      runPairCommandImpl: () => Effect.succeed(1),
    })

    const { result } = await run(["pair", "BAD"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
  })

  test("pair management actions exit without starting a server", async () => {
    const { calls, deps } = createDeps({
      runPairCommandImpl: () => Effect.succeed(0),
    })

    const { result } = await run(["pair", "--status"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.startServer).toEqual([])
    expect(calls.fetchLatestVersion).toEqual([])
  })

  test("paired + enabled identity auto-starts cloud", async () => {
    const fake = createFakeCloudRuntime()
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
      createCloudRuntimeImpl: () => fake.runtime,
    })

    const { result, stop } = await run(["--no-open"], deps)

    expect(result.kind).toBe("started")
    const serverOptions = calls.startServer[0]!
    expect(serverOptions.trustProxy).toBe(true)
    expect(serverOptions.cloud).toBe(fake.runtime)
    expect(fake.calls.starts).toEqual([{ localUrl: "http://localhost:3210" }])
    expect(calls.log.some((line) => line.includes("cloud: waiting for https://jakemor-mbp.kanna.sh"))).toBe(true)

    await stop()
    expect(fake.calls.stops).toBe(1)
  })

  test("stopping takes the cloud down first and the server last", async () => {
    const order: string[] = []
    const fake = createFakeCloudRuntime()
    fake.runtime = { ...fake.runtime, stop: Effect.sync(() => order.push("cloud")) }
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
      createCloudRuntimeImpl: () => fake.runtime,
      startServer: (options) => Effect.sync(() => {
        calls.startServer.push(options)
        return { port: options.port, stop: Effect.sync(() => order.push("server")) }
      }),
      claimInstanceImpl: Effect.succeed({
        kind: "ours",
        attach: () => Effect.addFinalizer(() => Effect.sync(() => order.push("supervisor link"))),
        releasedFromParent: () => false,
      }),
    })

    const { stop } = await run(["--no-open"], deps)
    await stop()

    // The supervisor keeps reporting the port until the server has stopped.
    expect(order).toEqual(["cloud", "server", "supervisor link"])
  })

  test("--no-cloud skips cloud for this run", async () => {
    let readCalls = 0
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.sync(() => {
        readCalls += 1
        return { ...CLOUD_IDENTITY }
      }),
      createCloudRuntimeImpl: () => {
        throw new Error("should not create a cloud runtime with --no-cloud")
      },
    })

    const { result, stop } = await run(["--no-open", "--no-cloud"], deps)

    expect(result.kind).toBe("started")
    // The identity may be read (the single-instance guard uses it for the
    // hosted URL), but no cloud runtime is created.
    expect(readCalls).toBeLessThanOrEqual(1)
    const serverOptions = calls.startServer[0]!
    expect(serverOptions.cloud ?? null).toBeNull()
    expect(serverOptions.trustProxy).toBe(false)
    await stop()
  })

  test("--share wins over cloud auto-enable", async () => {
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
      createCloudRuntimeImpl: () => {
        throw new Error("should not create a cloud runtime with --share")
      },
    })

    const { result, stop } = await run(["--no-open", "--share"], deps)

    expect(result.kind).toBe("started")
    expect(calls.shareTunnel.length).toBe(1)
    expect(calls.startServer[0]!.cloud ?? null).toBeNull()
    await stop()
  })

  test("disabled identity stays local", async () => {
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY, enabled: false }),
      createCloudRuntimeImpl: () => {
        throw new Error("should not create a cloud runtime when disabled")
      },
    })

    const { result, stop } = await run(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.startServer[0]!.cloud ?? null).toBeNull()
    expect(calls.log.some((line) => line.includes("cloud:"))).toBe(false)
    await stop()
  })

  test("--cloud without an identity exits 1", async () => {
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed(null),
      createCloudRuntimeImpl: () => {
        throw new Error("should not create a cloud runtime without an identity")
      },
    })

    const { result } = await run(["--no-open", "--cloud"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
    expect(calls.warn.some((line) => line.includes("--cloud needs a provisioned cloud identity"))).toBe(true)
  })

  test("--cloud forces direct mode and overrides a sticky disable", async () => {
    const fake = createFakeCloudRuntime()
    const identitiesSeen: unknown[] = []
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY, enabled: false }),
      createCloudRuntimeImpl: (identity) => {
        identitiesSeen.push(identity)
        return fake.runtime
      },
    })

    const { result, stop } = await run(["--no-open", "--cloud"], deps)

    expect(result.kind).toBe("started")
    expect(identitiesSeen).toEqual([{ ...CLOUD_IDENTITY, mode: "direct", enabled: true }])
    const serverOptions = calls.startServer[0]!
    expect(serverOptions.cloud).toBe(fake.runtime)
    expect(serverOptions.trustProxy).toBe(true)
    expect(serverOptions.host).toBe("0.0.0.0")
    expect(fake.calls.starts.length).toBe(1)
    await stop()
  })
})

describe("runCli single-instance guard + hosted open", () => {
  test("existing same-data-dir instance → exit 0, open local URL", async () => {
    const { calls, deps } = createDeps({
      probeExistingInstanceImpl: () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210 }),
    })

    const { result } = await run([], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.startServer).toEqual([])
    expect(calls.openUrl).toEqual(["http://localhost:3210"])
    expect(calls.log.some((line) => line.includes("already running"))).toBe(true)
  })

  test("existing instance + paired identity → open the hosted URL instead", async () => {
    const { calls, deps } = createDeps({
      probeExistingInstanceImpl: () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210 }),
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
    })

    const { result } = await run([], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.openUrl).toEqual(["https://jakemor-mbp.kanna.sh"])
  })

  test("existing instance + --no-open → no browser", async () => {
    const { calls, deps } = createDeps({
      probeExistingInstanceImpl: () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210 }),
    })
    await run(["--no-open"], deps)
    expect(calls.openUrl).toEqual([])
  })

  test("a Kanna holding the lock but still starting → exit 1", async () => {
    const { calls, deps } = createDeps({
      claimInstanceImpl: Effect.succeed({ kind: "running", status: null }),
    })

    const { result } = await run(["--no-open"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
    expect(calls.warn).toContain("[kanna] kanna is already starting; try again in a moment")
  })

  test("paired start opens the hosted URL when the tunnel connects (not localhost)", async () => {
    const fake = createFakeCloudRuntime()
    let capturedOnTunnelUp: ((kind: "started" | "recovered") => void) | undefined
    fake.runtime = {
      ...fake.runtime,
      start: (args) => Effect.sync(() => {
        fake.calls.starts.push({ localUrl: args.localUrl })
        capturedOnTunnelUp = args.onTunnelUp
      }),
    }
    const { calls, deps } = createDeps({
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
      createCloudRuntimeImpl: () => fake.runtime,
    })

    const { result, stop } = await run([], deps)

    expect(result.kind).toBe("started")
    // No local open while the tunnel is connecting…
    expect(calls.openUrl).toEqual([])
    capturedOnTunnelUp?.("started")
    expect(calls.openUrl).toEqual(["https://jakemor-mbp.kanna.sh"])
    // …and recoveries never re-open the browser.
    capturedOnTunnelUp?.("recovered")
    expect(calls.openUrl).toEqual(["https://jakemor-mbp.kanna.sh"])

    await stop()
  })

  test("unpaired start still opens localhost", async () => {
    const { calls, deps } = createDeps()
    const { result, stop } = await run([], deps)
    expect(result.kind).toBe("started")
    expect(calls.openUrl).toEqual(["http://localhost:3210"])
    await stop()
  })
})

describe("runCli stop and slim-transcripts", () => {
  test("`kanna stop` with nothing running says so", async () => {
    const { calls, deps } = createDeps()

    const { result } = await run(["stop"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.log).toEqual(["[kanna] kanna isn't running"])
  })

  test("`kanna stop` asks the running Kanna to stop and waits until it has", async () => {
    let statusChecks = 0
    let stopRequests = 0
    const running = {
      ok: true as const, pid: 4242, instance: "abc", owner: "terminal" as const, startedAt: 1,
      port: 3210, version: "0.3.0", runningChats: 0, cloud: false,
    }
    const { calls, deps } = createDeps({
      // Running for the first two checks, then gone.
      instanceStatusImpl: Effect.sync(() => (statusChecks += 1) <= 2 ? running : null),
      requestInstanceStopImpl: Effect.sync(() => {
        stopRequests += 1
        return true
      }),
    })

    const { result } = await run(["stop"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(stopRequests).toBe(1)
    expect(calls.log).toEqual(["[kanna] stopping kanna (pid 4242)…", "[kanna] stopped"])
  })

  test("slim-transcripts refuses while a Kanna runs, and reports what it rewrote", async () => {
    const busy = createDeps({
      probeExistingInstanceImpl: () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210 }),
      slimTranscriptsImpl: () => Effect.die("should not slim while a Kanna runs"),
    })
    expect((await run(["slim-transcripts"], busy.deps)).result).toEqual({ kind: "exited", code: 1 })
    expect(busy.calls.warn).toEqual(["[kanna] kanna is running at http://localhost:3210; stop it before slimming transcripts"])

    const idle = createDeps({
      slimTranscriptsImpl: () => Effect.succeed({ chats: 4, rewritten: 2, bytesBefore: 3 * 1024 * 1024, bytesAfter: 1024 * 1024 }),
    })
    expect((await run(["slim-transcripts"], idle.deps)).result).toEqual({ kind: "exited", code: 0 })
    expect(idle.calls.log).toEqual(["[kanna] rewrote 2/4 transcripts: 3.0 MB → 1.0 MB"])
  })
})

describe("runCli with the Mac app", () => {
  function withMacApp(installed: boolean) {
    const opened: string[] = []
    return {
      opened,
      openInMacApp: (localUrl: string) => Effect.sync(() => {
        opened.push(localUrl)
        return installed
      }),
    }
  }

  test("installed app gets the local URL and no browser opens, paired or not", async () => {
    const app = withMacApp(true)
    const fake = createFakeCloudRuntime()
    let capturedOnTunnelUp: ((kind: "started" | "recovered") => void) | undefined
    fake.runtime = {
      ...fake.runtime,
      start: (args) => Effect.sync(() => {
        capturedOnTunnelUp = args.onTunnelUp
      }),
    }
    const { calls, deps } = createDeps({
      openInMacApp: app.openInMacApp,
      readCloudIdentityImpl: () => Effect.succeed({ ...CLOUD_IDENTITY }),
      createCloudRuntimeImpl: () => fake.runtime,
    })

    const { stop } = await run([], deps)
    capturedOnTunnelUp?.("started")

    expect(app.opened).toEqual(["http://localhost:3210"])
    expect(calls.openUrl).toEqual([])
    await stop()
  })

  test("already running → the app, not the browser", async () => {
    const app = withMacApp(true)
    const { calls, deps } = createDeps({
      openInMacApp: app.openInMacApp,
      probeExistingInstanceImpl: () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210 }),
    })

    await run([], deps)

    expect(app.opened).toEqual(["http://localhost:3210"])
    expect(calls.openUrl).toEqual([])
  })

  test("no app installed → browser as before", async () => {
    const app = withMacApp(false)
    const { calls, deps } = createDeps({ openInMacApp: app.openInMacApp })
    const { stop } = await run([], deps)
    expect(calls.openUrl).toEqual(["http://localhost:3210"])
    await stop()
  })

  test("--no-open (how the app starts its own server) opens nothing", async () => {
    const app = withMacApp(true)
    const { calls, deps } = createDeps({ openInMacApp: app.openInMacApp })
    const { stop } = await run(["--no-open"], deps)
    expect(app.opened).toEqual([])
    expect(calls.openUrl).toEqual([])
    await stop()
  })
})

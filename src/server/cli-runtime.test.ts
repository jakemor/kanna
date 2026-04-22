import { afterEach, describe, expect, test } from "bun:test"
import { compareVersions, classifyInstallVersionFailure, parseArgs, runCli } from "./cli-runtime"
import { CLI_SUPPRESS_OPEN_ONCE_ENV_VAR } from "./restart"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const originalSuppressOpen = process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }
  if (originalSuppressOpen === undefined) {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
  } else {
    process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] = originalSuppressOpen
  }
})

function createDeps(overrides: Partial<Parameters<typeof runCli>[1]> = {}) {
  const calls = {
    startServer: [] as Array<{
      port: number
      host: string
      openBrowser: boolean
      share: false | "quick" | { kind: "token"; token: string }
      password: string | null
      strictPort: boolean
      trustProxy?: boolean
      update: {
        version: string
        argv: string[]
        command: string
      }
    }>,
    fetchLatestVersion: [] as string[],
    installVersion: [] as Array<{ packageName: string; version: string }>,
    openUrl: [] as string[],
    log: [] as string[],
    warn: [] as string[],
    shareTunnel: [] as Array<{ localUrl: string; shareMode: "quick" | { kind: "token"; token: string } }>,
    renderShareQr: [] as string[],
    shareTunnelStops: 0,
  }

  const deps: Parameters<typeof runCli>[1] = {
    version: "0.3.0",
    bunVersion: "1.3.10",
    startServer: async (options) => {
      calls.startServer.push(options)
      return {
        port: options.port,
        stop: async () => {},
      }
    },
    fetchLatestVersion: async (packageName) => {
      calls.fetchLatestVersion.push(packageName)
      return "0.3.0"
    },
    installVersion: (packageName, version) => {
      calls.installVersion.push({ packageName, version })
      return {
        ok: true,
        errorCode: null,
        userTitle: null,
        userMessage: null,
      }
    },
    openUrl: (url) => {
      calls.openUrl.push(url)
    },
    log: (message) => {
      calls.log.push(message)
    },
    warn: (message) => {
      calls.warn.push(message)
    },
    renderShareQr: async (url) => {
      calls.renderShareQr.push(url)
      return `[qr:${url}]`
    },
    startShareTunnel: async (localUrl, shareMode) => {
      calls.shareTunnel.push({ localUrl, shareMode })
      return {
        publicUrl: "https://kanna.trycloudflare.com",
        stop: () => {
          calls.shareTunnelStops += 1
        },
      }
    },
    ...overrides,
  }

  return { calls, deps }
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

    const result = await runCli(["--version"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.fetchLatestVersion).toEqual([])
    expect(calls.startServer).toEqual([])
    expect(calls.log).toEqual(["0.3.0"])
  })

  test("starts normally when no newer version exists", async () => {
    const { calls, deps } = createDeps()
    process.env.KANNA_RUNTIME_PROFILE = "prod"

    const result = await runCli(["--port", "4000", "--no-open"], deps)

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
  })

  test("logs the dev data dir when the dev runtime profile is active", async () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000", "--no-open"], deps)

    expect(calls.log).toContain("[kanna] data dir: ~/.kanna-dev/data")
  })

  test("fails fast on unsupported Bun versions", async () => {
    const { calls, deps } = createDeps({
      bunVersion: "1.3.1",
    })

    const result = await runCli(["--no-open"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
    expect(calls.warn).toContain("[kanna] Bun 1.3.5+ is required for the embedded terminal. Current Bun: 1.3.1")
  })

  test("opens the root route in the browser", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000"], deps)

    expect(calls.openUrl).toEqual(["http://localhost:4000"])
  })

  test("opens browser at hostname when --host <host> is given", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    await runCli(["--host", "dev-box", "--port", "4000"], deps)

    expect(calls.openUrl).toEqual(["http://dev-box:4000"])
  })

  test("suppresses browser open for a ui-triggered restarted child", async () => {
    process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] = "1"
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000"], deps)

    expect(calls.openUrl).toEqual([])
  })

  test("starts a share tunnel and prints qr/public/local urls", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    const result = await runCli(["--share", "--port", "4000"], deps)

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

    if (result.kind !== "started") {
      throw new Error(`expected started result, got ${result.kind}`)
    }
    await result.stop()
    expect(calls.shareTunnelStops).toBe(1)
  })

  test("logs share setup progress from the default tunnel helper", async () => {
    const { calls, deps } = createDeps({
      startShareTunnel: undefined,
      renderShareQr: async () => "[qr]",
    })

    let installLogged = false
    deps.startShareTunnel = async (_localUrl) => {
      deps.log("[kanna] installing cloudflared binary")
      installLogged = true
      return {
        publicUrl: "https://kanna.trycloudflare.com",
        stop: () => {},
      }
    }

    await runCli(["--share"], deps)

    expect(installLogged).toBe(true)
    expect(calls.log).toContain("[kanna] installing cloudflared binary")
  })

  test("uses the actual bound port for --share", async () => {
    const { calls, deps } = createDeps({
      startServer: async (options) => {
        calls.startServer.push(options)
        return {
          port: 4001,
          stop: async () => {},
        }
      },
    })

    const result = await runCli(["--share", "--port", "4000"], deps)

    expect(result.kind).toBe("started")
    expect(calls.shareTunnel).toEqual([{ localUrl: "http://localhost:4001", shareMode: "quick" }])
  })

  test("fails cleanly when share tunnel startup fails", async () => {
    let serverStopped = false
    const { calls, deps } = createDeps({
      startServer: async (options) => {
        calls.startServer.push(options)
        return {
          port: options.port,
          stop: async () => {
            serverStopped = true
          },
        }
      },
      startShareTunnel: async () => {
        throw new Error("cloudflared unavailable")
      },
    })

    const result = await runCli(["--share"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(serverStopped).toBe(true)
    expect(calls.warn).toContain("[kanna] failed to start Cloudflare share tunnel")
    expect(calls.warn).toContain("[kanna] cloudflared unavailable")
  })

  test("keeps running when a named tunnel starts without a detected hostname", async () => {
    const { calls, deps } = createDeps({
      startShareTunnel: async (localUrl, shareMode) => {
        calls.shareTunnel.push({ localUrl, shareMode })
        return {
          publicUrl: null,
          stop: () => {
            calls.shareTunnelStops += 1
          },
        }
      },
    })

    const result = await runCli(["--cloudflared", "secret-token"], deps)

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
  })

  test("returns restarting when a newer version is available", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: async (packageName) => {
        calls.fetchLatestVersion.push(packageName)
        return "0.4.0"
      },
    })

    const result = await runCli(["--port", "4000", "--no-open"], deps)

    expect(result).toEqual({ kind: "restarting", reason: "startup_update" })
    expect(calls.installVersion).toEqual([{ packageName: "kanna-code", version: "0.4.0" }])
    expect(calls.startServer).toEqual([])
  })

  test("falls back to current version when install fails", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: async (packageName) => {
        calls.fetchLatestVersion.push(packageName)
        return "0.4.0"
      },
      installVersion: (packageName, version) => {
        calls.installVersion.push({ packageName, version })
        return {
          ok: false,
          errorCode: "install_failed",
          userTitle: "Update failed",
          userMessage: "Kanna could not install the update. Try again later.",
        }
      },
    })

    const result = await runCli(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.installVersion).toEqual([{ packageName: "kanna-code", version: "0.4.0" }])
    expect(calls.warn).toContain("[kanna] update failed, continuing current version")
  })

  test("falls back to current version when the registry check fails", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: async (packageName) => {
        calls.fetchLatestVersion.push(packageName)
        throw new Error("network unavailable")
      },
    })

    const result = await runCli(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.installVersion).toEqual([])
    expect(calls.warn).toContain("[kanna] update check failed, continuing current version")
  })
})

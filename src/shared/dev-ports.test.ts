import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DEV_CLIENT_PORT,
  getDefaultDevServerPort,
  parseDevArgs,
  resolveDevPorts,
  stripShareArg,
  stripPortArg,
} from "./dev-ports"

describe("getDefaultDevServerPort", () => {
  test("derives the default backend port from the client port", () => {
    expect(getDefaultDevServerPort()).toBe(DEFAULT_DEV_CLIENT_PORT + 1)
    expect(getDefaultDevServerPort(4000)).toBe(4001)
  })
})

describe("resolveDevPorts", () => {
  test("uses default dev ports when no port override is provided", () => {
    expect(resolveDevPorts([])).toEqual({
      clientPort: DEFAULT_DEV_CLIENT_PORT,
      serverPort: DEFAULT_DEV_CLIENT_PORT + 1,
    })
  })

  test("treats --port as the client port and derives the backend port", () => {
    expect(resolveDevPorts(["--remote", "--port", "4000"])).toEqual({
      clientPort: 4000,
      serverPort: 4001,
    })
  })

  test("uses the last provided --port value", () => {
    expect(resolveDevPorts(["--port", "4000", "--port", "4100"])).toEqual({
      clientPort: 4100,
      serverPort: 4101,
    })
  })

  test("throws when --port is missing a value", () => {
    expect(() => resolveDevPorts(["--port"])).toThrow("Missing value for --port")
    expect(() => resolveDevPorts(["--port", "--remote"])).toThrow("Missing value for --port")
  })
})

describe("stripPortArg", () => {
  test("removes --port and its value while preserving other args", () => {
    expect(stripPortArg(["--remote", "--port", "4000", "--host", "dev-box"])).toEqual([
      "--remote",
      "--host",
      "dev-box",
    ])
  })
})

describe("stripShareArg", () => {
  test("removes --share and --cloudflared arguments while preserving other args", () => {
    expect(stripShareArg(["--remote", "--share", "--cloudflared", "secret-token", "--host", "dev-box"])).toEqual([
      "--remote",
      "--host",
      "dev-box",
    ])
  })
})

describe("parseDevArgs", () => {
  test("derives dev share options from the client port", () => {
    expect(parseDevArgs(["--share", "--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      share: "quick",
      backendTargetHost: "127.0.0.1",
      allowedHosts: true,
      serverArgs: [],
    })
  })

  test("accepts a token-bearing cloudflared dev mode", () => {
    expect(parseDevArgs(["--cloudflared", "secret-token", "--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      share: { kind: "token", token: "secret-token" },
      backendTargetHost: "127.0.0.1",
      allowedHosts: true,
      serverArgs: [],
    })
  })

  test("rejects combining --share with --host or --remote", () => {
    expect(() => parseDevArgs(["--share", "--host", "dev-box"], "dev-machine")).toThrow("--share cannot be used with --host")
    expect(() => parseDevArgs(["--host", "dev-box", "--share"], "dev-machine")).toThrow("--share cannot be used with --host")
    expect(() => parseDevArgs(["--share", "--remote"], "dev-machine")).toThrow("--share cannot be used with --remote")
    expect(() => parseDevArgs(["--remote", "--share"], "dev-machine")).toThrow("--share cannot be used with --remote")
  })

  test("rejects combining --cloudflared with --host or --remote", () => {
    expect(() => parseDevArgs(["--cloudflared", "secret-token", "--host", "dev-box"], "dev-machine")).toThrow("--cloudflared cannot be used with --host")
    expect(() => parseDevArgs(["--host", "dev-box", "--cloudflared", "secret-token"], "dev-machine")).toThrow("--cloudflared cannot be used with --host")
    expect(() => parseDevArgs(["--cloudflared", "secret-token", "--remote"], "dev-machine")).toThrow("--cloudflared cannot be used with --remote")
    expect(() => parseDevArgs(["--remote", "--cloudflared", "secret-token"], "dev-machine")).toThrow("--cloudflared cannot be used with --remote")
  })

  test("preserves existing remote host behavior when share is off", () => {
    expect(parseDevArgs(["--remote", "--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      share: false,
      backendTargetHost: "127.0.0.1",
      allowedHosts: true,
      serverArgs: ["--remote"],
    })
  })
})

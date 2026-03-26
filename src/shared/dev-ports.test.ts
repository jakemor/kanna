import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DEV_CLIENT_PORT,
  getDefaultDevServerPort,
  resolveDevPorts,
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

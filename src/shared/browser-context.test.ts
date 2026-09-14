import { describe, expect, test } from "bun:test"
import { isLoopbackHostname, parseBrowserAccessContext, resolveUrlForBrowserHost } from "./browser-context"

describe("browser access context", () => {
  test("recognizes loopback spellings", () => {
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("app.localhost")).toBe(true)
    expect(isLoopbackHostname("127.23.4.5")).toBe(true)
    expect(isLoopbackHostname("[::1]")).toBe(true)
    expect(isLoopbackHostname("192.168.1.20")).toBe(false)
    expect(isLoopbackHostname("jane.tailnet.ts.net")).toBe(false)
  })

  test("normalizes browser origins and drops untrusted URL parts", () => {
    expect(parseBrowserAccessContext("https://Jane.Example:8443/some/path?secret=yes#x")).toEqual({
      origin: "https://jane.example:8443",
      hostname: "jane.example",
      mode: "network",
    })
    expect(parseBrowserAccessContext("https://user:secret@example.com")).toBeNull()
    expect(parseBrowserAccessContext("javascript:alert(1)")).toBeNull()
  })

  test("uses the browsing hostname for machine-local server addresses over the network", () => {
    expect(resolveUrlForBrowserHost("http://localhost:3000", "https://jane.tailnet.ts.net")).toBe(
      "http://jane.tailnet.ts.net:3000"
    )
    expect(resolveUrlForBrowserHost("http://127.0.0.1:8080/path", "http://192.168.1.20:3210")).toBe(
      "http://192.168.1.20:8080/path"
    )
    expect(resolveUrlForBrowserHost("http://localhost:3000", "http://localhost:3210")).toBe(
      "http://localhost:3000"
    )
    expect(resolveUrlForBrowserHost("https://example.com/app", "http://192.168.1.20:3210")).toBe(
      "https://example.com/app"
    )
  })
})

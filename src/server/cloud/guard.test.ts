import { describe, expect, test } from "bun:test"
import { PROXY_AUTH_HEADER } from "../../shared/cloud-api"
import { classifyCloudRequest, isAllowedCloudWsUpgrade } from "./guard"

const PROXY_SECRET = "super-secret-proxy-value"

function request(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers })
}

describe("classifyCloudRequest", () => {
  test("valid proxy auth header → proxied", () => {
    const req = request("http://127.0.0.1:3210/", {
      host: "xyz.trycloudflare.com",
      [PROXY_AUTH_HEADER]: PROXY_SECRET,
    })
    expect(classifyCloudRequest(req, PROXY_SECRET)).toBe("proxied")
  })

  test("wrong proxy auth value → not proxied (timing-safe compare)", () => {
    const wrong = request("http://127.0.0.1:3210/", {
      host: "xyz.trycloudflare.com",
      [PROXY_AUTH_HEADER]: "super-secret-proxy-valuX",
    })
    expect(classifyCloudRequest(wrong, PROXY_SECRET)).toBe("untrusted")

    const wrongLength = request("http://127.0.0.1:3210/", {
      host: "xyz.trycloudflare.com",
      [PROXY_AUTH_HEADER]: "short",
    })
    expect(classifyCloudRequest(wrongLength, PROXY_SECRET)).toBe("untrusted")
  })

  test("loopback hosts without tunnel markers → local", () => {
    for (const host of ["localhost:3210", "127.0.0.1:3210", "[::1]:3210", "localhost"]) {
      expect(classifyCloudRequest(request("http://127.0.0.1:3210/", { host }), PROXY_SECRET)).toBe("local")
    }
  })

  test("raw tunnel hits → untrusted", () => {
    expect(
      classifyCloudRequest(request("http://127.0.0.1:3210/", { host: "xyz.trycloudflare.com" }), PROXY_SECRET),
    ).toBe("untrusted")

    // cloudflared stamps cf-connecting-ip even if Host were rewritten.
    expect(
      classifyCloudRequest(
        request("http://127.0.0.1:3210/", { host: "localhost:3210", "cf-connecting-ip": "1.2.3.4" }),
        PROXY_SECRET,
      ),
    ).toBe("untrusted")
  })
})

describe("isAllowedCloudWsUpgrade", () => {
  const context = {
    appOrigin: "https://jakemor-mbp.kanna.sh",
    validateToken: (token: string) => token === "live-token",
  }

  test("valid token + app origin → allowed", () => {
    const req = request("http://x.trycloudflare.com/ws?token=live-token", {
      origin: "https://jakemor-mbp.kanna.sh",
    })
    expect(isAllowedCloudWsUpgrade(req, context)).toBe(true)
  })

  test("origin comparison is case-insensitive on the host", () => {
    const req = request("http://x.trycloudflare.com/ws?token=live-token", {
      origin: "https://JAKEMOR-MBP.kanna.sh",
    })
    expect(isAllowedCloudWsUpgrade(req, context)).toBe(true)
  })

  test("valid token + local origin → rejected: only the kanna.sh page holds a token", () => {
    const req = request("http://localhost:3210/ws?token=live-token", {
      origin: "http://localhost:5173",
    })
    expect(isAllowedCloudWsUpgrade(req, context)).toBe(false)
  })

  test("a refused origin does not spend the token", () => {
    const spent: string[] = []
    const spending = { ...context, validateToken: (token: string) => { spent.push(token); return true } }
    expect(isAllowedCloudWsUpgrade(request("http://x/ws?token=live-token", { origin: "https://evil.example.com" }), spending)).toBe(false)
    expect(spent).toEqual([])
  })

  test("valid token without origin (non-browser client) → allowed", () => {
    expect(isAllowedCloudWsUpgrade(request("http://x/ws?token=live-token"), context)).toBe(true)
  })

  test("missing or invalid token → rejected", () => {
    expect(isAllowedCloudWsUpgrade(request("http://x/ws"), context)).toBe(false)
    expect(isAllowedCloudWsUpgrade(request("http://x/ws?token=stale"), context)).toBe(false)
  })

  test("foreign origin → rejected even with a valid token", () => {
    const req = request("http://x/ws?token=live-token", { origin: "https://evil.example.com" })
    expect(isAllowedCloudWsUpgrade(req, context)).toBe(false)

    const garbageOrigin = request("http://x/ws?token=live-token", { origin: "not-a-url" })
    expect(isAllowedCloudWsUpgrade(garbageOrigin, context)).toBe(false)
  })
})

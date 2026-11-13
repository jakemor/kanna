import { describe, expect, test } from "bun:test"
import {
  checkRequest,
  createHostAllowlist,
  createRefusalLog,
  describeRefusal,
  isIpLiteralHost,
  machineHostNames,
  normalizeAllowedHost,
  parseAllowedHostsFile,
  parseHostHeader,
  refusalResponse,
  requestOwnOrigins,
  type RequestGuardContext,
} from "./request-guard"

/** As the server sees one: Bun builds the URL from the Host header, so the two always agree. */
function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(url, { method: init.method ?? "GET", headers: { host: new URL(url).host, ...init.headers } })
}

const loopbackOnly = createHostAllowlist({ bindHost: "127.0.0.1", machineNames: ["jakes-mbp", "jakes-mbp.local"] })
const lan = createHostAllowlist({ bindHost: "0.0.0.0", machineNames: machineHostNames("Jakes-MBP.local", "Jakes-MacBook-Pro") })

function local(overrides: Partial<RequestGuardContext> = {}): RequestGuardContext {
  return { requestClass: "local", hosts: loopbackOnly, ...overrides }
}

describe("parseHostHeader", () => {
  test("takes the name and drops the port", () => {
    expect(parseHostHeader("localhost:3210")).toBe("localhost")
    expect(parseHostHeader("LOCALHOST")).toBe("localhost")
    expect(parseHostHeader("127.0.0.1:3210")).toBe("127.0.0.1")
    expect(parseHostHeader("[::1]:3210")).toBe("[::1]")
    expect(parseHostHeader("[::1]")).toBe("[::1]")
    expect(parseHostHeader("Mac.Tailnet.ts.net:3210")).toBe("mac.tailnet.ts.net")
    expect(parseHostHeader("localhost.:3210")).toBe("localhost")
  })

  test("refuses what is not a host", () => {
    for (const value of [null, "", " ", "a b", "user@localhost", "localhost/path", "[::1", "[::1]x", "a:b:c", "localhost:32x"]) {
      expect(parseHostHeader(value)).toBeNull()
    }
  })
})

describe("isIpLiteralHost", () => {
  test("dotted IPv4 and bracketed IPv6 only", () => {
    for (const host of ["127.0.0.1", "192.168.1.20", "100.64.3.9", "203.0.113.5", "[::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
      expect(isIpLiteralHost(host)).toBe(true)
    }
    // Names that only look like addresses are DNS names, and can be re-pointed.
    for (const host of ["1.2.3.4.evil.example", "127.0.0.1.nip.io", "2130706433", "0x7f.0.0.1", "127.1", "::1", "256.1.1.1", "localhost"]) {
      expect(isIpLiteralHost(host)).toBe(false)
    }
  })
})

describe("createHostAllowlist", () => {
  test("loopback names and IP literals always, on any bind", () => {
    for (const list of [loopbackOnly, lan]) {
      for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "[::1]", "192.168.1.20", "100.64.3.9", "[fe80::1]"]) {
        expect(list.allows(host)).toBe(true)
      }
    }
  })

  test("a stranger's name never", () => {
    for (const list of [loopbackOnly, lan]) {
      for (const host of ["evil.example", "localhost.evil.example", "127.0.0.1.nip.io", "kanna.sh", "x.trycloudflare.com", "mac.tailnet.ts.net"]) {
        expect(list.allows(host)).toBe(false)
      }
    }
  })

  test("the machine's own names only when it listens beyond loopback", () => {
    expect(lan.allows("jakes-mbp.local")).toBe(true)
    expect(lan.allows("jakes-mbp")).toBe(true)
    expect(lan.allows("jakes-macbook-pro.local")).toBe(true)
    expect(lan.allows("jakes-macbook-pro")).toBe(true)
    // Nothing reaches a loopback-only server by them.
    expect(loopbackOnly.allows("jakes-mbp.local")).toBe(false)
    expect(loopbackOnly.allows("jakes-mbp")).toBe(false)
  })

  test("the machine's tailnet name is recognized under --remote, and nobody else's", () => {
    expect(lan.allows("jakes-mbp.tail1234.ts.net")).toBe(true)
    expect(lan.allows("jakes-macbook-pro.tailnet-name.ts.net")).toBe(true)
    // Another machine's name, another domain, or a deeper one.
    expect(lan.allows("someone-else.tail1234.ts.net")).toBe(false)
    expect(lan.allows("jakes-mbp.tail1234.ts.net.evil.example")).toBe(false)
    expect(lan.allows("jakes-mbp.evil.example")).toBe(false)
    expect(lan.allows("jakes-mbp.a.b.ts.net")).toBe(false)
    expect(lan.allows("jakes-mbp.ts.net")).toBe(false)
    // A loopback-only server is reached by it only through a proxy, which is the user's to name.
    expect(loopbackOnly.allows("jakes-mbp.tail1234.ts.net")).toBe(false)
  })

  test("--host by name is a name the server answers to", () => {
    const named = createHostAllowlist({ bindHost: "my-mac.lan" })
    expect(named.allows("my-mac.lan")).toBe(true)
    expect(named.allows("other.lan")).toBe(false)
  })

  test("--allow-host names count on any bind, and a tunnel's name once learned", () => {
    const list = createHostAllowlist({ bindHost: "127.0.0.1", extra: ["Mac.Tailnet.ts.net", "https://kanna.example.com/", "bad name"] })
    expect(list.allows("mac.tailnet.ts.net")).toBe(true)
    expect(list.allows("kanna.example.com")).toBe(true)
    expect(list.allows("x.trycloudflare.com")).toBe(false)
    list.add("https://x.trycloudflare.com")
    expect(list.allows("x.trycloudflare.com")).toBe(true)
    expect(list.names().sort()).toEqual(["kanna.example.com", "mac.tailnet.ts.net", "x.trycloudflare.com"])
  })
})

describe("normalizeAllowedHost", () => {
  test("a bare name, a host:port or a URL", () => {
    expect(normalizeAllowedHost("Mac.Tailnet.ts.net")).toBe("mac.tailnet.ts.net")
    expect(normalizeAllowedHost("mac.local:3210")).toBe("mac.local")
    expect(normalizeAllowedHost("https://kanna.example.com/path")).toBe("kanna.example.com")
    expect(normalizeAllowedHost("")).toBeNull()
    expect(normalizeAllowedHost("*.example.com")).toBeNull()
    expect(normalizeAllowedHost("two words")).toBeNull()
  })
})

describe("machineHostNames", () => {
  test("the hostname, its first label and its Bonjour form", () => {
    expect(machineHostNames("Jakes-MBP.local").sort()).toEqual(["jakes-mbp", "jakes-mbp.local"])
    expect(machineHostNames("devbox.corp.example.com", null).sort()).toEqual(["devbox", "devbox.corp.example.com", "devbox.local"])
    expect(machineHostNames("", null)).toEqual([])
  })
})

describe("parseAllowedHostsFile", () => {
  test("one name per line, comments and blanks skipped", () => {
    expect(parseAllowedHostsFile("# my tailnet\nmac.tailnet.ts.net\n\n  kanna.example.com  # proxy\n")).toEqual(["mac.tailnet.ts.net", "kanna.example.com"])
  })
})

describe("checkRequest: Host", () => {
  test("a local request by a loopback name or an IP passes", () => {
    for (const host of ["localhost:3210", "127.0.0.1:3210", "[::1]:3210", "192.168.1.20:3210"]) {
      expect(checkRequest(request(`http://${host}/`), local())).toBeNull()
    }
  })

  test("a rebinding page's Host is refused on every route, same-origin or not", () => {
    for (const path of ["/", "/health", "/api/cloud/pair-session", "/api/chats/c1/window", "/ws", "/assets/app.js"]) {
      const refusal = checkRequest(request(`http://evil.example:3210${path}`, { headers: { origin: "http://evil.example:3210" } }), local())
      expect(refusal).toEqual({ kind: "host", host: "evil.example" })
    }
    const post = request("http://evil.example:3210/api/cloud/pair-session", { method: "POST", headers: { origin: "http://evil.example:3210", "sec-fetch-site": "same-origin" } })
    expect(checkRequest(post, local())).toEqual({ kind: "host", host: "evil.example" })
  })

  test("a private DNS name is refused until it is allowed", () => {
    const req = request("http://mac.corp.example.com:3210/")
    expect(checkRequest(req, local({ hosts: lan }))).toEqual({ kind: "host", host: "mac.corp.example.com" })
    const allowed = createHostAllowlist({ bindHost: "0.0.0.0", extra: ["mac.corp.example.com"] })
    expect(checkRequest(req, local({ hosts: allowed }))).toBeNull()
  })

  test("the machine's .local name passes under --remote", () => {
    expect(checkRequest(request("http://jakes-mbp.local:3210/"), local({ hosts: lan }))).toBeNull()
    expect(checkRequest(request("http://jakes-mbp.local:3210/"), local())).toEqual({ kind: "host", host: "jakes-mbp.local" })
  })

  test("a request with no Host is refused", () => {
    const req = request("http://localhost:3210/")
    req.headers.delete("host")
    expect(checkRequest(req, local())).toEqual({ kind: "host", host: null })
  })

  test("proxied and raw-tunnel requests are not held to the Host list: the tunnel guard classed them", () => {
    const viaProxy = request("http://tun-m1.kanna.sh/api/cloud/ws-endpoint")
    expect(checkRequest(viaProxy, { requestClass: "proxied", hosts: loopbackOnly, appOrigin: "https://mac.kanna.sh" })).toBeNull()
    expect(checkRequest(request("http://tun-m1.kanna.sh/health"), { requestClass: "untrusted", hosts: loopbackOnly })).toBeNull()
  })

  test("an unlearned tunnel hostname passes only on a request the tunnel forwarded", () => {
    const context = local({ tunnelHostUnknown: true })
    const forwarded = request("http://kanna.example.com/", { headers: { "cf-connecting-ip": "203.0.113.9" } })
    expect(checkRequest(forwarded, context)).toBeNull()
    expect(checkRequest(request("http://kanna.example.com/"), context)).toEqual({ kind: "host", host: "kanna.example.com" })
    // Without the mode, the marker means nothing: any page can send it on a fetch.
    expect(checkRequest(forwarded, local())).toEqual({ kind: "host", host: "kanna.example.com" })
  })
})

describe("checkRequest: Origin on /ws", () => {
  const ws = (host: string, headers: Record<string, string> = {}) => request(`http://${host}/ws`, { headers })

  test("no Origin passes: apps, the CLI and scripts send none", () => {
    expect(checkRequest(ws("localhost:3210"), local())).toBeNull()
    expect(checkRequest(ws("192.168.1.20:3210"), local({ hosts: lan }))).toBeNull()
  })

  test("the server's own page passes, by whichever loopback name it was opened", () => {
    expect(checkRequest(ws("localhost:3210", { origin: "http://localhost:3210" }), local())).toBeNull()
    expect(checkRequest(ws("127.0.0.1:3210", { origin: "http://127.0.0.1:3210" }), local())).toBeNull()
    expect(checkRequest(ws("192.168.1.20:3210", { origin: "http://192.168.1.20:3210" }), local({ hosts: lan }))).toBeNull()
  })

  test("the dev client passes: Vite forwards the browser's Host and Origin unchanged", () => {
    expect(checkRequest(ws("localhost:5174", { origin: "http://localhost:5174" }), local())).toBeNull()
  })

  test("any other page is refused", () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost:5173", // another dev server on this machine
      "http://127.0.0.1:3210", // same server, other name: not the page that was loaded
      "http://localhost",
      "null", // a sandboxed frame, a file:// page
      "file://",
      "not-a-url",
      "",
    ]) {
      expect(checkRequest(ws("localhost:3210", { origin }), local())).toEqual({ kind: "origin", origin })
    }
  })

  test("behind Kanna's own tunnel the https page is the server's own, and only that one", () => {
    const hosts = createHostAllowlist({ bindHost: "127.0.0.1", extra: ["x.trycloudflare.com"] })
    const shared = local({ hosts, trustProxy: true })
    const viaTunnel = ws("x.trycloudflare.com", { origin: "https://x.trycloudflare.com", "x-forwarded-proto": "https" })
    expect(checkRequest(viaTunnel, shared)).toBeNull()
    // cloudflared said https: a plain-http page of that name is someone in the middle.
    const downgraded = ws("x.trycloudflare.com", { origin: "http://x.trycloudflare.com", "x-forwarded-proto": "https" })
    expect(checkRequest(downgraded, shared)).toEqual({ kind: "origin", origin: "http://x.trycloudflare.com" })
    // The same server opened on this machine, not through the tunnel.
    expect(checkRequest(ws("localhost:3210", { origin: "http://localhost:3210" }), shared)).toBeNull()
  })

  test("behind a proxy of the user's own, https counts whether or not it says so", () => {
    const hosts = createHostAllowlist({ bindHost: "127.0.0.1", extra: ["mac.tailnet.ts.net"] })
    const context = local({ hosts })
    const sent: Array<Record<string, string>> = [
      { origin: "https://mac.tailnet.ts.net", "x-forwarded-proto": "https" },
      { origin: "https://mac.tailnet.ts.net" },
      { origin: "http://mac.tailnet.ts.net" },
    ]
    for (const headers of sent) {
      expect(checkRequest(ws("mac.tailnet.ts.net", headers), context)).toBeNull()
    }
    expect(checkRequest(ws("mac.tailnet.ts.net", { origin: "https://mac.tailnet.ts.net:8443" }), context)).not.toBeNull()
  })

  test("a proxy that rewrote Host says the public one in X-Forwarded-Host", () => {
    const req = ws("127.0.0.1:3210", { origin: "https://kanna.example.com", "x-forwarded-host": "kanna.example.com", "x-forwarded-proto": "https" })
    expect(checkRequest(req, local())).toBeNull()
    expect(requestOwnOrigins(req, true)).toEqual(new Set(["https://127.0.0.1:3210", "https://kanna.example.com"]))
    // With neither header the page's address and the request's do not meet.
    expect(checkRequest(ws("127.0.0.1:3210", { origin: "https://kanna.example.com" }), local())).toEqual({ kind: "origin", origin: "https://kanna.example.com" })
  })

  test("the kanna.sh page passes on the tunnel and through the proxy, and is not a local page", () => {
    const appOrigin = "https://mac.kanna.sh"
    const direct = ws("tun-m1.kanna.sh", { origin: appOrigin })
    expect(checkRequest(direct, { requestClass: "untrusted", hosts: loopbackOnly, appOrigin })).toBeNull()
    expect(checkRequest(direct, { requestClass: "proxied", hosts: loopbackOnly, appOrigin })).toBeNull()
    expect(checkRequest(ws("tun-m1.kanna.sh", { origin: "https://MAC.kanna.sh" }), { requestClass: "untrusted", hosts: loopbackOnly, appOrigin })).toBeNull()
    expect(checkRequest(ws("localhost:3210", { origin: appOrigin }), local({ appOrigin }))).toEqual({ kind: "origin", origin: appOrigin })
  })

  test("another kanna.sh machine's page is refused, token or no token", () => {
    const appOrigin = "https://mac.kanna.sh"
    for (const requestClass of ["untrusted", "proxied"] as const) {
      for (const origin of ["https://other.kanna.sh", "https://kanna.sh", "https://share.kanna.sh", "https://tun-m2.kanna.sh", "https://evil.example", "http://localhost:5173"]) {
        expect(checkRequest(ws("tun-m1.kanna.sh", { origin }), { requestClass, hosts: loopbackOnly, appOrigin })).toEqual({ kind: "origin", origin })
      }
    }
  })
})

describe("checkRequest: requests that change state", () => {
  const post = (host: string, headers: Record<string, string> = {}, method = "POST", path = "/api/cloud/pair-session") =>
    request(`http://${host}${path}`, { method, headers })

  test("reads pass whatever page asked: the browser keeps the answer from it", () => {
    const req = request("http://localhost:3210/api/cloud/pair-session", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })
    expect(checkRequest(req, local())).toBeNull()
  })

  test("the server's own page passes", () => {
    expect(checkRequest(post("localhost:3210", { origin: "http://localhost:3210", "sec-fetch-site": "same-origin" }), local())).toBeNull()
    // A LAN address is not a secure context, so the browser sends no Sec-Fetch-Site.
    expect(checkRequest(post("192.168.1.20:3210", { origin: "http://192.168.1.20:3210" }), local({ hosts: lan }))).toBeNull()
  })

  test("an app or a script, with neither header, passes", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(checkRequest(post("localhost:3210", {}, method), local())).toBeNull()
    }
  })

  test("another site's page is refused, pair-session included", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/api/cloud/pair-session", "/api/projects/p1/uploads", "/api/transcribe", "/auth/logout"]) {
        const req = post("localhost:3210", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, method, path)
        expect(checkRequest(req, local())).toEqual({ kind: "origin", origin: "https://evil.example" })
      }
    }
  })

  test("another port of localhost is another site here", () => {
    const req = post("localhost:3210", { origin: "http://localhost:5173", "sec-fetch-site": "same-site" })
    expect(checkRequest(req, local())).toEqual({ kind: "origin", origin: "http://localhost:5173" })
  })

  test("with no Origin, Sec-Fetch-Site answers", () => {
    expect(checkRequest(post("localhost:3210", { "sec-fetch-site": "cross-site" }), local())).toEqual({ kind: "cross-site", site: "cross-site" })
    expect(checkRequest(post("localhost:3210", { "sec-fetch-site": "same-site" }), local())).toEqual({ kind: "cross-site", site: "same-site" })
    expect(checkRequest(post("localhost:3210", { "sec-fetch-site": "same-origin" }), local())).toBeNull()
    expect(checkRequest(post("localhost:3210", { "sec-fetch-site": "none" }), local())).toBeNull()
  })

  test("through the kanna.sh proxy: the machine's page passes, another machine's does not", () => {
    const appOrigin = "https://mac.kanna.sh"
    const context = { requestClass: "proxied" as const, hosts: loopbackOnly, appOrigin }
    const own = post("tun-m1.kanna.sh", { origin: appOrigin, "sec-fetch-site": "same-origin", "x-forwarded-host": "mac.kanna.sh", "x-forwarded-proto": "https" }, "POST", "/api/projects/p1/uploads")
    expect(checkRequest(own, context)).toBeNull()
    // Same site as far as the cookie goes, so the proxy lets it through.
    const sibling = post("tun-m1.kanna.sh", { origin: "https://evil.kanna.sh", "sec-fetch-site": "same-site", "x-forwarded-host": "mac.kanna.sh", "x-forwarded-proto": "https" }, "POST", "/api/projects/p1/uploads")
    expect(checkRequest(sibling, context)).toEqual({ kind: "origin", origin: "https://evil.kanna.sh" })
    // The iOS app through kanna.sh sends neither header.
    expect(checkRequest(post("tun-m1.kanna.sh", {}, "POST", "/api/projects/p1/uploads"), context)).toBeNull()
  })
})

describe("refusals", () => {
  test("a refused host says what was refused and both ways to allow it", () => {
    const message = describeRefusal({ kind: "host", host: "mac.tailnet.ts.net" }, "~/.kanna/allowed-hosts")
    expect(message).toContain('"mac.tailnet.ts.net"')
    expect(message).toContain("--allow-host mac.tailnet.ts.net")
    expect(message).toContain("~/.kanna/allowed-hosts")
  })

  test("a refused origin names it and says what a proxy must pass", () => {
    const message = describeRefusal({ kind: "origin", origin: "https://kanna.example.com" }, "~/.kanna/allowed-hosts")
    expect(message).toContain("https://kanna.example.com")
    expect(message).toContain("X-Forwarded-Proto")
  })

  test("header values are printed back cleaned", () => {
    const message = describeRefusal({ kind: "origin", origin: 'https://x"><script>alert(1)</script>\n' }, "f")
    expect(message).not.toContain("<")
    expect(message).not.toContain(">")
    expect(describeRefusal({ kind: "host", host: null }, "f")).toContain("no usable Host header")
  })

  test("JSON for the API, plain text elsewhere, never sniffed", async () => {
    const api = refusalResponse({ kind: "host", host: "evil.example" }, "/api/cloud/pair-session", "f")
    expect(api.status).toBe(403)
    expect(api.headers.get("content-type")).toContain("application/json")
    expect(((await api.json()) as { error: string }).error).toContain("evil.example")
    const page = refusalResponse({ kind: "host", host: "evil.example" }, "/", "f")
    expect(page.status).toBe(403)
    expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("each distinct refusal is logged once, and only so many of them", () => {
    const lines: string[] = []
    const log = createRefusalLog((line) => lines.push(line), 2)
    log({ kind: "host", host: "evil.example" }, "f")
    log({ kind: "host", host: "evil.example" }, "f")
    log({ kind: "origin", origin: "https://evil.example" }, "f")
    log({ kind: "host", host: "third.example" }, "f")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("--allow-host evil.example")
    expect(lines[0]).not.toContain("\n")
  })
})

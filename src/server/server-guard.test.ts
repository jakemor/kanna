import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { PROXY_AUTH_HEADER } from "../shared/cloud-api"
import { createConnectTokenManager } from "./cloud/connect-token"
import type { CloudIdentity } from "./cloud/identity"
import type { CloudRuntime } from "./cloud"
import { getProjectUploadDir } from "./paths"
import { startTestServer } from "./__fixtures__/test-server"
import type { StartKannaServerOptions } from "./server"

/**
 * The request guard (request-guard.ts) as a client meets it: real sockets
 * against a real server, with the headers each kind of client sends. Raw
 * sockets, because `fetch` will not send a Host of the caller's choosing.
 */

// Each test boots a server or two, which on a busy machine outlasts the default five seconds.
setDefaultTimeout(30_000)

const PROXY_SECRET = "proxy-secret-for-guard-tests"
const IDENTITY: CloudIdentity = {
  controlUrl: "http://127.0.0.1:9/none",
  machineToken: "machine-token",
  proxySecret: PROXY_SECRET,
  subdomain: "mac",
  appOrigin: "https://mac.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
  enabled: true,
}
const TUNNEL = ["cf-connecting-ip: 203.0.113.9"]

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function start(port: number, options: Partial<StartKannaServerOptions> = {}) {
  const dataDir = await tempDir("kanna-guard-data-")
  const clientDistDir = await tempDir("kanna-guard-client-")
  await writeFile(path.join(clientDistDir, "index.html"), "<!doctype html><title>app</title>")
  const server = await startTestServer({ dataDir, clientDistDir, port, ...options })
  cleanups.push(() => server.stop())
  return server
}

function paired(): CloudRuntime {
  return { identity: IDENTITY, connectTokens: createConnectTokenManager(), start: () => {}, stop: async () => {} }
}

interface RawResponse {
  status: number
  headers: Map<string, string>
  body: string
}

function raw(port: number, lines: string[], body = ""): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1")
    let buffer = ""
    const finish = () => {
      socket.destroy()
      const [head = "", ...rest] = buffer.split("\r\n\r\n")
      const [statusLine = "", ...headerLines] = head.split("\r\n")
      const headers = new Map(headerLines.map((line) => {
        const colon = line.indexOf(":")
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const
      }))
      resolve({ status: Number(statusLine.split(" ")[1] ?? 0), headers, body: rest.join("\r\n\r\n") })
    }
    socket.on("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      const headEnd = buffer.indexOf("\r\n\r\n")
      if (headEnd === -1) return
      // A 101 never closes, and the server may hold the rest open a while:
      // done once the body the headers promised has arrived.
      const length = /^content-length:\s*(\d+)/im.exec(buffer.slice(0, headEnd))
      if (/^HTTP\/1\.1 101/.test(buffer) || (length && buffer.length - headEnd - 4 >= Number(length[1]))) finish()
    })
    socket.on("close", finish)
    socket.on("error", reject)
    setTimeout(finish, 4_000).unref()
  })
}

const upgrade = (port: number, host: string, extra: string[] = [], target = "/ws") => raw(port, [
  `GET ${target} HTTP/1.1`, `Host: ${host}`, "Upgrade: websocket", "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...extra,
])

const send = (port: number, method: string, host: string, target: string, extra: string[] = [], body = "") => raw(port, [
  `${method} ${target} HTTP/1.1`, `Host: ${host}`, "Connection: close", `Content-Length: ${Buffer.byteLength(body)}`, ...extra,
], body)

/** A socket opened the way a page does, then used: the ack proves commands run. */
async function socketWorks(port: number, headers: Record<string, string>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers } as unknown as string[])
  try {
    return await new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ v: 1, type: "command", id: "ping", command: { type: "system.ping" } })))
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: string; type?: string }
        if (message.id === "ping") resolve(message.type === "ack")
      })
      socket.addEventListener("error", () => resolve(false))
      socket.addEventListener("close", () => resolve(false))
    })
  } finally {
    socket.close()
  }
}

describe("an unpaired server", () => {
  test("its own page connects and runs commands, by either loopback name", async () => {
    const { port } = await start(4411)
    expect(await socketWorks(port, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(true)
    expect(await socketWorks(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).toBe(true)
    // An app, the CLI: no Origin at all.
    expect((await upgrade(port, `127.0.0.1:${port}`)).status).toBe(101)
  })

  test("a page on another site cannot open the socket", async () => {
    const { port } = await start(4412)
    for (const origin of ["https://evil.example", "http://localhost:5173", "null"]) {
      const response = await upgrade(port, `localhost:${port}`, [`Origin: ${origin}`])
      expect(response.status).toBe(403)
    }
    expect(await socketWorks(port, { host: `localhost:${port}`, origin: "https://evil.example" })).toBe(false)
  })

  test("a rebinding page's Host is refused on every route", async () => {
    const { port } = await start(4413)
    for (const target of ["/", "/health", "/api/cloud/pair-session", "/api/cloud/fleet", "/auth/status"]) {
      const response = await send(port, "GET", `evil.example:${port}`, target)
      expect(response.status).toBe(403)
      expect(response.body).toContain("evil.example")
      expect(response.body).toContain("--allow-host evil.example")
    }
    // Same-origin as far as the browser can tell, and still refused.
    expect((await upgrade(port, `evil.example:${port}`, [`Origin: http://evil.example:${port}`])).status).toBe(403)
    const pair = await send(port, "POST", `evil.example:${port}`, "/api/cloud/pair-session", [`Origin: http://evil.example:${port}`])
    expect(pair.status).toBe(403)
  })

  test("another site cannot change state; the server's own page and an app can", async () => {
    const { port } = await start(4414, { allowCloudPairing: false })
    const host = `localhost:${port}`
    for (const target of ["/api/cloud/pair-session", "/api/projects/p1/uploads", "/api/diagnostics/client", "/auth/logout"]) {
      expect((await send(port, "POST", host, target, ["Origin: https://evil.example", "Sec-Fetch-Site: cross-site"])).status).toBe(403)
      expect((await send(port, "POST", host, target, ["Origin: http://localhost:5173", "Sec-Fetch-Site: same-site"])).status).toBe(403)
      expect((await send(port, "POST", host, target, ["Sec-Fetch-Site: cross-site"])).status).toBe(403)
    }
    expect((await send(port, "DELETE", host, "/api/projects/p1/uploads/x.png", ["Origin: https://evil.example"])).status).toBe(403)
    expect((await send(port, "PUT", host, "/api/chats/c1/media/visualization-a.html/heights", ["Origin: https://evil.example"])).status).toBe(403)

    // The page itself, and the iOS app (no Origin, no Sec-Fetch-Site): past the guard, answered by the route.
    const own = await send(port, "POST", host, "/api/cloud/pair-session", [`Origin: http://${host}`, "Sec-Fetch-Site: same-origin"])
    expect(own.status).toBe(200)
    expect(own.body).toContain("unsupported")
    expect((await send(port, "POST", host, "/api/projects/p1/uploads")).status).toBe(404)
    expect((await send(port, "POST", host, "/auth/logout", [`Origin: http://${host}`])).status).toBe(200)
  })

  test("a private DNS name is refused with the way to allow it, and answered once allowed", async () => {
    const refusing = await start(4415)
    const refused = await send(refusing.port, "GET", "mac.tailnet.ts.net:4415", "/")
    expect(refused.status).toBe(403)
    expect(refused.body).toContain("--allow-host mac.tailnet.ts.net")
    expect(refused.body).toContain("allowed-hosts")

    const allowing = await start(4416, { allowedHosts: ["mac.tailnet.ts.net"] })
    expect((await send(allowing.port, "GET", "mac.tailnet.ts.net:4416", "/")).status).toBe(200)
    expect((await upgrade(allowing.port, "mac.tailnet.ts.net:4416", ["Origin: http://mac.tailnet.ts.net:4416"])).status).toBe(101)
    // Behind a TLS proxy of the user's own (Tailscale Serve, Caddy).
    expect((await upgrade(allowing.port, "mac.tailnet.ts.net", ["Origin: https://mac.tailnet.ts.net", "X-Forwarded-Proto: https"])).status).toBe(101)
  })

  test("the allowed-hosts file allows a name for a server nobody passes flags to", async () => {
    const dataDir = await tempDir("kanna-guard-hosts-")
    const allowedHostsFile = path.join(dataDir, "allowed-hosts")
    await writeFile(allowedHostsFile, "# tailnet\nmac.tailnet.ts.net\n")
    const { port } = await start(4417, { machine: { allowedHostsFile } })
    expect((await send(port, "GET", "mac.tailnet.ts.net", "/")).status).toBe(200)
    expect((await send(port, "GET", "other.tailnet.ts.net", "/")).status).toBe(403)
  })

  test("reached by IP address, as --remote on a LAN or a tailnet is", async () => {
    const { port } = await start(4418)
    for (const address of ["192.168.1.20", "100.64.3.9", "[fe80::1]"]) {
      expect((await send(port, "GET", `${address}:${port}`, "/")).status).toBe(200)
      expect((await upgrade(port, `${address}:${port}`, [`Origin: http://${address}:${port}`])).status).toBe(101)
      // The iOS app in direct mode: no Origin on its socket or its uploads.
      expect((await upgrade(port, `${address}:${port}`)).status).toBe(101)
      expect((await send(port, "POST", `${address}:${port}`, "/api/projects/p1/uploads")).status).toBe(404)
    }
  })

  test("a share tunnel's hostname is answered once the server has learned it", async () => {
    const server = await start(4419, { trustProxy: true })
    const host = "random-words.trycloudflare.com"
    const viaTunnel = [...TUNNEL, "X-Forwarded-Proto: https"]
    expect((await send(server.port, "GET", host, "/", viaTunnel)).status).toBe(403)
    server.allowHost(`https://${host}`)
    expect((await send(server.port, "GET", host, "/", viaTunnel)).status).toBe(200)
    expect((await upgrade(server.port, host, [...viaTunnel, `Origin: https://${host}`])).status).toBe(101)
    expect((await upgrade(server.port, host, [...viaTunnel, "Origin: https://evil.example"])).status).toBe(403)
    expect((await send(server.port, "GET", "other.trycloudflare.com", "/", viaTunnel)).status).toBe(403)
  })

  test("a named tunnel, whose hostname is the user's own, is answered for what the tunnel forwards", async () => {
    const { port } = await start(4420, { trustProxy: true, tunnelHostUnknown: true })
    const viaTunnel = [...TUNNEL, "X-Forwarded-Proto: https"]
    expect((await send(port, "GET", "kanna.example.com", "/", viaTunnel)).status).toBe(200)
    expect((await upgrade(port, "kanna.example.com", [...viaTunnel, "Origin: https://kanna.example.com"])).status).toBe(101)
    // A rebinding page's socket and navigation carry no tunnel marker.
    expect((await upgrade(port, `evil.example:${port}`, [`Origin: http://evil.example:${port}`])).status).toBe(403)
    expect((await send(port, "GET", `evil.example:${port}`, "/")).status).toBe(403)
  })
})

describe("a paired server", () => {
  test("its local page still connects; another site's page and a rebinding page do not", async () => {
    const { port } = await start(4421, { cloud: paired(), trustProxy: true })
    expect(await socketWorks(port, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(true)
    expect((await upgrade(port, `localhost:${port}`, ["Origin: https://evil.example"])).status).toBe(403)
    expect((await upgrade(port, `localhost:${port}`, [`Origin: ${IDENTITY.appOrigin}`])).status).toBe(403)
    // Not a loopback Host: the tunnel guard's to refuse, as before.
    expect((await send(port, "GET", `evil.example:${port}`, "/api/cloud/pair-session")).status).toBe(404)
    expect((await upgrade(port, `evil.example:${port}`, [`Origin: http://evil.example:${port}`])).status).toBe(401)
    expect((await send(port, "POST", `localhost:${port}`, "/api/cloud/pair-session", ["Origin: https://evil.example"])).status).toBe(403)
  })

  test("the kanna.sh page: HTTP through the proxy, the socket straight to the tunnel with a token used once", async () => {
    const cloud = paired()
    const { port } = await start(4422, { cloud, trustProxy: true })
    const proxied = [...TUNNEL, `${PROXY_AUTH_HEADER}: ${PROXY_SECRET}`, "X-Forwarded-Host: mac.kanna.sh", "X-Forwarded-Proto: https"]

    const endpoint = await send(port, "GET", IDENTITY.tunnelHost, "/api/cloud/ws-endpoint", proxied)
    expect(endpoint.status).toBe(200)
    const { connectToken } = JSON.parse(endpoint.body) as { connectToken: string }

    const page = [...TUNNEL, `Origin: ${IDENTITY.appOrigin}`]
    expect((await upgrade(port, IDENTITY.tunnelHost, page, `/ws?token=${connectToken}`)).status).toBe(101)
    // The token rode in a URL; a second socket on it is someone else's.
    expect((await upgrade(port, IDENTITY.tunnelHost, page, `/ws?token=${connectToken}`)).status).toBe(401)

    // A page elsewhere holding a fresh token does not spend it, and gets nothing.
    const fresh = cloud.connectTokens.mint().token
    expect((await upgrade(port, IDENTITY.tunnelHost, [...TUNNEL, "Origin: https://other.kanna.sh"], `/ws?token=${fresh}`)).status).toBe(403)
    expect((await upgrade(port, IDENTITY.tunnelHost, [...TUNNEL, "Origin: http://localhost:5173"], `/ws?token=${fresh}`)).status).toBe(403)
    // The iOS app sends no Origin: the token is its credential.
    expect((await upgrade(port, IDENTITY.tunnelHost, TUNNEL, `/ws?token=${fresh}`)).status).toBe(101)

    // State changes through the proxy: the machine's page and the app pass, a sibling site does not.
    const own = await send(port, "POST", IDENTITY.tunnelHost, "/api/projects/p1/uploads", [...proxied, `Origin: ${IDENTITY.appOrigin}`, "Sec-Fetch-Site: same-origin"])
    expect(own.status).toBe(404)
    expect((await send(port, "POST", IDENTITY.tunnelHost, "/api/projects/p1/uploads", proxied)).status).toBe(404)
    const sibling = await send(port, "POST", IDENTITY.tunnelHost, "/api/projects/p1/uploads", [...proxied, "Origin: https://evil.kanna.sh", "Sec-Fetch-Site: same-site"])
    expect(sibling.status).toBe(403)
    expect((await upgrade(port, IDENTITY.tunnelHost, [...proxied, "Origin: https://evil.example"])).status).toBe(403)
  })
})

describe("files from a project and its uploads", () => {
  async function projectServer(port: number) {
    const outside = await tempDir("kanna-guard-outside-")
    const projectDir = path.join(outside, "project")
    await mkdir(projectDir)
    const server = await start(port)
    const project = await server.store.openProject(projectDir, "Project")
    const get = (target: string) => send(server.port, "GET", `localhost:${server.port}`, target)
    return { server, outside, projectDir, project, get }
  }

  const SCRIPTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'

  test("a file that could run script is a sandboxed download, from either route", async () => {
    const { projectDir, project, get } = await projectServer(4423)
    const uploads = getProjectUploadDir(projectDir)
    await mkdir(uploads, { recursive: true })
    const files: Array<[string, string]> = [["x.svg", SCRIPTED_SVG], ["x.htm", "<script>alert(1)</script>"], ["x.xhtml", "<html xmlns='http://www.w3.org/1999/xhtml'/>"], ["x.bin", "?"]]
    for (const [name, content] of files) {
      await writeFile(path.join(projectDir, name), content)
      await writeFile(path.join(uploads, name), content)
      for (const target of [`/api/projects/${project.id}/files/${name}/content`, `/api/projects/${project.id}/uploads/${name}/content`]) {
        const response = await get(target)
        expect(response.status).toBe(200)
        // Still the file, for an <img> or a fetch.
        expect(response.body).toBe(content)
        expect(response.headers.get("x-content-type-options")).toBe("nosniff")
        expect(response.headers.get("content-security-policy")).toStartWith("sandbox;")
        expect(response.headers.get("content-disposition")).toBe("attachment")
      }
    }
  })

  test("images, video, audio and PDFs are shown as they are; text is shown in a sandbox", async () => {
    const { projectDir, project, get } = await projectServer(4424)
    for (const [name, type] of [["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.mp4", "video/mp4"], ["a.mp3", "audio/mpeg"], ["a.pdf", "application/pdf"]]) {
      await writeFile(path.join(projectDir, name!), "bytes")
      const response = await get(`/api/projects/${project.id}/files/${name}/content`)
      expect(response.headers.get("content-type")).toBe(type!)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.has("content-security-policy")).toBe(false)
      // Bun names the file here itself (`filename="a.png"`), which saves nothing.
      expect(response.headers.get("content-disposition") ?? "").not.toContain("attachment")
    }
    for (const name of ["a.ts", "a.html", "a.md", "a.json", "a.txt", "a.csv"]) {
      await writeFile(path.join(projectDir, name), "text")
      const response = await get(`/api/projects/${project.id}/files/${name}/content`)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("content-security-policy")).toStartWith("sandbox;")
      // Not an attachment: "Open in new tab" still shows it.
      expect(response.headers.get("content-disposition") ?? "").not.toContain("attachment")
      expect(response.headers.get("content-type")).not.toContain("html")
    }
  })

  test("a symlink out of the project is not followed; one inside it is", async () => {
    const { outside, projectDir, project, get } = await projectServer(4425)
    await writeFile(path.join(outside, "secret.txt"), "OUTSIDE")
    await writeFile(path.join(projectDir, "real.txt"), "INSIDE")
    await mkdir(path.join(outside, "elsewhere"))
    await writeFile(path.join(outside, "elsewhere", "deep.txt"), "OUTSIDE")
    await symlink(path.join(outside, "secret.txt"), path.join(projectDir, "out.txt"))
    await symlink(path.join(outside, "elsewhere"), path.join(projectDir, "outdir"))
    await symlink(path.join(projectDir, "real.txt"), path.join(projectDir, "in.txt"))

    const escaped = await get(`/api/projects/${project.id}/files/out.txt/content`)
    expect(escaped.status).toBe(400)
    expect(escaped.body).not.toContain("OUTSIDE")
    const escapedDir = await get(`/api/projects/${project.id}/files/${encodeURIComponent("outdir/deep.txt")}/content`)
    expect(escapedDir.status).toBe(400)
    expect(escapedDir.body).not.toContain("OUTSIDE")

    expect((await get(`/api/projects/${project.id}/files/in.txt/content`)).body).toBe("INSIDE")
    expect((await get(`/api/projects/${project.id}/files/real.txt/content`)).body).toBe("INSIDE")
    expect((await get(`/api/projects/${project.id}/files/missing.txt/content`)).status).toBe(404)
  })

  test("a project that is itself reached through a symlink still serves its files", async () => {
    const outside = await tempDir("kanna-guard-linked-")
    const real = path.join(outside, "real-project")
    await mkdir(real)
    await writeFile(path.join(real, "note.txt"), "LINKED")
    await symlink(real, path.join(outside, "link-project"))
    const server = await start(4426)
    const project = await server.store.openProject(path.join(outside, "link-project"), "Linked")
    const response = await send(server.port, "GET", `localhost:${server.port}`, `/api/projects/${project.id}/files/note.txt/content`)
    expect(response.status).toBe(200)
    expect(response.body).toBe("LINKED")
  })
})

describe("password login", () => {
  test("wrong guesses are slowed per address, and the tunnel's visitor is the address", async () => {
    const host = "x.trycloudflare.com"
    const server = await start(4427, { password: "hunter2", trustProxy: true })
    // What the CLI does when the tunnel comes up.
    server.allowHost(`https://${host}`)
    const attempt = (password: string, visitor: string) => send(server.port, "POST", host, "/auth/login", [
      `cf-connecting-ip: ${visitor}`, "X-Forwarded-Proto: https", `Origin: https://${host}`, "Content-Type: application/json",
    ], JSON.stringify({ password }))

    const statuses = new Map<number, number>()
    for (let index = 0; index < 300; index += 1) {
      const { status } = await attempt(`guess-${index}`, "203.0.113.9")
      statuses.set(status, (statuses.get(status) ?? 0) + 1)
    }
    // Five looked at, then one more each time a wait runs out; the rest refused unread.
    expect(statuses.get(401)).toBeGreaterThanOrEqual(5)
    expect(statuses.get(401)).toBeLessThan(12)
    expect(statuses.get(429)).toBeGreaterThan(288)

    const blocked = await attempt("hunter2", "203.0.113.9")
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    // The owner, at another address, is not slowed by it.
    const owner = await attempt("hunter2", "198.51.100.7")
    expect(owner.status).toBe(200)
    expect(owner.headers.get("set-cookie")).toContain("kanna_session=")
  })
})

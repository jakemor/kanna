import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { startKannaServer } from "./server"

test("backup API inherits password authentication and validates trusted-proxy origins", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-backup-server-"))
  const server = await startKannaServer({ dataDir, port: 4380, host: "127.0.0.1", password: "backup-test-password", openBrowser: false, trustProxy: true })
  const origin = `http://127.0.0.1:${server.port}`
  try {
    expect((await fetch(`${origin}/api/backups`)).status).toBe(401)
    const login = await fetch(`${origin}/auth/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password: "backup-test-password" }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!
    const status = await fetch(`${origin}/api/backups`, { headers: { Cookie: cookie } })
    expect(status.status).toBe(200)
    expect(status.headers.get("cache-control")).toBe("no-store")
    expect((await status.json()).connected).toBe(false)
    const csrf = await fetch(`${origin}/api/backups/disconnect`, { method: "POST", headers: { Cookie: cookie, Origin: "https://unrelated.example", "Content-Type": "application/json" }, body: "{}" })
    expect(csrf.status).toBe(403)
    const proxied = await fetch(`${origin}/api/backups/disconnect`, {
      method: "POST", headers: { Cookie: cookie, Origin: origin.replace("http:", "https:"), "X-Forwarded-Proto": "https", "Content-Type": "application/json" }, body: "{}",
    })
    expect(proxied.status).toBe(200)
  } finally {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("explicit HTTPS public origin retains its remote hostname and port without trusting proxy headers", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-public-origin-"))
  const publicOrigin = "https://kanna.example:8443"
  const server = await startKannaServer({ dataDir, port: 4381, host: "127.0.0.1", password: "test-password", openBrowser: false, publicOrigin })
  const origin = `http://127.0.0.1:${server.port}`
  try {
    const login = await fetch(`${origin}/auth/login`, {
      method: "POST", headers: { Origin: publicOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password" }),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie")).toContain("Secure")
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!
    for (const [requestOrigin, expected] of [[publicOrigin, 200], ["https://kanna.example:9999", 403], ["https://evil.example", 403]] as const) {
      const response = await fetch(`${origin}/api/backups/disconnect`, {
        method: "POST", headers: { Cookie: cookie, Origin: requestOrigin, "X-Forwarded-Proto": "https", "Content-Type": "application/json" }, body: "{}",
      })
      expect(response.status).toBe(expected)
    }
  } finally { await server.stop(); await rm(dataDir, { recursive: true, force: true }) }
})

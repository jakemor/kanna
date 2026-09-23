import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { R2BackupManager, cloudflareOAuthFromEnv } from "./r2-backup"
import { handleBackupRequest } from "./backup-routes"
import { restoreBackup } from "./restore-backup"
import type { BackupManifest } from "../shared/backup"

const directories: string[] = []
const managers: R2BackupManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const config = { accountId: "a".repeat(32), bucket: "history-backups", intervalMinutes: 15, enabled: false, apiToken: "secret-api-token" }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-backup-test-"))
  directories.push(root)
  const objects = new Map<string, Uint8Array>()
  const requests: { url: string; init?: RequestInit }[] = []
  let failure = false
  let content = Buffer.alloc(4 * 1024 * 1024 + 20, "x")
  let now = 1_800_000_000_000
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.includes("/oauth2/token")) return Response.json({ access_token: "oauth-secret", refresh_token: "rotated-refresh", expires_in: 3600 })
    if (init?.method === "PUT") {
      if (failure) return new Response(null, { status: 403 })
      const key = url.split("/objects/")[1]!
      objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer()))
    }
    return Response.json({ success: true })
  }) as typeof fetch
  const options = {
    directory: path.join(root, "state"), fetch: request, now: () => now,
    oauth: { clientId: "client", redirectUri: "https://kanna.example/settings/backups", scopes: "r2.write offline_access" },
    capture: async (destination: string) => {
      await mkdir(path.join(destination, "transcripts"), { recursive: true })
      await writeFile(path.join(destination, "snapshot.json"), '{"v":2,"projects":[],"chats":[]}')
      await writeFile(path.join(destination, "transcripts", "chat.jsonl"), content)
    },
  }
  const manager = new R2BackupManager(options)
  managers.push(manager)
  await manager.initialize(false)
  await manager.configure(config)
  return { root, manager, options, objects, requests, setFailure: (value: boolean) => { failure = value }, append: () => { content = Buffer.concat([content, Buffer.from("new turn")]) }, advance: (ms: number) => { now += ms } }
}

describe("R2 backups", () => {
  test("round trips files, uploads only changed chunks, and persists deduplication across restarts", async () => {
    const f = await fixture()
    await f.manager.run()
    const prefix = f.manager.status().prefix
    const firstLatest = f.objects.get(`${prefix}/latest.json`)!
    const firstChunks = f.requests.filter((request) => request.url.includes("/chunks/")).length
    expect(firstChunks).toBe(3)
    f.append()
    await f.manager.run()
    expect(f.requests.filter((request) => request.url.includes("/chunks/")).length).toBe(firstChunks + 1)
    const restarted = new R2BackupManager(f.options)
    managers.push(restarted)
    await restarted.initialize(false)
    await restarted.run()
    expect(f.requests.filter((request) => request.url.includes("/chunks/")).length).toBe(firstChunks + 1)
    expect([...f.objects.keys()].filter((key) => key.includes("/snapshots/"))).toHaveLength(3)
    const downloaded = path.join(f.root, "download")
    for (const [key, bytes] of f.objects) {
      const local = path.join(downloaded, key.slice(prefix.length + 1))
      await mkdir(path.dirname(local), { recursive: true })
      await writeFile(local, bytes)
    }
    const destination = path.join(f.root, "restore")
    await restoreBackup(downloaded, destination)
    expect((await readFile(path.join(destination, "transcripts/chat.jsonl"))).subarray(-8).toString()).toBe("new turn")
    await expect(restoreBackup(downloaded, destination)).rejects.toThrow()
    // Old snapshots still reconstruct the complete pre-append history.
    await writeFile(path.join(downloaded, "old.json"), firstLatest)
    await restoreBackup(downloaded, path.join(f.root, "old-restore"), path.join(downloaded, "old.json"))
    expect((await stat(path.join(f.root, "old-restore/transcripts/chat.jsonl"))).size).toBe(4 * 1024 * 1024 + 20)
    expect((await stat(path.join(f.options.directory, "state.json"))).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(restarted.status())).not.toContain("secret-api-token")
  })

  test("failed uploads do not advance the committed backup; failures retry and clear", async () => {
    const f = await fixture()
    await f.manager.run()
    const success = f.manager.status().lastSuccessAt
    const previous = f.objects.get(`${f.manager.status().prefix}/latest.json`)
    f.advance(1000)
    f.append()
    f.setFailure(true)
    await expect(f.manager.run()).rejects.toThrow("403")
    expect(f.manager.status().lastSuccessAt).toBe(success)
    expect(f.objects.get(`${f.manager.status().prefix}/latest.json`)).toEqual(previous)
    expect((await readdir(f.options.directory)).some((name) => name.startsWith("staging-"))).toBe(false)
    f.setFailure(false)
    await f.manager.run()
    expect(f.manager.status().error).toBeNull()
    expect(f.manager.status().lastSuccessAt).toBeGreaterThan(success!)
  })

  test("OAuth uses PKCE and browser-bound expiring single-use state, and rotates tokens", async () => {
    const f = await fixture()
    const started = f.manager.beginOAuth("https://kanna.example")
    const url = new URL(started.url)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    await expect(f.manager.completeOAuth("code", url.searchParams.get("state")!, "wrong-browser")).rejects.toThrow("browser")
    await f.manager.completeOAuth("code", url.searchParams.get("state")!, started.browser)
    await expect(f.manager.completeOAuth("code", url.searchParams.get("state")!, started.browser)).rejects.toThrow()
    expect(f.manager.status().authMethod).toBe("oauth")
    f.advance(3_600_000)
    await f.manager.run()
    const exchanges = f.requests.filter((request) => request.url.includes("/oauth2/token"))
    expect(exchanges).toHaveLength(2)
    expect(String(exchanges[1]!.init!.body)).toContain("grant_type=refresh_token")
    expect(String(exchanges[1]!.init!.body)).toContain("refresh_token=rotated-refresh")
    expect(JSON.stringify(f.manager.status())).not.toContain("oauth-secret")
    const expired = f.manager.beginOAuth()
    f.advance(11 * 60_000)
    await expect(f.manager.completeOAuth("code", new URL(expired.url).searchParams.get("state")!, expired.browser)).rejects.toThrow("expired")
  })

  test("overlapping OAuth flows keep separate states and browser cookies", async () => {
    const f = await fixture()
    const start = async () => {
      const response = await handleBackupRequest(new Request("https://kanna.example/api/backups/oauth/start", {
        method: "POST", headers: { Origin: "https://kanna.example", "Content-Type": "application/json" }, body: "{}",
      }), f.manager)
      const { url } = await response!.json() as { url: string }
      return { state: new URL(url).searchParams.get("state")!, cookie: response!.headers.get("set-cookie")!.split(";")[0]! }
    }
    const first = await start()
    const second = await start()
    expect(first.cookie.split("=")[0]).not.toBe(second.cookie.split("=")[0])
    const complete = (state: string, cookie: string) => handleBackupRequest(new Request("https://kanna.example/api/backups/oauth/complete", {
      method: "POST", headers: { Origin: "https://kanna.example", "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ code: "code", state }),
    }), f.manager)
    expect((await complete(first.state, second.cookie))!.status).toBe(400)
    const cookies = `${first.cookie}; ${second.cookie}`
    expect((await complete(first.state, cookies))!.status).toBe(200)
    expect((await complete(second.state, cookies))!.status).toBe(200)
    expect((await complete(first.state, cookies))!.status).toBe(400)
    const abandoned = await start()
    await f.manager.disconnect()
    expect((await complete(abandoned.state, abandoned.cookie))!.status).toBe(400)
  })

  test("destination changes re-upload chunks and disconnect stops scheduling", async () => {
    const f = await fixture()
    await f.manager.run()
    await f.manager.configure({ ...config, bucket: "another-bucket" })
    await f.manager.run()
    expect(f.requests.filter((request) => request.url.includes("another-bucket/objects/") && request.url.includes("/chunks/"))).toHaveLength(3)
    await f.manager.disconnect()
    f.advance(60 * 60_000)
    const count = f.requests.length
    await f.manager.tick()
    expect(f.requests).toHaveLength(count)
    expect(f.manager.status().connected).toBe(false)
  })

  test("routes reject cross-origin mutations and never return credentials", async () => {
    const f = await fixture()
    const response = await handleBackupRequest(new Request("https://kanna.example/api/backups"), f.manager)
    expect(await response!.text()).not.toContain("secret-api-token")
    for (const origin of [null, "https://evil.example"]) {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (origin) headers.Origin = origin
      const rejected = await handleBackupRequest(new Request("https://kanna.example/api/backups/disconnect", { method: "POST", headers, body: "{}" }), f.manager)
      expect(rejected!.status).toBe(403)
    }
    const started = await handleBackupRequest(new Request("https://kanna.example/api/backups/oauth/start", {
      method: "POST", headers: { Origin: "https://kanna.example", "Content-Type": "application/json" }, body: "{}",
    }), f.manager)
    expect(started!.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax")
    expect(started!.headers.get("set-cookie")).toContain("Secure")
  })

  test("restore rejects unsafe paths and corrupt chunks", async () => {
    const f = await fixture()
    const source = path.join(f.root, "malicious")
    await mkdir(source)
    await writeFile(path.join(source, "latest.json"), JSON.stringify({ version: 1, createdAt: 0, files: { "../escape": { size: 0, chunks: [] } } }))
    await expect(restoreBackup(source, path.join(f.root, "bad-restore"))).rejects.toThrow("path")
    await f.manager.run()
    const prefix = f.manager.status().prefix
    const manifest = JSON.parse(Buffer.from(f.objects.get(`${prefix}/latest.json`)!).toString()) as BackupManifest
    await writeFile(path.join(source, "latest.json"), JSON.stringify(manifest))
    await mkdir(path.join(source, "chunks"))
    for (const [key, bytes] of f.objects) if (key.includes("/chunks/")) await writeFile(path.join(source, "chunks", path.basename(key)), bytes)
    const hash = manifest.files["snapshot.json"]!.chunks[0]!
    await writeFile(path.join(source, "chunks", `${hash}.gz`), "corrupt")
    await expect(restoreBackup(source, path.join(f.root, "bad-restore"))).rejects.toThrow()
    expect(await Bun.file(path.join(f.root, "bad-restore/snapshot.json")).exists()).toBe(false)
  })

  test("scheduled runs survive restart, skip until due, and do not overlap", async () => {
    const f = await fixture()
    await f.manager.configure({ ...config, enabled: true })
    while (f.manager.status().running) await Bun.sleep(1)
    expect(f.manager.status().lastSuccessAt).not.toBeNull()
    const initial = f.requests.length
    await f.manager.tick()
    expect(f.requests).toHaveLength(initial)
    const restarted = new R2BackupManager(f.options)
    managers.push(restarted)
    await restarted.initialize(false)
    f.advance(16 * 60_000)
    await restarted.tick()
    expect(f.requests.length).toBeGreaterThan(initial)
    const run = restarted.run()
    expect(() => restarted.run()).toThrow("already running")
    await restarted.tick()
    await run
    // Pausing an existing destination does not depend on Cloudflare being reachable.
    const count = f.requests.length
    await restarted.configure({ ...config, apiToken: undefined, enabled: false })
    expect(f.requests).toHaveLength(count)
  })

  test("bad saved configuration disables backups without preventing chat startup", async () => {
    const f = await fixture()
    await writeFile(path.join(f.options.directory, "state.json"), "broken json")
    const restarted = new R2BackupManager(f.options)
    managers.push(restarted)
    await restarted.initialize(false)
    expect(restarted.status().enabled).toBe(false)
    expect(restarted.status().connected).toBe(false)
    expect(restarted.status().error).toContain("could not be read")
    expect(await readFile(path.join(f.options.directory, "state.json"), "utf8")).toBe("broken json")
  })

  test("CLI connection persists no token and refreshes credentials for each backup", async () => {
    const f = await fixture()
    let tokenReads = 0
    const wrangler = {
      accounts: async () => [{ id: config.accountId, name: "Personal" }],
      token: async () => { tokenReads++; return "cli-secret" },
      invalidate: () => {},
    }
    const manager = new R2BackupManager({ ...f.options, wrangler })
    managers.push(manager)
    await manager.initialize(false)
    const connected = await manager.connectWrangler()
    expect(connected.status.authMethod).toBe("wrangler")
    expect(connected.accounts).toEqual([{ id: config.accountId, name: "Personal" }])
    await manager.configure({ ...config, apiToken: undefined })
    const saved = await readFile(path.join(f.options.directory, "state.json"), "utf8")
    expect(saved).not.toContain("cli-secret")
    expect(saved).not.toContain("secret-api-token")
    expect(JSON.parse(saved).credential).toEqual({ method: "wrangler" })
    await manager.run()
    const firstReads = tokenReads
    const restarted = new R2BackupManager({ ...f.options, wrangler })
    managers.push(restarted)
    await restarted.initialize(false)
    expect(restarted.status().authMethod).toBe("wrangler")
    await restarted.run()
    expect(tokenReads).toBeGreaterThan(firstReads)
    expect(f.requests.filter((request) => request.init?.method === "PUT").every((request) => new Headers(request.init!.headers).get("authorization") === "Bearer cli-secret")).toBe(true)
  })

  test("CLI bucket discovery follows cursors, filters jurisdiction, and retries an expired token", async () => {
    const f = await fixture()
    let invalidations = 0
    let attempts = 0
    const wrangler = {
      accounts: async () => [{ id: config.accountId, name: "Personal" }],
      token: async () => "cli-secret",
      invalidate: () => { invalidations++ },
    }
    const manager = new R2BackupManager({ ...f.options, wrangler, fetch: (async (input: unknown) => {
      attempts++
      if (attempts === 1) return new Response(null, { status: 401 })
      if (!String(input).includes("cursor=")) return Response.json({ success: true, result: { buckets: [{ name: "z-bucket" }, { name: "eu-bucket", jurisdiction: "eu" }] }, result_info: { cursor: "next/page" } })
      expect(String(input)).toContain("cursor=next%2Fpage")
      return Response.json({ success: true, result: { buckets: [{ name: "a-bucket", jurisdiction: "default" }] } })
    }) as typeof fetch })
    managers.push(manager)
    await manager.initialize(false)
    await manager.connectWrangler()
    expect(await manager.listBuckets(config.accountId)).toEqual([{ name: "a-bucket" }, { name: "z-bucket" }])
    expect(attempts).toBe(3)
    expect(invalidations).toBe(2)
  })

  test("transient socket failures retry the same object and complete the backup", async () => {
    const f = await fixture()
    let interrupted = false
    const manager = new R2BackupManager({ ...f.options, fetch: (async (input, init) => {
      if (init?.method === "PUT" && !interrupted) {
        interrupted = true
        throw new Error("socket closed unexpectedly")
      }
      return f.options.fetch(input, init)
    }) as typeof fetch })
    managers.push(manager)
    await manager.initialize(false)
    await manager.run()
    expect(interrupted).toBe(true)
    expect(manager.status().lastSuccessAt).not.toBeNull()
  })

  test("failed first backup checkpoints completed chunks for a restart", async () => {
    const f = await fixture()
    let chunkAttempts = 0
    const interrupted = new R2BackupManager({ ...f.options, fetch: (async (input, init) => {
      if (String(input).includes("/chunks/") && ++chunkAttempts === 2) return new Response(null, { status: 403 })
      return f.options.fetch(input, init)
    }) as typeof fetch })
    managers.push(interrupted)
    await interrupted.initialize(false)
    await expect(interrupted.run()).rejects.toThrow("403")
    expect(interrupted.status().lastSuccessAt).toBeNull()
    expect(f.objects.has(`${interrupted.status().prefix}/latest.json`)).toBe(false)
    const saved = JSON.parse(await readFile(path.join(f.options.directory, "state.json"), "utf8"))
    expect(saved.chunks).toHaveLength(1)
    const restarted = new R2BackupManager(f.options)
    managers.push(restarted)
    await restarted.initialize(false)
    await restarted.run()
    expect(f.requests.filter((request) => request.url.includes("/chunks/"))).toHaveLength(3)
    expect(restarted.status().lastSuccessAt).not.toBeNull()
  })

  test("OAuth configuration requires a secure, fixed browser callback", () => {
    expect(cloudflareOAuthFromEnv({})).toBeUndefined()
    expect(() => cloudflareOAuthFromEnv({ KANNA_CF_OAUTH_CLIENT_ID: "x", KANNA_CF_OAUTH_REDIRECT_URI: "http://remote.example/settings/backups", KANNA_CF_OAUTH_SCOPES: "r2.write" })).toThrow("HTTPS")
  })
})

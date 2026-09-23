import { WranglerBackupAuth, type BackupWrangler } from "./backup-wrangler"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { z } from "zod"
import type { BackupConfig, BackupManifest, BackupStatus } from "../shared/backup"

const API = "https://api.cloudflare.com/client/v4"
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token"
const CHUNK_SIZE = 4 * 1024 * 1024
export const backupConfigSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/i, "Enter a 32-character Cloudflare account ID"),
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Enter a valid R2 bucket name"),
  intervalMinutes: z.number().int().min(15).max(10080),
  enabled: z.boolean(),
  apiToken: z.string().trim().min(1).max(4096).optional(),
})

type Credential = { method: "wrangler" } | { method: "oauth" | "token"; accessToken: string; refreshToken?: string; expiresAt?: number }
interface SavedState {
  version: 1
  installationId: string
  config: BackupConfig
  credential?: Credential
  lastSuccessAt: number | null
  nextRunAt: number | null
  error: string | null
  files: number
  uploadedBytes: number
  chunks: string[]
}
interface OAuthConfig { clientId: string; redirectUri: string; scopes: string; clientSecret?: string }
interface PendingOAuth { state: string; verifier: string; browser: string; expiresAt: number }
export interface BackupOptions {
  directory: string
  capture: (destination: string) => Promise<void>
  fetch?: typeof fetch
  oauth?: OAuthConfig
  now?: () => number
  wrangler?: BackupWrangler
}

export class R2BackupManager {
  private state: SavedState = {
    version: 1, installationId: randomUUID(),
    config: { accountId: "", bucket: "", intervalMinutes: 60, enabled: false },
    lastSuccessAt: null, nextRunAt: null, error: null, files: 0, uploadedBytes: 0, chunks: [],
  }
  private timer?: ReturnType<typeof setInterval>
  private task: Promise<void> | null = null
  private busy = false
  private stopped = false
  private readonly abort = new AbortController()
  private pending = new Map<string, PendingOAuth>()
  private readonly wrangler: BackupWrangler
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly statePath: string

  constructor(private options: BackupOptions) {
    this.wrangler = options.wrangler ?? new WranglerBackupAuth(options.directory)
    this.request = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.statePath = path.join(options.directory, "state.json")
  }

  async initialize(schedule = true) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    await chmod(this.options.directory, 0o700)
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8")) as SavedState
      if (saved.version !== 1 || !/^[a-f0-9-]{36}$/.test(saved.installationId) || !Array.isArray(saved.chunks)
        || !saved.chunks.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid backup state")
      if (saved.config.accountId) saved.config = backupConfigSchema.omit({ apiToken: true }).parse(saved.config)
      else if (saved.config.enabled) throw new Error("Invalid backup configuration")
      if (saved.credential && saved.credential.method !== "wrangler" && (!['oauth', 'token'].includes(saved.credential.method) || typeof saved.credential.accessToken !== "string")) throw new Error("Invalid backup credentials")
      this.state = saved
      await chmod(this.statePath, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await this.save()
      else {
        // Leave the unreadable file untouched and keep chat serving available.
        this.state.config.enabled = false
        this.state.credential = undefined
        this.state.error = "Backup settings could not be read. Reconnect Cloudflare and save the destination again."
      }
    }
    // Incomplete staging directories are local scratch space, never committed backups.
    for (const name of await readdir(this.options.directory)) {
      if (name.startsWith("staging-")) await rm(path.join(this.options.directory, name), { recursive: true, force: true })
    }
    if (schedule) {
      this.timer = setInterval(() => { void this.tick() }, 30_000)
      this.timer.unref()
      void this.tick()
    }
  }

  status(): BackupStatus {
    return {
      accountId: this.state.config.accountId, bucket: this.state.config.bucket,
      intervalMinutes: this.state.config.intervalMinutes, enabled: this.state.config.enabled,
      connected: Boolean(this.state.credential),
      authMethod: this.state.credential?.method ?? null, oauthAvailable: Boolean(this.options.oauth),
      running: Boolean(this.task), lastSuccessAt: this.state.lastSuccessAt,
      nextRunAt: this.state.config.enabled ? this.state.nextRunAt : null,
      error: this.state.error, files: this.state.files, uploadedBytes: this.state.uploadedBytes,
      prefix: `kanna/${this.state.installationId}`,
    }
  }

  private async save() {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 })
      await rename(temporary, this.statePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private assertIdle() {
    if (this.task || this.busy) throw new Error("A backup operation is already running. Try again when it finishes.")
    if (this.stopped) throw new Error("Backups are shutting down")
  }

  async configure(input: unknown) {
    this.assertIdle()
    const { apiToken, ...config } = backupConfigSchema.parse(input)
    if (config.enabled && !apiToken && !this.state.credential) throw new Error("Connect Cloudflare first")
    this.busy = true
    const previous = structuredClone(this.state)
    try {
      if (apiToken) this.state.credential = { method: "token", accessToken: apiToken }
      if (config.accountId !== previous.config.accountId || config.bucket !== previous.config.bucket) {
        this.state.chunks = []
        this.state.lastSuccessAt = null
        this.state.files = 0
        this.state.uploadedBytes = 0
      }
      this.state.config = config
      // Verify the exact bucket before enabling a schedule; never create a public bucket.
      if (this.state.credential && (config.enabled || apiToken || config.accountId !== previous.config.accountId || config.bucket !== previous.config.bucket)) await this.api(`/accounts/${config.accountId}/r2/buckets/${config.bucket}`)
      this.state.error = null
      this.state.nextRunAt = config.enabled ? this.now() : null
      await this.save()
    } catch (error) {
      // Preserve a rotated refresh token even if bucket validation failed.
      const credential = this.state.credential
      this.state = previous
      if (!apiToken && credential?.method === "oauth") this.state.credential = credential
      await this.save()
      throw error
    } finally { this.busy = false }
    void this.tick()
    return this.status()
  }

  async connectWrangler() {
    this.assertIdle()
    this.busy = true
    const previous = this.state.credential
    try {
      const accounts = await this.wrangler.accounts()
      this.wrangler.invalidate()
      await this.wrangler.token()
      this.state.credential = { method: "wrangler" }
      this.state.error = null
      await this.save()
      return { status: this.status(), accounts }
    } catch (error) { this.state.credential = previous; throw error }
    finally { this.busy = false }
  }

  async wranglerAccounts() {
    if (this.state.credential?.method !== "wrangler") throw new Error("Connect Cloudflare CLI first")
    return this.wrangler.accounts()
  }

  async listBuckets(accountId: string) {
    z.string().regex(/^[a-f0-9]{32}$/i).parse(accountId)
    this.assertIdle()
    this.busy = true
    try {
      const buckets: Array<{ name: string }> = []
      const cursors = new Set<string>()
      let cursor = ""
      do {
        const page = await this.api(`/accounts/${accountId}/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        const parsed = z.object({ result: z.object({ buckets: z.array(z.object({ name: z.string(), jurisdiction: z.string().optional() })) }), result_info: z.object({ cursor: z.string().optional() }).optional() }).parse(page)
        buckets.push(...parsed.result.buckets.filter((bucket) => !bucket.jurisdiction || bucket.jurisdiction === "default").map(({ name }) => ({ name })))
        cursor = parsed.result_info?.cursor ?? ""
        if (cursor && cursors.has(cursor)) throw new Error("Cloudflare returned a repeated bucket page. Try again.")
        cursors.add(cursor)
      } while (cursor)
      return buckets.sort((a, b) => a.name.localeCompare(b.name))
    } finally { this.busy = false }
  }

  async disconnect() {
    this.assertIdle()
    this.busy = true
    try {
      this.state.credential = undefined
      this.wrangler.invalidate()
      this.pending.clear()
      this.state.config.enabled = false
      this.state.nextRunAt = null
      this.state.error = null
      await this.save()
    } finally { this.busy = false }
    return this.status()
  }

  beginOAuth(origin?: string) {
    this.assertIdle()
    const config = this.options.oauth
    if (!config) throw new Error("Cloudflare OAuth is not configured on this Kanna server")
    if (origin && new URL(config.redirectUri).origin !== origin) throw new Error("Cloudflare sign-in must start from the configured OAuth redirect origin")
    const verifier = randomBytes(32).toString("base64url")
    for (const [state, flow] of this.pending) if (flow.expiresAt <= this.now()) this.pending.delete(state)
    if (this.pending.size >= 32) throw new Error("Cloudflare sign-in has too many pending attempts. Try again in ten minutes.")
    const pending = { verifier, state: randomBytes(32).toString("base64url"), browser: randomBytes(32).toString("base64url"), expiresAt: this.now() + 10 * 60_000 }
    this.pending.set(pending.state, pending)
    const url = new URL("https://dash.cloudflare.com/oauth2/auth")
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
      scope: config.scopes, state: pending.state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString()
    return { url: url.toString(), browser: pending.browser }
  }

  async completeOAuth(code: string, state: string, browser: string) {
    this.assertIdle()
    const pending = this.pending.get(state)
    if (!pending || pending.expiresAt < this.now() || pending.state !== state || pending.browser !== browser) {
      throw new Error("Cloudflare sign-in expired or did not originate in this browser. Connect again.")
    }
    this.pending.delete(state)
    this.busy = true
    try {
      this.state.credential = await this.exchange({
        grant_type: "authorization_code", code, redirect_uri: this.options.oauth!.redirectUri, code_verifier: pending.verifier,
      })
      this.state.error = null
      await this.save()
    } finally { this.busy = false }
    return this.status()
  }

  private async exchange(params: Record<string, string>, previousRefresh?: string): Promise<Credential> {
    const config = this.options.oauth
    if (!config) throw new Error("Cloudflare OAuth configuration is missing. Reconnect Cloudflare.")
    const response = await this.request(TOKEN_URL, {
      method: "POST", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }),
    })
    if (!response.ok) throw new Error(`Cloudflare sign-in failed (${response.status}). Reconnect Cloudflare.`)
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (typeof token.access_token !== "string" || !token.access_token || !Number.isFinite(token.expires_in) || Number(token.expires_in) <= 0) throw new Error("Cloudflare returned an invalid token response")
    const refreshToken = token.refresh_token ?? previousRefresh
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("Cloudflare did not grant offline access. Enable refresh tokens on the OAuth client and reconnect.")
    return { method: "oauth", accessToken: token.access_token, refreshToken, expiresAt: this.now() + Number(token.expires_in) * 1000 }
  }

  private async token() {
    let credential = this.state.credential
    if (!credential) throw new Error("Connect Cloudflare first")
    if (credential.method === "wrangler") return this.wrangler.token()
    if (credential.method === "oauth" && (credential.expiresAt ?? 0) < this.now() + 60_000) {
      if (!credential.refreshToken) throw new Error("Reconnect Cloudflare to resume backups")
      credential = await this.exchange({ grant_type: "refresh_token", refresh_token: credential.refreshToken }, credential.refreshToken)
      this.state.credential = credential
      // Persist rotated credentials before making any storage requests.
      await this.save()
    }
    if (credential.method === "wrangler") return this.wrangler.token()
    return credential.accessToken
  }

  private async api(route: string, body?: Uint8Array) {
    // Bound each request and retry transient failures without exposing response bodies or tokens.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.abort.signal.throwIfAborted()
      const token = await this.token()
      let response: Response
      try {
        response = await this.request(`${API}${route}`, {
          method: body ? "PUT" : "GET", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)]),
          headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
          body: body ? new Blob([new Uint8Array(body)]) : undefined,
        })
      } catch {
        this.abort.signal.throwIfAborted()
        if (attempt === 2) throw new Error("Cloudflare R2 connection was interrupted. The backup will retry automatically.")
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
        continue
      }
      if (response.ok) {
        let result: { success?: boolean }
        try { result = await response.json() as { success?: boolean } }
        catch {
          this.abort.signal.throwIfAborted()
          if (attempt === 2) throw new Error("Cloudflare R2 response was interrupted. The backup will retry automatically.")
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
          continue
        }
        if (!result || result.success !== true) throw new Error("Cloudflare R2 rejected the request. Check R2 permissions.")
        return result
      }
      await response.body?.cancel()
      if (response.status === 401 && this.state.credential?.method === "wrangler" && attempt === 0) {
        this.wrangler.invalidate()
        continue
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"))
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(1000 * 2 ** attempt, retryAfter * 1000 || 0))))
        continue
      }
      throw new Error(`Cloudflare R2 request failed (${response.status}). Check the account, bucket and R2 permissions.`)
    }
  }

  private async put(key: string, body: Uint8Array) {
    const { accountId, bucket } = this.state.config
    const objectKey = `${this.status().prefix}/${key}`.split("/").map(encodeURIComponent).join("/")
    await this.api(`/accounts/${accountId}/r2/buckets/${bucket}/objects/${objectKey}`, body)
  }

  async tick() {
    if (this.stopped || this.task || this.busy || !this.state.config.enabled || !this.state.credential) return
    if ((this.state.nextRunAt ?? 0) > this.now()) return
    await this.run().catch(() => undefined)
  }

  run(): Promise<void> {
    this.assertIdle()
    if (!this.state.credential || !this.state.config.accountId || !this.state.config.bucket) throw new Error("Connect Cloudflare and save an R2 destination first")
    this.task = this.performBackup().finally(() => { this.task = null })
    return this.task
  }

  private async performBackup() {
    let staging: string | undefined
    const knownChunks = new Set(this.state.chunks)
    try {
      if (this.state.credential?.method === "wrangler") this.wrangler.invalidate()
      await this.token()
      staging = await mkdtemp(path.join(this.options.directory, "staging-"))
      await this.options.capture(staging)
      const manifest: BackupManifest = { version: 1, createdAt: this.now(), files: {} }
      let uploadedBytes = 0
      const visit = async (directory: string, relative = "") => {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          this.abort.signal.throwIfAborted()
          const filePath = path.join(directory, entry.name)
          const name = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory()) { await visit(filePath, name); continue }
          if (!entry.isFile()) throw new Error("Backup staging contains an unsupported file")
          const handle = await open(filePath, "r")
          const file = { size: 0, chunks: [] as string[] }
          try {
            const buffer = Buffer.alloc(CHUNK_SIZE)
            while (true) {
              this.abort.signal.throwIfAborted()
              // A short read is not EOF: fill each fixed-size chunk before hashing.
              let count = 0
              while (count < buffer.length) {
                const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null)
                if (!bytesRead) break
                count += bytesRead
              }
              if (!count) break
              const bytes = buffer.subarray(0, count)
              const hash = createHash("sha256").update(bytes).digest("hex")
              file.chunks.push(hash)
              file.size += count
              if (!knownChunks.has(hash)) {
                const compressed = gzipSync(bytes)
                await this.put(`chunks/${hash}.gz`, compressed)
                knownChunks.add(hash)
                uploadedBytes += compressed.byteLength
              }
            }
          } finally { await handle.close() }
          manifest.files[name] = file
        }
      }
      await visit(staging)
      const bytes = Buffer.from(JSON.stringify(manifest))
      const key = `snapshots/${new Date(manifest.createdAt).toISOString().replaceAll(":", "-")}-${randomUUID()}.json`
      // Publish only after every chunk succeeds. Old snapshots and deleted chats remain recoverable.
      await this.put(key, bytes)
      await this.put("latest.json", bytes)
      this.state.chunks = [...knownChunks]
      this.state.lastSuccessAt = this.now()
      this.state.files = Object.keys(manifest.files).length
      this.state.uploadedBytes = uploadedBytes + bytes.byteLength * 2
      this.state.error = null
      this.state.nextRunAt = this.now() + this.state.config.intervalMinutes * 60_000
      await this.save()
    } catch (error) {
      // Keep confirmed uploads so retrying a large initial backup resumes its progress.
      this.state.chunks = [...knownChunks]
      // Do not persist arbitrary network exception strings, which can contain URLs/credentials.
      this.state.error = error instanceof Error && /^(Cloudflare|Reconnect|Connect |Backup )/.test(error.message)
        ? error.message : "Backup failed. Check network connectivity, local disk space and file access, then retry."
      this.state.nextRunAt = this.now() + Math.min(this.state.config.intervalMinutes * 60_000, 5 * 60_000)
      await this.save()
      throw new Error(this.state.error)
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true })
    }
  }

  async stop() {
    this.stopped = true
    this.abort.abort()
    if (this.timer) clearInterval(this.timer)
    await this.task?.catch(() => undefined)
  }
}

export function cloudflareOAuthFromEnv(env = process.env): OAuthConfig | undefined {
  const clientId = env.KANNA_CF_OAUTH_CLIENT_ID
  const redirectUri = env.KANNA_CF_OAUTH_REDIRECT_URI
  const scopes = env.KANNA_CF_OAUTH_SCOPES
  if (!clientId || !redirectUri || !scopes) return undefined
  const url = new URL(redirectUri)
  if (url.pathname !== "/settings/backups" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("Cloudflare OAuth redirect URI must be HTTPS /settings/backups (HTTP allowed only on localhost)")
  }
  return { clientId, redirectUri, scopes: [...new Set([...scopes.split(/\s+/), "offline_access"])].join(" "), clientSecret: env.KANNA_CF_OAUTH_CLIENT_SECRET }
}

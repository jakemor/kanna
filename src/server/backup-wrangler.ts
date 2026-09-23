import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"

const execute = promisify(execFile)
const accountSchema = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/i), name: z.string() })
export type CloudflareAccount = z.infer<typeof accountSchema>
export interface BackupWrangler {
  accounts(): Promise<CloudflareAccount[]>
  token(): Promise<string>
  invalidate(): void
}

/** Use Wrangler's supported commands; its credential storage and refresh remain its responsibility. */
export class WranglerBackupAuth implements BackupWrangler {
  private cached?: { token: string; until: number }
  private pending?: Promise<string>
  constructor(private directory: string, private run: (args: string[]) => Promise<string> = async (args) => {
    try {
      const { stdout } = await execute("wrangler", args, {
        cwd: this.directory, timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", BROWSER: "none" },
      })
      return stdout
    } catch {
      // execFile errors include stdout/stderr, which may contain credentials. Never propagate them.
      throw new Error("Cloudflare CLI unavailable or signed out. Install Wrangler and sign in on the Kanna machine, then try again.")
    }
  }) {}

  async accounts() {
    try {
      const result = z.object({ loggedIn: z.literal(true), accounts: z.array(accountSchema) }).parse(JSON.parse(await this.run(["whoami", "--json"])))
      if (!result.accounts.length) throw new Error("No accounts")
      return result.accounts
    } catch {
      throw new Error("Cloudflare CLI could not list accounts. Run wrangler login on the Kanna machine and try again.")
    }
  }

  invalidate() { this.cached = undefined }

  async token() {
    if (this.cached && this.cached.until > Date.now()) return this.cached.token
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const result = z.object({ type: z.string(), token: z.string().min(1) }).parse(JSON.parse(await this.run(["auth", "token", "--json"])))
        this.cached = { token: result.token, until: Date.now() + 5 * 60_000 }
        return result.token
      } catch {
        throw new Error("Cloudflare CLI could not provide a token. Sign in with Wrangler on the Kanna machine and reconnect.")
      }
    })()
    try { return await this.pending } finally { this.pending = undefined }
  }
}

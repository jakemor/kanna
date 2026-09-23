import { z } from "zod"
import { R2BackupManager } from "./r2-backup"

const PREFIX = "/api/backups"
const COOKIE = "kanna_backup_oauth"

/** Mount after Kanna's existing password/cloud authentication gate. */
export async function handleBackupRequest(req: Request, manager: R2BackupManager, expectedOrigin = new URL(req.url).origin): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null
  const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(value, {
    status, headers: { "Cache-Control": "no-store", ...extra },
  })
  if (req.method === "GET" && url.pathname === PREFIX) return json(manager.status())
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  // Same-origin JSON requests only, including when password auth is disabled.
  if (req.headers.get("origin") !== expectedOrigin || !req.headers.get("content-type")?.startsWith("application/json")) {
    return json({ error: "Forbidden" }, 403)
  }
  try {
    if (url.pathname === `${PREFIX}/wrangler/connect`) return json(await manager.connectWrangler())
    if (url.pathname === `${PREFIX}/wrangler/accounts`) return json({ accounts: await manager.wranglerAccounts() })
    if (url.pathname === `${PREFIX}/buckets`) {
      const { accountId } = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/i) }).parse(await req.json())
      return json({ buckets: await manager.listBuckets(accountId) })
    }
    if (url.pathname === PREFIX) return json(await manager.configure(await req.json()))
    if (url.pathname === `${PREFIX}/run`) {
      const task = manager.run()
      void task.catch(() => undefined)
      return json(manager.status(), 202)
    }
    if (url.pathname === `${PREFIX}/disconnect`) return json(await manager.disconnect())
    if (url.pathname === `${PREFIX}/oauth/start`) {
      const { url: authorizationUrl, browser } = manager.beginOAuth(expectedOrigin)
      const secure = expectedOrigin.startsWith("https:") ? "; Secure" : ""
      return json({ url: authorizationUrl }, 200, {
        "Set-Cookie": `${COOKIE}_${new URL(authorizationUrl).searchParams.get("state")}=${browser}; HttpOnly; SameSite=Lax; Path=/api/backups; Max-Age=600${secure}`,
      })
    }
    if (url.pathname === `${PREFIX}/oauth/complete`) {
      const input = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256) }).parse(await req.json())
      const cookie = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}_${input.state}=`))?.slice(COOKIE.length + input.state.length + 2) ?? ""
      return json(await manager.completeOAuth(input.code, input.state, cookie), 200, {
        "Set-Cookie": `${COOKIE}_${input.state}=; HttpOnly; SameSite=Lax; Path=/api/backups; Max-Age=0`,
      })
    }
    return json({ error: "Not found" }, 404)
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: error.issues.map((issue) => issue.message).join(". ") }, 400)
    if (error instanceof SyntaxError) return json({ error: "Invalid JSON" }, 400)
    const message = error instanceof Error ? error.message : "Backup operation failed"
    // Only intentional, safe errors reach the UI; filesystem/network exceptions remain private.
    return json({ error: /^(Cloudflare|Connect |Reconnect|A backup|Backups|Backup |Enter )/.test(message) ? message : "Backup operation failed. Check the server configuration and try again." }, 400)
  }
}

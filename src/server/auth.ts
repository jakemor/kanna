import { randomBytes, timingSafeEqual } from "node:crypto"
import { APP_NAME } from "../shared/branding"

const SESSION_COOKIE_NAME = "kanna_session"

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

export interface AuthManager {
  readonly enabled: true
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  createSessionCookie(req: Request): string
  clearSessionCookie(req: Request): string
  verifyPassword(candidate: string): boolean
  handleLogin(req: Request, nextPath: string): Promise<Response>
  handleLogout(req: Request): Response
  handleStatus(req: Request): Response
  renderLoginPage(req: Request): Response
  unauthorizedResponse(req: Request): Response
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const segment of header.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    cookies.set(key, decodeURIComponent(value))
  }

  return cookies
}

function sanitizeNextPath(nextPath: string | null | undefined) {
  if (!nextPath || typeof nextPath !== "string") return "/"
  if (!nextPath.startsWith("/")) return "/"
  if (nextPath.startsWith("//")) return "/"
  if (nextPath.startsWith("/auth/login")) return "/"
  return nextPath
}

function forwardedProto(req: Request): "http" | "https" | null {
  const xfp = req.headers.get("x-forwarded-proto")
  if (!xfp) return null
  const value = xfp.split(",")[0]?.trim().toLowerCase()
  return value === "http" || value === "https" ? value : null
}

function effectiveOrigin(req: Request, trustProxy: boolean): string {
  const url = new URL(req.url)
  if (!trustProxy) return url.origin
  const proto = forwardedProto(req)
  const scheme = proto ?? url.protocol.replace(":", "")
  return `${scheme}://${url.host}`
}

function shouldUseSecureCookie(req: Request, trustProxy: boolean) {
  if (trustProxy) {
    const proto = forwardedProto(req)
    if (proto) return proto === "https"
  }
  return new URL(req.url).protocol === "https:"
}

function buildCookie(name: string, value: string, req: Request, trustProxy: boolean, extras: string[] = []) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ]

  if (shouldUseSecureCookie(req, trustProxy)) {
    parts.push("Secure")
  }

  parts.push(...extras)
  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = await req.json() as { password?: unknown; next?: unknown }
    return {
      password: typeof payload.password === "string" ? payload.password : "",
      nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
      wantsJson: true,
    }
  }

  const formData = await req.formData()
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
    wantsJson: false,
  }
}

function requestWantsHtml(req: Request) {
  const accept = req.headers.get("accept") ?? ""
  return accept.includes("text/html")
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
}

export interface AuthManagerOptions {
  /**
   * When true, the auth layer trusts X-Forwarded-Proto to decide whether the
   * public origin is http or https. The hostname always comes from the Host
   * header (never X-Forwarded-Host) because X-Forwarded-Host is passed
   * through by some tunnels unmodified and would otherwise allow open
   * redirects.
   * Enable only when the server is reachable solely through a trusted reverse
   * proxy such as cloudflared.
   */
  trustProxy?: boolean
}

export function createAuthManager(password: string, options: AuthManagerOptions = {}): AuthManager {
  const sessions = new Set<string>()
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false

  function getSessionToken(req: Request) {
    return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE_NAME) ?? null
  }

  function isAuthenticated(req: Request) {
    const sessionToken = getSessionToken(req)
    return Boolean(sessionToken && sessions.has(sessionToken))
  }

  function validateOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (!origin) return true
    if (origin === new URL(req.url).origin) return true
    if (!trustProxy) return false
    return origin === effectiveOrigin(req, trustProxy)
  }

  function createSessionCookie(req: Request) {
    const sessionToken = randomBytes(32).toString("base64url")
    sessions.add(sessionToken)
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req, trustProxy)
  }

  function clearSessionCookie(req: Request) {
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      sessions.delete(sessionToken)
    }
    return buildCookie(SESSION_COOKIE_NAME, "", req, trustProxy, ["Max-Age=0"])
  }

  function verifyPassword(candidate: string) {
    const actual = Buffer.from(candidate)
    if (actual.length !== expectedPassword.length) {
      return false
    }
    return timingSafeEqual(actual, expectedPassword)
  }

  function handleStatus(req: Request) {
    return Response.json({
      enabled: true,
      authenticated: isAuthenticated(req),
    } satisfies AuthStatusPayload)
  }

  function unauthorizedResponse(req: Request) {
    if (req.method === "GET" && requestWantsHtml(req)) {
      const url = new URL(req.url)
      const loginUrl = new URL("/auth/login", effectiveOrigin(req, trustProxy))
      loginUrl.searchParams.set("next", sanitizeNextPath(`${url.pathname}${url.search}`))
      return Response.redirect(loginUrl, 302)
    }

    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  function renderLoginPage(req: Request) {
    if (isAuthenticated(req)) {
      const currentUrl = new URL(req.url)
      return Response.redirect(new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), effectiveOrigin(req, trustProxy)), 302)
    }

    const currentUrl = new URL(req.url)
    const nextPath = sanitizeNextPath(currentUrl.searchParams.get("next"))
    const showError = currentUrl.searchParams.get("error") === "1"
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(APP_NAME)} Login</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background:
          radial-gradient(circle at top, rgba(255,255,255,0.10), transparent 28%),
          linear-gradient(160deg, #16181d 0%, #0b0d10 55%, #050608 100%);
        color: #f4f7fb;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(420px, 100%);
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(12, 15, 20, 0.88);
        backdrop-filter: blur(10px);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 70px rgba(0,0,0,0.35);
      }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 20px; color: #a6b0bd; line-height: 1.5; }
      label { display: block; font-size: 13px; margin-bottom: 8px; color: #d7dce4; }
      input {
        width: 100%;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.04);
        color: inherit;
        padding: 14px 16px;
        font-size: 15px;
        margin-bottom: 16px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 14px;
        padding: 14px 16px;
        background: linear-gradient(135deg, #f4ede0 0%, #d9c4a1 100%);
        color: #16181d;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
      }
      .error {
        margin-bottom: 16px;
        border-radius: 14px;
        background: rgba(255, 106, 106, 0.12);
        border: 1px solid rgba(255, 106, 106, 0.24);
        color: #ffb8b8;
        padding: 12px 14px;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <form class="card" method="post" action="/auth/login">
      <h1>${escapeHtml(APP_NAME)}</h1>
      <p>This server is password protected. Enter the launch password to continue.</p>
      ${showError ? '<div class="error">Incorrect password. Try again.</div>' : ""}
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Unlock</button>
    </form>
  </body>
</html>`
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    })
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const { password: candidate, nextPath, wantsJson } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      if (wantsJson) {
        return Response.json({ error: "Invalid password" }, { status: 401 })
      }

      const redirectUrl = new URL("/auth/login", effectiveOrigin(req, trustProxy))
      redirectUrl.searchParams.set("error", "1")
      redirectUrl.searchParams.set("next", sanitizeNextPath(nextPath || fallbackNextPath))
      return Response.redirect(redirectUrl, 302)
    }

    const response = wantsJson
      ? Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })
      : Response.redirect(new URL(sanitizeNextPath(nextPath || fallbackNextPath), effectiveOrigin(req, trustProxy)), 302)

    response.headers.set("Set-Cookie", createSessionCookie(req))
    return response
  }

  function handleLogout(req: Request) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const response = Response.json({ ok: true })
    response.headers.set("Set-Cookie", clearSessionCookie(req))
    return response
  }

  return {
    enabled: true,
    isAuthenticated,
    validateOrigin,
    createSessionCookie,
    clearSessionCookie,
    verifyPassword,
    handleLogin,
    handleLogout,
    handleStatus,
    renderLoginPage,
    unauthorizedResponse,
  }
}

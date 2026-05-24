import { randomBytes, timingSafeEqual } from "node:crypto"
import type { AuthSessionStore } from "./auth-session-store.adapter"

const SESSION_COOKIE_NAME = "kanna_session"
const TOUCH_THROTTLE_MS = 60 * 1000

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

export interface AuthManager {
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  handleLogin(req: Request, nextPath: string): Promise<Response>
  handleLogout(req: Request): Response
  handleStatus(req: Request): Response
  dispose(): Promise<void>
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

function buildCookie(
  name: string,
  value: string,
  req: Request,
  trustProxy: boolean,
  maxAgeSeconds: number,
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ]

  if (shouldUseSecureCookie(req, trustProxy)) {
    parts.push("Secure")
  }

  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = await req.json() as { password?: unknown; next?: unknown }
    return {
      password: typeof payload.password === "string" ? payload.password : "",
      nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
    }
  }

  const formData = await req.formData()
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
  }
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
  sessionStore: AuthSessionStore
  getMaxAgeMs: () => number
}

export function isPublicSharePath(url: string): boolean {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url
  }
  return pathname.startsWith("/share/")
    || pathname === "/share"
    || pathname.startsWith("/assets/share-view/")
}

export function createAuthManager(password: string, options: AuthManagerOptions): AuthManager {
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false
  const sessionStore = options.sessionStore
  const getMaxAgeMs = options.getMaxAgeMs
  const lastTouchedAt = new Map<string, number>()

  function getSessionToken(req: Request) {
    return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE_NAME) ?? null
  }

  function maybeTouchSession(token: string) {
    const now = Date.now()
    const last = lastTouchedAt.get(token)
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return
    lastTouchedAt.set(token, now)
    sessionStore.touch(token, getMaxAgeMs())
  }

  function isAuthenticated(req: Request) {
    const sessionToken = getSessionToken(req)
    if (!sessionToken) return false
    const session = sessionStore.validate(sessionToken)
    if (!session) {
      lastTouchedAt.delete(sessionToken)
      return false
    }
    maybeTouchSession(sessionToken)
    return true
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
    const maxAgeMs = getMaxAgeMs()
    sessionStore.create(sessionToken, maxAgeMs)
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req, trustProxy, Math.floor(maxAgeMs / 1000))
  }

  function clearSessionCookie(req: Request) {
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      sessionStore.revoke(sessionToken)
      lastTouchedAt.delete(sessionToken)
    }
    return buildCookie(SESSION_COOKIE_NAME, "", req, trustProxy, 0)
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

  function redirectToApp(req: Request) {
    const currentUrl = new URL(req.url)
    return Response.redirect(new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), effectiveOrigin(req, trustProxy)), 302)
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const { password: candidate, nextPath } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }

    const response = Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })

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

  async function dispose() {
    lastTouchedAt.clear()
    await sessionStore.dispose()
  }

  return {
    isAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
    dispose,
  }
}

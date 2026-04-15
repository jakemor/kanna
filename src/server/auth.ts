import { randomBytes, timingSafeEqual } from "node:crypto"


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

function shouldUseSecureCookie(req: Request) {
  return new URL(req.url).protocol === "https:"
}

function buildCookie(name: string, value: string, req: Request, extras: string[] = []) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ]

  if (shouldUseSecureCookie(req)) {
    parts.push("Secure")
  }

  parts.push(...extras)
  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const payload = await req.json() as { password?: unknown; next?: unknown }
  return {
    password: typeof payload.password === "string" ? payload.password : "",
    nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
  }
}

export function createAuthManager(password: string): AuthManager {
  const sessions = new Set<string>()
  const expectedPassword = Buffer.from(password)

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
    return origin === new URL(req.url).origin
  }

  function createSessionCookie(req: Request) {
    const sessionToken = randomBytes(32).toString("base64url")
    sessions.add(sessionToken)
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req)
  }

  function clearSessionCookie(req: Request) {
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      sessions.delete(sessionToken)
    }
    return buildCookie(SESSION_COOKIE_NAME, "", req, ["Max-Age=0"])
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

  function unauthorizedResponse(_req: Request) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
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
    unauthorizedResponse,
  }
}

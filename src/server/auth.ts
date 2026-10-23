import { randomBytes, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"

const SESSION_COOKIE_NAME = "kanna_session"

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

export interface AuthManager {
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  handleLogin(req: Request, nextPath: string): Effect.Effect<Response, LoginFormError>
  handleLogout(req: Request): Response
  handleStatus(req: Request): Response
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

/** The login body could not be read: not JSON, or not a form. Left to the server (a 500), as before. */
export class LoginFormError extends Schema.TaggedError<LoginFormError>()(
  "@kanna/server/auth/LoginFormError",
  {
    contentType: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** `value[key]` when `value` is an object, as JSON property access reads it. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

const readLoginForm = Effect.fn("Auth.readLoginForm")(function* (req: Request) {
  const contentType = req.headers.get("content-type") ?? ""
  const formError = (cause: unknown) => new LoginFormError({ contentType, cause })

  if (contentType.includes("application/json")) {
    const text = yield* Effect.tryPromise({ try: () => req.text(), catch: formError })
    const payload = yield* decodeJson(text).pipe(
      Effect.catchTag("SchemaError", (cause) => Effect.fail(formError(cause))),
    )
    const password = field(payload, "password")
    const next = field(payload, "next")
    return {
      password: typeof password === "string" ? password : "",
      nextPath: sanitizeNextPath(typeof next === "string" ? next : "/"),
    }
  }

  const formData = yield* Effect.tryPromise({ try: () => req.formData(), catch: formError })
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
  }
})

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

  function redirectToApp(req: Request) {
    const currentUrl = new URL(req.url)
    return Response.redirect(new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), effectiveOrigin(req, trustProxy)), 302)
  }

  const handleLogin = Effect.fn("Auth.handleLogin")(function* (req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const { password: candidate, nextPath } = yield* readLoginForm(req)
    if (!verifyPassword(candidate)) {
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }

    const response = Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })

    response.headers.set("Set-Cookie", createSessionCookie(req))
    return response
  })

  function handleLogout(req: Request) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const response = Response.json({ ok: true })
    response.headers.set("Set-Cookie", clearSessionCookie(req))
    return response
  }

  return {
    isAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
  }
}

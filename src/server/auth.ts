import { randomBytes, timingSafeEqual } from "node:crypto"

const SESSION_COOKIE_NAME = "kanna_session"

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

/**
 * Wrong guesses from one address, slowed down. The password is one the user
 * typed on a command line, often short, and without this a script tries
 * thousands a second.
 *
 * Counted per address, never for everyone at once: a shared lock would let
 * anyone who can reach the login keep the owner out of their own machine.
 * The first few misses cost nothing (a person mistypes), each one after
 * doubles the wait, and the wait stops at half a minute, which is the
 * longest the owner can be kept out by someone guessing from their address.
 * While an address waits its guesses are not looked at, so they tell it
 * nothing and do not lengthen the wait.
 */
const FREE_LOGIN_FAILURES = 5
const MAX_LOGIN_WAIT_MS = 30_000
/** A quiet quarter of an hour and the count starts over. */
const LOGIN_FAILURE_MEMORY_MS = 15 * 60_000
const MAX_TRACKED_LOGIN_CLIENTS = 10_000

/** One key per IPv4 address and per IPv6 /64, which is what one customer is handed. */
export function loginClientKey(address: string | null | undefined) {
  const lower = (address ?? "").trim().toLowerCase()
  if (!lower) return "unknown"
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return mapped[1]!
  if (!lower.includes(":")) return lower
  const [head = "", tail] = lower.split("::")
  const headGroups = head ? head.split(":") : []
  const tailGroups = tail ? tail.split(":") : []
  const filler = tail === undefined ? [] : new Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0")
  return `${[...headGroups, ...filler, ...tailGroups].slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`
}

export interface LoginThrottle {
  /** How long this client must still wait before a guess is looked at; 0 when it may try. */
  waitMs(client: string): number
  recordFailure(client: string): void
  recordSuccess(client: string): void
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const clients = new Map<string, { failures: number; blockedUntil: number; lastFailureAt: number }>()

  function current(client: string) {
    const entry = clients.get(client)
    if (entry && now() - entry.lastFailureAt >= LOGIN_FAILURE_MEMORY_MS) {
      clients.delete(client)
      return undefined
    }
    return entry
  }

  return {
    waitMs(client) {
      return Math.max(0, (current(client)?.blockedUntil ?? 0) - now())
    },
    recordFailure(client) {
      const failures = (current(client)?.failures ?? 0) + 1
      const wait = failures < FREE_LOGIN_FAILURES ? 0 : Math.min(1_000 * 2 ** (failures - FREE_LOGIN_FAILURES), MAX_LOGIN_WAIT_MS)
      // Re-inserted so the map stays oldest-first for the trim below.
      clients.delete(client)
      clients.set(client, { failures, blockedUntil: now() + wait, lastFailureAt: now() })
      if (clients.size > MAX_TRACKED_LOGIN_CLIENTS) {
        for (const key of clients.keys()) {
          if (clients.size <= MAX_TRACKED_LOGIN_CLIENTS) break
          clients.delete(key)
        }
      }
    },
    recordSuccess(client) {
      clients.delete(client)
    },
  }
}

export interface AuthManager {
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  /** `clientAddress` is who is guessing, for the wrong-password backoff. */
  handleLogin(req: Request, nextPath: string, clientAddress?: string | null): Promise<Response>
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
  now?: () => number
}

export function createAuthManager(password: string, options: AuthManagerOptions = {}): AuthManager {
  const sessions = new Set<string>()
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false
  const throttle = createLoginThrottle(options.now)

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

  async function handleLogin(req: Request, fallbackNextPath: string, clientAddress?: string | null) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const client = loginClientKey(clientAddress)
    const waitMs = throttle.waitMs(client)
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000)
      return Response.json(
        { error: `Too many wrong passwords. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, retryAfterSeconds: seconds },
        { status: 429, headers: { "Retry-After": String(seconds) } },
      )
    }

    const { password: candidate, nextPath } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      throttle.recordFailure(client)
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }
    throttle.recordSuccess(client)

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
    isAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
  }
}

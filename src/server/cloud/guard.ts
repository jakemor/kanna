/**
 * Request classification for a cloud-enabled machine.
 *
 * When the machine is paired, its Bun server is reachable two ways:
 *  - locally (the normal loopback browser), and
 *  - through the cloudflared quick tunnel — either forwarded by the kanna.sh
 *    proxy (which injects PROXY_AUTH_HEADER) or hit raw by whoever discovers
 *    the rotating trycloudflare URL.
 *
 * Raw tunnel traffic must see nothing but /health and the token-gated /ws
 * upgrade; everything else 404s so the tunnel URL leaks no surface.
 */

import { timingSafeEqual } from "node:crypto"
import { PROXY_AUTH_HEADER } from "../../shared/cloud-api"

export type CloudRequestClass = "proxied" | "local" | "untrusted"

function timingSafeStringEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) {
    return false
  }
  return timingSafeEqual(aBuffer, bBuffer)
}

function isLoopbackHost(hostHeader: string | null) {
  if (!hostHeader) return false
  let hostname = hostHeader.trim().toLowerCase()
  if (hostname.startsWith("[")) {
    const closing = hostname.indexOf("]")
    hostname = closing === -1 ? hostname : hostname.slice(0, closing + 1)
  } else {
    hostname = hostname.split(":")[0]
  }
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

export function classifyCloudRequest(req: Request, proxySecret: string): CloudRequestClass {
  const proxyAuth = req.headers.get(PROXY_AUTH_HEADER)
  if (proxyAuth && timingSafeStringEqual(proxyAuth, proxySecret)) {
    return "proxied"
  }

  // Tunnel traffic reaches the local port through the cloudflared connector,
  // so the remote address is useless — but the Host header survives: tunnel
  // requests carry the public tunnel hostname, local browsers a loopback
  // host. cloudflared also stamps cf-connecting-ip on everything it forwards.
  if (isLoopbackHost(req.headers.get("host")) && !req.headers.get("cf-connecting-ip")) {
    return "local"
  }

  return "untrusted"
}

export interface CloudWsUpgradeContext {
  appOrigin: string
  validateToken: (token: string) => boolean
}

/**
 * A cloud WebSocket upgrade arrives directly on the tunnel with a fresh
 * connect token minted through the proxied /api/cloud/ws-endpoint call.
 * Requires the token AND a sane Origin: the machine's public app origin
 * (the page lives on <sub>.kanna.sh), or none at all (non-browser clients —
 * the token is the credential). The server's request guard has already
 * checked the Origin by then (request-guard.ts); this one stays so the
 * token alone is never enough from a page elsewhere.
 */
export function isAllowedCloudWsUpgrade(req: Request, context: CloudWsUpgradeContext): boolean {
  const origin = req.headers.get("origin")
  if (origin && origin.toLowerCase() !== context.appOrigin.toLowerCase()) {
    return false
  }

  const token = new URL(req.url).searchParams.get("token")
  return Boolean(token) && context.validateToken(token!)
}

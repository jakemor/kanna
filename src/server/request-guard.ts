/**
 * The checks every request passes before any route sees it.
 *
 * The server runs shell commands for whoever can open its WebSocket, and a
 * browser will open one for any page that asks. A page on another site (or a
 * dev server on another localhost port) could connect to ws://localhost:3210
 * and drive the machine, and a page whose DNS name was re-pointed at this
 * machine (DNS rebinding) is same-origin with the server as far as the
 * browser can tell. Three rules close that:
 *
 *  - Host: a request treated as local must name the server by an address a
 *    rebinding page cannot have: a loopback name, an IP literal, or a name
 *    this machine is known by.
 *  - Origin on /ws: none (apps and scripts send none), the request's own
 *    origin, or the machine's kanna.sh address.
 *  - Origin on anything that changes state: the same, with Sec-Fetch-Site as
 *    the fallback where a browser sent no Origin.
 *
 * They bind browsers only. A program that can reach the port can send any
 * header it likes; who may reach the port is the bind address's, the
 * password's and the tunnel guard's job (cloud/guard.ts).
 */

import { isIPv4, isIPv6 } from "node:net"
import type { CloudRequestClass } from "./cloud/guard"

export const ALLOW_HOST_FLAG = "--allow-host"

/** Host header → lowercase name without the port, IPv6 kept in brackets. */
export function parseHostHeader(value: string | null): string | null {
  if (!value) return null
  let host = value.trim().toLowerCase()
  if (!host || /[\s/@?#\\]/.test(host)) return null
  if (host.startsWith("[")) {
    const closing = host.indexOf("]")
    if (closing === -1) return null
    const rest = host.slice(closing + 1)
    if (rest && !/^:\d+$/.test(rest)) return null
    return host.slice(0, closing + 1)
  }
  const colon = host.lastIndexOf(":")
  if (colon !== -1) {
    if (host.indexOf(":") !== colon || !/^\d*$/.test(host.slice(colon + 1))) return null
    host = host.slice(0, colon)
  }
  // "localhost." is localhost.
  if (host.endsWith(".")) host = host.slice(0, -1)
  return host || null
}

/**
 * An IP literal names an address, not a DNS record, so no one can re-point
 * it. Browsers turn every other spelling of one (`0x7f.1`, `2130706433`)
 * into dotted form before they send Host, and nothing else is accepted here.
 */
export function isIpLiteralHost(hostname: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return isIPv6(hostname.slice(1, -1))
  return isIPv4(hostname)
}

export function isLoopbackHostName(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || (isIPv4(hostname) && hostname.startsWith("127."))
}

export function isLoopbackBind(bindHost: string) {
  const host = bindHost.trim().toLowerCase()
  return host === "localhost" || host === "::1" || host === "[::1]" || (isIPv4(host) && host.startsWith("127."))
}

/** A name as a user would write it for {@link ALLOW_HOST_FLAG}: a bare host, or a URL or host:port to take it from. */
export function normalizeAllowedHost(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let host = trimmed
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).host
    } catch {
      return null
    }
  }
  const parsed = parseHostHeader(host.replace(/\/.*$/, ""))
  return parsed && /^[a-z\d.\-_[\]:]+$/.test(parsed) ? parsed : null
}

export interface HostAllowlist {
  allows(hostname: string): boolean
  /** A name learned after boot: a share tunnel's public hostname. */
  add(name: string): void
  /** Every name beyond the loopback ones and IP literals, for logs and tests. */
  names(): string[]
}

export interface HostAllowlistOptions {
  /** The address the server listens on. */
  bindHost: string
  /**
   * What this machine calls itself (its hostname, its Bonjour name). Counted
   * only when the server listens beyond loopback: nothing reaches a
   * loopback-only server by those names, so there they could only help
   * someone on the network who answers for them.
   */
  machineNames?: string[]
  /** {@link ALLOW_HOST_FLAG} values and the allowed-hosts file. */
  extra?: string[]
}

export function createHostAllowlist(options: HostAllowlistOptions): HostAllowlist {
  const names = new Set<string>()
  const add = (value: string) => {
    const name = normalizeAllowedHost(value)
    if (name && !isLoopbackHostName(name) && !isIpLiteralHost(name)) names.add(name)
  }
  if (!isLoopbackBind(options.bindHost)) {
    for (const name of options.machineNames ?? []) add(name)
    // `--host my-mac.lan` binds by name, and is then reached by it.
    add(options.bindHost)
  }
  /**
   * The machine's name on its tailnet, `<hostname>.<tailnet>.ts.net`, which
   * the server cannot look up but can recognize. Safe to take on sight where
   * a name under someone else's domain is not: Tailscale alone answers for
   * ts.net, and gives a name only the address of the device that holds it.
   */
  const machineLabels = [...names].filter((name) => !name.includes("."))
  const isOwnTailnetName = (hostname: string) => {
    const match = /^([a-z\d-]+)\.[a-z\d-]+\.ts\.net$/.exec(hostname)
    return match !== null && machineLabels.includes(match[1]!)
  }
  for (const name of options.extra ?? []) add(name)

  return {
    allows: (hostname) => isLoopbackHostName(hostname) || isIpLiteralHost(hostname) || names.has(hostname) || isOwnTailnetName(hostname),
    add,
    names: () => [...names],
  }
}

/**
 * The names a machine goes by on its network, from its hostname:
 * `Jakes-MacBook-Pro.local` is also reached as `jakes-macbook-pro` (a
 * tailnet's short name, a router's DNS) and the Bonjour name may differ from
 * the hostname a DHCP server handed out.
 */
export function machineHostNames(hostname: string, bonjourName?: string | null): string[] {
  const names = new Set<string>()
  for (const raw of [hostname, bonjourName]) {
    const name = raw?.trim().toLowerCase().replace(/\.$/, "")
    if (!name) continue
    names.add(name)
    const label = name.split(".")[0]!
    names.add(label)
    names.add(`${label}.local`)
  }
  return [...names]
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function forwardedProto(req: Request) {
  const value = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
  return value === "http" || value === "https" ? value : null
}

function originOf(scheme: string, host: string) {
  try {
    return new URL(`${scheme}://${host}`).origin
  } catch {
    return null
  }
}

/**
 * The origins a page served by this server can have, as this request shows
 * them. The host is the Host header's, or X-Forwarded-Host's for a proxy
 * that rewrote Host to its upstream.
 *
 * The scheme, behind the tunnel Kanna runs itself (`trustProxy`), is the one
 * X-Forwarded-Proto names, so a plain-http page of the same name (someone in
 * the middle of an unencrypted load) is not taken for the https one.
 * Otherwise a proxy of the user's own may sit in front and end TLS without
 * saying so, and https counts beside the request's own scheme.
 *
 * A browser sets none of these headers on a WebSocket handshake, and on a
 * fetch only for a page already same-origin with the server, so a page
 * elsewhere cannot use them to pass for one of ours.
 */
export function requestOwnOrigins(req: Request, trustProxy = false): Set<string> {
  const origins = new Set<string>()
  const own = new URL(req.url).protocol.replace(":", "")
  const schemes = trustProxy ? [forwardedProto(req) ?? own] : [own, "https"]
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")?.split(",")[0]]
  for (const host of hosts) {
    const trimmed = host?.trim()
    if (!trimmed) continue
    for (const scheme of schemes) {
      const origin = originOf(scheme, trimmed)
      if (origin) origins.add(origin)
    }
  }
  return origins
}

function normalizeOrigin(value: string) {
  try {
    const url = new URL(value)
    // "null" (a sandboxed frame, a file:// page) and non-web schemes have no origin of ours.
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null
  } catch {
    return null
  }
}

export type RequestRefusal =
  | { kind: "host"; host: string | null }
  | { kind: "origin"; origin: string }
  | { kind: "cross-site"; site: string }

export interface RequestGuardContext {
  requestClass: CloudRequestClass
  hosts: HostAllowlist
  /** The paired machine's kanna.sh address, where its page is served from. */
  appOrigin?: string | null
  /**
   * The server sits behind a Cloudflare tunnel whose hostname it has not
   * learned (`--cloudflared <token>`, a dev tunnel). A request cloudflared
   * forwarded is then taken under whatever Host it names. A rebinding page
   * can copy the marker on a fetch, but not on a WebSocket handshake or a
   * navigation, and device pairing is off in the modes that set this.
   */
  tunnelHostUnknown?: boolean
  /** Every request from outside comes through cloudflared, which names the scheme the visitor used. */
  trustProxy?: boolean
}

/** Null when the request may go on; otherwise why it may not. */
export function checkRequest(req: Request, context: RequestGuardContext): RequestRefusal | null {
  const { requestClass } = context
  const url = new URL(req.url)

  if (requestClass === "local") {
    const hostname = parseHostHeader(req.headers.get("host"))
    const viaTunnel = context.tunnelHostUnknown === true && Boolean(req.headers.get("cf-connecting-ip"))
    if (!hostname || (!context.hosts.allows(hostname) && !viaTunnel)) {
      return { kind: "host", host: hostname }
    }
  }

  const isSocket = url.pathname === "/ws"
  if (!isSocket && SAFE_METHODS.has(req.method)) return null

  const origin = req.headers.get("origin")
  if (origin !== null) {
    const normalized = normalizeOrigin(origin)
    if (normalized && requestOwnOrigins(req, context.trustProxy).has(normalized)) return null
    // The kanna.sh page: its HTTP comes through the proxy, and its socket
    // straight to the tunnel with a connect token. Never a local request.
    const appOrigin = requestClass === "local" ? null : normalizeOrigin(context.appOrigin ?? "")
    if (normalized && appOrigin && normalized === appOrigin) return null
    return { kind: "origin", origin }
  }

  // No Origin: an app, the CLI, curl. A browser that left it off still says
  // where the request came from. Not on /ws: the kanna.sh page's socket to
  // the tunnel host is same-site, and Origin has already answered for it.
  const site = isSocket ? null : req.headers.get("sec-fetch-site")?.trim().toLowerCase()
  if (site && site !== "same-origin" && site !== "none") return { kind: "cross-site", site }
  return null
}

/** Header values are the caller's: only what is safe to print back or log. */
function printable(value: string | null) {
  if (!value) return "(none)"
  const clean = value.replace(/[^\w.\-:[\]/]/g, "?")
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean
}

export function describeRefusal(refusal: RequestRefusal, allowedHostsFile: string): string {
  switch (refusal.kind) {
    case "host": {
      const host = printable(refusal.host)
      return [
        `Kanna refused this request: it was addressed to "${host}", which is not a name this server knows itself by.`,
        "A web page can point a DNS name at your machine to reach servers on it, so only localhost, IP addresses and this machine's own names are answered.",
        refusal.host
          ? `If "${host}" is your machine (a Tailscale or private DNS name, a reverse proxy's hostname), allow it: start Kanna with ${ALLOW_HOST_FLAG} ${host}, or add a line with ${host} to ${allowedHostsFile} and restart Kanna.`
          : "The request carried no usable Host header.",
      ].join("\n")
    }
    case "origin":
      return [
        `Kanna refused this request: it came from a page at "${printable(refusal.origin)}", which is not this server's own address.`,
        "If a reverse proxy sits in front of Kanna, have it pass the Host header through (nginx: proxy_set_header Host $host) and send X-Forwarded-Proto.",
      ].join("\n")
    case "cross-site":
      return `Kanna refused this request: it came from another site (Sec-Fetch-Site: ${printable(refusal.site)}).`
  }
}

/** One log line per distinct refusal, and few of them: the values are a stranger's. */
export function createRefusalLog(warn: (message: string) => void, limit = 20) {
  const seen = new Set<string>()
  return (refusal: RequestRefusal, allowedHostsFile: string) => {
    const key = JSON.stringify(refusal)
    if (seen.has(key) || seen.size >= limit) return
    seen.add(key)
    warn(describeRefusal(refusal, allowedHostsFile).split("\n").filter((line, index) => index !== 1).join(" "))
  }
}

export function refusalResponse(refusal: RequestRefusal, pathname: string, allowedHostsFile: string) {
  const message = describeRefusal(refusal, allowedHostsFile)
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  if (pathname.startsWith("/api/")) return Response.json({ error: message }, { status: 403, headers })
  return new Response(`${message}\n`, { status: 403, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } })
}

/** `<data root>/allowed-hosts`: one name per line, `#` starts a comment. */
export function parseAllowedHostsFile(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
}

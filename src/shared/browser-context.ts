export type BrowserAccessMode = "local" | "network"

export interface BrowserAccessContext {
  origin: string
  hostname: string
  mode: BrowserAccessMode
}
function normalizedHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
}

export function isLoopbackHostname(hostname: string) {
  const normalized = normalizedHostname(hostname)
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true
  }

  const ipv4 = normalized.split(".")
  return ipv4.length === 4
    && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(ipv4[0]) === 127
}

/**
 * Browser-provided, informational context. Keep it deliberately narrow: it
 * is copied into an agent prompt, so paths, credentials, query strings, and
 * fragments never survive normalization.
 */
export function parseBrowserAccessContext(value: string | undefined | null): BrowserAccessContext | null {
  if (!value || value.length > 2_048) return null

  try {
    const url = new URL(value)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null
    }

    return {
      origin: url.origin,
      hostname: url.hostname,
      mode: isLoopbackHostname(url.hostname) ? "local" : "network",
    }
  } catch {
    return null
  }
}

export function normalizeBrowserOrigin(value: string | undefined | null) {
  return parseBrowserAccessContext(value)?.origin
}

export function browserOriginFromWindow() {
  if (typeof window === "undefined") return undefined
  return normalizeBrowserOrigin(window.location.origin)
}

/**
 * Kanna discovers servers from its own machine as localhost URLs. When the UI
 * is being used over the network, localhost means the reader's device, not
 * the Kanna machine, so retain the server's protocol/port and swap only the
 * loopback hostname for the hostname used to reach Kanna.
 */
export function resolveUrlForBrowserHost(address: string, browserOrigin: string | undefined | null) {
  const context = parseBrowserAccessContext(browserOrigin)
  if (!context || context.mode === "local") return address

  try {
    const target = new URL(address)
    if (!isLoopbackHostname(target.hostname) && normalizedHostname(target.hostname) !== "0.0.0.0") {
      return address
    }
    target.hostname = context.hostname
    return target.toString().replace(/\/$/, "")
  } catch {
    return address
  }
}

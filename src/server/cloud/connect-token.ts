/**
 * Short-lived WebSocket connect tokens. Minted by /api/cloud/ws-endpoint for
 * proxied requests; validated on the /ws upgrade that arrives directly on
 * the tunnel. In-memory only — a machine restart invalidates them, and the
 * client just re-fetches the endpoint on reconnect.
 *
 * Each opens one socket. The token rides in the URL's query, where a log or
 * a proxy between the browser and the machine can keep it, and every client
 * asks for a new one before each connect, so a second use is someone else's.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"

export const CONNECT_TOKEN_TTL_MS = 60_000

export interface ConnectTokenManager {
  mint(): { token: string; expiresInMs: number }
  /** True once per token: a token that validates is spent. */
  validate(token: string): boolean
}

export interface ConnectTokenDeps {
  now?: () => number
  ttlMs?: number
}

export function createConnectTokenManager(deps: ConnectTokenDeps = {}): ConnectTokenManager {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? CONNECT_TOKEN_TTL_MS
  const tokens = new Map<string, number>()

  function sweep() {
    const current = now()
    for (const [token, expiresAt] of tokens) {
      if (expiresAt <= current) {
        tokens.delete(token)
      }
    }
  }

  return {
    mint() {
      sweep()
      const token = randomBytes(32).toString("base64url")
      tokens.set(token, now() + ttlMs)
      return { token, expiresInMs: ttlMs }
    },

    validate(candidate: string) {
      sweep()
      if (!candidate) return false
      const candidateBuffer = Buffer.from(candidate)
      // Compare against every live token timing-safely so a miss and a hit
      // cost the same per entry (the map stays tiny: 60s TTL).
      let matched: string | null = null
      for (const token of tokens.keys()) {
        const tokenBuffer = Buffer.from(token)
        if (
          tokenBuffer.length === candidateBuffer.length &&
          timingSafeEqual(tokenBuffer, candidateBuffer)
        ) {
          matched = token
        }
      }
      if (matched !== null) tokens.delete(matched)
      return matched !== null
    },
  }
}

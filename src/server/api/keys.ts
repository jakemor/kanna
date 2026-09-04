/**
 * API keys for the remote REST API (`kanna --api`).
 *
 * Keys arrive either inline (`--api-key=a,b,c`) or from a file
 * (`--api-key-file=path`, one key per line). Both forms end up as the same
 * flat list, which the verifier compares against in constant time.
 *
 * The API key is the *only* credential on these routes — a caller with a key
 * skips the `--password` session gate — so verification must not leak which
 * prefix of a candidate matched.
 */

import { timingSafeEqual } from "node:crypto"

/** Longest key we will accept, so a huge header can't be used to burn CPU. */
const MAX_KEY_LENGTH = 512

function isUsableKey(value: string) {
  return value.length > 0 && value.length <= MAX_KEY_LENGTH
}

function dedupe(keys: string[]) {
  return [...new Set(keys)]
}

/**
 * `--api-key=a,b,c` — comma separated. Whitespace around each key is trimmed,
 * so `--api-key="a, b"` works as typed.
 */
export function parseApiKeyList(value: string): string[] {
  return dedupe(
    value
      .split(",")
      .map((key) => key.trim())
      .filter(isUsableKey)
  )
}

/**
 * `--api-key-file` contents — one key per line. Blank lines are skipped and so
 * are `#` comments, so a key file can be annotated with who each key is for.
 * Handles CRLF, since a key file may well be edited on another machine.
 */
export function parseApiKeyFile(contents: string): string[] {
  return dedupe(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#"))
      .filter(isUsableKey)
  )
}

export async function readApiKeyFile(filePath: string): Promise<string[]> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new Error(`API key file not found: ${filePath}`)
  }
  return parseApiKeyFile(await file.text())
}

/**
 * Compare without leaking length or content through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, so both sides are hashed to a
 * fixed 32 bytes first. That also bounds the comparison cost for a candidate
 * of any length.
 */
function constantTimeEquals(a: string, b: string) {
  const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest()
  return timingSafeEqual(hash(a), hash(b))
}

export interface ApiKeyVerifier {
  /** How many keys are configured. Zero means the API must not be mounted. */
  readonly count: number
  isValid(candidate: string | null | undefined): boolean
}

export function createApiKeyVerifier(keys: string[]): ApiKeyVerifier {
  const configured = dedupe(keys.filter(isUsableKey))

  return {
    get count() {
      return configured.length
    },
    isValid(candidate) {
      if (!candidate || candidate.length > MAX_KEY_LENGTH) return false
      // No early return: every configured key is compared on every call, so a
      // hit and a miss cost the same.
      let matched = false
      for (const key of configured) {
        if (constantTimeEquals(candidate, key)) {
          matched = true
        }
      }
      return matched
    },
  }
}

/**
 * The credential on an incoming request: `Authorization: Bearer <key>`, or
 * `X-Api-Key: <key>` for callers that can't set an Authorization header.
 */
export function extractApiKey(req: Request): string | null {
  const authorization = req.headers.get("authorization")
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/)
    if (scheme?.toLowerCase() === "bearer" && rest.length > 0) {
      return rest.join(" ")
    }
  }

  const headerKey = req.headers.get("x-api-key")
  return headerKey?.trim() || null
}

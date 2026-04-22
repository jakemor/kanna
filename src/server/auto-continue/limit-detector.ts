export interface LimitDetection {
  chatId: string
  resetAt: number
  tz: string
  raw: unknown
}

export interface LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null
}

interface ErrorLike {
  message?: string
  status?: number
  headers?: Record<string, string>
}

function extractHeaders(error: unknown): Record<string, string> {
  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as ErrorLike).headers
    if (headers && typeof headers === "object") return headers
  }
  return {}
}

function parseBody(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null
  const message = (error as ErrorLike).message
  if (!message) return null
  try {
    const parsed = JSON.parse(message)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null
  const millis = new Date(value).getTime()
  return Number.isFinite(millis) ? millis : null
}

export class ClaudeLimitDetector implements LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null {
    const body = parseBody(error)
    const inner = body && typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>)
      : null
    const isRateLimit = inner?.type === "rate_limit_error"
      || (error as ErrorLike | null)?.status === 429 && inner?.type === "rate_limit_error"
    if (!isRateLimit) return null

    const headers = extractHeaders(error)
    const resetAt = parseIsoMillis(headers["anthropic-ratelimit-unified-reset"])
      ?? parseIsoMillis(inner?.resets_at)
      ?? parseIsoMillis(inner?.reset_at)
    if (resetAt === null) return null

    const tz = headers["x-anthropic-timezone"]
      ?? (typeof inner?.timezone === "string" ? (inner.timezone as string) : null)
      ?? "system"

    return { chatId, resetAt, tz, raw: error }
  }
}

interface JsonRpcErrorLike {
  code?: number
  message?: string
  data?: Record<string, unknown>
}

export class CodexLimitDetector implements LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null {
    if (!error || typeof error !== "object") return null
    const rpc = error as JsonRpcErrorLike
    const data = rpc.data && typeof rpc.data === "object" ? rpc.data : null
    const isRateLimit = data?.code === "rate_limit" || rpc.code === -32001
    if (!isRateLimit) return null

    let resetAt: number | null = null
    if (typeof data?.resets_at_ms === "number" && Number.isFinite(data.resets_at_ms)) {
      resetAt = data.resets_at_ms
    } else {
      resetAt = parseIsoMillis(data?.resets_at)
    }
    if (resetAt === null) return null

    const tz = typeof data?.timezone === "string" ? (data.timezone as string) : "system"
    return { chatId, resetAt, tz, raw: error }
  }
}

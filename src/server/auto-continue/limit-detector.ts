export interface LimitDetection {
  chatId: string
  resetAt: number
  tz: string
  raw: unknown
}

export interface LimitDetector {
  detect(chatId: string, error: unknown): LimitDetection | null
  detectFromResultText?(chatId: string, text: string, nowMs?: number): LimitDetection | null
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

function zonedWallClockToUtcMs(
  year: number, month: number, day: number, hour: number, minute: number, tz: string,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute)
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  })
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(utcGuess))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
  const asLocal = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour), Number(parts.minute),
  )
  return utcGuess - (asLocal - utcGuess)
}

export function parseResetFromText(text: string, nowMs: number = Date.now()): { resetAt: number; tz: string } | null {
  if (typeof text !== "string") return null
  const match = text.match(/resets\s+(\d{1,2})(am|pm)\s*\(([^)]+)\)/i)
  if (!match) return null
  const hour12 = Number(match[1])
  const meridiem = match[2].toLowerCase()
  const tz = match[3].trim()
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return null
  const hour24 = meridiem === "pm"
    ? (hour12 === 12 ? 12 : hour12 + 12)
    : (hour12 === 12 ? 0 : hour12)
  let tzYear: number, tzMonth: number, tzDay: number
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    })
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(nowMs))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    )
    tzYear = Number(parts.year)
    tzMonth = Number(parts.month)
    tzDay = Number(parts.day)
  } catch {
    return null
  }
  let resetAt = zonedWallClockToUtcMs(tzYear, tzMonth, tzDay, hour24, 0, tz)
  if (resetAt <= nowMs) {
    const next = new Date(Date.UTC(tzYear, tzMonth - 1, tzDay) + 24 * 3600_000)
    resetAt = zonedWallClockToUtcMs(
      next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour24, 0, tz,
    )
  }
  return { resetAt, tz }
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

  detectFromResultText(chatId: string, text: string, nowMs: number = Date.now()): LimitDetection | null {
    const parsed = parseResetFromText(text, nowMs)
    if (!parsed) return null
    return { chatId, resetAt: parsed.resetAt, tz: parsed.tz, raw: text }
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

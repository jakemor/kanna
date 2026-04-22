function resolveTimeZone(tz: string): string | undefined {
  if (tz === "system") return undefined
  return tz
}

export function formatLocal(epochMs: number, tz: string): string {
  const timeZone = resolveTimeZone(tz)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00"
  let hour = part("hour")
  if (hour === "24") hour = "00"
  return `${part("day")}/${part("month")}/${part("year")} ${hour}:${part("minute")}`
}

const PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/

function offsetMinutes(tz: string, referenceUtcMs: number): number {
  if (tz === "system") return -new Date(referenceUtcMs).getTimezoneOffset()
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(referenceUtcMs))
  const p = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? 0)
  let hour = p("hour")
  if (hour === 24) hour = 0
  const asUtc = Date.UTC(p("year"), p("month") - 1, p("day"), hour, p("minute"), p("second"))
  return Math.round((asUtc - referenceUtcMs) / 60_000)
}

export function parseLocal(input: string, tz: string): number | null {
  const match = PATTERN.exec(input.trim())
  if (!match) return null
  const [, ddStr, mmStr, yyyyStr, hhStr, minStr] = match
  const dd = Number(ddStr)
  const mm = Number(mmStr)
  const yyyy = Number(yyyyStr)
  const hh = Number(hhStr)
  const min = Number(minStr)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || min > 59) return null

  const guess = Date.UTC(yyyy, mm - 1, dd, hh, min)
  const offMin = offsetMinutes(tz, guess)
  const corrected = guess - offMin * 60_000
  const offMinAfter = offsetMinutes(tz, corrected)
  return corrected - (offMinAfter - offMin) * 60_000
}

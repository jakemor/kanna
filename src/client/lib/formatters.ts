export function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

const SHELL_WRAPPER_PATTERNS = [
  /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[a-zA-Z]*c|-c)\s+(['"])([\s\S]*)\1$/,
  /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[a-zA-Z]*c|-c)\s+(.+)$/,
  /^(?:\/usr\/bin\/env\s+)?(?:cmd(?:\.exe)?)\s+\/c\s+(['"])([\s\S]*)\1$/i,
  /^(?:\/usr\/bin\/env\s+)?(?:cmd(?:\.exe)?)\s+\/c\s+(.+)$/i,
  /^(?:\/usr\/bin\/env\s+)?(?:powershell(?:\.exe)?|pwsh)\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1$/i,
  /^(?:\/usr\/bin\/env\s+)?(?:powershell(?:\.exe)?|pwsh)\s+(?:-NoProfile\s+)?-Command\s+(.+)$/i,
] as const

export function formatBashCommandTitle(command: string): string {
  const trimmed = command.trim()
  for (const pattern of SHELL_WRAPPER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (!match) continue
    const candidate = (match[2] ?? match[1] ?? "").trim()
    if (candidate) {
      return candidate
    }
  }
  return trimmed
}

export function getPathBasename(fullPath: string): string {
  return fullPath.split("/").pop() || fullPath
}

export function formatModelLabel(modelId: string): string {
  const shortModelName = modelId.split("/")[1]?.split(":")[0] ?? modelId
  return toTitleCase(shortModelName).replace(/^Claude\s+/i, "")
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

export const SIDEBAR_RECENT_WINDOW_MS = DAY_MS

interface RelativeAgeStyle {
  nowLabel: string
  suffix: string
  round: (value: number) => number
  units: Array<{ ms: number; label: string }>
}

function formatRelativeAge(deltaMs: number, style: RelativeAgeStyle): string {
  const { units } = style
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]
    if (deltaMs >= unit.ms) {
      return `${style.round(deltaMs / unit.ms)}${unit.label}${style.suffix}`
    }
  }
  return style.nowLabel
}

const SIDEBAR_AGE_STYLE: RelativeAgeStyle = {
  nowLabel: "now",
  suffix: "",
  round: Math.floor,
  units: [
    { ms: MINUTE_MS, label: "m" },
    { ms: HOUR_MS, label: "h" },
    { ms: DAY_MS, label: "d" },
    { ms: WEEK_MS, label: "w" },
  ],
}

const TIMESTAMP_AGE_STYLE: RelativeAgeStyle = {
  nowLabel: "just now",
  suffix: " ago",
  round: Math.round,
  units: [
    { ms: MINUTE_MS, label: "m" },
    { ms: HOUR_MS, label: "hr" },
    { ms: DAY_MS, label: "d" },
    { ms: WEEK_MS, label: "wk" },
    { ms: MONTH_MS, label: "mo" },
    { ms: YEAR_MS, label: "yr" },
  ],
}

export function formatSidebarAgeLabel(lastMessageAt: number | undefined, nowMs: number): string | null {
  if (lastMessageAt === undefined) return null
  return formatRelativeAge(Math.max(0, nowMs - lastMessageAt), SIDEBAR_AGE_STYLE)
}

export function formatRelativeTime(isoTimestamp: string): string {
  const timestamp = Date.parse(isoTimestamp)
  if (!Number.isFinite(timestamp)) {
    return ""
  }
  return formatRelativeAge(Date.now() - timestamp, TIMESTAMP_AGE_STYLE)
}

export interface DetectorInput {
  command: string
  stdout: string
}

export type DetectorResult =
  | { isServer: true; ports: number[] }
  | { isServer: false }

const STDOUT_TAIL_LIMIT = 8192
const MAX_PORTS = 5
const MIN_PORT = 1024
const MAX_PORT = 65535

const STRONG_PATTERNS: RegExp[] = [
  /\blocalhost:(\d+)/gi,
  /\b127\.0\.0\.1:(\d+)/gi,
  /\b0\.0\.0\.0:(\d+)/gi,
  /\[::1?\]:(\d+)/gi,
  /\bhttps?:\/\/[^/\s:]+:(\d+)/gi,
  /(?:listening|ready|started|running)\s+(?:on\s+)?(?:port\s+)?:?(\d{4,5})\b/gi,
  /\bport\s+(\d{4,5})\b/gi,
]

export function evaluateBashOutput(input: DetectorInput): DetectorResult {
  const tail = input.stdout.slice(-STDOUT_TAIL_LIMIT)
  const found = new Set<number>()

  for (const pattern of STRONG_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(tail)) !== null) {
      const port = Number.parseInt(match[1] ?? "", 10)
      if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) {
        found.add(port)
        if (found.size >= MAX_PORTS) break
      }
    }
    if (found.size >= MAX_PORTS) break
  }

  if (found.size === 0) return { isServer: false }
  return { isServer: true, ports: [...found].sort((a, b) => a - b) }
}

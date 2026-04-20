import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import type { ClaudeSessionRecord, ParsedClaudeSession } from "./claude-session-types"

function tryParse(line: string): ClaudeSessionRecord | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (typeof (parsed as ClaudeSessionRecord).type !== "string") return null
    return parsed as ClaudeSessionRecord
  } catch {
    return null
  }
}

export function parseClaudeSessionFile(filePath: string): ParsedClaudeSession | null {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
  } catch {
    return null
  }
  const sourceHash = createHash("md5").update(raw).digest("hex")

  const records: ClaudeSessionRecord[] = []
  let sessionId: string | null = null
  let cwd: string | null = null
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const record = tryParse(trimmed)
    if (!record) continue

    if (!sessionId && typeof record.sessionId === "string") sessionId = record.sessionId
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd

    const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    if (!Number.isNaN(ts)) {
      if (ts < first) first = ts
      if (ts > last) last = ts
    }

    records.push(record)
  }

  if (!sessionId) return null
  if (records.length === 0) return null

  let mtime: number
  try {
    mtime = statSync(filePath).mtimeMs
  } catch {
    mtime = Date.now()
  }
  return {
    sessionId,
    filePath,
    cwd: cwd ?? "",
    firstTimestamp: Number.isFinite(first) ? first : mtime,
    lastTimestamp: Number.isFinite(last) ? last : mtime,
    records,
    sourceHash,
  }
}

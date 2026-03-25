import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider, ChatUsageSnapshot, ChatUsageWarning, TranscriptEntry } from "../shared/types"

const WARNING_THRESHOLD = 75
const CRITICAL_THRESHOLD = 90
const STALE_AFTER_MS = 5 * 60 * 1000

interface NumericUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
}

interface ClaudeRateLimitInfo {
  percent: number | null
  resetsAt: number | null
}

const CLAUDE_CONTEXT_WINDOW_FALLBACKS: Record<string, number> = {
  sonnet: 200_000,
  opus: 200_000,
  haiku: 200_000,
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function toPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function usageWarnings(args: {
  contextUsedPercent: number | null
  sessionLimitUsedPercent: number | null
  updatedAt: number | null
}): ChatUsageWarning[] {
  const warnings: ChatUsageWarning[] = []

  if (args.contextUsedPercent !== null) {
    if (args.contextUsedPercent >= CRITICAL_THRESHOLD) {
      warnings.push("context_critical")
    } else if (args.contextUsedPercent >= WARNING_THRESHOLD) {
      warnings.push("context_warning")
    }
  }

  if (args.sessionLimitUsedPercent !== null) {
    if (args.sessionLimitUsedPercent >= CRITICAL_THRESHOLD) {
      warnings.push("rate_critical")
    } else if (args.sessionLimitUsedPercent >= WARNING_THRESHOLD) {
      warnings.push("rate_warning")
    }
  }

  if (args.updatedAt !== null && Date.now() - args.updatedAt > STALE_AFTER_MS) {
    warnings.push("stale")
  }

  return warnings
}

function relevantMessagesForCurrentContext(messages: TranscriptEntry[]) {
  let lastContextClearedIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "context_cleared") {
      lastContextClearedIndex = index
      break
    }
  }

  return lastContextClearedIndex >= 0 ? messages.slice(lastContextClearedIndex + 1) : messages
}

function estimateTokenCountFromText(text: string | undefined | null) {
  if (!text) return 0
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.ceil(trimmed.length / 4)
}

function estimateTokenCountFromUnknown(value: unknown) {
  if (typeof value === "string") {
    return estimateTokenCountFromText(value)
  }

  try {
    return estimateTokenCountFromText(JSON.stringify(value))
  } catch {
    return 0
  }
}

export function estimateCurrentThreadTokens(messages: TranscriptEntry[]) {
  let total = 0

  for (const entry of relevantMessagesForCurrentContext(messages)) {
    switch (entry.kind) {
      case "user_prompt":
        total += estimateTokenCountFromText(entry.content)
        if (entry.attachments?.length) {
          total += entry.attachments.length * 256
        }
        break
      case "assistant_text":
        total += estimateTokenCountFromText(entry.text)
        break
      case "compact_summary":
        total += estimateTokenCountFromText(entry.summary)
        break
      case "result":
        total += estimateTokenCountFromText(entry.result)
        break
      case "tool_call":
        total += estimateTokenCountFromText(entry.tool.toolName)
        total += estimateTokenCountFromUnknown(entry.tool.input)
        break
      case "tool_result":
        total += estimateTokenCountFromUnknown(entry.content)
        break
      case "status":
        total += estimateTokenCountFromText(entry.status)
        break
      default:
        break
    }
  }

  return total
}

function buildSnapshot(args: {
  provider: AgentProvider
  threadTokens: number | null
  contextWindowTokens: number | null
  lastTurnTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens?: number | null
  sessionLimitUsedPercent: number | null
  rateLimitResetAt: number | null
  source: ChatUsageSnapshot["source"]
  updatedAt: number | null
}): ChatUsageSnapshot | null {
  const contextUsedPercent = args.threadTokens !== null && args.contextWindowTokens && args.contextWindowTokens > 0
    ? toPercent((args.threadTokens / args.contextWindowTokens) * 100)
    : null

  const snapshot: ChatUsageSnapshot = {
    provider: args.provider,
    threadTokens: args.threadTokens,
    contextWindowTokens: args.contextWindowTokens,
    contextUsedPercent,
    lastTurnTokens: args.lastTurnTokens,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens: args.cachedInputTokens,
    reasoningOutputTokens: args.reasoningOutputTokens ?? null,
    sessionLimitUsedPercent: toPercent(args.sessionLimitUsedPercent),
    rateLimitResetAt: args.rateLimitResetAt,
    source: args.source,
    updatedAt: args.updatedAt,
    warnings: usageWarnings({
      contextUsedPercent,
      sessionLimitUsedPercent: toPercent(args.sessionLimitUsedPercent),
      updatedAt: args.updatedAt,
    }),
  }

  const hasAnyData = [
    snapshot.threadTokens,
    snapshot.contextWindowTokens,
    snapshot.lastTurnTokens,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.cachedInputTokens,
    snapshot.reasoningOutputTokens ?? null,
    snapshot.sessionLimitUsedPercent,
  ].some((value) => value !== null)

  return hasAnyData ? snapshot : null
}

function usageTotals(usage: Record<string, unknown>): NumericUsage & { totalTokens: number } {
  const inputTokens = toNumber(usage.input_tokens) ?? 0
  const outputTokens = toNumber(usage.output_tokens) ?? 0
  const cachedInputTokens = (toNumber(usage.cache_read_input_tokens) ?? 0) + (toNumber(usage.cache_creation_input_tokens) ?? 0)
  const reasoningOutputTokens = toNumber(usage.reasoning_output_tokens) ?? 0

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens,
  }
}

function extractClaudeUsageRecord(entry: TranscriptEntry) {
  if (!entry.debugRaw) return null
  const raw = parseJsonLine(entry.debugRaw)
  if (!raw) return null

  const type = raw.type
  if (type !== "assistant" && type !== "result") return null

  if (type === "assistant") {
    const message = asRecord(raw.message)
    const usage = asRecord(message?.usage)
    if (!usage) return null

    const usageTotalsRecord = usageTotals(usage)
    return {
      key: typeof raw.uuid === "string" ? raw.uuid : entry.messageId ?? entry._id,
      updatedAt: entry.createdAt,
      totals: usageTotalsRecord,
      contextWindowTokens: null,
    }
  }

  const usage = asRecord(raw.usage)
  const modelUsage = asRecord(raw.modelUsage)
  const firstModel = modelUsage ? Object.values(modelUsage).map((value) => asRecord(value)).find(Boolean) ?? null : null
  if (!usage && !firstModel) return null

  const usageTotalsRecord = usage ? usageTotals(usage) : {
    inputTokens: toNumber(firstModel?.inputTokens) ?? 0,
    outputTokens: toNumber(firstModel?.outputTokens) ?? 0,
    cachedInputTokens:
      (toNumber(firstModel?.cacheReadInputTokens) ?? 0)
      + (toNumber(firstModel?.cacheCreationInputTokens) ?? 0),
    reasoningOutputTokens: 0,
    totalTokens:
      (toNumber(firstModel?.inputTokens) ?? 0)
      + (toNumber(firstModel?.outputTokens) ?? 0)
      + (toNumber(firstModel?.cacheReadInputTokens) ?? 0)
      + (toNumber(firstModel?.cacheCreationInputTokens) ?? 0),
  }

  return {
    key: typeof raw.uuid === "string" ? raw.uuid : entry.messageId ?? entry._id,
    updatedAt: entry.createdAt,
    totals: usageTotalsRecord,
    contextWindowTokens: toNumber(firstModel?.contextWindow),
  }
}

export function reconstructClaudeUsage(
  messages: TranscriptEntry[],
  liveRateLimit?: ClaudeRateLimitInfo | null
): ChatUsageSnapshot | null {
  const relevantMessages = relevantMessagesForCurrentContext(messages)
  const deduped = new Map<string, ReturnType<typeof extractClaudeUsageRecord>>()

  for (const entry of relevantMessages) {
    const usageRecord = extractClaudeUsageRecord(entry)
    if (!usageRecord) continue
    deduped.set(usageRecord.key, usageRecord)
  }

  const latest = [...deduped.values()]
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (!latest && liveRateLimit?.percent == null) {
    return null
  }

  const latestModel = [...relevantMessages]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { kind: "system_init" }> =>
      entry.kind === "system_init" && entry.provider === "claude"
    )
  const fallbackContextWindow = latestModel
    ? CLAUDE_CONTEXT_WINDOW_FALLBACKS[latestModel.model.toLowerCase()] ?? null
    : null

  return buildSnapshot({
    provider: "claude",
    threadTokens: estimateCurrentThreadTokens(messages),
    contextWindowTokens: latest?.contextWindowTokens ?? fallbackContextWindow,
    lastTurnTokens: latest?.totals.totalTokens ?? null,
    inputTokens: latest?.totals.inputTokens ?? null,
    outputTokens: latest?.totals.outputTokens ?? null,
    cachedInputTokens: latest?.totals.cachedInputTokens ?? null,
    reasoningOutputTokens: latest?.totals.reasoningOutputTokens ?? null,
    sessionLimitUsedPercent: liveRateLimit?.percent ?? null,
    rateLimitResetAt: liveRateLimit?.resetsAt ?? null,
    source: latest ? "reconstructed" : "live",
    updatedAt: latest?.updatedAt ?? null,
  })
}

function findCodexSessionFile(sessionToken: string, sessionsDir = path.join(homedir(), ".codex", "sessions")): string | null {
  if (!existsSync(sessionsDir)) {
    return null
  }

  const stack = [sessionsDir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      if (entry.name.includes(sessionToken)) {
        return fullPath
      }

      const firstLine = readFileSync(fullPath, "utf8").split("\n", 1)[0]
      const record = parseJsonLine(firstLine)
      const payload = asRecord(record?.payload)
      if (record?.type === "session_meta" && payload?.id === sessionToken) {
        return fullPath
      }
    }
  }

  return null
}

export function reconstructCodexUsageFromFile(
  sessionToken: string,
  sessionsDir = path.join(homedir(), ".codex", "sessions")
): ChatUsageSnapshot | null {
  const sessionFile = findCodexSessionFile(sessionToken, sessionsDir)
  if (!sessionFile || !existsSync(sessionFile)) {
    return null
  }

  let latestUsage: ChatUsageSnapshot | null = null
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonLine(line)
    if (!record || record.type !== "event_msg") continue
    const payload = asRecord(record.payload)
    if (!payload || payload.type !== "token_count") continue
    const info = asRecord(payload.info)
    const totalTokenUsage = asRecord(info?.total_token_usage)
    const lastTokenUsage = asRecord(info?.last_token_usage)
    const rateLimits = asRecord(payload.rate_limits)
    const primary = asRecord(rateLimits?.primary)
    const updatedAt = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()

    latestUsage = buildSnapshot({
      provider: "codex",
      threadTokens: null,
      contextWindowTokens: toNumber(info?.model_context_window),
      lastTurnTokens: toNumber(lastTokenUsage?.total_tokens),
      inputTokens: toNumber(totalTokenUsage?.input_tokens),
      outputTokens: toNumber(totalTokenUsage?.output_tokens),
      cachedInputTokens: toNumber(totalTokenUsage?.cached_input_tokens),
      reasoningOutputTokens: toNumber(totalTokenUsage?.reasoning_output_tokens),
      sessionLimitUsedPercent: toNumber(primary?.used_percent),
      rateLimitResetAt: typeof primary?.resets_at === "number" ? primary.resets_at * 1000 : null,
      source: "reconstructed",
      updatedAt,
    })
  }

  return latestUsage
}

export function mergeUsageSnapshots(
  reconstructed: ChatUsageSnapshot | null,
  live: ChatUsageSnapshot | null
): ChatUsageSnapshot | null {
  if (!reconstructed) return live
  if (!live) return reconstructed

  const merged: ChatUsageSnapshot = {
    ...reconstructed,
    ...live,
    provider: live.provider,
    threadTokens: live.threadTokens ?? reconstructed.threadTokens,
    contextWindowTokens: live.contextWindowTokens ?? reconstructed.contextWindowTokens,
    contextUsedPercent: live.contextUsedPercent ?? reconstructed.contextUsedPercent,
    lastTurnTokens: live.lastTurnTokens ?? reconstructed.lastTurnTokens,
    inputTokens: live.inputTokens ?? reconstructed.inputTokens,
    outputTokens: live.outputTokens ?? reconstructed.outputTokens,
    cachedInputTokens: live.cachedInputTokens ?? reconstructed.cachedInputTokens,
    reasoningOutputTokens: live.reasoningOutputTokens ?? reconstructed.reasoningOutputTokens,
    sessionLimitUsedPercent: live.sessionLimitUsedPercent ?? reconstructed.sessionLimitUsedPercent,
    rateLimitResetAt: live.rateLimitResetAt ?? reconstructed.rateLimitResetAt,
    source: live.source === "live" ? "live" : reconstructed.source,
    updatedAt: live.updatedAt ?? reconstructed.updatedAt,
    warnings: [],
  }

  merged.warnings = usageWarnings({
    contextUsedPercent: merged.contextUsedPercent,
    sessionLimitUsedPercent: merged.sessionLimitUsedPercent,
    updatedAt: merged.updatedAt,
  })

  return merged
}

export function applyThreadEstimate(
  snapshot: ChatUsageSnapshot | null,
  messages: TranscriptEntry[]
): ChatUsageSnapshot | null {
  const estimatedThreadTokens = estimateCurrentThreadTokens(messages)
  if (!snapshot) return null

  const contextUsedPercent = snapshot.contextWindowTokens && snapshot.contextWindowTokens > 0
    ? toPercent((estimatedThreadTokens / snapshot.contextWindowTokens) * 100)
    : null

  return {
    ...snapshot,
    threadTokens: estimatedThreadTokens,
    contextUsedPercent,
    warnings: usageWarnings({
      contextUsedPercent,
      sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
      updatedAt: snapshot.updatedAt,
    }),
  }
}

export function createClaudeRateLimitSnapshot(percent: number | null, resetsAt: number | null): ChatUsageSnapshot | null {
  return buildSnapshot({
    provider: "claude",
    threadTokens: null,
    contextWindowTokens: null,
    lastTurnTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    sessionLimitUsedPercent: percent,
    rateLimitResetAt: resetsAt,
    source: "live",
    updatedAt: Date.now(),
  })
}

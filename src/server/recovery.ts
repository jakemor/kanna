import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import { normalizeClaudeStreamMessage } from "./agent"

interface RecoveryStore {
  listChatsByProject(projectId: string): Array<{
    id: string
    provider: AgentProvider | null
    sessionToken: string | null
    lastMessageAt?: number
    updatedAt: number
  }>
  isProjectHidden(repoKey: string): boolean
  createChat(projectId: string): Promise<{ id: string }>
  deleteChat(chatId: string): Promise<void>
  renameChat(chatId: string, title: string): Promise<void>
  setChatProvider(chatId: string, provider: AgentProvider): Promise<void>
  setSessionToken(chatId: string, sessionToken: string | null): Promise<void>
  appendMessage(chatId: string, entry: TranscriptEntry): Promise<void>
}

interface RecoveryChat {
  provider: AgentProvider
  sessionToken: string
  localPath: string
  title: string
  modifiedAt: number
  entries: TranscriptEntry[]
}

export interface ProjectImportResult {
  importedChatIds: string[]
  importedChats: number
  importedMessages: number
  newestChatId: string | null
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function collectFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return []
  }

  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, extension))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(fullPath)
    }
  }

  return files
}

function makeEntryId(prefix: string, sessionToken: string, index: number) {
  return `${prefix}:${sessionToken}:${index}`
}

function textFromClaudeContentArray(content: unknown[]): string {
  return content
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return ""
      const record = item as Record<string, unknown>
      return record.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .filter((part) => part.trim())
    .join("\n")
}

function claudeUserEntriesFromRecord(record: Record<string, unknown>, timestamp: number, messageId: string): TranscriptEntry[] {
  const message = record.message
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return []
  }

  const messageRecord = message as Record<string, unknown>
  let content = ""
  if (typeof messageRecord.content === "string") {
    content = messageRecord.content
  } else if (Array.isArray(messageRecord.content)) {
    content = textFromClaudeContentArray(messageRecord.content)
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith("This session is being continued")) {
    return [{
      _id: messageId,
      messageId,
      createdAt: timestamp,
      kind: "compact_summary",
      summary: trimmed,
    }]
  }

  return [{
    _id: messageId,
    messageId,
    createdAt: timestamp,
    kind: "user_prompt",
    content: trimmed,
  }]
}

function claudeEntriesFromRecord(record: Record<string, unknown>): TranscriptEntry[] {
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
  if (Number.isNaN(timestamp)) {
    return []
  }

  const messageId = typeof record.uuid === "string"
    ? record.uuid
    : makeEntryId("claude-message", String(record.sessionId ?? "session"), 0)

  if (record.type === "user") {
    return claudeUserEntriesFromRecord(record, timestamp, messageId)
  }

  const entries = normalizeClaudeStreamMessage(record).filter((entry) => {
    if (entry.kind === "assistant_text" && !entry.text.trim()) return false
    if (entry.kind === "compact_summary" && !entry.summary.trim()) return false
    return entry.kind !== "tool_call" && entry.kind !== "tool_result" && entry.kind !== "system_init"
  })

  return entries.map((entry, index) => ({
    ...entry,
    _id: entry._id || makeEntryId("claude", String(record.sessionId ?? "session"), index),
    createdAt: timestamp + index,
  }))
}

function firstUserPrompt(entries: TranscriptEntry[]): string | null {
  const entry = entries.find((candidate) => candidate.kind === "user_prompt" && candidate.content.trim())
  if (!entry || entry.kind !== "user_prompt") {
    return null
  }
  return entry.content.trim()
}

function firstLine(value: string, fallback: string) {
  const line = value.split("\n").map((part) => part.trim()).find(Boolean)
  if (!line) return fallback
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

function isInternalTitleGenerationPrompt(value: string | null) {
  return Boolean(
    value?.startsWith("Generate a short, descriptive title (under 30 chars) for a conversation that starts with this message.")
  )
}

function markSkippedSession(
  skippedSessionKeys: Set<string>,
  provider: AgentProvider,
  sessionToken: string | null
) {
  if (sessionToken) {
    skippedSessionKeys.add(`${provider}:${sessionToken}`)
  }
}

function readClaudeProjectChats(homeDir: string, trackedWorktreePaths: Set<string>, skippedSessionKeys: Set<string>): RecoveryChat[] {
  const projectsDir = path.join(homeDir, ".claude", "projects")
  const chats: RecoveryChat[] = []

  for (const sessionFile of collectFiles(projectsDir, ".jsonl")) {
    const lines = readFileSync(sessionFile, "utf8").split("\n")
    const entries: TranscriptEntry[] = []
    let sessionToken: string | null = null
    let sessionLocalPath: string | null = null
    let modifiedAt = statSync(sessionFile).mtimeMs

    for (const line of lines) {
      if (!line.trim()) continue
      const record = parseJsonRecord(line)
      if (!record) continue

      if (!sessionToken && typeof record.sessionId === "string") {
        sessionToken = record.sessionId
      }
      if (!sessionLocalPath && typeof record.cwd === "string" && path.isAbsolute(record.cwd)) {
        sessionLocalPath = path.normalize(record.cwd)
      }

      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
      if (!Number.isNaN(timestamp)) {
        modifiedAt = Math.max(modifiedAt, timestamp)
      }

      entries.push(...claudeEntriesFromRecord(record))
    }

    if (!sessionToken || !sessionLocalPath || !trackedWorktreePaths.has(sessionLocalPath) || entries.length === 0) {
      continue
    }

    const prompt = firstUserPrompt(entries)
    if (!prompt || isInternalTitleGenerationPrompt(prompt)) {
      markSkippedSession(skippedSessionKeys, "claude", sessionToken)
      continue
    }

    chats.push({
      provider: "claude",
      sessionToken,
      localPath: sessionLocalPath,
      title: prompt,
      modifiedAt,
      entries,
    })
  }

  return chats
}

function codexAssistantTextFromResponseItem(record: Record<string, unknown>, index: number): TranscriptEntry | null {
  const payload = record.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null
  }

  const payloadRecord = payload as Record<string, unknown>
  if (payloadRecord.type !== "message") {
    return null
  }

  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()
  const content = Array.isArray(payloadRecord.content) ? payloadRecord.content : []
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return ""
      const contentItem = item as Record<string, unknown>
      return contentItem.type === "output_text" && typeof contentItem.text === "string"
        ? contentItem.text
        : ""
    })
    .filter(Boolean)
    .join("\n")

  if (!text.trim()) {
    return null
  }

  return {
    _id: makeEntryId("codex", String(payloadRecord.id ?? "assistant"), index),
    createdAt: timestamp + index,
    kind: "assistant_text",
    text,
  }
}

function codexToolCallFromResponseItem(record: Record<string, unknown>, index: number): TranscriptEntry | null {
  const payload = record.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null
  }

  const payloadRecord = payload as Record<string, unknown>
  if (payloadRecord.type !== "function_call" || typeof payloadRecord.name !== "string") {
    return null
  }

  const toolId = typeof payloadRecord.call_id === "string"
    ? payloadRecord.call_id
    : makeEntryId("codex-tool", payloadRecord.name, index)
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()
  let input: Record<string, unknown> = {}

  if (typeof payloadRecord.arguments === "string") {
    input = parseJsonRecord(payloadRecord.arguments) ?? {}
  }

  return {
    _id: makeEntryId("codex", toolId, index),
    createdAt: timestamp + index,
    kind: "tool_call",
    tool: normalizeToolCall({
      toolName: payloadRecord.name,
      toolId,
      input,
    }),
  }
}

function codexEntriesFromRecord(record: Record<string, unknown>, index: number): TranscriptEntry[] {
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()

  if (record.type === "event_msg") {
    const payload = record.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return []
    }
    const payloadRecord = payload as Record<string, unknown>

    if (payloadRecord.type === "user_message" && typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
      return [{
        _id: makeEntryId("codex-user", String(index), index),
        createdAt: timestamp + index,
        kind: "user_prompt",
        content: payloadRecord.message.trim(),
      }]
    }

    if (payloadRecord.type === "agent_message" && typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
      return [{
        _id: makeEntryId("codex-assistant", String(index), index),
        createdAt: timestamp + index,
        kind: "assistant_text",
        text: payloadRecord.message,
      }]
    }

    return []
  }

  if (record.type === "response_item") {
    const toolCall = codexToolCallFromResponseItem(record, index)
    if (toolCall) {
      return [toolCall]
    }
    const assistantText = codexAssistantTextFromResponseItem(record, index)
    return assistantText ? [assistantText] : []
  }

  return []
}

function isCodexSubagentSession(payload: Record<string, unknown>) {
  if (typeof payload.forked_from_id === "string" && payload.forked_from_id.trim()) {
    return true
  }

  const source = payload.source
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return false
  }

  const sourceRecord = source as Record<string, unknown>
  return Boolean(sourceRecord.subagent)
}

function readCodexProjectChats(homeDir: string, trackedWorktreePaths: Set<string>, skippedSessionKeys: Set<string>): RecoveryChat[] {
  const sessionsDir = path.join(homeDir, ".codex", "sessions")
  const chats: RecoveryChat[] = []

  for (const sessionFile of collectFiles(sessionsDir, ".jsonl")) {
    const lines = readFileSync(sessionFile, "utf8").split("\n")
    const entries: TranscriptEntry[] = []
    let sessionToken: string | null = null
    let sessionLocalPath: string | null = null
    let isSubagentSession = false
    let modifiedAt = statSync(sessionFile).mtimeMs

    lines.forEach((line, index) => {
      if (!line.trim()) return
      const record = parseJsonRecord(line)
      if (!record) return

      if (record.type === "session_meta") {
        const payload = record.payload
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const payloadRecord = payload as Record<string, unknown>
          isSubagentSession = isSubagentSession || isCodexSubagentSession(payloadRecord)
          if (!sessionToken && typeof payloadRecord.id === "string") {
            sessionToken = payloadRecord.id
          }
          if (!sessionLocalPath && typeof payloadRecord.cwd === "string" && path.isAbsolute(payloadRecord.cwd)) {
            sessionLocalPath = path.normalize(payloadRecord.cwd)
          }
        }
      }

      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
      if (!Number.isNaN(timestamp)) {
        modifiedAt = Math.max(modifiedAt, timestamp)
      }

      entries.push(...codexEntriesFromRecord(record, index))
    })

    if (isSubagentSession) {
      markSkippedSession(skippedSessionKeys, "codex", sessionToken)
      continue
    }

    if (!sessionToken || !sessionLocalPath || !trackedWorktreePaths.has(sessionLocalPath) || entries.length === 0) {
      continue
    }

    const prompt = firstUserPrompt(entries)
    if (!prompt || isInternalTitleGenerationPrompt(prompt)) {
      markSkippedSession(skippedSessionKeys, "codex", sessionToken)
      continue
    }

    chats.push({
      provider: "codex",
      sessionToken,
      localPath: sessionLocalPath,
      title: prompt,
      modifiedAt,
      entries,
    })
  }

  return chats
}

function collectProjectChats(homeDir: string, trackedWorktreePaths: Set<string>) {
  const skippedSessionKeys = new Set<string>()
  return {
    skippedSessionKeys,
    chats: [
      ...readClaudeProjectChats(homeDir, trackedWorktreePaths, skippedSessionKeys),
      ...readCodexProjectChats(homeDir, trackedWorktreePaths, skippedSessionKeys),
    ],
  }
}

export async function importProjectHistory(args: {
  store: RecoveryStore
  projectId: string
  repoKey: string
  localPath: string
  worktreePaths: string[]
  homeDir?: string
  log?: (message: string) => void
}): Promise<ProjectImportResult> {
  const normalizedPaths = new Set(args.worktreePaths.map((worktreePath) => path.normalize(worktreePath)))
  normalizedPaths.add(path.normalize(args.localPath))
  if (args.store.isProjectHidden(args.repoKey)) {
    return {
      importedChatIds: [],
      importedChats: 0,
      importedMessages: 0,
      newestChatId: null,
    }
  }

  const { chats, skippedSessionKeys } = collectProjectChats(args.homeDir ?? homedir(), normalizedPaths)
  const existingChats = args.store.listChatsByProject(args.projectId)

  for (const chat of existingChats.filter((candidate) => {
    if (!candidate.provider || !candidate.sessionToken) return false
    return skippedSessionKeys.has(`${candidate.provider}:${candidate.sessionToken}`)
  })) {
    await args.store.deleteChat(chat.id)
  }

  const refreshedExistingChats = args.store.listChatsByProject(args.projectId)
  const existingSessionKeys = new Set(
    refreshedExistingChats
      .filter((chat) => chat.provider && chat.sessionToken)
      .map((chat) => `${chat.provider}:${chat.sessionToken}`)
  )
  const importedChatIds: string[] = []
  let importedMessages = 0

  for (const chat of chats
    .filter((candidate) => !existingSessionKeys.has(`${candidate.provider}:${candidate.sessionToken}`))
    .sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    const createdChat = await args.store.createChat(args.projectId)
    await args.store.renameChat(createdChat.id, firstLine(chat.title, "Recovered Chat"))
    await args.store.setChatProvider(createdChat.id, chat.provider)
    await args.store.setSessionToken(createdChat.id, chat.sessionToken)

    for (const entry of chat.entries) {
      await args.store.appendMessage(createdChat.id, entry)
      importedMessages += 1
    }

    importedChatIds.push(createdChat.id)
  }

  const newestChatId = args.store.listChatsByProject(args.projectId)[0]?.id ?? null
  args.log?.(
    `[kanna] project import repo=${args.repoKey} paths=${[...normalizedPaths].join(",")} discovered=${chats.length} imported=${importedChatIds.length} messages=${importedMessages}`
  )

  return {
    importedChatIds,
    importedChats: importedChatIds.length,
    importedMessages,
    newestChatId,
  }
}

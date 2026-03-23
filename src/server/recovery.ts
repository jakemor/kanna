import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
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
  createChat(projectId: string): Promise<{ id: string }>
  renameChat(chatId: string, title: string): Promise<void>
  setChatProvider(chatId: string, provider: AgentProvider): Promise<void>
  setSessionToken(chatId: string, sessionToken: string | null): Promise<void>
  appendMessage(chatId: string, entry: TranscriptEntry): Promise<void>
}

interface RecoveryChat {
  provider: AgentProvider
  sessionToken: string
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

async function collectFiles(directory: string, extension: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" }) as Dirent[]
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, extension))
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

function encodeClaudeProjectPath(localPath: string) {
  return `-${localPath.replace(/\//g, "-")}`
}

async function readClaudeProjectChats(homeDir: string, localPath: string, log?: (message: string) => void): Promise<RecoveryChat[]> {
  const projectsDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(localPath))
  const chats: RecoveryChat[] = []
  const sessionFiles = await collectFiles(projectsDir, ".jsonl")

  for (const sessionFile of sessionFiles) {
    let lines: string[]
    let modifiedAt = Date.now()
    try {
      const [fileText, fileStat] = await Promise.all([
        readFile(sessionFile, "utf8"),
        stat(sessionFile),
      ])
      lines = fileText.split("\n")
      modifiedAt = fileStat.mtimeMs
    } catch (error) {
      log?.(`[kanna] Skipping unreadable Claude history file ${sessionFile}: ${String(error)}`)
      continue
    }

    const entries: TranscriptEntry[] = []
    let sessionToken: string | null = null
    let sessionLocalPath: string | null = null

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

    if (!sessionToken || sessionLocalPath !== path.normalize(localPath) || entries.length === 0) {
      continue
    }

    const prompt = firstUserPrompt(entries)
    if (!prompt) {
      continue
    }

    chats.push({
      provider: "claude",
      sessionToken,
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

async function readCodexProjectChats(homeDir: string, localPath: string, log?: (message: string) => void): Promise<RecoveryChat[]> {
  const sessionsDir = path.join(homeDir, ".codex", "sessions")
  const chats: RecoveryChat[] = []
  const normalizedPath = path.normalize(localPath)

  for (const sessionFile of await collectFiles(sessionsDir, ".jsonl")) {
    let lines: string[]
    let modifiedAt = Date.now()
    try {
      const [fileText, fileStat] = await Promise.all([
        readFile(sessionFile, "utf8"),
        stat(sessionFile),
      ])
      lines = fileText.split("\n")
      modifiedAt = fileStat.mtimeMs
    } catch (error) {
      log?.(`[kanna] Skipping unreadable Codex history file ${sessionFile}: ${String(error)}`)
      continue
    }

    const entries: TranscriptEntry[] = []
    let sessionToken: string | null = null
    let sessionLocalPath: string | null = null

    lines.forEach((line, index) => {
      if (!line.trim()) return
      const record = parseJsonRecord(line)
      if (!record) return

      if (record.type === "session_meta") {
        const payload = record.payload
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const payloadRecord = payload as Record<string, unknown>
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

    if (!sessionToken || sessionLocalPath !== normalizedPath || entries.length === 0) {
      continue
    }

    const prompt = firstUserPrompt(entries)
    if (!prompt) {
      continue
    }

    chats.push({
      provider: "codex",
      sessionToken,
      title: prompt,
      modifiedAt,
      entries,
    })
  }

  return chats
}

async function collectProjectChats(homeDir: string, localPath: string, log?: (message: string) => void) {
  return [
    ...await readClaudeProjectChats(homeDir, localPath, log),
    ...await readCodexProjectChats(homeDir, localPath, log),
  ]
}

export async function importProjectHistory(args: {
  store: RecoveryStore
  projectId: string
  localPath: string
  homeDir?: string
  log?: (message: string) => void
}): Promise<ProjectImportResult> {
  const normalizedPath = path.normalize(args.localPath)
  const chats = await collectProjectChats(args.homeDir ?? homedir(), normalizedPath, args.log)
  const existingChats = args.store.listChatsByProject(args.projectId)
  const existingSessionKeys = new Set(
    existingChats
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

  const importedNewestChatId = importedChatIds.length === 0
    ? null
    : args.store
      .listChatsByProject(args.projectId)
      .find((chat) => importedChatIds.includes(chat.id))
      ?.id ?? null
  args.log?.(
    `[kanna] project import path=${normalizedPath} discovered=${chats.length} imported=${importedChatIds.length} messages=${importedMessages}`
  )

  return {
    importedChatIds,
    importedChats: importedChatIds.length,
    importedMessages,
    newestChatId: importedNewestChatId,
  }
}

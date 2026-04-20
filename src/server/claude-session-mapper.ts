import { normalizeToolCall } from "../shared/tools"
import type {
  AssistantTextEntry,
  ToolCallEntry,
  ToolResultEntry,
  TranscriptEntry,
  UserPromptEntry,
} from "../shared/types"
import type {
  ClaudeSessionAssistantRecord,
  ClaudeSessionRecord,
  ClaudeSessionUserRecord,
} from "./claude-session-types"

function toMillis(value: string | undefined): number {
  if (!value) return Date.now()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function makeId(uuid: string | undefined, suffix: string): string {
  if (uuid) return `${uuid}-${suffix}`
  return `${crypto.randomUUID()}-${suffix}`
}

function mapUserRecord(record: ClaudeSessionUserRecord): TranscriptEntry[] {
  const createdAt = toMillis(record.timestamp)
  const content = record.message.content

  if (typeof content === "string") {
    const entry: UserPromptEntry = {
      _id: makeId(record.uuid, "user"),
      kind: "user_prompt",
      createdAt,
      content,
    }
    return [entry]
  }

  const entries: TranscriptEntry[] = []
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i]
    if (block.type === "tool_result") {
      const resultEntry: ToolResultEntry = {
        _id: makeId(record.uuid, `tool_result-${i}`),
        kind: "tool_result",
        createdAt,
        toolId: block.tool_use_id,
        content: typeof block.content === "string" ? block.content : block.content ?? null,
        isError: block.is_error === true,
      }
      entries.push(resultEntry)
    }
  }
  return entries
}

function mapAssistantRecord(record: ClaudeSessionAssistantRecord): TranscriptEntry[] {
  const createdAt = toMillis(record.timestamp)
  const messageId = record.message.id

  const entries: TranscriptEntry[] = []
  for (let i = 0; i < record.message.content.length; i += 1) {
    const block = record.message.content[i]
    if (block.type === "text") {
      const entry: AssistantTextEntry = {
        _id: makeId(record.uuid, `text-${i}`),
        messageId,
        kind: "assistant_text",
        createdAt,
        text: block.text,
      }
      entries.push(entry)
      continue
    }
    if (block.type === "tool_use") {
      const tool = normalizeToolCall({
        toolName: block.name,
        toolId: block.id,
        input: block.input ?? {},
      })
      const entry: ToolCallEntry = {
        _id: makeId(record.uuid, `tool_call-${i}`),
        messageId,
        kind: "tool_call",
        createdAt,
        tool,
      }
      entries.push(entry)
    }
  }
  return entries
}

export function mapClaudeRecordsToEntries(records: ClaudeSessionRecord[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const record of records) {
    if (record.type === "user") {
      entries.push(...mapUserRecord(record as ClaudeSessionUserRecord))
    } else if (record.type === "assistant") {
      entries.push(...mapAssistantRecord(record as ClaudeSessionAssistantRecord))
    }
    // summary / system / other: skipped
  }
  return entries
}

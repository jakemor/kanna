// src/server/claude-session-types.ts

export interface ClaudeSessionRecordBase {
  type: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  version?: string
}

export interface ClaudeSessionUserRecord extends ClaudeSessionRecordBase {
  type: "user"
  message: {
    role: "user"
    content: string | Array<
      | { type: "text"; text: string }
      | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
    >
  }
}

export interface ClaudeSessionAssistantRecord extends ClaudeSessionRecordBase {
  type: "assistant"
  message: {
    role: "assistant"
    id?: string
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >
  }
}

export interface ClaudeSessionSummaryRecord extends ClaudeSessionRecordBase {
  type: "summary"
  summary?: string
}

export interface ClaudeSessionSystemRecord extends ClaudeSessionRecordBase {
  type: "system"
  content?: string
}

export type ClaudeSessionRecord =
  | ClaudeSessionUserRecord
  | ClaudeSessionAssistantRecord
  | ClaudeSessionSummaryRecord
  | ClaudeSessionSystemRecord
  | ClaudeSessionRecordBase

export interface ParsedClaudeSession {
  sessionId: string
  filePath: string
  cwd: string
  firstTimestamp: number
  lastTimestamp: number
  records: ClaudeSessionRecord[]
  sourceHash: string
}

import type { AgentProvider, ProjectSummary, TranscriptEntry } from "../shared/types"

export interface ProjectRecord extends ProjectSummary {
  deletedAt?: number
}

export interface ChatRecord {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  unread: boolean
  provider: AgentProvider | null
  planMode: boolean
  sessionToken: string | null
  hasMessages?: boolean
  lastMessageAt?: number
  lastTurnOutcome: "success" | "failed" | "cancelled" | null
}

export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByPath: Map<string, string>
  chatsById: Map<string, ChatRecord>
}

export interface SnapshotFile {
  v: 2
  generatedAt: number
  projects: ProjectRecord[]
  chats: ChatRecord[]
  messages?: Array<{ chatId: string; entries: TranscriptEntry[] }>
}

export type ProjectEvent = {
  v: 2
  type: "project_opened"
  timestamp: number
  projectId: string
  localPath: string
  title: string
} | {
  v: 2
  type: "project_removed"
  timestamp: number
  projectId: string
}

export type ChatEvent =
  | {
      v: 2
      type: "chat_created"
      timestamp: number
      chatId: string
      projectId: string
      title: string
    }
  | {
      v: 2
      type: "chat_renamed"
      timestamp: number
      chatId: string
      title: string
    }
  | {
      v: 2
      type: "chat_deleted"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_provider_set"
      timestamp: number
      chatId: string
      provider: AgentProvider
    }
  | {
      v: 2
      type: "chat_plan_mode_set"
      timestamp: number
      chatId: string
      planMode: boolean
    }
  | {
      v: 2
      type: "chat_read_state_set"
      timestamp: number
      chatId: string
      unread: boolean
    }

export type MessageEvent = {
  v: 2
  type: "message_appended"
  timestamp: number
  chatId: string
  entry: TranscriptEntry
}

export type TurnEvent =
  | {
      v: 2
      type: "turn_started"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_finished"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_failed"
      timestamp: number
      chatId: string
      error: string
    }
  | {
      v: 2
      type: "turn_cancelled"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "session_token_set"
      timestamp: number
      chatId: string
      sessionToken: string | null
    }

export type StoreEvent = ProjectEvent | ChatEvent | MessageEvent | TurnEvent

export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(),
  }
}

export function cloneTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

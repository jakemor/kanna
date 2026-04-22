import type { AgentProvider, ProjectSummary, QueuedChatMessage, SlashCommand, TranscriptEntry } from "../shared/types"
import type { AutoContinueEvent } from "./auto-continue/events"

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
  sourceHash: string | null
  hasMessages?: boolean
  lastMessageAt?: number
  lastTurnOutcome: "success" | "failed" | "cancelled" | null
  slashCommands?: SlashCommand[]
}

export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByPath: Map<string, string>
  chatsById: Map<string, ChatRecord>
  queuedMessagesByChatId: Map<string, QueuedChatMessage[]>
  sidebarProjectOrder: string[]
  autoContinueEventsByChatId: Map<string, AutoContinueEvent[]>
}

export interface SnapshotFile {
  v: 3
  generatedAt: number
  projects: ProjectRecord[]
  chats: ChatRecord[]
  sidebarProjectOrder?: string[]
  queuedMessages?: Array<{ chatId: string; entries: QueuedChatMessage[] }>
  messages?: Array<{ chatId: string; entries: TranscriptEntry[] }>
  autoContinueEvents?: Array<{ chatId: string; events: AutoContinueEvent[] }>
}

export type ProjectEvent = {
  v: 3
  type: "project_opened"
  timestamp: number
  projectId: string
  localPath: string
  title: string
} | {
  v: 3
  type: "project_removed"
  timestamp: number
  projectId: string
} | {
  v: 3
  type: "sidebar_project_order_set"
  timestamp: number
  projectIds: string[]
}

export type ChatEvent =
  | {
      v: 3
      type: "chat_created"
      timestamp: number
      chatId: string
      projectId: string
      title: string
    }
  | {
      v: 3
      type: "chat_renamed"
      timestamp: number
      chatId: string
      title: string
    }
  | {
      v: 3
      type: "chat_deleted"
      timestamp: number
      chatId: string
    }
  | {
      v: 3
      type: "chat_provider_set"
      timestamp: number
      chatId: string
      provider: AgentProvider
    }
  | {
      v: 3
      type: "chat_plan_mode_set"
      timestamp: number
      chatId: string
      planMode: boolean
    }
  | {
      v: 3
      type: "chat_read_state_set"
      timestamp: number
      chatId: string
      unread: boolean
    }
  | {
      v: 3
      type: "chat_source_hash_set"
      timestamp: number
      chatId: string
      sourceHash: string | null
    }

export type MessageEvent = {
  v: 3
  type: "message_appended"
  timestamp: number
  chatId: string
  entry: TranscriptEntry
}

export type QueuedMessageEvent =
  | {
      v: 3
      type: "queued_message_enqueued"
      timestamp: number
      chatId: string
      message: QueuedChatMessage
    }
  | {
      v: 3
      type: "queued_message_removed"
      timestamp: number
      chatId: string
      queuedMessageId: string
    }

export type TurnEvent =
  | {
      v: 3
      type: "turn_started"
      timestamp: number
      chatId: string
    }
  | {
      v: 3
      type: "turn_finished"
      timestamp: number
      chatId: string
    }
  | {
      v: 3
      type: "turn_failed"
      timestamp: number
      chatId: string
      error: string
    }
  | {
      v: 3
      type: "turn_cancelled"
      timestamp: number
      chatId: string
    }
  | {
      v: 3
      type: "session_token_set"
      timestamp: number
      chatId: string
      sessionToken: string | null
    }
  | {
      v: 3
      type: "session_commands_loaded"
      timestamp: number
      chatId: string
      commands: Array<{ name: string; description: string; argumentHint: string }>
    }

export type StoreEvent = ProjectEvent | ChatEvent | MessageEvent | QueuedMessageEvent | TurnEvent | AutoContinueEvent

export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(),
    queuedMessagesByChatId: new Map(),
    sidebarProjectOrder: [],
    autoContinueEventsByChatId: new Map(),
  }
}

export function cloneTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

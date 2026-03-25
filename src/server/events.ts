import type { AgentProvider, FeatureBrowserState, FeatureStage, FeatureSummary, ProjectSummary, TranscriptEntry } from "../shared/types"

export interface ProjectRecord extends ProjectSummary {
  deletedAt?: number
}

export interface FeatureRecord extends FeatureSummary {
  deletedAt?: number
}

export interface ChatRecord {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  featureId?: string | null
  provider: AgentProvider | null
  planMode: boolean
  sessionToken: string | null
  lastMessageAt?: number
  lastTurnOutcome: "success" | "failed" | "cancelled" | null
}

export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByRepoKey: Map<string, string>
  projectIdsByPath: Map<string, string>
  featuresById: Map<string, FeatureRecord>
  chatsById: Map<string, ChatRecord>
  messagesByChatId: Map<string, TranscriptEntry[]>
  hiddenProjectKeys: Set<string>
}

export interface SnapshotFile {
  v: 3
  generatedAt: number
  projects: ProjectRecord[]
  features: FeatureRecord[]
  chats: ChatRecord[]
  messages: Array<{ chatId: string; entries: TranscriptEntry[] }>
  hiddenProjectKeys?: string[]
}

export type ProjectEvent = {
  v: 3
  type: "project_opened"
  timestamp: number
  projectId: string
  repoKey: string
  localPath: string
  worktreePaths: string[]
  title: string
} | {
  v: 3
  type: "project_worktree_added"
  timestamp: number
  projectId: string
  localPath: string
} | {
  v: 3
  type: "project_removed"
  timestamp: number
  projectId: string
} | {
  v: 3
  type: "project_hidden"
  timestamp: number
  repoKey: string
} | {
  v: 3
  type: "project_unhidden"
  timestamp: number
  repoKey: string
}

export type FeatureEvent =
  | {
      v: 3
      type: "feature_created"
      timestamp: number
      featureId: string
      projectId: string
      title: string
      description: string
      browserState?: FeatureBrowserState
      stage: FeatureStage
      sortOrder: number
      directoryRelativePath: string
      overviewRelativePath: string
    }
  | {
      v: 3
      type: "feature_renamed"
      timestamp: number
      featureId: string
      title: string
    }
  | {
      v: 3
      type: "feature_browser_state_set"
      timestamp: number
      featureId: string
      browserState: FeatureBrowserState
    }
  | {
      v: 3
      type: "feature_stage_set"
      timestamp: number
      featureId: string
      stage: FeatureStage
      sortOrder?: number
    }
  | {
      v: 3
      type: "feature_reordered"
      timestamp: number
      projectId: string
      orderedFeatureIds: string[]
    }
  | {
      v: 3
      type: "feature_deleted"
      timestamp: number
      featureId: string
    }

export type ChatEvent =
  | {
      v: 3
      type: "chat_created"
      timestamp: number
      chatId: string
      projectId: string
      title: string
      featureId?: string
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
      type: "chat_feature_set"
      timestamp: number
      chatId: string
      featureId: string | null
    }

export type MessageEvent = {
  v: 3
  type: "message_appended"
  timestamp: number
  chatId: string
  entry: TranscriptEntry
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

export type StoreEvent = ProjectEvent | FeatureEvent | ChatEvent | MessageEvent | TurnEvent

export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByRepoKey: new Map(),
    projectIdsByPath: new Map(),
    featuresById: new Map(),
    chatsById: new Map(),
    messagesByChatId: new Map(),
    hiddenProjectKeys: new Set(),
  }
}

export function cloneTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

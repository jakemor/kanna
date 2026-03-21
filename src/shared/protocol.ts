import type {
  AgentProvider,
  ChatUserMessage,
  ChatSnapshot,
  FileTreeDirectoryPage,
  FileTreeSnapshot,
  LocalProjectsSnapshot,
  ModelOptions,
  SidebarData,
} from "./types"

export type EditorPreset = "cursor" | "vscode" | "windsurf" | "custom"

export interface EditorOpenSettings {
  preset: EditorPreset
  commandTemplate: string
}

export type SubscriptionTopic =
  | { type: "sidebar" }
  | { type: "local-projects" }
  | { type: "file-tree"; projectId: string }
  | { type: "chat"; chatId: string }
  | { type: "terminal"; terminalId: string }

export interface TerminalSnapshot {
  terminalId: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  scrollback: number
  serializedState: string
  status: "running" | "exited"
  exitCode: number | null
  signal?: number
}

export type TerminalEvent =
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string; exitCode: number; signal?: number }

export type ClientCommand =
  | { type: "project.open"; localPath: string }
  | { type: "project.create"; localPath: string; title: string }
  | { type: "project.remove"; projectId: string }
  | { type: "system.ping" }
  | {
      type: "system.openExternal"
      localPath: string
      action: "open_finder" | "open_terminal" | "open_editor"
      line?: number
      column?: number
      editor?: EditorOpenSettings
    }
  | { type: "chat.create"; projectId: string }
  | { type: "chat.rename"; chatId: string; title: string }
  | { type: "chat.delete"; chatId: string }
  | {
      type: "chat.send"
      chatId?: string
      projectId?: string
      provider?: AgentProvider
      message: ChatUserMessage
      model?: string
      modelOptions?: ModelOptions
      effort?: string
      planMode?: boolean
    }
  | { type: "chat.cancel"; chatId: string }
  | { type: "chat.respondTool"; chatId: string; toolUseId: string; result: unknown }
  | { type: "terminal.create"; projectId: string; terminalId: string; cols: number; rows: number; scrollback: number }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  | {
      type: "file-tree.readDirectory"
      projectId: string
      directoryPath: string
      cursor?: string
      limit?: number
    }

export type ClientEnvelope =
  | { v: 1; type: "subscribe"; id: string; topic: SubscriptionTopic }
  | { v: 1; type: "unsubscribe"; id: string }
  | { v: 1; type: "command"; id: string; command: ClientCommand }

export type ServerSnapshot =
  | { type: "sidebar"; data: SidebarData }
  | { type: "local-projects"; data: LocalProjectsSnapshot }
  | { type: "file-tree"; data: FileTreeSnapshot }
  | { type: "chat"; data: ChatSnapshot | null }
  | { type: "terminal"; data: TerminalSnapshot | null }

export type FileTreeEvent = {
  type: "file-tree.invalidate"
  projectId: string
  directoryPaths: string[]
}

export type ServerEnvelope =
  | { v: 1; type: "snapshot"; id: string; snapshot: ServerSnapshot }
  | { v: 1; type: "event"; id: string; event: TerminalEvent | FileTreeEvent }
  | { v: 1; type: "ack"; id: string; result?: unknown }
  | { v: 1; type: "error"; id?: string; message: string }

export type FileTreeReadDirectoryResult = FileTreeDirectoryPage

export function isClientEnvelope(value: unknown): value is ClientEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ClientEnvelope>
  return candidate.v === 1 && typeof candidate.type === "string"
}

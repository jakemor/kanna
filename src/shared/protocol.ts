import type {
  AppSettingsSnapshot,
  AppSettingsPatch,
  AgentProvider,
  ChatAttachment,
  ChatDiffSnapshot,
  ChatHistoryPage,
  ChatSnapshot,
  ClaudeAuthSettings,
  CloudflareTunnelSettings,
  DiffCommitMode,
  KeybindingsSnapshot,
  LlmProviderSnapshot,
  LocalProjectsSnapshot,
  ModelOptions,
  PushConfigSnapshot,
  PushSubscribeRequestPayload,
  SidebarData,
  StandaloneTranscriptAttachmentMode,
  StandaloneTranscriptExportResult,
  Subagent,
  SubagentInput,
  SubagentPatch,
  SubagentValidationError,
  UpdateSnapshot,
  EditorPreset,
} from "./types"
import type { ChatPermissionPolicyOverride, ToolRequestDecision } from "./permission-policy"
import type { PtyInstanceDelta, PtyInstancesSnapshot } from "./pty-instance"

export type { EditorPreset }

export interface EditorOpenSettings {
  preset: EditorPreset
  commandTemplate: string
}

export type SubscriptionTopic =
  | { type: "sidebar" }
  | { type: "local-projects" }
  | { type: "update" }
  | { type: "keybindings" }
  | { type: "app-settings" }
  | { type: "push-config" }
  | { type: "chat"; chatId: string; recentLimit?: number }
  | { type: "project-git"; projectId: string }
  | { type: "terminal"; terminalId: string }
  | { type: "pty-instances" }

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

export type SubagentCommandResult =
  | { ok: true; subagent: Subagent }
  | { ok: false; error: SubagentValidationError }

export type SubagentDeleteResult = { ok: true }

export type PtyInstancesEvent =
  | { type: "pty-instances.added"; instance: Extract<PtyInstanceDelta, { type: "added" }>["instance"] }
  | { type: "pty-instances.updated"; instance: Extract<PtyInstanceDelta, { type: "updated" }>["instance"] }
  | { type: "pty-instances.removed"; chatId: string }

export type WsEvent = TerminalEvent | PtyInstancesEvent

export type ClientCommand =
  | { type: "project.open"; localPath: string }
  | { type: "project.create"; localPath: string; title: string }
  | { type: "sessions.importClaude" }
  | { type: "project.remove"; projectId: string }
  | { type: "project.setStar"; projectId: string; starred: boolean }
  | { type: "sidebar.reorderProjectGroups"; projectIds: string[] }
  | { type: "project.readDiffPatch"; projectId: string; path: string }
  | { type: "stack.create"; title: string; projectIds: string[] }
  | { type: "stack.rename"; stackId: string; title: string }
  | { type: "stack.remove"; stackId: string }
  | { type: "stack.addProject"; stackId: string; projectId: string }
  | { type: "stack.removeProject"; stackId: string; projectId: string }
  | { type: "stack.listWorktrees"; projectId: string }
  | { type: "system.ping" }
  | { type: "update.check"; force?: boolean }
  | { type: "update.install"; version?: string }
  | { type: "update.reload" }
  | { type: "settings.readKeybindings" }
  | { type: "settings.writeKeybindings"; bindings: KeybindingsSnapshot["bindings"] }
  | { type: "settings.readAppSettings" }
  | { type: "settings.writeAppSettings"; analyticsEnabled: boolean }
  | { type: "appSettings.setCloudflareTunnel"; patch: Partial<CloudflareTunnelSettings> }
  | { type: "appSettings.setClaudeAuth"; patch: Partial<ClaudeAuthSettings> }
  | { type: "appSettings.testOAuthToken"; token: string }
  | { type: "settings.writeAppSettingsPatch"; patch: AppSettingsPatch }
  | { type: "subagent.create"; input: SubagentInput }
  | { type: "subagent.update"; id: string; patch: SubagentPatch }
  | { type: "subagent.delete"; id: string }
  | { type: "settings.testMcpServer"; id: string }
  | { type: "settings.readLlmProvider" }
  | { type: "skills.search"; query: string; limit?: number }
  | { type: "skills.install"; source: string; skillId: string }
  | { type: "skills.uninstall"; skillId: string }
  | { type: "skills.listInstalled" }
  | {
      type: "settings.writeLlmProvider"
      provider: LlmProviderSnapshot["provider"]
      apiKey: string
      model: string
      baseUrl: string
    }
  | {
      type: "settings.validateLlmProvider"
      provider: LlmProviderSnapshot["provider"]
      apiKey: string
      model: string
      baseUrl: string
    }
  | {
      type: "system.openExternal"
      localPath: string
      action: "open_finder" | "open_terminal" | "open_editor" | "open_preview" | "open_default"
      line?: number
      column?: number
      editor?: EditorOpenSettings
    }
  | {
      type: "chat.create"
      projectId: string
      stackId?: string
      stackBindings?: Array<{ projectId: string; worktreePath: string; role: "primary" | "additional" }>
    }
  | { type: "chat.fork"; chatId: string }
  | { type: "chat.rename"; chatId: string; title: string }
  | { type: "chat.archive"; chatId: string }
  | { type: "chat.unarchive"; chatId: string }
  | { type: "chat.delete"; chatId: string }
  | { type: "chat.setDraftProtection"; chatIds: string[] }
  | { type: "chat.markRead"; chatId: string }
  | { type: "chat.setPolicyOverride"; chatId: string; policyOverride: ChatPermissionPolicyOverride | null }
  | {
      type: "chat.send"
      chatId?: string
      projectId?: string
      clientTraceId?: string
      provider?: AgentProvider
      content: string
      attachments?: ChatAttachment[]
      model?: string
      modelOptions?: ModelOptions
      effort?: string
      planMode?: boolean
      autoResumeOnRateLimit?: boolean
    }
  | { type: "chat.refreshDiffs"; chatId: string }
  | { type: "chat.initGit"; chatId: string }
  | { type: "chat.getGitHubPublishInfo"; chatId: string }
  | { type: "chat.checkGitHubRepoAvailability"; chatId: string; owner: string; name: string }
  | {
      type: "chat.publishToGitHub"
      chatId: string
      owner: string
      name: string
      visibility: "public" | "private"
      description?: string
    }
  | { type: "chat.listBranches"; chatId: string }
  | {
      type: "chat.previewMergeBranch"
      chatId: string
      branch:
      | { kind: "local"; name: string }
      | { kind: "remote"; name: string; remoteRef: string }
      | {
          kind: "pull_request"
          name: string
          prNumber: number
          headRefName: string
          headRepoCloneUrl?: string
          isCrossRepository?: boolean
          remoteRef?: string
        }
    }
  | {
      type: "chat.mergeBranch"
      chatId: string
      branch:
      | { kind: "local"; name: string }
      | { kind: "remote"; name: string; remoteRef: string }
      | {
          kind: "pull_request"
          name: string
          prNumber: number
          headRefName: string
          headRepoCloneUrl?: string
          isCrossRepository?: boolean
          remoteRef?: string
        }
    }
  | { type: "chat.syncBranch"; chatId: string; action: "fetch" | "pull" | "push" | "publish" }
  | {
      type: "chat.checkoutBranch"
      chatId: string
      branch:
      | { kind: "local"; name: string }
      | { kind: "remote"; name: string; remoteRef: string }
      | {
          kind: "pull_request"
          name: string
          prNumber: number
          headRefName: string
          headRepoCloneUrl?: string
          isCrossRepository?: boolean
          remoteRef?: string
        }
      bringChanges?: boolean
    }
  | { type: "chat.createBranch"; chatId: string; name: string; baseBranchName?: string }
  | { type: "chat.generateCommitMessage"; chatId: string; paths: string[] }
  | { type: "chat.commitDiffs"; chatId: string; paths: string[]; summary: string; description?: string; mode: DiffCommitMode }
  | { type: "chat.discardDiffFile"; chatId: string; path: string }
  | { type: "chat.ignoreDiffFile"; chatId: string; path: string }
  | { type: "chat.cancel"; chatId: string }
  | { type: "chat.stopDraining"; chatId: string }
  | {
      type: "chat.exportStandalone"
      chatId: string
      theme: "light" | "dark"
      attachmentMode: StandaloneTranscriptAttachmentMode
    }
  | { type: "chat.loadHistory"; chatId: string; beforeCursor: string; limit: number }
  | { type: "chat.respondTool"; chatId: string; toolUseId: string; result: unknown }
  | {
      type: "chat.toolRequestAnswer"
      chatId: string
      toolRequestId: string
      decision: ToolRequestDecision
    }
  | { type: "chat.respondSubagentTool"; chatId: string; runId: string; toolUseId: string; result: unknown }
  | {
      type: "chat.cancelSubagentRun"
      chatId: string
      runId: string
    }
  | {
      type: "message.enqueue"
      chatId: string
      content: string
      attachments?: ChatAttachment[]
      provider?: AgentProvider
      model?: string
      modelOptions?: ModelOptions
      planMode?: boolean
      autoResumeOnRateLimit?: boolean
    }
  | {
      type: "message.steer"
      chatId: string
      queuedMessageId: string
    }
  | {
      type: "message.dequeue"
      chatId: string
      queuedMessageId: string
    }
  | { type: "autoContinue.accept"; chatId: string; scheduleId: string; scheduledAt: number }
  | { type: "autoContinue.reschedule"; chatId: string; scheduleId: string; scheduledAt: number }
  | { type: "autoContinue.cancel"; chatId: string; scheduleId: string }
  | { type: "tunnel.accept"; chatId: string; tunnelId: string }
  | { type: "tunnel.stop"; chatId: string; tunnelId: string }
  | { type: "tunnel.retry"; chatId: string; tunnelId: string }
  | { type: "terminal.create"; projectId: string; terminalId: string; cols: number; rows: number; scrollback: number }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  | { type: "pty.cancel"; chatId: string }
  | { type: "pty.kill"; chatId: string }
  | { type: "push.identifyDevice"; pushDeviceId: string | null }
  | { type: "push.subscribe"; subscription: PushSubscribeRequestPayload; label: string; userAgent: string }
  | { type: "push.unsubscribe"; pushDeviceId: string }
  | { type: "push.test" }
  | { type: "push.setProjectMute"; localPath: string; muted: boolean }
  | { type: "push.setFocusedChat"; chatId: string | null }

export type OpenExternalAction = Extract<ClientCommand, { type: "system.openExternal" }>["action"]

export type ClientEnvelope =
  | { v: 1; type: "subscribe"; id: string; topic: SubscriptionTopic }
  | { v: 1; type: "unsubscribe"; id: string }
  | { v: 1; type: "command"; id: string; command: ClientCommand }

export type ServerSnapshot =
  | { type: "sidebar"; data: SidebarData }
  | { type: "local-projects"; data: LocalProjectsSnapshot }
  | { type: "update"; data: UpdateSnapshot }
  | { type: "keybindings"; data: KeybindingsSnapshot }
  | { type: "app-settings"; data: AppSettingsSnapshot }
  | { type: "llm-provider"; data: LlmProviderSnapshot }
  | { type: "push-config"; data: PushConfigSnapshot }
  | { type: "chat"; data: ChatSnapshot | null }
  | { type: "project-git"; data: ChatDiffSnapshot | null }
  | { type: "terminal"; data: TerminalSnapshot | null }
  | { type: "pty-instances"; data: PtyInstancesSnapshot }

export type ServerEnvelope =
  | { v: 1; type: "snapshot"; id: string; snapshot: ServerSnapshot }
  | { v: 1; type: "event"; id: string; event: WsEvent }
  | { v: 1; type: "ack"; id: string; result?: unknown | ChatHistoryPage | StandaloneTranscriptExportResult }
  | { v: 1; type: "error"; id?: string; message: string }

export function isClientEnvelope(value: unknown): value is ClientEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ClientEnvelope>
  return candidate.v === 1 && typeof candidate.type === "string"
}

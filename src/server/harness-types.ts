import type { AccountInfo, AgentProvider, NormalizedToolCall, TranscriptEntry } from "../shared/types"

export interface HarnessEvent {
  type: "transcript" | "session_token"
  entry?: TranscriptEntry
  sessionToken?: string
}

export interface HarnessToolRequest {
  tool: NormalizedToolCall & {
    toolKind:
      | "ask_user_question"
      | "exit_plan_mode"
      | "codex_command_approval"
      | "codex_file_change_approval"
      | "codex_mcp_approval"
      | "codex_permissions_approval"
  }
}

export interface HarnessTurn {
  provider: AgentProvider
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  interrupt: () => Promise<void>
  close: () => void
}

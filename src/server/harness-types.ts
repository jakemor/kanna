import type { AccountInfo, AgentProvider, NormalizedToolCall, TranscriptEntry } from "../shared/types"

export interface HarnessEvent {
  type: "transcript" | "session_token"
  entry?: TranscriptEntry
  sessionToken?: string
  /** Claude results: the ids of the prompts this turn answered, as the CLI echoes them. */
  promptIds?: string[]
}

export interface HarnessToolRequest {
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" | "request_secrets" }
  /** Shared tools write their own result after the user replies. */
  resultOwner?: "tool"
  validateResult?: (result: unknown) => void
}

export interface HarnessTurn {
  provider: AgentProvider
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  interrupt: () => Promise<void>
  close: () => void
}

export type {
  AccountInfo,
  AskUserQuestionItem,
  AskUserQuestionOption,
  HydratedTranscriptMessage,
  HydratedToolCall as ProcessedToolCall,
} from "../../../shared/types"

export type ProcessedTextMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "assistant_text" }
>

export type ProcessedThoughtMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "assistant_thought" }
>

export type ProcessedSystemMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "system_init" }
>

export type ProcessedAccountInfoMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "account_info" }
>

export type ProcessedResultMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "result" }
>

export type ProcessedCompactBoundaryMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "compact_boundary" }
>

export type ProcessedCompactSummaryMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "compact_summary" }
>

export type ProcessedContextClearedMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "context_cleared" }
>

export type ProcessedStatusMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "status" }
>

export type ProcessedInterruptedMessage = Extract<
  import("../../../shared/types").HydratedTranscriptMessage,
  { kind: "interrupted" }
>

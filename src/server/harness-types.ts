import type { Effect, Stream } from "effect"
import type { AccountInfo, AgentProvider, NormalizedToolCall, TranscriptEntry } from "../shared/types"

export interface HarnessEvent {
  type: "transcript" | "session_token"
  entry?: TranscriptEntry
  sessionToken?: string
  /** Claude results: the ids of the prompts this turn answered, as the CLI echoes them. */
  promptIds?: string[]
}

export interface HarnessToolRequest {
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
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

/**
 * A provider turn on Effect: what the adapters (codex, cursor, grok, pi)
 * return from `startTurn` as they migrate.
 *
 * The turn lives in the `Scope` its `startTurn` ran in: closing that scope
 * is `close()` — it stops the provider's process or session and ends
 * `events`. `interrupt` asks the provider to stop the turn and lets
 * `events` finish on its own, as `interrupt()` did.
 *
 * `events` fails with the provider's own tagged errors where the old
 * AsyncIterable threw; the agent reads those as it read the throws.
 */
export interface HarnessTurnEffect<E = never, IE = never, AE = never> {
  readonly provider: AgentProvider
  readonly events: Stream.Stream<HarnessEvent, E>
  readonly accountInfo?: Effect.Effect<AccountInfo | null, AE>
  readonly interrupt: Effect.Effect<void, IE>
}

/** A provider turn whose owning scope can be closed by the coordinator. */
export interface ManagedHarnessTurn<E = never, IE = never, AE = never> extends HarnessTurnEffect<E, IE, AE> {
  readonly close: Effect.Effect<void>
}

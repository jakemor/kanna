import type { HarnessToolRequest, HarnessTurn } from "./harness-types"
import type { CodexAppServerManager } from "./codex-app-server"
import type {
  AgentProvider,
  CodexReasoningEffort,
  ProviderUsage,
  Subagent,
  TranscriptEntry,
} from "../shared/types"
import type { ClaudeSessionHandle } from "./agent"
import type { ProviderRunStart } from "./subagent-orchestrator"
import type { SubagentOrchestrator } from "./subagent-orchestrator"
import type { KannaMcpDelegationContext } from "./kanna-mcp"

/**
 * Builds a ProviderRunStart for a single subagent run. Each call returns a
 * fresh ProviderRunStart bound to one (subagent, chatId) pair — the orchestrator
 * invokes start() exactly once per run, then discards.
 */
export interface BuildSubagentProviderRunArgs {
  subagent: Subagent
  chatId: string
  primer: string | null
  /**
   * The instruction that triggered this run — the user's typed message when
   * spawned from a `@agent/<name>` mention, the parent agent's reply text for
   * chained mentions, or null when no instruction is available (e.g. a
   * background trigger). Always rendered above the primer so the subagent
   * sees the request before the context.
   */
  userInstruction: string | null
  runId: string
  /** Abort signal from the run's AbortController; triggers cancellation of the provider session. */
  abortSignal: AbortSignal
  /** Project cwd shared with the parent chat. */
  cwd: string
  additionalDirectories?: string[]
  /**
   * Subset of `AgentCoordinatorArgs["startClaudeSession"]` (`agent.ts:148-172`).
   * Subagents intentionally omit `tunnelGateway` — they don't tunnel-route.
   * Structural typing accepts the canonical fn (which has the extra optional
   * field) since the missing prop is optional from the canonical side.
   */
  startClaudeSession: (args: {
    projectId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    oauthToken: string | null
    additionalDirectories?: string[]
    chatId?: string
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    systemPromptOverride?: string
    initialPrompt?: string
    subagentOrchestrator?: SubagentOrchestrator
    delegationContext?: KannaMcpDelegationContext
  }) => Promise<ClaudeSessionHandle>
  /** Optional — propagated into the subagent's own kanna-mcp so it can call `delegate_subagent`. */
  subagentOrchestrator?: SubagentOrchestrator
  /** Optional — per-spawn delegation context forwarded to kanna-mcp for sub-spawn-sub. */
  delegationContext?: KannaMcpDelegationContext
  codexManager: CodexAppServerManager
  /** Forwards interactive tool requests (AskUserQuestion / ExitPlanMode) to the parent chat's UI handler. */
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  /** Resolves credentials per provider. Returns false → run fails AUTH_REQUIRED. */
  authReady: (provider: AgentProvider) => Promise<boolean>
  /** Picks an oauth token for Claude runs, or null. Subagents share the primary pool. */
  pickOauthToken: () => string | null
  projectId: string
}

export function buildSubagentProviderRun(args: BuildSubagentProviderRunArgs): ProviderRunStart {
  return {
    provider: args.subagent.provider,
    model: args.subagent.model,
    systemPrompt: args.subagent.systemPrompt,
    preamble: args.primer,
    authReady: async () => args.authReady(args.subagent.provider),
    async start(onChunk, onEntry) {
      const initialPrompt = composeInitialPrompt(args.subagent, args.primer, args.userInstruction)
      if (args.subagent.provider === "claude") {
        return runClaudeSubagent({ args, initialPrompt, onChunk, onEntry })
      }
      return runCodexSubagent({ args, initialPrompt, onChunk, onEntry })
    },
  }
}

export function composeInitialPrompt(
  subagent: Subagent,
  primer: string | null,
  userInstruction: string | null,
): string {
  const instruction = userInstruction?.trim() ?? ""
  const primerText = primer?.trim() ?? ""
  if (instruction && primerText) {
    return `User asked: ${instruction}\n\n${primerText}`
  }
  if (instruction) return `User asked: ${instruction}`
  if (primerText) return primerText
  return `(no prior context — proceed based on your system prompt and the @agent/${subagent.name} mention)`
}

async function runClaudeSubagent(opts: {
  args: BuildSubagentProviderRunArgs
  initialPrompt: string
  onChunk: (chunk: string) => void
  onEntry: (entry: TranscriptEntry) => void
}): Promise<{ text: string; usage?: ProviderUsage }> {
  const { args, initialPrompt, onChunk, onEntry } = opts
  const session = await args.startClaudeSession({
    projectId: args.projectId,
    localPath: args.cwd,
    additionalDirectories: args.additionalDirectories,
    model: args.subagent.model,
    effort: args.subagent.modelOptions?.reasoningEffort,
    planMode: false,
    sessionToken: null,
    forkSession: false,
    oauthToken: args.pickOauthToken(),
    chatId: args.chatId,
    onToolRequest: args.onToolRequest,
    systemPromptOverride: args.subagent.systemPrompt,
    initialPrompt,
    subagentOrchestrator: args.subagentOrchestrator,
    delegationContext: args.delegationContext,
  })
  args.abortSignal.addEventListener("abort", () => { session.interrupt() }, { once: true })
  try {
    return await drainHarnessTurn(session, onChunk, onEntry)
  } finally {
    session.close()
  }
}

async function runCodexSubagent(opts: {
  args: BuildSubagentProviderRunArgs
  initialPrompt: string
  onChunk: (chunk: string) => void
  onEntry: (entry: TranscriptEntry) => void
}): Promise<{ text: string; usage?: ProviderUsage }> {
  const { args, initialPrompt, onChunk, onEntry } = opts
  const scope = `sub:${args.runId}` as const
  args.abortSignal.addEventListener("abort", () => { args.codexManager.stopSession(args.chatId, scope) }, { once: true })
  await args.codexManager.startSession({
    chatId: args.chatId,
    scope,
    cwd: args.cwd,
    model: args.subagent.model,
    serviceTier: undefined,
    sessionToken: null,
  })
  try {
    const turn = await args.codexManager.startTurn({
      chatId: args.chatId,
      scope,
      content: initialPrompt,
      model: args.subagent.model,
      // modelOptions is ClaudeModelOptions | CodexModelOptions; runtime-narrowed
      // by the outer provider check, but TS doesn't propagate that to modelOptions.
      effort: args.subagent.modelOptions?.reasoningEffort as CodexReasoningEffort | undefined,
      serviceTier: undefined,
      planMode: false,
      onToolRequest: args.onToolRequest,
    })
    return await drainHarnessTurn(turn, onChunk, onEntry)
  } finally {
    args.codexManager.stopSession(args.chatId, scope)
  }
}

async function drainHarnessTurn(
  turn: HarnessTurn,
  onChunk: (chunk: string) => void,
  onEntry: (entry: TranscriptEntry) => void,
): Promise<{ text: string; usage?: ProviderUsage }> {
  let accumulated = ""
  let usage: ProviderUsage | undefined
  for await (const event of turn.stream) {
    if (event.type !== "transcript" || !event.entry) continue
    onEntry(event.entry)
    if (event.entry.kind === "assistant_text") {
      const fragment = event.entry.text
      accumulated += fragment
      onChunk(fragment)
    } else if (event.entry.kind === "result") {
      const e = event.entry
      usage = {
        inputTokens: e.usage?.inputTokens,
        outputTokens: e.usage?.outputTokens,
        cachedInputTokens: e.usage?.cachedInputTokens,
        costUsd: e.costUsd,
      }
    }
  }
  return { text: accumulated, usage }
}

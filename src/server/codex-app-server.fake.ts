import { Effect, Stream } from "effect"
import type { CodexAppServer, CodexTaskActivityListener, StartCodexSessionArgs, StartCodexTurnArgs, StartedCodexSession } from "./codex-app-server"
import { runKanna } from "./effect/bridge"
import type { HarnessToolRequest, HarnessTurn } from "./harness-types"

/** A turn's args as a Promise-shaped stand-in sees them: callbacks return Promises. */
export type PromiseCodexTurnArgs = Omit<StartCodexTurnArgs, "onToolRequest" | "onApprovalRequest"> & {
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  /**
   * Codex takes the tool host on the session, never on a turn. Declared so a
   * stand-in shared with a provider that takes it on the turn (pi) fits.
   */
  customTools?: undefined
}

/**
 * The Promise-shaped stand-ins agent.ts's tests (and the orchestrator's) were
 * written against: every method optional, `startTurn` returning a
 * `HarnessTurn`.
 */
export interface PromiseCodexStandIn {
  startSession?: (args: StartCodexSessionArgs) => Promise<StartedCodexSession | undefined | void>
  startTurn?: (args: PromiseCodexTurnArgs) => Promise<HarnessTurn>
  stopSession?: (chatId: string) => void
  stopAll?: () => void
  stopAgent?: (chatId: string, agentThreadId: string) => Promise<boolean>
  stopAgents?: (chatId: string) => Promise<void>
  setTaskActivityListener?: (listener: CodexTaskActivityListener | null) => void
}

/**
 * A `CodexAppServer` over a Promise-shaped stand-in, so those tests keep
 * their fakes while agent.ts reads the Effect service. Turns go through
 * `toHarnessTurn` in the agent and come back out as the stand-in's own
 * `HarnessTurn`. Goes with the stand-ins when agent.ts moves to Effect.
 */
export function fakeCodexAppServer(standIn: PromiseCodexStandIn = {}): CodexAppServer["Service"] {
  return {
    startSession: (args) => Effect.promise(async () => (await standIn.startSession?.(args)) ?? undefined),
    startTurn: (args) => Effect.gen(function* () {
      if (!standIn.startTurn) return yield* Effect.die(new Error("This fake Codex has no startTurn"))
      const turn = yield* Effect.promise(() => standIn.startTurn!({
        ...args,
        onToolRequest: (request) => runKanna(args.onToolRequest(request)),
      }))
      yield* Effect.addFinalizer(() => Effect.sync(() => turn.close()))
      return {
        provider: turn.provider,
        // What the stand-in's stream throws comes back out of the agent's iterator as it was.
        events: Stream.fromAsyncIterable(turn.stream, (error) => error).pipe(Stream.orDie),
        interrupt: Effect.promise(() => turn.interrupt()),
        ...(turn.getAccountInfo ? { accountInfo: Effect.promise(() => turn.getAccountInfo!()) } : {}),
      }
    }),
    listSkills: () => Effect.succeed(null),
    listModels: () => Effect.succeed(null),
    readAccountRateLimits: () => Effect.succeed(null),
    generateStructured: () => Effect.succeed(null),
    stopAgent: (chatId, agentThreadId) => Effect.promise(async () => (await standIn.stopAgent?.(chatId, agentThreadId)) ?? false),
    stopAgents: (chatId) => Effect.promise(async () => {
      await standIn.stopAgents?.(chatId)
    }),
    stopSession: (chatId) => Effect.sync(() => standIn.stopSession?.(chatId)),
    stopAll: Effect.sync(() => standIn.stopAll?.()),
    resourceCounts: Effect.succeed({ codexSessions: 0, codexPendingRequests: 0, codexStderrChars: 0 }),
    rateLimitPushes: Stream.empty,
    setTaskActivityListener: (listener) => standIn.setTaskActivityListener?.(listener),
  }
}

import { Cause, Effect, Exit, Result } from "effect"
import type { ChatRecord } from "./events"
import type { EventStore } from "./event-store"

/**
 * Boot-time counterpart to `AgentCoordinator.interruptForShutdown`: pick back
 * up every chat whose turn the previous process cut short by exiting.
 *
 * Only chats the shutdown actually marked are considered — a crash that never
 * ran the shutdown path leaves no marker and no resume, which is deliberate.
 * Inferring "in progress" from `lastTurnStartedAt > lastTurnEndedAt` instead
 * would make every chat ever killed with `kill -9`, including ones from months
 * ago, start running again on the next upgrade.
 */
export interface ResumeInterruptedTurnsDeps<E> {
  store: Pick<EventStore["Service"], "state" | "setTurnResumePending">
  agent: {
    resumeInterruptedTurnEffect: (chatId: string) => Effect.Effect<boolean, E>
  }
  onError?: (chatId: string, error: unknown) => void
}

function isResumable(chat: ChatRecord) {
  if (!chat.resumePending) return false
  // Deleted is self-explanatory; archived means the user put the chat away
  // between the turn starting and the shutdown, and starting an agent in it
  // behind their back is worse than leaving the turn interrupted.
  return !chat.deletedAt && !chat.archivedAt
}

/**
 * Resumes each marked chat and returns the ids that actually started a turn.
 *
 * Sequential rather than parallel: every resume spawns a harness process, and
 * a machine that went down with six chats running should not try to bring six
 * of them up in the same instant as the rest of boot.
 */
export const resumeInterruptedTurns = Effect.fn("ResumeTurns.resumeInterruptedTurns")(function* <E>(deps: ResumeInterruptedTurnsDeps<E>) {
  const pending = [...deps.store.state.chatsById.values()]
    .filter(isResumable)
    // Oldest interruption first, so the resumes go out in the order the turns
    // originally started rather than in map order.
    .sort((left, right) => (left.lastTurnStartedAt ?? left.updatedAt) - (right.lastTurnStartedAt ?? right.updatedAt))

  const resumed: string[] = []
  for (const chat of pending) {
    const resumedOne = Effect.gen(function* () {
      const cleared = yield* Effect.result(deps.store.setTurnResumePending(chat.id, false))
      if (Result.isFailure(cleared)) {
        deps.onError?.(chat.id, "cause" in cleared.failure ? cleared.failure.cause : cleared.failure)
        return false
      }

      // A crash resuming one chat is reported like a failure and the next
      // chat still gets its turn, as the old per-chat try/catch did.
      const attempt = yield* Effect.exit(deps.agent.resumeInterruptedTurnEffect(chat.id))
      if (Exit.isSuccess(attempt)) return attempt.value
      if (Cause.hasInterruptsOnly(attempt.cause)) return yield* Effect.interrupt
      deps.onError?.(chat.id, Cause.squash(attempt.cause))
      return false
    }).pipe(Effect.onInterrupt(() => deps.store.setTurnResumePending(chat.id, true).pipe(Effect.orDie)))
    if (yield* resumedOne) resumed.push(chat.id)
  }

  return resumed
})

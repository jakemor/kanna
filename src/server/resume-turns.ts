import type { ChatRecord, StoreState } from "./events"

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
export interface ResumeInterruptedTurnsDeps {
  store: {
    state: StoreState
    setTurnResumePending: (chatId: string, pending: boolean) => Promise<void>
  }
  agent: {
    resumeInterruptedTurn: (chatId: string) => Promise<boolean>
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
export async function resumeInterruptedTurns(deps: ResumeInterruptedTurnsDeps): Promise<string[]> {
  const pending = [...deps.store.state.chatsById.values()]
    .filter(isResumable)
    // Oldest interruption first, so the resumes go out in the order the turns
    // originally started rather than in map order.
    .sort((left, right) => (left.lastTurnStartedAt ?? left.updatedAt) - (right.lastTurnStartedAt ?? right.updatedAt))

  const resumed: string[] = []
  for (const chat of pending) {
    // Cleared *before* the attempt: a chat that can't be resumed (no session
    // to resume into, harness fails to start) must not be retried on every
    // boot from here to eternity. One shutdown earns one resume attempt.
    try {
      await deps.store.setTurnResumePending(chat.id, false)
    } catch (error) {
      deps.onError?.(chat.id, error)
      continue
    }

    try {
      if (await deps.agent.resumeInterruptedTurn(chat.id)) {
        resumed.push(chat.id)
      }
    } catch (error) {
      deps.onError?.(chat.id, error)
    }
  }

  return resumed
}

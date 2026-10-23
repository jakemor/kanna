import { Effect } from "effect"
import type { ChatAgent } from "./chat-agent"

/**
 * A `ChatAgent` with nothing running, which records the turn commands it is
 * given in `calls`. Pass `overrides` for the methods a test cares about.
 */
export function makeFakeChatAgent(overrides: Partial<ChatAgent["Service"]> = {}): { agent: ChatAgent["Service"]; calls: string[] } {
  const calls: string[] = []
  const agent: ChatAgent["Service"] = {
    isBusy: () => false,
    isDraining: () => false,
    hasDelegatedWork: () => false,
    getLeftRunning: () => [],
    isPlanning: () => false,
    getActiveStatuses: () => new Map(),
    send: (command) => Effect.sync(() => {
      calls.push("send")
      return { chatId: command.chatId ?? "c" }
    }),
    enqueue: () => Effect.sync(() => {
      calls.push("enqueue")
      return { queuedMessageId: "q" }
    }),
    steer: () => Effect.sync(() => { calls.push("steer") }),
    dequeue: () => Effect.sync(() => { calls.push("dequeue") }),
    cancel: (chatId) => Effect.sync(() => { calls.push(`cancel:${chatId}`) }),
    closeChat: (chatId) => Effect.sync(() => { calls.push(`close:${chatId}`) }),
    forkChat: () => Effect.succeed({ chatId: "fork" }),
    ...overrides,
  }
  return { agent, calls }
}

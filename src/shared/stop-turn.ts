import type { SubagentActivity } from "./types"

/**
 * How many sub-chats a stop with `cascade` would stop as well: the running
 * ones this chat started. An adopted chat is never stopped with its parent
 * (`ChatOrchestrator.handleChatStopped`), so it is not counted.
 *
 * With none, stop is one press and stops the turn. With some, the stop
 * button asks whether they stop too. The iOS app counts the same way
 * (`StopChoice.cascadingSubchats`).
 */
export function countCascadingSubchats(subagents: readonly SubagentActivity[] | undefined): number {
  if (!subagents) return 0
  let count = 0
  for (const activity of subagents) {
    if (activity.type === "chat" && activity.status === "running" && !activity.adopted) count += 1
  }
  return count
}

/**
 * What a stop does. `ask` puts the choice in front of the user: "Stop this
 * turn" or the turn and its sub-chats. With no sub-chats running there is
 * nothing to choose, and the flag is left off so the stop is exactly the one
 * from before the choice. The keyboard (holding Escape) stops only the turn:
 * a key has no menu to answer, and it is the stop that loses nothing.
 */
export type StopIntent =
  | { kind: "stop"; cascade?: false }
  | { kind: "ask"; count: number }

export function resolveStop(cascadingSubchats: number, via: "button" | "keyboard"): StopIntent {
  if (cascadingSubchats <= 0) return { kind: "stop" }
  if (via === "keyboard") return { kind: "stop", cascade: false }
  return { kind: "ask", count: cascadingSubchats }
}

/** The label of the stop that takes the sub-chats with it. */
export function cascadeStopLabel(count: number) {
  return `Stop this turn and ${count} ${count === 1 ? "sub-chat" : "sub-chats"}`
}

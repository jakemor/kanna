import { generateUUID } from "./utils"

/**
 * The router-state contract for opening a chat *at a message*.
 *
 * The URL stays `/chat/:chatId` — a jump is not a location, it's an instruction
 * carried alongside one. Putting it in history state rather than the path keeps
 * chat identity the single thing the URL means, and keeps a shared or reloaded
 * link landing wherever the reader left off rather than replaying someone
 * else's jump.
 *
 * `requestId` is what makes a repeat click work: navigating to the chat you are
 * already in produces the same pathname, so the message id alone can't say
 * "again". The chat page spends the id and clears the state.
 */
/**
 * Which end of the last exchange to land on.
 *
 * A role rather than a message id, because the sidebar doesn't know message
 * ids and doesn't need to: the card shows a chat's *latest* prompt and its
 * *latest* reply by construction, and the transcript already identifies both —
 * the minimap slices turns out of the same rows. Naming the role lets the side
 * that has the transcript answer the question, instead of the side that has
 * only a preview string carrying an id along for it.
 */
export type ChatJumpRole = "prompt" | "reply"

export interface ChatJumpLocationState {
  jumpToRole: ChatJumpRole
  jumpRequestId: string
}

export function buildChatJumpLocationState(role: ChatJumpRole): ChatJumpLocationState {
  // generateUUID, not crypto.randomUUID: the latter is secure-context only and
  // is undefined over plain http on a LAN/Tailscale hostname.
  return { jumpToRole: role, jumpRequestId: generateUUID() }
}

/** Reads the jump out of an opaque `useLocation().state`, or null if absent. */
export function readChatJumpLocationState(state: unknown): ChatJumpLocationState | null {
  if (!state || typeof state !== "object") return null
  const { jumpToRole, jumpRequestId } = state as Partial<ChatJumpLocationState>
  if (jumpToRole !== "prompt" && jumpToRole !== "reply") return null
  if (typeof jumpRequestId !== "string" || !jumpRequestId) return null
  return { jumpToRole, jumpRequestId }
}

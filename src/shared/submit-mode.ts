import type { SubmitWhileRunning } from "./types"

/**
 * Whether a send should interrupt the running turn rather than queue behind it.
 *
 * The setting decides what a bare Enter does, and the modifier (⌘/Ctrl+Enter,
 * or a modified click on the send button) always asks for the other one — so
 * whichever way the default is set, both actions stay one keystroke away and
 * neither becomes unreachable.
 */
export function shouldSteerSubmit(mode: SubmitWhileRunning, withModifier: boolean) {
  return (mode === "steer") !== withModifier
}

/**
 * What ⌘/Ctrl+Enter does. With anything in the composer, text or an
 * attachment (even one still uploading), it sends that as it always has.
 * With nothing there it has nothing of its own to send, so it sends the
 * oldest queued message now: what that message's Send now does, which also
 * resumes a queue a stop left paused. Whitespace is nothing, as it is to
 * Send.
 */
export function resolveModifiedEnter(
  composer: { text: string; attachmentCount: number },
  hasQueuedMessage: boolean
): "composer" | "send-oldest-queued" | "none" {
  if (composer.text.trim().length > 0 || composer.attachmentCount > 0) return "composer"
  return hasQueuedMessage ? "send-oldest-queued" : "none"
}

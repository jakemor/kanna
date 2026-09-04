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

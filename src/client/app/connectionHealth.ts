/**
 * How the connection reads to a person, as against `SocketStatus`, which is
 * the socket's raw state. A tab coming back from idle or sleep usually finds
 * its socket dropped and gets it back within a second or two; flashing
 * "Disconnected" for that is noise. So a drop first reads as `reconnecting`
 * (`connecting` before the first connection ever opened), and only reads as
 * `lost` once reconnecting has really failed.
 */
export type ConnectionHealth = "connected" | "connecting" | "reconnecting" | "lost"

/** Failed attempts in a row before a drop can read as lost. */
export const RECONNECT_FAILURES_BEFORE_LOST = 3
/**
 * The least time down before a drop can read as lost. A wake from sleep can
 * fail three quick attempts while the network comes back; this keeps that quiet.
 */
export const RECONNECT_GRACE_MS = 5_000
/**
 * Down this long reads as lost whatever the attempts did. An attempt can hang
 * in CONNECTING instead of failing, and then never adds to the count.
 */
export const RECONNECT_LOST_AFTER_MS = 15_000

/** The message every in-flight command rejects with when its socket closes. */
export const SOCKET_DISCONNECTED_MESSAGE = "Disconnected"

export function getConnectionHealth(input: {
  open: boolean
  hasConnected: boolean
  /** Attempts that failed since the socket was last open (or since the grace window restarted). */
  failedAttempts: number
  /** Time since the socket was last open (or since the grace window restarted). */
  downForMs: number
}): ConnectionHealth {
  if (input.open) return "connected"
  const lost = input.downForMs >= RECONNECT_LOST_AFTER_MS
    || (input.failedAttempts >= RECONNECT_FAILURES_BEFORE_LOST && input.downForMs >= RECONNECT_GRACE_MS)
  if (lost) return "lost"
  return input.hasConnected ? "reconnecting" : "connecting"
}

/** When to look again, for a health that time alone can change; null when only an event can. */
export function msUntilConnectionHealthCheck(downForMs: number): number | null {
  if (downForMs < RECONNECT_GRACE_MS) return RECONNECT_GRACE_MS - downForMs
  if (downForMs < RECONNECT_LOST_AFTER_MS) return RECONNECT_LOST_AFTER_MS - downForMs
  return null
}

/**
 * A command that died with its socket says "Disconnected". During a reconnect
 * that is the same noise as the banner, so it stays hidden until the
 * connection reads as lost. Any other error shows as it comes.
 */
export function visibleCommandError(commandError: string | null, health: ConnectionHealth): string | null {
  if (commandError === SOCKET_DISCONNECTED_MESSAGE && health !== "lost") return null
  return commandError
}
